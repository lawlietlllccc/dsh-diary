// 日记（v2 重做）自检：三档寿命 / 延长 / 升降温 / 搁着冻结 / 记糊 / 回收站 /
// 模糊视图三档 / 关键词命中 / 凌晨结算 / 300 条缓存 / MCP 工具面。
//
// 用法：node scripts/test-diary.mjs
// 全部走临时目录，不碰真实 state/diary.json。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dc from '../src/diary-core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-test-'));
const FILE = path.join(TMP, 'diary.json');

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`✅ ${name}`);
}

const DAY = dc.DAY_MS;
// 固定的“写下那天”：2026-10-18 23:12 本地时间
const T0 = Date.parse('2026-10-18T23:12:00+08:00');

function freshState() {
  return dc.emptyState();
}

// ── 1. 三档初始寿命 ─────────────────────────────────────────────────────────
{
  const state = freshState();
  const n = dc.createEntry(state, { text: '今天他夸了我一句，我假装没听见。', tier: 'normal' }, T0);
  const i = dc.createEntry(state, { text: '他说他失恋过。', tier: 'important' }, T0);
  const h = dc.createEntry(state, { text: '那年冬天她走了，我没有送。', tier: 'heart' }, T0);
  assert.equal(dc.lifeDays(n), 7);
  assert.equal(dc.lifeDays(i), 21);
  assert.equal(dc.lifeDays(h), 90);
  assert.equal(dc.remainingDays(n, T0), 7);
  assert.equal(dc.remainingDays(i, T0), 21);
  assert.equal(dc.remainingDays(h, T0), 90);
  // 寿命是绝对时长：第 7 天整就到期
  assert.equal(dc.remainingDays(n, T0 + 7 * DAY), 0);
  assert.equal(dc.remainingDays(n, T0 + 6 * DAY), 1);
  ok('三档初始寿命 7/21/90，且按绝对时长递减');
}

// ── 2. 翻看不续命 ───────────────────────────────────────────────────────────
{
  const state = freshState();
  const e = dc.createEntry(state, { text: '他今天换头像了。' }, T0);
  const before = dc.expiryAt(e, T0);
  dc.openEntry(state, e.id, T0 + 2 * DAY);
  dc.openEntry(state, e.id, T0 + 4 * DAY);
  assert.equal(dc.expiryAt(e, T0 + 4 * DAY), before, '打开不能改到期时间');
  assert.equal(e.extendedDays, 0, '打开不能加天数');
  ok('展开不续命（只有 extend 才加天数）');
}

// ── 3. 延长：按档位加天数，同一天只算一次 ───────────────────────────────────
{
  const state = freshState();
  const n = dc.createEntry(state, { text: 'a' }, T0);
  const i = dc.createEntry(state, { text: 'b', tier: 'important' }, T0);
  const h = dc.createEntry(state, { text: 'c', tier: 'heart' }, T0);
  const day2 = T0 + 12 * 3600_000; // 第二天白天（同一天内第二次延长必须被拒）
  assert.equal(dc.extendEntry(state, n.id, day2).days, 3);
  assert.equal(dc.extendEntry(state, i.id, day2).days, 7);
  assert.equal(dc.extendEntry(state, h.id, day2).days, 30);
  assert.throws(() => dc.extendEntry(state, n.id, day2 + 3600_000), /今天已经延长过/, '同一天第二次延长必须被拒');
  // 第二天可以再延长
  assert.equal(dc.extendEntry(state, n.id, T0 + 2 * DAY).days, 3);
  assert.equal(dc.lifeDays(n), 13);
  ok('延长 +3/+7/+30，同一天只算一次');
}

