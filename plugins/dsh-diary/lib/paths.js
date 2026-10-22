/**
 * lib/paths.js —— 认根 + 解析日记相关路径。**不写死任何人的目录。**
 *
 * 两级根（这一版新增，回答"能不能只让它在某个大目录里作用"）：
 *
 *   root     数据根 / 作用范围：日记 `.md` 默认就放它底下（`<root>/日记`、`<root>/日记-私密`）。
 *            面板的写操作只允许落在 root 或 project 的子树里（越界直接拒绝）。
 *   project  项目根：`config.json` 与 `state/`（记忆文件、聊天流水、备份）所在。
 *            它决定"记忆日记读哪份 JSON、聊天流水去哪儿找"。
 *
 * 两者默认相同（`project = root`）。分开是为了这种场景："日记文件放在 <数据根>，
 * 但配置和状态在 <项目根>"——于是配成 root=<数据根> / project=<项目根>。
 *
 * 认根优先级：面板记下的位置 → 插件配置 → 环境变量 → 从 cwd 往上找。
 * 每一级都拿**特征文件**验，验不过就当这级没配、往下一级走，最后把"试过哪些、各缺什么"
 * 摊给面板看 —— 不猜、不写。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PANEL_STATE_FILE = path.join(os.homedir(), '.dsh', 'diary-panel.json');
/** 项目根的特征文件：config.json + src/diary-core.js 都在。 */
export const CHARACTER_FILES = ['config.json', path.join('src', 'diary-core.js')];
/** 纯数据根的特征：这两个日记目录都在（不需要 config.json）。 */
export const DATA_DIRS = ['日记', '日记-私密'];

export function exists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

export function expandHome(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return raw;
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

function readPanelState(file = PANEL_STATE_FILE) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** 记下使用者选的位置（机器本地，不进 profile 的 patch）。 */
export function rememberScope({ root = '', project = '' }, file = PANEL_STATE_FILE) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload = { savedAt: new Date().toISOString() };
    if (root) payload.root = path.resolve(expandHome(root));
    if (project) payload.project = path.resolve(expandHome(project));
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, file, ...payload };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

export function looksLikeRoot(dir) {
  if (!dir) return { ok: false, missing: [...CHARACTER_FILES] };
  const resolved = path.resolve(expandHome(String(dir)));
  const missing = CHARACTER_FILES.filter((rel) => !exists(path.join(resolved, rel)));
  return { ok: missing.length === 0, path: resolved, missing };
}

/** 数据根：有 `日记/` + `日记-私密/` 就算，或者本身是项目根（也接受）。 */
export function looksLikeDataRoot(dir) {
  if (!dir) return { ok: false, missing: [...DATA_DIRS] };
  const resolved = path.resolve(expandHome(String(dir)));
  if (looksLikeRoot(resolved).ok) return { ok: true, path: resolved, missing: [] };
  const missing = DATA_DIRS.filter((rel) => !exists(path.join(resolved, rel)));
  return { ok: missing.length === 0, path: resolved, missing };
}

