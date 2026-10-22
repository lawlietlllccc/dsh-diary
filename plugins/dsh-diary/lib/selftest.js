/**
 * lib/selftest.js —— 模块层自检：`node index.js --selftest`
 *
 * 为什么要有它：面板的 bug 大多死在"模型/浏览器才看得见"的地方，但在那之前，
 * 写盘内核、认根、搜索、备份恢复这些**纯逻辑**都能在没有 cordis、没有浏览器的情况下跑。
 * 这里在一个临时目录里铺一份最小日记项目，把读、写、指纹拒写、备份、恢复全走一遍。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntime, createRoutes } from './router.js';
import { resolveScope } from './paths.js';

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`ok ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function seed(root) {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.mkdirSync(path.join(root, '日记'), { recursive: true });
  fs.mkdirSync(path.join(root, '日记-私密'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'diary-core.js'), '// fixture\n', 'utf8');
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    journal: { publicDir: path.join(root, '日记'), privateDir: path.join(root, '日记-私密'), writeAt: '23:30' }
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(root, '日记', '2026-10-22.md'), '# 2026-10-22 周四\n\n今天他给我带了一杯咖啡。\n', 'utf8');
  fs.writeFileSync(path.join(root, '日记', '2026-10-21.md'), '# 2026-10-21 周三\n\n很平常的一天。\n', 'utf8');
  fs.writeFileSync(path.join(root, '日记-私密', '2026-10-22.md'), '# 2026-10-22 周四（私密）\n\n其实我有点怕。\n', 'utf8');
  fs.writeFileSync(path.join(root, 'state', 'diary.json'), JSON.stringify({
    version: 2,
    seq: 2,
    entries: {
      d1: {
        id: 'd1', createdAt: Date.now() - 86400000, updatedAt: Date.now() - 86400000,
        tier: 'important', scope: 'group', baseDays: 21, extendedDays: 0,
        anchorAt: Date.now() - 86400000, frozenMs: 0,
        text: '他说自己失恋过。', mood: '心里有点沉', unsaid: '想问他还疼不疼',
        shortTitle: '他说自己失恋过', keywords: ['失恋'], history: [], deletedAt: null, shelved: null, faded: null
      },
      d2: {
        id: 'd2', createdAt: Date.now() - 3600000, updatedAt: Date.now() - 3600000,
        tier: 'normal', scope: 'private', baseDays: 7, extendedDays: 0,
        anchorAt: Date.now() - 3600000, frozenMs: 0,
        text: '私聊里他说怕我走。', mood: '酸', unsaid: null,
        shortTitle: '私聊里他说怕我走', keywords: ['怕我走'], history: [], deletedAt: null, shelved: null, faded: null
      }
    },
    cache: [], settle: { lastRunDate: null, pending: { private: null, group: null }, heartRemindedAt: { private: null, group: null }, portraitNotified: {} }
  }, null, 2), 'utf8');
}

/** 用一个假 request 直接调路由的 fetch（和 HTTP 层同一条代码路径）。 */
async function call(route, { query = {}, body = null, origin = 'http://127.0.0.1:1' } = {}) {
  const url = `http://127.0.0.1:1${route.path}?${new URLSearchParams(query)}`;
  const init = { method: route.methods[0], headers: { origin } };
  if (body) {
    init.method = 'POST';
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const request = new Request(url, init);
  const response = await route.fetch(request);
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: response.status, data };
}

function findRoute(routes, pathSuffix, method) {
  return routes.find((r) => r.path.endsWith(pathSuffix) && r.methods.includes(method));
}