// ── 4. 升档 / 降档按新档位初始寿命重算 ──────────────────────────────────────
{
  const state = freshState();
  const n = dc.createEntry(state, { text: 'x' }, T0);
  dc.extendEntry(state, n.id, T0); // 7+3=10
  const at = T0 + 3 * DAY;
  const { to } = dc.promoteEntry(state, n.id, at);
  assert.equal(to, 'important');
  assert.equal(dc.lifeDays(n), 21, '升档后按新档位 21 天重算，不叠旧寿命');
  assert.equal(dc.remainingDays(n, at), 21);
  assert.equal(dc.expiryAt(n, at), at + 21 * DAY);

  const h = dc.createEntry(state, { text: 'y', tier: 'heart' }, T0);
  const { to: down } = dc.demoteEntry(state, h.id, at);
  assert.equal(down, 'important');
  assert.equal(dc.lifeDays(h), 21);
  assert.throws(() => dc.promoteEntry(state, h.id, at).to === 'heart' && dc.promoteEntry(state, h.id, at), /最高档/);
  const lowest = dc.createEntry(state, { text: 'z' }, T0);
  assert.throws(() => dc.demoteEntry(state, lowest.id, at), /最低档/);
  ok('升降档按新档位初始寿命重算');
}

// ── 5. 搁着：不敢看冻结计时，没兴趣照常衰减 ────────────────────────────────
{
  const state = freshState();
  const a = dc.createEntry(state, { text: '那件事我一直没敢问他。' }, T0);
  const b = dc.createEntry(state, { text: '那条无聊的转发。' }, T0);

  dc.shelveEntry(state, a.id, 'afraid', T0 + DAY);
  dc.shelveEntry(state, b.id, 'uninterested', T0 + DAY);

  const aAt1 = dc.remainingDays(a, T0 + 2 * DAY);
  const aAt20 = dc.remainingDays(a, T0 + 20 * DAY);
  assert.equal(aAt1, aAt20, '不敢看：时间冻结，剩余天数不变');
  assert.equal(dc.remainingDays(b, T0 + 20 * DAY), 0, '没兴趣：照常衰减到期');
  assert.ok(aAt1 > 0, '冻结期间不会到期');

  // 理由可以改：afraid → uninterested，冻结的时长结算掉，之后时间重新走
  dc.shelveEntry(state, a.id, 'uninterested', T0 + 5 * DAY);
  assert.ok(a.frozenMs >= 4 * DAY, '改理由时要把冻结时长结算掉');
  const after = dc.remainingDays(a, T0 + 6 * DAY);
  assert.ok(after < aAt1, '改成没兴趣后开始正常衰减');

  // 拿出来
  const c = dc.createEntry(state, { text: '被他问起的时候我躲开了。' }, T0);
  dc.shelveEntry(state, c.id, 'afraid', T0 + DAY);
  dc.unshelveEntry(state, c.id, T0 + 4 * DAY);
  assert.equal(c.shelved, null);
  assert.ok(c.frozenMs >= 3 * DAY, '拿出来时结算冻结时长');
  ok('搁着两种理由的寿命算法不同，理由可改，可拿出来');
}

// ── 6. 记糊：正文改写，原文留底 ─────────────────────────────────────────────
{
  const state = freshState();
  const e = dc.createEntry(state, { text: '他走的时候我没有回头，其实回头了。', mood: '有点酸' }, T0);
  const original = e.text;
  dc.fadeEntry(state, e.id, T0 + DAY);
  assert.notEqual(e.text, original, '正文应被改写');
  assert.equal(e.history.length, 1);
  assert.equal(e.history[0].text, original, '原文必须留底');
  assert.ok(e.text.includes('模糊') || e.text.includes('、'), '模糊版应有关键词骨架');
  ok('记糊改写正文且原文留底');
}