/** 从 cwd 逐级往上找项目根（找不到返回 null）。 */
export function detectFromCwd(start = process.cwd()) {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i += 1) {
    if (looksLikeRoot(dir).ok) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 认"作用范围"（root + project）。
 *
 * 判定规则（尽量不吓人）：
 *   · root 必须是**数据根**（日记目录在，或者本身是项目根）；
 *   · project 必须是**项目根**（config.json + src/diary-core.js）；
 *   · 只给了 root、没给 project 时：如果 root 自己就是项目根 → project = root；
 *     否则在 root 下面找一层子目录里有没有项目根（取第一个），找不到就报错让人填。
 *
 * @returns {{root:string|null, project:string|null, origin:string|null, tried:object[]}}
 */
export function resolveScope(config = {}, options = {}) {
  const state = options.state !== undefined ? options.state : readPanelState(options.stateFile);
  const tried = [];
  const candidates = [];
  if (state && (state.root || state.project)) {
    candidates.push({ origin: 'state', root: state.root, project: state.project });
  }
  if (config.root || config.project) {
    candidates.push({ origin: 'config', root: config.root, project: config.project });
  }
  if (process.env.DSH_DIARY_ROOT || process.env.DSH_DIARY_PROJECT) {
    candidates.push({ origin: 'env', root: process.env.DSH_DIARY_ROOT, project: process.env.DSH_DIARY_PROJECT });
  }
  const detected = detectFromCwd(options.cwd);
  if (detected) candidates.push({ origin: 'detected', root: detected, project: detected });

  for (const candidate of candidates) {
    const rootCheck = candidate.root ? looksLikeDataRoot(candidate.root) : null;
    let projectRaw = candidate.project ? path.resolve(expandHome(candidate.project)) : null;
    let projectCheck = projectRaw ? looksLikeRoot(projectRaw) : null;

    // 只给了 root：先当项目根本身，再往下找一层
    if (!projectCheck && rootCheck?.ok) {
      if (looksLikeRoot(rootCheck.path).ok) {
        projectRaw = rootCheck.path;
        projectCheck = { ok: true, path: projectRaw, missing: [] };
      } else {
        let children = [];
        try { children = fs.readdirSync(rootCheck.path, { withFileTypes: true }); } catch {}
        for (const child of children) {
          if (!child.isDirectory()) continue;
          const sub = path.join(rootCheck.path, child.name);
          const subCheck = looksLikeRoot(sub);
          if (subCheck.ok) { projectRaw = sub; projectCheck = subCheck; break; }
        }
      }
    }

    tried.push({
      origin: candidate.origin,
      root: rootCheck?.path ?? null,
      rootOk: Boolean(rootCheck?.ok),
      rootMissing: rootCheck?.missing ?? [...DATA_DIRS],
      project: projectRaw,
      projectOk: Boolean(projectCheck?.ok),
      projectMissing: projectCheck?.missing ?? [...CHARACTER_FILES]
    });
    if (rootCheck?.ok && projectCheck?.ok) {
      return { root: rootCheck.path, project: projectCheck.path, origin: candidate.origin, tried };
    }
  }
  return { root: null, project: null, origin: null, tried };
}

/** 兼容旧调用：只要项目根。 */
export function resolveRoot(config = {}, options = {}) {
  const scope = resolveScope(config, options);
  return { root: scope.project, origin: scope.origin, tried: scope.tried };
}

export function readConfig(project) {
  try {
    const raw = fs.readFileSync(path.join(project, 'config.json'), 'utf8');
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function absoluteOf(base, value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return path.isAbsolute(raw) ? raw : path.join(base, raw);
}

/**
 * 全部路径。
 * @param {string} root    数据根（日记默认位置；写操作的允许范围之一）
 * @param {string} project 项目根（config.json / state/ 所在）
 */
export function diaryPaths(root, project = root) {
  const cfg = readConfig(project);
  const journal = cfg.journal ?? {};
  const diary = cfg.diary ?? {};
  const publicDir = absoluteOf(project, journal.publicDir) || path.join(root, '日记');
  const privateDir = absoluteOf(project, journal.privateDir) || path.join(root, '日记-私密');
  const memoryFile = absoluteOf(project, diary.file) || path.join(project, 'state', 'diary.json');
  const chatLogDir = absoluteOf(project, journal.logDir) || path.join(project, 'state', 'chat-log');
  return {
    root,
    project,
    // 写操作允许的子树（两个根都算；它们经常是父子关系）
    roots: [...new Set([root, project])],
    publicDir,
    privateDir,
    memoryFile,
    chatLogDir,
    backupDir: path.join(project, 'state', 'diary-backups'),
    cfg
  };
}

export const JOURNAL_KINDS = { public: '公开', private: '私密' };

export function journalDirOf(paths, kind) {
  return kind === 'private' ? paths.privateDir : paths.publicDir;
}

/** 只认 YYYY-MM-DD.md，别的文件一概不碰。 */
export function isJournalName(name) {
  return /^\d{4}-\d{2}-\d{2}\.md$/.test(String(name ?? ''));
}

/** 某个文件是否落在允许的子树里（面板所有写操作的前置检查）。 */
export function isInside(roots, file) {
  const target = path.resolve(file);
  for (const base of Array.isArray(roots) ? roots : [roots]) {
    if (!base) continue;
    const rel = path.relative(path.resolve(base), target);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true;
  }
  return false;
}
