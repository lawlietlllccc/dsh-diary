/**
 * lib/router.js —— 11 条 HTTP 路由（面板用）。
 *
 * 每条路由**各自注册**（不靠 pathname 分派：历史教训是把两条路径写进一个 handler，
 * 等于只有第一条能被服务）。这里只做参数解析、三关检查与 JSON 包装，业务在 lib/data.js / lib/write.js。
 *
 * 写操作三关（照搬 dsh-memory-board 的做法）：
 *   ① 插件配置 readOnly 关着 ② confirm=yes ③ Origin 是本机面板（或缺省=命令行）
 */
import path from 'node:path';
import { resolveScope, diaryPaths, rememberScope, looksLikeDataRoot, looksLikeRoot } from './paths.js';
import { listJournals, readJournal, memoryEntries, memoryEntry, overview, search, listBackups } from './data.js';
import { editJournal, editMemoryEntry, restoreBackup } from './write.js';

export const API_PREFIX = '/api/diary';

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 1), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

/** 参数同时认 query 和 JSON body（面板两种都能用，命令行拼 query 更省事）。 */
async function paramsOf(request) {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  if (request.method === 'POST') {
    try {
      const body = await request.json();
      if (body && typeof body === 'object' && !Array.isArray(body)) Object.assign(params, body);
    } catch {
      /* 没有 body 或不是 JSON：只当 query 用 */
    }
  }
  return params;
}

const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

export function createRuntime(config = {}, deps = {}) {
  const settings = {
    // 数据根（日记文件所在 / 写操作允许范围）；project 是 config.json + state 所在
    root: typeof config.root === 'string' ? config.root.trim() : '',
    project: typeof config.project === 'string' ? config.project.trim() : '',
    readOnly: config.readOnly === true
  };
  const log = typeof deps.log === 'function' ? deps.log : (line) => console.log(`[dsh-diary] ${line}`);
  const stateFile = deps.stateFile; // 自检用：换个面板状态文件，免得碰使用者的 ~/.dsh/diary-panel.json
  const state = { root: null, project: null, tried: [] };
  return {
    settings,
    log,
    state,
    /** 每次现认：使用者可能刚在面板里换了位置，或者改了插件配置。 */
    scope() {
      const resolved = resolveScope(
        { root: settings.root, project: settings.project },
        { ...(deps.rootOptions ?? {}), stateFile }
      );
      state.root = resolved.root;
      state.project = resolved.project;
      state.tried = resolved.tried;
      if (!resolved.root) return { ok: false, reason: 'no-root', tried: resolved.tried, origin: resolved.origin };
      return {
        ok: true,
        origin: resolved.origin,
        root: resolved.root,
        project: resolved.project,
        paths: diaryPaths(resolved.root, resolved.project)
      };
    },
    /** 兼容旧名字 */
    paths() {
      const found = this.scope();
      return found.ok
        ? { ok: true, origin: found.origin, paths: found.paths }
        : { ok: false, reason: found.reason, tried: found.tried, origin: found.origin };
    }
  };
}

