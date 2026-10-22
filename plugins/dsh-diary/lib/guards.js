/**
 * lib/guards.js —— 写盘内核（从 S3K926/dsh-memory-board 的 lib/fs-guards.js 移植，MIT）
 *
 * 它解决的问题：面板里改了半行、还没保存，另一个进程（桥接 23:30 写日记、MCP 工具）
 * 把文件换了新版——直接写就会把对方的内容盖掉。这里的顺序是：
 *
 *   指纹拒写 → 幂等跳过 → 内存里先校验 → 改前备份 → **写前再核一次指纹**（TOCTOU）
 *   → 临时文件 + rename → 写完读回复核 → 复核不过就把备份放回去
 *
 * 与原实现的差异：
 *   · 原版档案要求 CRLF / UTF-8 无 BOM；本项目的 `.md` 是 LF、JSON 是 2 空格缩进，
 *     所以这里保留调用方给的文本原样，只统一去 BOM。
 *   · 备份目录改成 `<root>/state/diary-backups/`，文件名 `<相对名>.<时间戳>.bak`。
 *   · 没有"删除"路径（日记只软删除进回收站，文件不删），所以不带 archiveDeleted。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function exists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

export function statOf(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

/** 读文本并去掉 BOM（别的编辑器可能给文件加一个）。 */
export function readText(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

export function stamp(date = new Date()) {
  const pad = (v, w = 2) => String(v).padStart(w, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * 外部改动判据：内容 sha256 取前 32 位。
 * 不用 mtime —— 备份/同步工具会把 mtime 改掉但内容一样，那不该算"别人改过"。
 */
export function fingerprint(file) {
  if (!exists(file)) return 'absent';
  return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 32)}`;
}

/** 临时文件 + rename，不赌 write 原子性（Windows 上 rename 也可能被占用，重试几次）。 */
export function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 });
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(temp, file);
      return file;
    } catch (error) {
      const retryable = ['EPERM', 'EBUSY', 'EACCES'].includes(error?.code);
      if (!retryable || attempt >= 4) {
        try { fs.unlinkSync(temp); } catch {}
        throw error;
      }
      // 同步忙等一小会儿：调用点都在交互路径上，不值得改成异步
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (attempt + 1)); } catch {}
    }
  }
}

/** 备份目录（可被插件配置覆盖）。 */
export function backupDir(root) {
  return path.join(root, 'state', 'diary-backups');
}

/**
 * 改前备份。返回备份文件路径；源文件不存在则返回 null。
 *
 * 命名：把"相对根目录的路径"里的分隔符换成 `__`，再拼时间戳。
 * 这样能从备份名反推出原文件（恢复要用），而不用另存一份索引 —— 索引会和备份文件失同步。
 * 不设自动清理（那是使用者的东西），但超过阈值喊一声，避免把磁盘写满还没人知道。
 */
export function backupFile(file, root, { warnBytes = 200 * 1024 * 1024, log = () => {} } = {}) {
  if (!exists(file)) return null;
  const dir = backupDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const rel = path.relative(root, file).split(/[\\/]/).join('__').replace(/[:*?"<>|]/g, '_');
  const dest = path.join(dir, `${rel}.${stamp()}..bak`);
  fs.copyFileSync(file, dest);
  let total = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      try { total += fs.statSync(path.join(dir, name)).size; } catch {}
    }
  } catch {}
  if (total > warnBytes) {
    log(`日记备份已 ${(total / 1048576).toFixed(0)} MB（阈值 ${warnBytes / 1048576} MB）—— ${dir} 该清了，插件不会自己删`);
  }
  return dest;
}

/** 从备份文件名反推原文件路径（相对根）。认不出返回 null。 */
export function targetOfBackup(name) {
  const m = /^(.+?)\.(\d{14})\.\.bak$/.exec(String(name ?? ''));
  if (!m) return null;
  return m[1].split('__').join(path.sep);
}

/**
 * 唯一的写盘入口。
 *
 * @param {object} options
 *   file      目标文件绝对路径（必须已存在；新建文件走 createFile）
 *   root      项目根（备份落在这里）
 *   expect    调用方读到的指纹。给了就比对：不一致 = 别人改过，直接拒写
 *   transform (before) => next | null —— 返回 null 表示"本来就一样"，跳过
 *   verify    (next, before) => boolean —— 写完复核的判据
 *   backup    是否留备份（默认留）
 * @returns {{ok:boolean, reason?:string, file:string, changed?:boolean, backup?:string|null, fingerprint?:string}}
 */
export function writeWithGuards({ file, root, expect, transform, verify, backup = true, log = () => {} }) {
  if (!exists(file)) return { ok: false, reason: 'missing-file', file };
  const before = readText(file);
  const observed = fingerprint(file);
  if (expect !== undefined && expect !== null && expect !== '' && expect !== observed) {
    return { ok: false, reason: 'stale-fingerprint', file, fingerprint: observed };
  }
  const next = transform(before);
  if (next === null || next === before) return { ok: true, changed: false, reason: 'no-op', file, fingerprint: observed };
  if (typeof verify === 'function' && verify(next, before) !== true) {
    return { ok: false, reason: 'verify-failed', file, fingerprint: observed };
  }
  const saved = backup ? backupFile(file, root, { log }) : null;
  // TOCTOU：读文件到写文件之间，桥接可能刚好写了新内容。写之前再核一次。
  if (fingerprint(file) !== observed) {
    return { ok: false, reason: 'changed-since-read', file, fingerprint: fingerprint(file) };
  }
  atomicWrite(file, next);
  const after = readText(file);
  if (after !== next) {
    if (saved) {
      try { fs.copyFileSync(saved, file); } catch {}
    }
    return { ok: false, reason: 'verify-mismatch', file, backup: saved };
  }
  return { ok: true, changed: true, file, backup: saved, bytes: Buffer.byteLength(after, 'utf8'), fingerprint: fingerprint(file) };
}

/** 新建文件（日记面板不给建新日记，这里只留给复核/恢复用）。 */
export function createFile(file, text) {
  if (exists(file)) return { ok: false, reason: 'exists', file };
  atomicWrite(file, text);
  return { ok: true, file, fingerprint: fingerprint(file) };
}