// ── 7. 划掉：软删除，所有注入与列表过滤 ────────────────────────────────────
{
  const state = freshState();
  const e = dc.createEntry(state, { text: '不想再提的事。' }, T0);
  dc.deleteEntry(state, e.id, T0 + DAY);
  assert.equal(dc.listEntries(state, T0 + DAY).length, 0, '默认列表过滤回收站');
  assert.equal(dc.listEntries(state, T0 + DAY, { includeDeleted: true }).length, 1);
  assert.equal(dc.buildFuzzyBlock(state, { now: T0 + DAY }), '', '回收站的不能进模糊视图');
  assert.throws(() => dc.extendEntry(state, e.id, T0 + DAY), /回收站/);
  assert.throws(() => dc.deleteEntry(state, e.id, T0 + DAY), /已经在回收站/);
  ok('划掉只标 deletedAt，注入/列表/工具都过滤');
}

// ── 8. 模糊视图三档规则 ────────────────────────────────────────────────────
{
  const state = freshState();
  const fresh = dc.createEntry(state, { text: '今天他给我带了一杯咖啡，说是顺手。', mood: '有点高兴' }, T0);
  const mid = dc.createEntry(state, { text: '下午那通电话没接。', mood: '烦' }, T0);
  const old = dc.createEntry(state, { text: '一件快要忘干净的小事。', mood: '空' }, T0);
  const noMood = dc.createEntry(state, { text: '没写心情的一条，标题应该出现。' }, T0);

  // fresh: 第 0 天，比例 7/7 > 0.5 → 心情 + 短标题
  const lineFresh = dc.renderFuzzyLine(fresh, T0);
  assert.ok(lineFresh.includes('有点高兴'), '高比例给心情');
  assert.ok(lineFresh.includes(dc.shortTitleOf(fresh.text).replace(/…$/, '')), '高比例给短标题');
  // mid: 第 4 天，剩余 3/7 ≈ 0.43 → 只给心情
  const lineMid = dc.renderFuzzyLine(mid, T0 + 4 * DAY);
  assert.ok(lineMid.includes('烦'));
  assert.ok(!lineMid.includes('下午那通电话没接'), '中比例不给标题');
  // old: 第 6 天，剩余 1/7 ≈ 0.14 → 只给心情
  const lineOld = dc.renderFuzzyLine(old, T0 + 6 * DAY);
  assert.ok(lineOld.includes('空'));
  assert.ok(!lineOld.includes('一件快要忘干净的小事'));
  // 没写心情 + 低比例 → 只剩日期
  const lineNoMood = dc.renderFuzzyLine(noMood, T0 + 6 * DAY);
  assert.ok(!lineNoMood.includes('没写心情的一条'), '低比例 + 没心情 → 只剩日期');
  assert.ok(lineNoMood.includes(dc.monthDayText(noMood.createdAt)), '日期必须还在');
  // 块级：有内容就带头尾说明，且不含正文
  const block = dc.buildFuzzyBlock(state, { now: T0 + 4 * DAY });
  assert.ok(block.includes('看不到原文'));
  assert.ok(block.includes('diary_open'));
  assert.ok(!block.includes('今天他给我带了一杯咖啡'), '块里绝不能出现正文');
  ok('模糊视图按剩余比例分三档，且从不给正文');
}

// ── 9. 关键词命中：把命中的排到前面并点出聊到了什么 ───────────────────────
{
  const state = freshState();
  for (let i = 0; i < 5; i += 1) dc.createEntry(state, { text: `一些无关的小事 ${i}，比如今天吃了面。` }, T0);
  const hit = dc.createEntry(state, { text: '他说自己失恋过，前任结婚了。', keywords: ['失恋', '前任'] }, T0);
  const block = dc.buildFuzzyBlock(state, { now: T0, matchedIds: [hit.id], matchedWords: ['失恋'], maxEntries: 3 });
  assert.ok(block.includes('聊到「失恋」'), '命中词要写进标题');
  const firstLine = block.split('\n')[1];
  assert.ok(firstLine.includes(`id=${hit.id}`), '命中的条目要排第一');
  const matched = dc.matchByKeywords(state, '你们说他失恋那次真的假的', T0);
  assert.ok(matched.ids.includes(hit.id));
  assert.ok(matched.words.includes('失恋'));
  const none = dc.matchByKeywords(state, '今天天气不错', T0);
  assert.equal(none.ids.length, 0);
  ok('关键词命中排前并点出来源词');
}

