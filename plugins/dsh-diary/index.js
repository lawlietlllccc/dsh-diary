/**
 * dsh-diary —— 日记面板（Host 半边）。
 *
 * 这是把「日记项目」打包成的 DSH 插件：设置页里多一页「日记」，
 * 能看概览、翻公开/私密日记、翻记忆条目、全库搜索、以及在**指纹守卫 + 改前备份**下
 * 修改正文/心情/没敢说的话、从备份恢复。
 *
 * 它**不写记忆、不写日记内容**：日记由桥接每天 23:30 的专用会话写，记忆由 13 个
 * `mcp__diary__*` 工具写。面板是"人看和修的窗口"，写盘一律走 lib/guards.js 那条内核
 * （指纹拒写 → 改前备份 → 原子写 → 写完复核），所以桥接随时可能在动，它也不会盖错版本。
 *
 * ⚠ 两个真机上踩过的坑（照抄 dsh-memory-board 的教训）：
 *   1. 必须导出 name / inject，否则 ctx.connection 取不到、**所有路由一条都挂不上**；
 *   2. inject 必须是**数组**（本机 cordis 的口味），写成 { required: [...] } 会一直 pending。
 */
import { createRuntime, createRoutes, API_PREFIX } from './lib/router.js';

export const name = 'dsh-diary';
export const inject = ['connection'];

export function apply(ctx, config = {}) {
  const runtime = createRuntime(config);
  runtime.log(`apply 进入（readOnly=${runtime.settings.readOnly} root=${runtime.settings.root || '(未配，按特征文件认)'}）`);
  const routes = createRoutes(runtime);
  let registered = 0;
  for (const route of routes) {
    try {
      ctx.connection.fetch.register({
        path: route.path,
        methods: route.methods,
        requestBody: 'buffered',
        fetch: route.fetch
      });
      registered += 1;
      runtime.log(`路由已注册：${route.methods.join('/')} ${route.path}`);
    } catch (error) {
      runtime.log(`路由注册失败：${route.path} —— ${error?.message ?? String(error)}`);
    }
  }
  runtime.log(`共注册 ${registered}/${routes.length} 条路由（前缀 ${API_PREFIX}）`);
}

// ─────────────────────────────────────────────────────────────── 自检
// `node index.js --selftest [root]`：不依赖 cordis/DSH，直接在临时目录跑一遍读写。
if (process.argv.includes('--selftest')) {
  const { runSelftest } = await import('./lib/selftest.js');
  const root = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
  process.exitCode = runSelftest(root) ? 0 : 1;
}

// ─────────────────────────────────────────────────────────────── 对外导出
// 命令行脚本（scripts/）与测试直接复用同一套实现，别另抄一份。
export { createRuntime, createRoutes } from './lib/router.js';
export { resolveScope, resolveRoot, diaryPaths, looksLikeRoot, looksLikeDataRoot, detectFromCwd, rememberScope, isInside, PANEL_STATE_FILE } from './lib/paths.js';
export { fingerprint, writeWithGuards, atomicWrite, backupFile, targetOfBackup, backupDir } from './lib/guards.js';
export { overview, listJournals, readJournal, readMemory, memoryEntries, memoryEntry, search, listBackups } from './lib/data.js';
export { editJournal, editMemoryEntry, restoreBackup } from './lib/write.js';