export function createRoutes(runtime) {
  const guard = (handler) => async (request) => {
    try {
      return await handler(request);
    } catch (error) {
      const message = error?.message ?? String(error);
      runtime.log(`路由出错：${message}`);
      return json({ ok: false, reason: 'error', error: message }, 500);
    }
  };

  const guardWrite = (handler) => async (request) => {
    let origin = '';
    try {
      origin = request?.headers?.get?.('origin') ?? '';
    } catch {
      origin = '';
    }
    if (origin === 'null') return json({ ok: false, reason: 'bad-origin' }, 403);
    if (origin && !LOCAL_ORIGIN.test(origin)) return json({ ok: false, reason: 'bad-origin' }, 403);
    if (runtime.settings.readOnly) return json({ ok: false, reason: 'read-only' }, 403);
    const params = await paramsOf(request);
    if (String(params.confirm ?? '') !== 'yes') return json({ ok: false, reason: 'confirm-required' }, 400);
    // 参数已经读过一次，handler 里不能再读 body —— 把解析结果挂到 request 上透传。
    return guard(handler)(Object.assign(request, { __params: params }));
  };

  const params = async (request) => request.__params ?? paramsOf(request);
  const located = () => {
    const found = runtime.scope();
    if (!found.ok) {
      return {
        error: json({
          ok: false,
          reason: 'no-root',
          hint: '认不出日记位置。数据根要含 日记/ 与 日记-私密/（或本身是项目根）；项目根要含 config.json 与 src/diary-core.js。请在面板「位置」里填，或设 DSH_DIARY_ROOT / DSH_DIARY_PROJECT。',
          tried: found.tried
        }, 409)
      };
    }
    return { paths: found.paths, origin: found.origin, root: found.root, project: found.project };
  };

  return [
    {
      path: `${API_PREFIX}/info`,
      methods: ['GET'],
      fetch: guard(async () => {
        const found = runtime.scope();
        return json({
          ok: Boolean(found.ok),
          origin: found.origin,
          root: found.ok ? found.root : null,
          project: found.ok ? found.project : null,
          readOnly: runtime.settings.readOnly,
          tried: found.tried
        }, found.ok ? 200 : 409);
      })
    },
    {
      // 换位置：面板「位置」那一栏用。校验过再记住，写进 ~/.dsh/diary-panel.json（机器本地）。
      path: `${API_PREFIX}/scope`,
      methods: ['POST'],
      fetch: guardWrite(async (request) => {
        const p = await params(request);
        const rootRaw = String(p.root ?? '').trim();
        const projectRaw = String(p.project ?? '').trim();
        if (!rootRaw && !projectRaw) return json({ ok: false, reason: 'no-target' }, 400);
        const rootCheck = rootRaw ? looksLikeDataRoot(rootRaw) : null;
        const projectCheck = projectRaw ? looksLikeRoot(projectRaw) : null;
        if (rootRaw && !rootCheck.ok) {
          return json({ ok: false, reason: 'bad-root', missing: rootCheck.missing, path: rootCheck.path }, 400);
        }
        if (projectRaw && !projectCheck.ok) {
          return json({ ok: false, reason: 'bad-project', missing: projectCheck.missing, path: projectCheck.path }, 400);
        }
        const saved = rememberScope(
          { root: rootCheck?.path, project: projectCheck?.path },
          stateFile
        );
        if (!saved.ok) return json({ ok: false, reason: 'save-failed', error: saved.error }, 500);        if (rootCheck) runtime.settings.root = rootCheck.path;
        if (projectCheck) runtime.settings.project = projectCheck.path;
        const after = runtime.scope();
        return json({
          ok: after.ok,
          reason: after.ok ? null : after.reason,
          root: after.root,
          project: after.project,
          tried: after.tried
        }, after.ok ? 200 : 409);
      })
    },
    {
      path: `${API_PREFIX}/overview`,
      methods: ['GET'],
      fetch: guard(async () => {
        const l = located();
        if (l.error) return l.error;
        return json({ ...overview(l.paths), origin: l.origin, readOnly: runtime.settings.readOnly });
      })
    },
    {
      path: `${API_PREFIX}/journals`,
      methods: ['GET'],
      fetch: guard(async (request) => {
        const l = located();
        if (l.error) return l.error;
        const p = await params(request);
        const kind = p.kind === 'private' ? 'private' : 'public';
        return json({ ok: true, kind, items: listJournals(l.paths, kind, { limit: p.limit }) });
      })
    },
    {
      path: `${API_PREFIX}/journal`,
      methods: ['GET'],
      fetch: guard(async (request) => {
        const l = located();
        if (l.error) return l.error;
        const p = await params(request);
        const kind = p.kind === 'private' ? 'private' : 'public';
        const read = readJournal(l.paths, kind, p.date);
        return json(read, read.ok ? 200 : 404);
      })
    },
    {
      path: `${API_PREFIX}/journal`,
      methods: ['POST'],
      fetch: guardWrite(async (request) => {
        const l = located();
        if (l.error) return l.error;
        const p = await params(request);
        const kind = p.kind === 'private' ? 'private' : 'public';
        const result = editJournal(l.paths, { kind, date: p.date, text: p.text, expect: p.expect });
        return json(result, result.ok ? 200 : 409);
      })
    },
    {
      path: `${API_PREFIX}/memory`,
      methods: ['GET'],
      fetch: guard(async (request) => {
        const l = located();
        if (l.error) return l.error;
        const p = await params(request);
        const scope = ['private', 'group'].includes(p.scope) ? p.scope : 'all';
        const result = memoryEntries(l.paths, { scope, limit: p.limit });
        return json(result, result.ok ? 200 : 409);
      })
    },
    {
      path: `${API_PREFIX}/entry`,
      methods: ['GET'],
      fetch: guard(async (request) => {
        const l = located();
        if (l.error) return l.error;
        const p = await params(request);
        const scope = ['private', 'group'].includes(p.scope) ? p.scope : 'all';
        const result = memoryEntry(l.paths, p.id, scope);
        return json(result, result.ok ? 200 : 404);
      })
    },
    {
      path: `${API_PREFIX}/entry`,
      methods: ['POST'],
      fetch: guardWrite(async (request) => {
        const l = located();
        if (l.error) return l.error;
        const p = await params(request);
        const patch = {};
        if (Object.hasOwn(p, 'mood')) patch.mood = p.mood;
        if (Object.hasOwn(p, 'unsaid')) patch.unsaid = p.unsaid;
        const result = editMemoryEntry(l.paths, { id: p.id, patch, expect: p.expect });
        return json(result, result.ok ? 200 : 409);
      })
    },
    {
      path: `${API_PREFIX}/search`,
      methods: ['GET'],
      fetch: guard(async (request) => {
        const l = located();
        if (l.error) return l.error;
        const p = await params(request);
        return json(search(l.paths, p.q, { limit: p.limit, days: p.days }));
      })
    },
    {
      path: `${API_PREFIX}/backups`,
      methods: ['GET'],
      fetch: guard(async (request) => {
        const l = located();
        if (l.error) return l.error;
        const p = await params(request);
        return json({ ok: true, items: listBackups(l.paths, { limit: p.limit }) });
      })
    },
    {
      path: `${API_PREFIX}/restore`,
      methods: ['POST'],
      fetch: guardWrite(async (request) => {
        const l = located();
        if (l.error) return l.error;
        const p = await params(request);
        const result = restoreBackup(l.paths, { name: p.name, expect: p.expect });
        return json(result, result.ok ? 200 : 409);
      })
    }
  ];
}

/** 备份路径名里的分隔符（面板显示用）。 */
export function displayPath(file) {
  return String(file ?? '').split(path.sep).join('/');
}
