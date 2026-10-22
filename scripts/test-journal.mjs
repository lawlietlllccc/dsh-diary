// 每日两份日记（journal-store）自检：写入/不覆盖、到期判定、补写窗口、输出解析、摘要。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as js from '../src/journal-store.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-test-'));
const PUB = path.join(TMP, '日记');
const PRIV = path.join(TMP, '日记-私密');

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`✅ ${name}`);
}

const at = (y, m, d, hh = 12, mm = 0) => new Date(y, m - 1, d, hh, mm, 0, 0).getTime();

// ── 1. writeAt 解析 ────────────────────────────────────────────────────────
{
  assert.deepEqual(js.parseWriteAt('23:30'), { hour: 23, minute: 30 });
  assert.deepEqual(js.parseWriteAt('7:05'), { hour: 7, minute: 5 });
  assert.deepEqual(js.parseWriteAt('bad'), { hour: 23, minute: 30 });
  assert.deepEqual(js.parseWriteAt('99:99'), { hour: 23, minute: 59 });
  ok('writeAt 解析容错');
}

// ── 2. 写入：带日期头、拒绝覆盖、可显式重写 ────────────────────────────────
{
  const p = js.writeJournal(PUB, '2026-10-22', '今天他给我带了一杯咖啡。', { now: at(2026, 10, 22, 23, 31) });
  assert.equal(path.basename(p.file), '2026-10-22.md');
  const text = fs.readFileSync(p.file, 'utf8');
  assert.ok(text.startsWith('# 2026-10-22 周四'), '文件头要有日期和星期');
  assert.ok(text.includes('今天他给我带了一杯咖啡。'));
  assert.ok(text.includes('写于 2026-10-22 23:31'));

  assert.throws(() => js.writeJournal(PUB, '2026-10-22', '改写', { now: at(2026, 10, 22, 23, 40) }), /已经写过/, '默认不覆盖');
  js.writeJournal(PUB, '2026-10-22', '改写后的版本', { now: at(2026, 10, 22, 23, 40), overwrite: true });
  assert.ok(fs.readFileSync(p.file, 'utf8').includes('改写后的版本'));

  assert.throws(() => js.writeJournal(PUB, '2026-10-23', '   ', {}), /为空/);
  // 私密那份的文件头标记不同
  const priv = js.writeJournal(PRIV, '2026-10-22', '其实我有点怕。', { now: at(2026, 10, 22, 23, 32), kind: 'private' });
  assert.ok(fs.readFileSync(priv.file, 'utf8').includes('（私密）'));

  // 覆盖前留备份（学自 dsh-memory-board 的写盘内核：护栏放在唯一入口上）
  const bakDir = path.join(TMP, 'diary-backups');
  js.writeJournal(PUB, '2026-10-22', '第二版正文', { now: at(2026, 10, 22, 23, 45), overwrite: true, backupDir: bakDir });
  const baks = fs.readdirSync(bakDir);
  assert.equal(baks.length, 1, '覆盖前应留一份备份');
  assert.ok(baks[0].endsWith('..bak'));
  assert.ok(fs.readFileSync(path.join(bakDir, baks[0]), 'utf8').includes('改写后的版本'), '备份里是覆盖前的内容');
  assert.ok(fs.readFileSync(p.file, 'utf8').includes('第二版正文'), '文件已变成新内容');
  // 不覆盖时不该产生备份
  assert.throws(() => js.writeJournal(PUB, '2026-10-22', '第三版', { now: at(2026, 10, 22, 23, 50), backupDir: bakDir }), /已经写过/);
  assert.equal(fs.readdirSync(bakDir).length, 1, '被拒绝的写入不该留备份');
  ok('写入带日期头、默认不覆盖、可显式重写、空正文拒绝、覆盖前备份');
}

// ── 3. 日期列表 ────────────────────────────────────────────────────────────
{
  assert.deepEqual(js.listJournalDates(PUB), ['2026-10-22']);
  assert.equal(js.hasJournal(PUB, '2026-10-22'), true);
  assert.equal(js.hasJournal(PUB, '2026-10-21'), false);
  assert.deepEqual(js.listJournalDates(path.join(TMP, '不存在')), []);
  ok('日期列表只认 YYYY-MM-DD.md');
}