// ── 10. 凌晨结算：只报事实 ─────────────────────────────────────────────────
{
  const state = freshState();
  const soon = dc.createEntry(state, { text: '快到期的普通日记。' }, T0);
  // 第 5 天：剩余 2 天 <= 3，进入“快到期”
  const r1 = dc.runSettle(state, { now: T0 + 5 * DAY, options: { ...dc.DEFAULT_OPTIONS } });
  assert.equal(r1.ran, true);
  const g1 = r1.byScope.group;
  assert.ok(g1.text.includes('【快到期的日记】'), '要有快到期清单');
  assert.ok(g1.text.includes(soon.id));
  assert.ok(g1.text.includes('群聊'), '清单要标明是哪一侧的记忆');
  assert.ok(!g1.text.includes('你该'), '结算不能带催促引导');
  // 私聊那份这天没有内容（条目都在群聊一侧）
  assert.equal(r1.byScope.private.text, '');
  // 同一天再跑 = 不重复
  assert.equal(dc.runSettle(state, { now: T0 + 5 * DAY }).ran, false);
  // 普通档 1 天一次：第二天会再报
  assert.equal(dc.runSettle(state, { now: T0 + 6 * DAY }).ran, true);
  ok('结算按档位频率报快到期，且不带催促语');
}

// ── 11. 到期 → 模糊临存 → 回收站；延长可以救回来 ───────────────────────────
{
  const state = freshState();
  const e = dc.createEntry(state, { text: '会被模糊掉的日记。', mood: '闷' }, T0);
  const r = dc.runSettle(state, { now: T0 + 7 * DAY, options: { ...dc.DEFAULT_OPTIONS, fadeGraceDays: 3 } });
  assert.ok(r.byScope.group.facts.expired.length === 1, '到期应进入模糊临存');
  assert.ok(state.entries[e.id].faded, '状态里要有 faded');
  const opened = dc.openEntry(state, e.id, T0 + 8 * DAY);
  assert.equal(opened.payload.text, null, '模糊临存期间看不到原文');
  assert.ok(String(opened.payload.note).includes('延长'));

  // 延长 = 恢复正常并续命
  dc.extendEntry(state, e.id, T0 + 8 * DAY);
  assert.equal(state.entries[e.id].faded, null, '延长后 faded 应清除');
  const reopened = dc.openEntry(state, e.id, T0 + 8 * DAY);
  assert.equal(reopened.payload.text, '会被模糊掉的日记。', '原文应恢复');

  // 另一条什么都不做 → grace 结束进回收站（数据仍在）
  const dead = dc.createEntry(state, { text: '没人管的过期日记。' }, T0);
  dc.runSettle(state, { now: T0 + 7 * DAY + DAY, force: true });
  assert.ok(state.entries[dead.id].faded);
  const r3 = dc.runSettle(state, { now: T0 + 12 * DAY, force: true });
  assert.ok(r3.byScope.group.facts.archiving.some((x) => x.id === dead.id), '超过临存期应进回收站');
  assert.ok(state.entries[dead.id].deletedAt, '回收站是软删除');
  assert.equal(state.entries[dead.id].text, '没人管的过期日记。', '划掉不删正文');
  ok('到期先模糊临存，延长可恢复，临存结束进回收站');
}

