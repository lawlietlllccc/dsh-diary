/**
 * lib/write.js —— 面板的写操作：改日记正文 / 改记忆条目的心情与没敢说的话 / 恢复备份。
 *
 * 全部走 lib/guards.js 的 writeWithGuards：**指纹拒写 → 改前备份 → 原子写 → 写完复核**。
 * 面板不知道文件当前是什么版本，所以必须带 `expect`（打开时拿到的指纹）；
 * 期间桥接写入了新内容 → 指纹变了 → 拒写，让使用者刷新后重看，而不是把新版盖掉。
 *
 * 这里刻意**不提供**：新建日记、删除日记、改记忆条目的正文。
 * 日记该由她自己写（23:30 的专用会话），面板只做"我读到了、想改个错字"这类修正；
 * 记忆条目的正文改动会破坏"模糊/遗忘"那条线，只允许改心情/没敢说的话。
 */
import fs from 'node:fs';
import path from 'node:path';
import { exists, readText, targetOfBackup, writeWithGuards, atomicWrite } from './guards.js';
import { journalDirOf, isInside } from './paths.js';

/** 改一篇日记的正文（整篇替换）。 */
export function editJournal(paths, { kind = 'public', date, text, expect } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ''))) return { ok: false, reason: 'bad-date' };
  const body = String(text ?? '');
  if (!body.trim()) return { ok: false, reason: 'empty-text' };
  if (body.length > 20000) return { ok: false, reason: 'too-long', limit: 20000 };
  const file = path.join(journalDirOf(paths, kind), `${date}.md`);
  if (!exists(file)) return { ok: false, reason: 'missing-file', file };
  if (!isInside(paths.roots, file)) return { ok: false, reason: 'outside-root' };
  const normalized = body.replace(/\r\n/g, '\n');
  return writeWithGuards({
    file,
    root: paths.project ?? paths.root,
    expect,
    transform: () => (normalized.endsWith('\n') ? normalized : `${normalized}\n`),
    verify: (next) => next.trim().length > 0 && next.endsWith('\n')
  });
}

/** 改记忆条目的心情 / 没敢说的话（正文不动）。 */
export function editMemoryEntry(paths, { id, patch = {}, expect } = {}) {
  const entryId = String(id ?? '');
  if (!entryId) return { ok: false, reason: 'missing-id' };
  const file = paths.memoryFile;
  if (!exists(file)) return { ok: false, reason: 'missing-file', file };
  if (!isInside(paths.roots, file)) return { ok: false, reason: 'outside-root' };
  const fields = {};
  for (const key of ['mood', 'unsaid']) {
    if (Object.hasOwn(patch, key)) {
      const value = patch[key] == null ? null : String(patch[key]).trim();
      if (key === 'mood' && value && value.length > 40) return { ok: false, reason: 'mood-too-long', limit: 40 };
      if (key === 'unsaid' && value && value.length > 500) return { ok: false, reason: 'unsaid-too-long', limit: 500 };
      fields[key] = value || null;
    }
  }
  if (!Object.keys(fields).length) return { ok: false, reason: 'no-fields' };

  return writeWithGuards({
    file,
    root: paths.project ?? paths.root,
    expect,
    transform: (before) => {
      const state = JSON.parse(before);
      const entry = state.entries?.[entryId];
      if (!entry) throw new Error(`没有这条记忆：${entryId}`);
      Object.assign(entry, fields, { updatedAt: Date.now() });
      // 与 diary-core 的 atomicWriteJson 保持同一口味：2 空格缩进 + 结尾换行
      return `${JSON.stringify(state, null, 2)}\n`;
    },
    verify: (next) => {
      try {
        const state = JSON.parse(next);
        const entry = state.entries?.[entryId];
        if (!entry) return false;
        return Object.entries(fields).every(([k, v]) => (entry[k] ?? null) === v);
      } catch {
        return false;
      }
    }
  });
}

/** 用一份备份覆盖回原文件（同样过指纹守卫：别人刚改过就拒绝）。 */
export function restoreBackup(paths, { name, expect } = {}) {
  const backupName = String(name ?? '');
  if (!backupName || !backupName.endsWith('.bak')) return { ok: false, reason: 'bad-backup-name' };
  const backupPath = path.join(paths.backupDir, path.basename(backupName));
  if (!exists(backupPath)) return { ok: false, reason: 'missing-backup' };
  const rel = targetOfBackup(path.basename(backupName));
  if (!rel || rel.startsWith('..')) return { ok: false, reason: 'bad-backup-target' };
  // 备份名里的相对路径是按 project 记的（备份也落在 project/state 下）
  const file = path.join(paths.project ?? paths.root, rel);
  if (!isInside(paths.roots, file)) return { ok: false, reason: 'outside-root' };
  if (!exists(file)) return { ok: false, reason: 'missing-target', file };
  const snapshot = readText(backupPath);
  return writeWithGuards({
    file,
    root: paths.project ?? paths.root,
    expect,
    transform: () => snapshot,
    verify: (next) => next === snapshot
  });
}

/** 面板自己记的位置（认根时优先级最高的一级）。 */
export function touchPanelState(file, root) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWrite(file, JSON.stringify({ root, savedAt: new Date().toISOString() }, null, 2));
    return true;
  } catch {
    return false;
  }
}
