# 日记（dsh-diary）

> 日记不是日志。**一份写给别人看，一份只写给自己；记性会变糊、会淡忘，也会因为被反复想起而留得更久。**

这是一个跑在 [DeepSeek Harness](https://github.com/) 上的日记系统，由四部分组成：

| 组成 | 路径 | 作用 |
|---|---|---|
| **记忆内核** | `src/diary-core.js` | 三档寿命、搁着冻结、记糊、回收站、模糊视图、结算、300 条缓存 |
| **日记本内核** | `src/journal-store.js` | 每天写两份 `.md`（公开 / 私密）、全天聊天流水、按小时取样 |
| **工具面** | `src/mcp-diary.js` | MCP stdio 服务：12 个 `diary_*` 工具 + 缓存查询 `diary_recall` |
| **面板插件** | `plugins/dsh-diary/` | DSH 设置页「日记」：概览 / 翻看 / 搜索 / 谨慎编辑 / 备份恢复 |

「记忆」和「日记本」是两套东西：**记忆是会遗忘的记性**（会注入到每轮对话），
**日记本是纸**（每天两份文件，写完就一直留着）。

---

## 它和别的日记插件有什么不一样

1. **日记会自己变糊。** 每轮只给一段「模糊视图」——心情 + 一句短标题，正文要本人主动展开。
   剩余寿命越短给的信息越少：>50% 给心情+标题，20–50% 只给心情，<20% 只剩日期。
2. **翻看不会续命。** 只有明确的「延长」才加天数，同一天只算一次。
   这是为了模仿人：你反复想起一件事，不代表它会永远记得；但你真的舍不得，就会主动留。
3. **搁着分两种代价。** 选「不敢看」→ 冻结计时，一天都不会少；选「没兴趣」→ 照常衰减。
   理由随时能改——选错了不算错。
4. **到期不直接删。** 先模糊成关键词、临存几天，再决定恢复 / 划掉 / 不管；划掉也只是进回收站。
5. **记忆分两边。** 私聊与群聊各有一套记忆，互不相通；只有写日记那一刻两边会合。
6. **每天两份文件，内容不同。** 公开那份愿意给人看，私密那份只给自己。
7. **写日记的素材覆盖一整天。** 不是「取最后 N 行」，而是按小时分桶均匀取样——
   哪怕一天两千多条，早上说的话也一定在。

## 三档寿命

| 档位 | 初始 | 延长一次 | 升档提示 | 降档提示 | 到期提醒频率 |
|---|---|---|---|---|---|
| 普通 | 7 天 | +3 天 | 寿命 > 13 天 | — | 1 天一次 |
| 重要 | 21 天 | +7 天 | 寿命 > 60 天 | 剩余 < 10 天 | 3 天一次 |
| 刻骨铭心 | 90 天 | +30 天 | — | 剩余 < 30 天 | 7 天一次 |

四条硬规则：寿命从写下那天算**绝对时长**；翻看不续命；同一天只算一次延长；
升/降档按**新档位的初始寿命重算**，不在旧寿命上叠加。

## 十二个工具

`diary_write`（写）· `diary_list`（目录）· `diary_open`（展开）· `diary_extend`（延长）
· `diary_promote`（升档）· `diary_demote`（降档）· `diary_shelve`（搁着）· `diary_unshelve`（拿出来）
· `diary_fade`（记糊）· `diary_delete`（划掉）· `diary_amend`（补写心情/没敢说的话）· `diary_moods`（按天数翻心情）

外加 `diary_recall`（上下文压缩配套：最近主动打开过的 300 条，一次最多查 16 条）。

工具描述里放的是**这些动作意味着什么**，而不是 API 文档：

> 「同一天里不管想它几次，只能延长一次——舍不得也不是这么用的。」

---

## 快速开始

### 1. 装上 MCP 工具（让 AI 能读写记忆）

```bash
npm install
node src/mcp-diary.js        # 标准 MCP stdio 服务，交给 DSH 的 MCP 客户端拉起
```

在 DSH 的 profile patch 里加一行：

```yaml
- insert:
    - id: mcp-diary
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: diary
        transport: stdio
        command: 'node'
        args: ['<仓库路径>/src/mcp-diary.js']
```

工具名会变成 `mcp__diary__diary_write` 这种形式。

### 2. 装面板插件（在设置页里看和修）

```bash
node scripts/install-diary-plugin.mjs desktop   # 幂等；装完完全退出 DSH 再打开
```

打开后在 **设置 → 日记**。插件配置可以指定它管哪些目录：

```yaml
- id: dsh-diary
  name: 'dsh-diary'
  config:
    root: 'D:\我的日记'        # 数据根：日记文件所在，也是面板允许写的那棵子树
    project: 'D:\我的项目'     # 项目根：config.json 与 state/ 所在
    readOnly: false
```

### 3. 跑测试

```bash
npm test                                  # 记忆内核 18 组 + 日记本内核 9 组
node plugins/dsh-diary/index.js --selftest # 面板插件自检 26 项（临时目录，不碰真实数据）
```

都不需要 DSH、不需要网络、不需要真实日记。

---

## 每天 23:30 的两份日记

```
<数据根>/日记/2026-10-23.md
<数据根>/日记-私密/2026-10-23.md
```

公开那份的正文长这样（真实输出，已脱敏）：

> 早上群友乙的耳机到了，竹林鸟烛龙，他说蹲了半个月……五百八，比原价便宜一百。
> 中午开始大家聊吃的……
> 到下午，群友乙说老板第三次改需求了……
> 傍晚下雨，路上全堵。晚上说好一起打的，人到齐了又因为这局输了互相怪。

写作**需要一个宿主来调度**（本仓库提供被调用的内核，不含具体宿主）：
宿主每天到点 → 取当天聊天流水、按小时取样 → 让模型写两段 → 落盘。
接入方式与最小示例见 [`docs/INTEGRATION.md`](docs/INTEGRATION.md)。

关键细节：

- **流水**：`state/chat-log/YYYY-MM-DD.jsonl`，一条消息一行，自己说的话也记（`s:"我"`）；
  默认保留 10 天（`logRetentionDays`）。
- **取样**：按小时分桶，每桶取首/尾/中间几行；预算不够整体降采样（6→4→3→2→1），
  **绝不靠丢掉前面的小时来省字数**。
- **不加盖**：已经写过的日期不会重写；只有缺一份时才补那一份。
- **补写**：关机错过的日期，开机后按 `catchupDays`（默认 7 天）往回补，每次只补一天。
- **不编历史**：`startedOn` 记着部署日，不会给安装之前的日子凭空写日记。

## 窗口 / 注入长什么样

每轮给 AI 看到的是这样一小块（没有正文）：

```
【日记·作用域】群聊（调 diary_* 工具时 scope=group；私聊与群聊的记忆互不相通，也不该互相提起）

【日记·模糊印象】聊到「失联」的时候，这几条忽然冒了出来——你只记得个大概，看不到原文：
【刻骨铭心】10月18日 · 心里有点沉　他说自己失恋过　id=d3
【重要】10月20日 · 有点烦　id=d7
（想看哪条就用 diary_open 展开；不打开就一直是这个样子。展开不算留住。）
```

## 命令与配置

`config.json`（宿主用，本仓库只给示例 `config.example.json`）：

```json
{
  "diary": {
    "enabled": true,
    "settleAt": "23:30",
    "fadeGraceDays": 3,
    "heartRemindEveryDays": 7,
    "injectMaxEntries": 10,
    "injectMaxChars": 1200,
    "portraitThreshold": 80
  },
  "journal": {
    "enabled": true,
    "publicDir": "D:\\我的日记\\日记",
    "privateDir": "D:\\我的日记\\日记-私密",
    "writeAt": "23:30",
    "catchupDays": 7,
    "logRetentionDays": 10,
    "digestPerHour": 6,
    "maxDigestChars": 8000
  }
}
```

## 目录结构

```
.
├── src/
│   ├── diary-core.js       记忆内核（寿命/遗忘/搁着/回收站/模糊视图/结算/缓存）
│   ├── journal-store.js    日记本内核（两份文件/流水/取样/补写窗口）
│   └── mcp-diary.js        MCP stdio 服务（12 个工具 + diary_recall）
├── plugins/dsh-diary/      面板插件（host 路由 + 客户端设置页）
│   ├── index.js            host：注册 /api/diary/*
│   ├── client.js           设置页「日记」
│   └── lib/{guards,paths,data,write,router,selftest}.js
├── scripts/
│   ├── install-diary-plugin.mjs   幂等安装到 DSH profile
│   ├── test-diary.mjs             记忆内核测试
│   └── test-journal.mjs           日记本内核测试
├── docs/
│   ├── DIARY.md             记忆系统完整设计（寿命/结算/作用域/缓存）
│   ├── JOURNAL.md           每日两份日记完整设计（流水/取样/补写）
│   └── INTEGRATION.md       怎么接进你自己的宿主（调度与落盘）
├── config.example.json
└── package.json
```

## 隐私与安全

- **本仓库不含任何真实日记数据。** 真实数据在 `state/`、`日记/`、`日记-私密/`，都在 `.gitignore` 里。
- 插件只读写你配置的两个根目录下的文件，**越界一律拒绝**。
- 面板的写操作有三道闸：配置 `readOnly` 不为真、请求带 `confirm=yes`、`Origin` 是本机面板。
- 写盘一律「指纹拒写 → 改前备份 → 原子写 → 写完复核」：
  这期间别人（比如自动写日记的进程）改过这个文件 → **拒绝写入**，而不是覆盖。
- 备份在 `state/diary-backups/`，**不会自动删**（那是使用者的东西）。

## 与 dsh-memory-board 的关系

面板的写盘内核（指纹拒写、TOCTOU 复检、改前备份、写完复核）与「认根只认特征文件」
「写操作三关」的设计来自 **[S3K926/dsh-memory-board](https://github.com/S3K926/dsh-memory-board)（MIT）**。
本仓库按自己的数据结构做了移植与裁剪，不是它的分支，也不共享数据格式。

## 许可

MIT。见 [LICENSE](LICENSE)。