// ── 12. 升档 / 降档 / 刻骨铭心的结算提示 ──────────────────────────────────
{
  const state = freshState();
  const n = dc.createEntry(state, { text: '普通但被反复延长的事。' }, T0);
  dc.extendEntry(state, n.id, T0);
  dc.extendEntry(state, n.id, T0 + DAY);
  dc.extendEntry(state, n.id, T0 + 2 * DAY); // 7+9=16 > 13
  const i = dc.createEntry(state, { text: '重要但快到期。', tier: 'important' }, T0);
  const h = dc.createEntry(state, { text: '刻骨铭心的事。', tier: 'heart' }, T0);
  const r = dc.runSettle(state, { now: T0 + 3 * DAY, options: { ...dc.DEFAULT_OPTIONS } });
  assert.ok(r.byScope.group.facts.promoted.some((x) => x.id === n.id), '寿命 > 13 应提示可升档');
  assert.ok(r.byScope.group.text.includes('【达到升档条件】'));
  // 重要剩 18 天，还不该提示降档（<10 才提示）
  assert.ok(!r.byScope.group.facts.demoted.some((x) => x.id === i.id));
  const r2 = dc.runSettle(state, { now: T0 + 14 * DAY, options: { ...dc.DEFAULT_OPTIONS } });
  assert.ok(r2.byScope.group.facts.demoted.some((x) => x.id === i.id), '重要剩余 <10 应提示降档');
  assert.ok(r2.byScope.group.text.includes('【刻骨铭心】'), '刻骨铭心要有客观提示');
  assert.ok(r2.byScope.group.text.includes('由你决定'), '决定权要交给她');
  // 刻骨铭心剩余 <30 才提示降档（90 天的第 65 天才满足）
  const r4 = dc.runSettle(state, { now: T0 + 65 * DAY, options: { ...dc.DEFAULT_OPTIONS } });
  assert.ok(r4.byScope.group.facts.demoted.some((x) => x.id === h.id), '刻骨铭心剩余 <30 应提示降档');
  // 刻骨铭心提示最多 7 天一次：第二天不再重复
  const r3 = dc.runSettle(state, { now: T0 + 15 * DAY, options: { ...dc.DEFAULT_OPTIONS } });
  assert.ok(!r3.byScope.group.text.includes('【刻骨铭心】'), '第二天不应重复刻骨铭心提示');
  ok('升/降档提示与刻骨铭心提示都按频率控制');
}

// ── 13. 画像联动：强度到阈值才提示，且只提示一次 ──────────────────────────
{
  const state = freshState();
  const portraits = [
    { name: '害怕被丢下', strength: 92, summary: '她从不主动说再见' },
    { name: '喜欢猫', strength: 30, summary: '只是提过一次' }
  ];
  const r = dc.runSettle(state, { now: T0, portraits, options: { ...dc.DEFAULT_OPTIONS, portraitThreshold: 80 } });
  assert.ok(r.byScope.group.facts.portraits.some((p) => p.name === '害怕被丢下'));
  assert.ok(r.byScope.private.facts.portraits.some((p) => p.name === '害怕被丢下'), '两边都会收到画像提示');
  assert.ok(!r.byScope.group.facts.portraits.some((p) => p.name === '喜欢猫'), '没到阈值的不提示');
  assert.ok(r.byScope.group.text.includes('记哪一档由你自己定'), '档位由她自己定');
  const r2 = dc.runSettle(state, { now: T0 + DAY, portraits, options: { ...dc.DEFAULT_OPTIONS, portraitThreshold: 80 } });
  assert.ok(!r2.byScope.group.text.includes('害怕被丢下'), '同一个画像只提示一次');
  ok('画像强度达阈值才提示入日记，且只提示一次');
}

// ── 14. 300 条缓存 + 16 条查询上限 ─────────────────────────────────────────
{
  const state = freshState();
  for (let i = 0; i < 320; i += 1) {
    const e = dc.createEntry(state, { text: `第 ${i} 条记录，内容各不相同 ${i}。`, mood: i % 3 === 0 ? '还行' : undefined }, T0 + i * 1000);
    dc.openEntry(state, e.id, T0 + i * 1000);
  }
  assert.equal(state.cache.length, 300, '缓存最多 300 条');
  assert.equal(state.cache[state.cache.length - 1].id, 'd320', '最新打开的在末尾');
  const recall = dc.recallCache(state, { limit: 100 }, T0 + 320 * 1000);
  assert.equal(recall.items.length, 16, '一次最多 16 条');
  assert.equal(recall.total, 300);
  const filtered = dc.recallCache(state, { query: '第 319 条' }, T0 + 320 * 1000);
  assert.equal(filtered.items.length, 1, '按词筛要能命中');
  ok('缓存 300 条上限，查询 16 条上限');
}