// ── 4. 该写哪几天：过了 23:30 才算今天 / 补写窗口 / 部署日 ─────────────────
{
  const dirs = [PUB, PRIV];
  const before = js.dueDates({ now: at(2026, 10, 23, 22, 0), dirs, catchupDays: 7, startedOn: '2026-10-23' });
  assert.deepEqual(before, [], '23:30 之前今天不算该写；部署日之前的日子不补');

  const after = js.dueDates({ now: at(2026, 10, 23, 23, 31), dirs, catchupDays: 7, startedOn: '2026-10-23' });
  assert.deepEqual(after, ['2026-10-23'], '过了 23:30，今天该写');

  // 第 22 天两份都有；21、20 两天完全没写 → 待写列表从老到新
  const partial = js.dueDates({ now: at(2026, 10, 23, 9, 0), dirs, catchupDays: 7, startedOn: '2026-10-20' });
  assert.deepEqual(partial, ['2026-10-20', '2026-10-21'], '补写从老到新，且不含已写完的 22 号');

  // 只写了一份也算没写完（公开在、私密缺）
  fs.rmSync(js.journalFile(PRIV, '2026-10-22'));
  const oneSided = js.dueDates({ now: at(2026, 10, 23, 9, 0), dirs, catchupDays: 7, startedOn: '2026-10-22' });
  assert.deepEqual(oneSided, ['2026-10-22'], '两个文件夹任一缺失都要重写这一天');

  // 全部齐全后没有待写
  for (const d of ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']) {
    if (!js.hasJournal(PUB, d)) js.writeJournal(PUB, d, '补的公开', { now: at(2026, 10, 23, 12) });
    if (!js.hasJournal(PRIV, d)) js.writeJournal(PRIV, d, '补的私密', { now: at(2026, 10, 23, 12), kind: 'private' });
  }
  assert.deepEqual(js.dueDates({ now: at(2026, 10, 23, 9, 0), dirs, catchupDays: 7, startedOn: '2026-10-20' }), [], '都写过了就不该再排');

  // 补写窗口之外的旧日子不排
  const old = js.dueDates({ now: at(2026, 11, 5, 9, 0), dirs, catchupDays: 3, startedOn: '2026-01-01' });
  assert.ok(old.length <= 3, '补写窗口受 catchupDays 限制');
  ok('到期判定：23:30 门槛、补写窗口、部署日、部分缺失');
}

// ── 5. 解析两段输出 ────────────────────────────────────────────────────────
{
  const a = js.parseJournalOutput('===公开===\n今天很平常。\n===私密===\n其实有点难过。');
  assert.equal(a.ok, true);
  assert.equal(a.public, '今天很平常。');
  assert.equal(a.private, '其实有点难过。');

  const b = js.parseJournalOutput('【公开】\n甲\n【私密】\n乙');
  assert.equal(b.ok, true);

  const c = js.parseJournalOutput('## 公开\n甲\n## 私密\n乙');
  assert.equal(c.ok, true);

  // 只有一份 → 不通过（要重试，而不是把半篇存下来）
  const d = js.parseJournalOutput('===公开===\n只有这一份');
  assert.equal(d.ok, false);
  assert.equal(d.public, '只有这一份');
  assert.equal(d.private, '');

  // 完全认不出来 → 不通过
  assert.equal(js.parseJournalOutput('随便说两句').ok, false);
  // 标记之前的废话不要混进正文
  const e = js.parseJournalOutput('好的，我写。\n===公开===\n甲\n===私密===\n乙');
  assert.equal(e.public, '甲');
  ok('两段输出解析：三种标记 / 半篇不算成功 / 前置废话被丢掉');
}

// ── 6. 聊天摘要：去重、限长、留最近的 ──────────────────────────────────────
{
  const msgs = Array.from({ length: 200 }, (_, i) => ({ sender: '群友', text: `第 ${i} 条消息` }));
  const digest = js.buildDigest(msgs, { maxChars: 300, maxLines: 20 });
  assert.ok(digest.length <= 300 + 20);
  assert.ok(digest.includes('第 199 条'), '要留最近的');
  assert.ok(!digest.includes('第 0 条'), '太旧的被截掉');
  const dup = js.buildDigest([{ sender: 'A', text: '同一句' }, { sender: 'A', text: '同一句' }]);
  assert.equal(dup.split('\n').length, 1, '重复行只留一条');
  assert.equal(js.buildDigest([]), '');
  ok('摘要去重、限长、留最近的');
}