export function runSelftest(rootArg) {
  const root = rootArg ? path.resolve(rootArg) : fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-diary-'));
  const seeded = fs.existsSync(path.join(root, 'config.json'));
  if (!seeded) seed(root);
  else console.log(`使用现有目录：${root}`);

  const runtime = createRuntime({ root, project: root }, {
    log: () => {},
    // 面板状态文件换到临时目录：自检绝不能改写使用者的 ~/.dsh/diary-panel.json
    stateFile: path.join(root, 'panel-state.json')
  });
  const routes = createRoutes(runtime);

  check('路由数量 = 12', routes.length === 12, `实际 ${routes.length}`);
  const scope = resolveScope({ root, project: root });
  check('认根成功（root + project）', scope.root === root && scope.project === root, JSON.stringify(scope.tried));

  return (async () => {
    const info = await call(findRoute(routes, '/info', 'GET'));
    check('GET /info 认识根', info.data.ok === true && info.data.root === root);

    const ov = await call(findRoute(routes, '/overview', 'GET'));
    check('概览：公开 2 篇 / 私密 1 篇',
      ov.data.journals?.public?.count === 2 && ov.data.journals?.private?.count === 1,
      JSON.stringify(ov.data.journals));
    check('概览：记忆 2 条（群聊 1 私聊 1）',
      ov.data.memory?.total === 2 && ov.data.memory?.byScope?.group === 1 && ov.data.memory?.byScope?.private === 1);

    const list = await call(findRoute(routes, '/journals', 'GET'), { query: { kind: 'public' } });
    check('日记目录按日期倒序', list.data.items?.[0]?.date === '2026-10-22');

    const one = await call(findRoute(routes, '/journal', 'GET'), { query: { kind: 'public', date: '2026-10-22' } });
    check('读单篇日记带指纹', one.data.ok === true && String(one.data.fingerprint).startsWith('sha256:'));
    const expect = one.data.fingerprint;

    // 写：必须带 confirm=yes + origin
    const noConfirm = await call(findRoute(routes, '/journal', 'POST'), {
      body: { kind: 'public', date: '2026-10-22', text: '改一版', expect }
    });
    check('缺 confirm 拒写', noConfirm.status === 400 && noConfirm.data.reason === 'confirm-required');

    const badOrigin = await call(findRoute(routes, '/journal', 'POST'), {
      body: { kind: 'public', date: '2026-10-22', text: '改一版', expect, confirm: 'yes' },
      origin: 'https://evil.example'
    });
    check('外站 Origin 拒写', badOrigin.status === 403 && badOrigin.data.reason === 'bad-origin');

    const stale = await call(findRoute(routes, '/journal', 'POST'), {
      body: { kind: 'public', date: '2026-10-22', text: '改一版', expect: 'sha256:deadbeef', confirm: 'yes' }
    });
    check('指纹过期拒写', stale.status === 409 && stale.data.reason === 'stale-fingerprint');

    const good = await call(findRoute(routes, '/journal', 'POST'), {
      body: { kind: 'public', date: '2026-10-22', text: '# 2026-10-22 周四\n\n今天他给我带了一杯咖啡，热的。\n', expect, confirm: 'yes' }
    });
    check('指纹正确时写入成功', good.data.ok === true && good.data.changed === true, JSON.stringify(good.data));
    check('写前留了备份', Boolean(good.data.backup) && fs.existsSync(good.data.backup));

    const after = await call(findRoute(routes, '/journal', 'GET'), { query: { kind: 'public', date: '2026-10-22' } });
    check('写入内容已生效', after.data.text.includes('热的'));
    check('写完指纹变了', after.data.fingerprint !== expect);

    // 恢复备份
    const backups = await call(findRoute(routes, '/backups', 'GET'));
    check('备份列表非空', backups.data.items.length >= 1);
    const target = backups.data.items[0];
    const restored = await call(findRoute(routes, '/restore', 'POST'), {
      body: { name: target.name, expect: after.data.fingerprint, confirm: 'yes' }
    });
    check('从备份恢复成功', restored.data.ok === true, JSON.stringify(restored.data));
    const back = await call(findRoute(routes, '/journal', 'GET'), { query: { kind: 'public', date: '2026-10-22' } });
    check('恢复后内容回到旧版', !back.data.text.includes('热的'));

    // 记忆：改心情
    const mem = await call(findRoute(routes, '/memory', 'GET'), { query: { scope: 'group' } });
    check('记忆按作用域过滤', mem.data.entries?.length === 1 && mem.data.entries[0].id === 'd1');
    const memExpect = mem.data.fingerprint;
    const edited = await call(findRoute(routes, '/entry', 'POST'), {
      body: { id: 'd1', expect: memExpect, mood: '其实不是沉，是怕', confirm: 'yes' }
    });
    check('改记忆心情成功', edited.data.ok === true, JSON.stringify(edited.data));
    const entry = await call(findRoute(routes, '/entry', 'GET'), { query: { id: 'd1' } });
    check('心情已更新且正文没动',
      entry.data.entry?.mood === '其实不是沉，是怕' && entry.data.entry?.text === '他说自己失恋过。');

    const again = await call(findRoute(routes, '/entry', 'POST'), {
      body: { id: 'd1', expect: memExpect, mood: '再改一次', confirm: 'yes' }
    });
    check('记忆指纹过期拒写', again.status === 409 && again.data.reason === 'stale-fingerprint');

    // 搜索
    const hitJournal = await call(findRoute(routes, '/search', 'GET'), { query: { q: '咖啡' } });
    check('搜索命中日记', hitJournal.data.hits?.some((h) => h.kind === 'journal'));
    const hitMemory = await call(findRoute(routes, '/search', 'GET'), { query: { q: '失恋' } });
    check('搜索命中记忆', hitMemory.data.hits?.some((h) => h.kind === 'memory'));

    // 换位置：坏路径要拒、好路径要记住（写进面板状态文件，所以再改回来）
    const badScope = await call(findRoute(routes, '/scope', 'POST'), {
      body: { root: path.join(root, '不存在'), confirm: 'yes' }
    });
    check('换到不存在的目录被拒', badScope.status === 400 && badScope.data.reason === 'bad-root');
    const noConfirmScope = await call(findRoute(routes, '/scope', 'POST'), { body: { root } });
    check('换位置也要 confirm', noConfirmScope.status === 400 && noConfirmScope.data.reason === 'confirm-required');

    // 分根：数据根只有日记目录、项目根有 config.json —— 也应认得出来
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-diary-data-'));
    fs.mkdirSync(path.join(dataRoot, '日记'), { recursive: true });
    fs.mkdirSync(path.join(dataRoot, '日记-私密'), { recursive: true });
    const split = resolveScope({ root: dataRoot, project: root });
    check('数据根与项目根可以分开', split.root === dataRoot && split.project === root, JSON.stringify(split.tried));
    fs.rmSync(dataRoot, { recursive: true, force: true });

    if (!seeded) fs.rmSync(root, { recursive: true, force: true });
    console.log(`\n${failed === 0 ? '自检通过' : '自检失败'}：${passed} 通过 / ${failed} 失败`);
    return failed === 0;
  })();
}