// ── 15. 补写心情 / 按天数翻心情 ────────────────────────────────────────────
{
  const state = freshState();
  const e = dc.createEntry(state, { text: '写的时候没心情。' }, T0);
  dc.amendEntry(state, e.id, { mood: '其实有点怕', unsaid: '别走' }, T0 + DAY);
  assert.equal(e.mood, '其实有点怕');
  assert.equal(e.unsaid, '别走');
  dc.amendEntry(state, e.id, { mood: null }, T0 + 2 * DAY);
  assert.equal(e.mood, null, '传 null 表示清空');
  assert.throws(() => dc.amendEntry(state, e.id, {}, T0), /没有要补写/);
  const moods = dc.listMoodsByDays(state, 7, T0 + 3 * DAY);
  assert.equal(moods.length, 1);
  assert.equal(moods[0].mood, null);
  assert.ok(!('text' in moods[0]), '按天数翻心情不返回正文');
  ok('补写心情可改可清空，按天数翻心情只看心情');
}

// ── 16. 存储：原子写、损坏不覆盖、文件锁 ───────────────────────────────────
{
  fs.rmSync(FILE, { force: true });
  dc.mutateDiary(FILE, (state) => dc.createEntry(state, { text: '落盘测试。' }, T0));
  const loaded = dc.loadDiary(FILE);
  assert.equal(Object.keys(loaded.entries).length, 1);

  // 损坏的文件必须抛错，而不是静默返回空状态（否则下一次写入会覆盖整本日记）
  fs.writeFileSync(FILE, '{ this is not json', 'utf8');
  assert.throws(() => dc.loadDiary(FILE), /损坏/);
  assert.equal(dc.readDiary(FILE), null, '注入层读到坏文件应静默跳过');

  // 文件不存在 = 还没开始写，返回空状态
  fs.rmSync(FILE, { force: true });
  assert.equal(Object.keys(dc.loadDiary(FILE).entries).length, 0);

  // 并发写：两个 mutate 串行，不会互相覆盖
  dc.mutateDiary(FILE, (state) => dc.createEntry(state, { text: '并发 A' }, T0));
  dc.mutateDiary(FILE, (state) => dc.createEntry(state, { text: '并发 B' }, T0));
  assert.equal(Object.keys(dc.loadDiary(FILE).entries).length, 2);

  // 每次落盘都留一份上一版 `<file>.bak`：逻辑写坏了还能把上一秒捞回来
  assert.ok(fs.existsSync(`${FILE}.bak`), '应该有一份滚动备份');
  const bak = JSON.parse(fs.readFileSync(`${FILE}.bak`, 'utf8'));
  assert.equal(Object.keys(bak.entries ?? {}).length, 1, '备份里是上一版（只有 1 条）');
  ok('原子落盘、损坏不覆盖、锁串行、滚动备份');
}