// ── 7. 当天聊天流水：按小时取样，覆盖整天而不是只剩最近一小时 ──────────────
{
  const LOGDIR = path.join(TMP, 'chat-log');
  const date = '2026-10-22';

  // 写一条 / 读回来
  assert.equal(js.appendChatLog(LOGDIR, date, { t: at(2026, 10, 22, 9, 5), k: 'group:1', s: '甲', x: '上午在聊耳机' }), true);
  js.appendChatLog(LOGDIR, date, { t: at(2026, 10, 22, 15, 0), k: 'group:1', s: '乙', x: '下午在吵品牌溢价' });
  js.appendChatLog(LOGDIR, date, { t: at(2026, 10, 22, 22, 30), k: 'private:9', s: '主人', x: '晚上问我在不在' });
  js.appendChatLog(LOGDIR, date, { t: at(2026, 10, 22, 23, 20), k: 'group:1', s: '我', x: '我回了一句' });
  assert.equal(js.appendChatLog(LOGDIR, date, { t: Date.now(), k: 'group:1', s: '甲', x: '   ' }), false, '空内容不写');

  const rows = js.readChatLog(LOGDIR, date);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].s, '甲');
  assert.equal(js.readChatLog(LOGDIR, '2026-01-01').length, 0, '没有的日期返回空');

  // 分桶取样：3 个群聊小时 + 1 个私聊小时 = 4 个小时都要出现
  const day = js.buildDayDigest(rows, { maxChars: 8000, perHour: 4 });
  assert.equal(day.hours, 4);
  assert.equal(day.total, 4);
  assert.ok(day.text.includes('09:05 群聊·甲：上午在聊耳机'), `要带时间和来源，实际：\n${day.text}`);
  assert.ok(day.text.includes('15:00 群聊·乙'));
  assert.ok(day.text.includes('22:30 私聊·主人'), '私聊也要进素材');
  assert.ok(day.text.includes('23:20 群聊·我'), '她自己说的话也在里面');

  // 关键回归：一天几十条挤在一起时，**最早的上午也要留在素材里**（旧实现只留最后 N 行）
  const many = [];
  for (let hour = 9; hour <= 23; hour += 1) {
    for (let i = 0; i < 30; i += 1) {
      many.push({ t: at(2026, 10, 22, hour, i), k: 'group:1', s: `人${hour}`, x: `第 ${hour} 点的第 ${i} 句，说了一件事` });
    }
  }
  const crowded = js.buildDayDigest(many, { maxChars: 2000, perHour: 4 });
  assert.equal(crowded.hours, 15, '9 点到 23 点共 15 个小时');
  assert.ok(crowded.text.includes('09:'), '最早的一小时不能被挤掉');
  assert.ok(crowded.text.includes('23:'), '最后一小时也要在');
  assert.ok(crowded.text.length <= 2000, '不能超预算');
  assert.ok(crowded.sampled < crowded.total, '是取样，不是全量');

  // 预算更紧时仍然保留整天跨度（自动降采样到 1 行/时）
  const tight = js.buildDayDigest(many, { maxChars: 700, perHour: 4 });
  assert.ok(tight.text.length <= 700);
  assert.ok(tight.text.includes('09:') && tight.text.includes('23:'), '预算再紧也要覆盖首尾小时');

  // 保留期清理：只删超过 keepDays 的、只认自己的文件名
  fs.writeFileSync(path.join(LOGDIR, '2026-10-01.jsonl'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(LOGDIR, 'keep-me.txt'), 'x', 'utf8');
  const removed = js.pruneChatLogs(LOGDIR, { now: at(2026, 10, 22, 23, 0), keepDays: 10 });
  assert.deepEqual(removed, ['2026-10-01.jsonl']);
  assert.ok(fs.existsSync(path.join(LOGDIR, `${date}.jsonl`)), '当天的流水不能被删');
  assert.ok(fs.existsSync(path.join(LOGDIR, 'keep-me.txt')), '非流水文件不碰');
  ok('聊天流水：落盘/读回/按小时均分取样/保留期清理');
}

// ── 8. 提示词 ──────────────────────────────────────────────────────────────
{
  const p = js.renderJournalPrompt({
    date: '2026-10-22',
    now: at(2026, 10, 22, 23, 31),
    digest: '09:05 群聊·甲：今天好冷\n22:30 私聊·主人：他走了',
    diaryNotes: '10月22日 普通 · 他说自己失恋过',
    writeAt: '23:30'
  });
  assert.ok(p.includes('【写日记】2026-10-22 周四 23:31'));
  assert.ok(p.includes('公开') && p.includes('私密'));
  assert.ok(p.includes('内容**不同**'), '必须强调两份不同');
  assert.ok(p.includes('===公开===') && p.includes('===私密==='), '要给固定格式');
  assert.ok(p.includes('主人永远不会看到'), '私密那份要有安全感');
  assert.ok(p.includes('不要调用任何工具'));
  assert.ok(p.includes('09:05 群聊·甲'));

  const catchup = js.renderJournalPrompt({ date: '2026-10-20', now: at(2026, 10, 22, 9, 0), catchup: true, writeAt: '23:30' });
  assert.ok(catchup.includes('【补写日记】'), '补写要有不同抬头');
  assert.ok(catchup.includes('想不起来就写得模糊一点'));
  ok('提示词把两份的定位、格式、补写语气都说清楚');
}

// ── 8. 排程状态 ────────────────────────────────────────────────────────────
{
  const file = js.journalStatePath(path.join(TMP, 'state'));
  const s1 = js.loadJournalState(file, { now: at(2026, 10, 22, 23, 31) });
  assert.equal(s1.startedOn, '2026-10-22', '首次运行记录部署日');
  assert.deepEqual(s1.attempts, {});
  s1.attempts['2026-10-22'] = { n: 1, at: at(2026, 10, 22, 23, 35) };
  js.saveJournalState(file, s1);
  const s2 = js.loadJournalState(file, { now: at(2026, 10, 23, 1, 0) });
  assert.equal(s2.startedOn, '2026-10-22', '部署日不会因为重启而变');
  assert.equal(s2.attempts['2026-10-22'].n, 1);

  // 损坏的状态文件不能把日记功能打死
  fs.writeFileSync(file, '{ broken', 'utf8');
  const s3 = js.loadJournalState(file, { now: at(2026, 10, 24, 1, 0) });
  assert.equal(s3.startedOn, '2026-10-24');
  ok('排程状态：部署日持久、损坏文件降级');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n🎉 每日日记核心测试通过（${passed} 项）`);
