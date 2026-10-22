# dsh-diary —— 日记面板（DSH 插件）

把本仓库那套日记（**每天 23:30 写的公开/私密两份 `.md`** + **会变糊的记忆**）
搬进 DSH 设置页：概览、翻看、搜索、在**指纹守卫 + 改前备份**下谨慎编辑。

> 它不是第二个写日记的东西。日记内容由宿主的专用会话写、记忆由 `mcp__diary__*` 工具写；
> 这个插件是**人看和修的那扇窗**。

## 它做什么

| 页 | 内容 |
|---|---|
| 概览 | 公开/私密各几篇、最近日期；记忆条目数、档位分布、私聊/群聊分布、搁着/模糊临存；聊天流水天数；备份份数 |
| 公开日记 | 按日期列出 → 读全文 → **改正文并保存**（带指纹守卫） |
| 私密日记 | 同上 |
| 记忆 | 按作用域筛（全部/群聊/私聊）→ 看正文（只读）→ 改「心情」和「当时没说出口的话」 |
| 搜索 | 一次搜完：日记正文 + 记忆正文/心情/没敢说的话，给带上下文的片段 |
| 备份 | 每次面板写入前的旧版都在这里，可一键恢复 |

## 写盘规矩（从 [S3K926/dsh-memory-board](https://github.com/S3K926/dsh-memory-board) 学来的内核，MIT）

```
指纹拒写 → 幂等跳过 → 内存里先校验 → 改前备份 → **写前再核一次指纹**（TOCTOU）
→ 临时文件 + rename → 写完读回复核 → 复核不过就把备份放回去
```

- **指纹** = 文件内容的 sha256 前 32 位。面板打开文章时拿到指纹，保存时回传；
  期间桥接（23:30 写日记）或 MCP 工具改过这个文件 → 指纹不匹配 → **拒写**，提示刷新。
  不用 mtime：备份工具改 mtime 但内容没变，那不该算"别人改过"。
- **改前备份**：`<root>/state/diary-backups/<相对路径>.YYYYMMDDHHmmss..bak`；插件**不会自动删**备份。
- 恢复备份同样过指纹守卫，并且会先给"当前版本"再留一份备份（所以恢复本身也可回退）。

三道闸：① 插件配置 `readOnly` 不为真 ② 请求带 `confirm=yes` ③ `Origin` 是本机面板（或缺省）。

## 装法

```powershell
# 1) 把本插件链接进 desktop profile（junction）、登记依赖与 bundle、写入本机 root
node scripts/install-diary-plugin.mjs

# 2) 完全退出 DSH 再打开（client 半要重新打包加载）
```

装完在 **设置 → 日记** 里。插件配置里可以覆盖：

```yaml
- id: dsh-diary
  name: 'dsh-diary'
  config:
    root: '<数据根>'          # 数据根：日记文件所在，也是面板允许写的那棵子树
    project: '<项目根>' # 项目根：config.json 与 state/ 所在
    readOnly: false              # true = 面板只读
```

## 两个根：数据根 / 项目根

| | 是什么 | 校验（特征） | 缺省 |
|---|---|---|---|
| `root` | 日记文件所在，也是**写操作允许的范围**（越界一律拒绝） | 含 `日记/` 与 `日记-私密/`，或本身是项目根 | = project |
| `project` | `config.json` 与 `state/`（记忆 JSON、聊天流水、备份）所在 | 含 `config.json` + `src/diary-core.js` | = root |

分开是为了这种布局：**日记放在大目录里，配置和状态在子项目里**。例如本机就是
`root = <数据根>`、`project = <项目根>`——面板只管 `<数据根>` 这棵树，
但其实只读写 `日记/`、`日记-私密/` 和 `qqbot/state/` 这几处。

**不想改配置也行**：面板「概览 → 位置（作用范围）」里直接填两个路径，点「切换到这个范围」，
会写进 `~/.dsh/diary-panel.json`（机器本地，不进 profile patch）。改错了再填回原值即可。

认根顺序：**面板记下的位置 → config → 环境变量（`DSH_DIARY_ROOT` / `DSH_DIARY_PROJECT`）→ 从 cwd 往上找**。
每一级都要过特征校验；全都不过就报错让人手填，**绝不猜一个目录去写**。

## 路由（`/api/diary/*`）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/info` | 认到的 root/project（含试过哪些路径、各缺什么） |
| POST | `/scope` | `{root,project,confirm}` 换作用范围（写面板状态文件） |
| GET | `/overview` | 概览 |
| GET | `/journals?kind=public\|private&limit=` | 日记目录 |
| GET | `/journal?kind=&date=` | 单篇全文 + 指纹 |
| POST | `/journal` | `{kind,date,text,expect,confirm}` 改正文 |
| GET | `/memory?scope=all\|group\|private&limit=` | 记忆条目 |
| GET | `/entry?id=&scope=` | 单条记忆 + 记忆文件指纹 |
| POST | `/entry` | `{id,mood,unsaid,expect,confirm}` 改心情/没敢说的话 |
| GET | `/search?q=&limit=&days=` | 全库搜索 |
| GET | `/backups?limit=` | 备份列表 |
| POST | `/restore` | `{name,expect,confirm}` 从备份恢复 |

## 自检

```powershell
node plugins/dsh-diary/index.js --selftest
```

在一个临时目录里铺一份最小日记项目，把读、写、缺 confirm、外站 Origin、指纹过期、
备份、恢复、作用域过滤、搜索全跑一遍（23 项）。不依赖 DSH、不碰真实日记。

## 已知边界

- 面板**不能新建日记、不能删日记、不能改记忆正文**。日记该由她在 23:30 写；
  记忆的正文改动会破坏「会变糊、会遗忘」那条线。
- 桥接和面板同时写同一个文件时，靠指纹 + 写前复核避免互相覆盖；**没有文件锁**——
  极端情况下（两边在微秒级同时写）仍可能有一方收到 `changed-since-read` 而失败，刷新重试即可。
- 本插件只读/写 **文件**；它不替代 MCP 工具，也不参与每轮提示词注入。

## 许可

MIT。写盘内核与「认根只认特征文件」「写操作三关」的设计来自 **S3K926/dsh-memory-board**（MIT），
本仓库按自己的文件布局做了移植与裁剪，上面已注明。