// ── 17. 记忆作用域：私聊与群聊互不相通 ────────────────────────────────────
{
  const state = freshState();
  const p = dc.createEntry(state, { text: '私聊里他说怕我走。', mood: '酸', scope: 'private' }, T0);
  const g = dc.createEntry(state, { text: '群里在聊圆周率，笑死。', mood: '乐', scope: 'group' }, T0);
  assert.equal(p.scope, 'private');
  assert.equal(g.scope, 'group');
  assert.equal(dc.createEntry(state, { text: '没写作用域默认群聊。' }, T0).scope, 'group', '默认回落群聊');

  // 注入只看得到自己那一侧
  const gBlock = dc.buildFuzzyBlock(state, { now: T0, scope: 'group' });
  assert.ok(gBlock.includes('圆周率'));
  assert.ok(!gBlock.includes('怕我走'), '群聊的模糊视图里不能出现私聊记忆');
  const pBlock = dc.buildFuzzyBlock(state, { now: T0, scope: 'private' });
  assert.ok(pBlock.includes('怕我走'));
  assert.ok(!pBlock.includes('圆周率'), '私聊的模糊视图里不能出现群聊记忆');

  // 关键词命中同样按侧过滤
  assert.deepEqual(dc.matchByKeywords(state, '圆周率', T0, { scope: 'private' }).ids, []);
  assert.deepEqual(dc.matchByKeywords(state, '圆周率', T0, { scope: 'group' }).ids, [g.id]);

  // 列表 / 心情 / 缓存
  assert.deepEqual(dc.listEntries(state, T0, { scope: 'private' }).map((e) => e.id), [p.id]);
  const groupMoods = dc.listMoodsByDays(state, 7, T0, { scope: 'group' }).map((e) => e.id);
  assert.ok(groupMoods.includes(g.id));
  assert.ok(!groupMoods.includes(p.id), '按天数翻心情也不能跨侧');
  dc.openEntry(state, p.id, T0);
  dc.openEntry(state, g.id, T0);
  assert.equal(dc.recallCache(state, { scope: 'private' }, T0).items.length, 1);
  assert.equal(dc.recallCache(state, { scope: 'private' }, T0).items[0].id, p.id);

  // 打开别一侧的条目会被拒（不给人"顺手看一眼"的口子）
  assert.throws(() => dc.openEntry(state, p.id, T0, { scope: 'group' }), /不在当前的记忆里/);
  assert.throws(() => dc.assertEntryScope(state, g.id, 'private'), /不在当前的记忆里/);

  // 结算也分两份：各侧只报自己那些条目
  const pSoon = dc.createEntry(state, { text: '私聊快到期的。', scope: 'private' }, T0 - 5 * DAY);
  const gSoon = dc.createEntry(state, { text: '群聊快到期的。', scope: 'group' }, T0 - 5 * DAY);
  const r = dc.runSettle(state, { now: T0, options: { ...dc.DEFAULT_OPTIONS } });
  assert.ok(r.byScope.private.text.includes(pSoon.id), '私聊清单要出现私聊的条目');
  assert.ok(!r.byScope.private.text.includes(gSoon.id), '私聊清单不能出现群聊的条目');
  assert.ok(r.byScope.group.text.includes(gSoon.id));
  assert.ok(!r.byScope.group.text.includes(pSoon.id), '群聊清单不能出现私聊的条目');
  ok('记忆作用域隔离：注入/检索/列表/心情/缓存/展开/结算各管各的');
}

// ── 18. MCP 工具面（13 个：12 日记 + 1 缓存查询） ──────────────────────────
{
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'src', 'mcp-diary.js')],
    cwd: ROOT,
    stderr: 'pipe'
  });
  const client = new Client({ name: 'diary-test', version: '0.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.equal(names.length, 13, `工具数应为 13，实际 ${names.length}: ${names.join(',')}`);
    for (const required of ['diary_write', 'diary_list', 'diary_open', 'diary_extend', 'diary_promote',
      'diary_demote', 'diary_shelve', 'diary_unshelve', 'diary_fade', 'diary_delete', 'diary_amend',
      'diary_moods', 'diary_recall']) {
      assert.ok(names.includes(required), `缺少工具 ${required}`);
    }
    // 工具描述要带“人味”的行为说明，而不是 API 文档
    const write = tools.find((t) => t.name === 'diary_write');
    assert.ok(String(write.description).includes('没说出口'), '工具描述应说明三部分构成');
    ok('MCP 暴露 13 个工具，描述带行为语义');
  } finally {
    try { await client.close(); } catch {}
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n🎉 日记核心测试通过（${passed} 项）`);
