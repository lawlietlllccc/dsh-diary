# 接进你自己的宿主：调度与落盘

本仓库提供**内核**（记忆、日记本、工具），不提供「每天 23:30 触发」的那一层。
这一页说明宿主需要做哪几件事，以及每件事用哪个函数。

下面的代码是**示意**：变量名对应本仓库导出名，替换成你宿主的会话/日志设施即可。

## 1. 收消息时：写当天流水

每一行是一条消息。缺了这一步，日记就只剩「社交窗口里最后那点消息」。

```js
import { appendChatLog, dateKey } from './src/journal-store.js';

// 入站消息
appendChatLog('state/chat-log', dateKey(Date.now()), {
  t: Date.now(),
  k: 'group:123456',        // 会话标识：group:<群号> / private:<QQ号>
  s: sender,                // 发言人昵称
  x: text                   // 正文（纯文本，图片可记成 [图片]）
});

// 她自己发出去的也要记（这样日记里能写「我回了一句…」）
appendChatLog('state/chat-log', dateKey(Date.now()), {
  t: Date.now(), k: key, s: '我', x: text
});
```

单日约 6000 条上限；`pruneChatLogs(dir, { keepDays })` 清过期文件。

## 2. 每分钟：看有没有该写的

```js
import { dueDates, readChatLog, buildDayDigest } from './src/journal-store.js';

const dates = dueDates({
  now: new Date(),
  dirs: [publicDir, privateDir],
  catchupDays: 7,
  startedOn,                     // 首次运行那天，别给过去编日记
  writeAt: '23:30'
});
if (!dates.length) return;

const date = dates[0];           // 从老到新，每次只写一天
const rows = readChatLog(logDir, date);
const { text, hours, total, sampled } = buildDayDigest(rows, {
  maxChars: 8000, perHour: 6
});
```

`buildDayDigest` 返回的 `text` 就是给模型的素材，形如：

```
09:05 群聊·群友甲：早，今天又是被闹钟骗起来的一天
14:49 群聊·群友乙：老板又改需求了，第三次了
21:30 群聊·群友乙：晚安
```

## 3. 让模型写两段，然后落盘

提示词自己拼即可，关键是**两段格式固定**、并明确「两份内容不同」：

```
写两份，内容不同：
1）公开：愿意让主人看到的一天。
2）私密：只给自己看的部分，可以很短、可以不体面。

只输出下面两段，不要任何解释：
===公开===
（正文）
===私密===
（正文）
```

回收模型输出后：

```js
import { parseJournalOutput, writeJournal, hasJournal } from './src/journal-store.js';

const parsed = parseJournalOutput(raw);
if (!parsed.ok) throw new Error('不是两段，重试');
if (!hasJournal(publicDir, date)) {
  writeJournal(publicDir, date, parsed.public, { kind: 'public', backupDir });
}
if (!hasJournal(privateDir, date)) {
  writeJournal(privateDir, date, parsed.private, { kind: 'private', backupDir });
}
```

`writeJournal` 默认**不覆盖**已存在的日记；确实要重写才传 `overwrite: true`（会先备份）。

## 4. 每轮对话：注入模糊视图

```js
import { readDiary, buildFuzzyBlock, matchByKeywords, mutateDiary } from './src/diary-core.js';

const state = readDiary('state/diary.json');
const scope = key.startsWith('private:') ? 'private' : 'group';
const hit = matchByKeywords(state, recentChatText, Date.now(), { scope });
const block = buildFuzzyBlock(state, {
  now: Date.now(), scope,
  matchedIds: hit.ids, matchedWords: hit.words,
  maxEntries: 10, maxChars: 1200
});
// 把 block 拼进系统提示词；没有内容时它返回空串
```

**别每轮都读全文**：模糊视图是这套设计的核心，正文只能由 `diary_open` 主动展开。

## 5. 每天一次：记忆结算

```js
import { mutateDiary, runSettle, readPortraits } from './src/diary-core.js';

mutateDiary('state/diary.json', (state) => runSettle(state, {
  now: new Date(),
  options: { fadeGraceDays: 3, heartRemindEveryDays: 7, hintCooldownDays: 3 },
  portraits: readPortraits('state/portraits.json')   // 可选的画像联动
}));
```

结果写进 `state.settle.pending[scope]`，下一轮对话开头展示一次（只报事实，不催）。
按作用域分开：群聊的清单里不会出现私聊的条目。

## 6. 并发与一致性

`diary.json` 由宿主、MCP 工具、面板三方共写：

- 程序内写：`mutateDiary()` 带文件锁（`diary.json.lock`，10 秒超时接管）+ 原子写，每次落盘留 `diary.json.bak`。
- 面板写：乐观并发——带指纹（内容 sha256 前 32 位），不一致就拒写。
- 两边都不会「覆盖掉不知道的新版本」；读坏文件时 `loadDiary` 抛错而不是回空，避免一次读失败把整本日记写成空。

## 7. 工具面（可选）

如果你的宿主支持 MCP，直接把 `src/mcp-diary.js` 当 stdio server 挂上即可，12 个工具的方法名与语义见
[`../docs/DIARY.md`](../docs/DIARY.md)。
