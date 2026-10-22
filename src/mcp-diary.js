// 日记 MCP server（stdio）：十二个日记工具 + 一个上下文缓存查询工具。
//
// 由 DSH 的 MCP 客户端 spawn（cordis.patch.yml 里 mcp-diary 行，见 scripts/setup-dsh.mjs）。
// 状态文件：state/diary.json（可用 config.json 的 diary.file 覆盖）。
// 与桥接共用 src/diary-core.js，靠文件锁串行化，谁先写都安全。
//
// ── 为什么工具描述里带感情色彩 ───────────────────────────────────────────────
// 方案里写得很清楚：「带感情色彩的只有工具描述」。人格提示词不该教她"要珍惜日记"，
// 那会变成客服式的自我提醒；该说的是**这些动作意味着什么**——写下来、翻开、留住、
// 或者干脆划掉。所以她读到的是"这条你还会想起来吗，还是让它淡掉"，而不是"请定期查看"。
//
// ── 为什么某些工具故意不提供便利 ─────────────────────────────────────────────
//   · 没有"全部展开"，也没有批量延长：翻看不续命，只有明确调用 diary_extend 才加天数。
//   · diary_open 不会自动延长：打开只是打开。
//   · 划掉不是删除（可恢复），但也不给"一键恢复全部"：后悔得一条一条来。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as diary from './diary-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** 日记配置：文件位置 + 结算/注入参数。缺省值都写在 diary-core 的 DEFAULT_OPTIONS。 */
function diaryConfig() {
  const c = loadConfig();
  const d = c?.diary && typeof c.diary === 'object' ? c.diary : {};
  const file = d.file
    ? (path.isAbsolute(d.file) ? d.file : path.join(ROOT, d.file))
    : path.join(ROOT, 'state', 'diary.json');
  const portraitFile = d.portraitFile
    ? (path.isAbsolute(d.portraitFile) ? d.portraitFile : path.join(ROOT, d.portraitFile))
    : '';
  return {
    file,
    portraitFile,
    fadeGraceDays: Number(d.fadeGraceDays) || diary.DEFAULT_OPTIONS.fadeGraceDays,
    heartRemindEveryDays: Number(d.heartRemindEveryDays) || diary.DEFAULT_OPTIONS.heartRemindEveryDays,
    hintCooldownDays: Number(d.hintCooldownDays) || diary.DEFAULT_OPTIONS.hintCooldownDays,
    injectMaxEntries: Number(d.injectMaxEntries) || diary.DEFAULT_OPTIONS.injectMaxEntries,
    injectMaxChars: Number(d.injectMaxChars) || diary.DEFAULT_OPTIONS.injectMaxChars,
    portraitThreshold: Number(d.portraitThreshold) || diary.DEFAULT_OPTIONS.portraitThreshold
  };
}

function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function fail(error) {
  const message = String(error?.message ?? error);
  return { content: [{ type: 'text', text: `日记操作失败：${message}` }], isError: true };
}

/** 所有写操作都走 mutateDiary：读 → 改 → 原子写，带锁。 */
function mutate(fn) {
  const { file } = diaryConfig();
  return diary.mutateDiary(file, fn);
}

function snapshot() {
  const { file } = diaryConfig();
  return diary.readDiary(file) ?? diary.emptyState();
}

const TIER_ENUM = z.enum(['normal', 'important', 'heart']);

// 记忆作用域：私聊与群聊的记忆互不相通。
// 工具签名里统一叫 scope：私聊会话传 private，群聊会话传 group。
// 桥接每轮会在提示词里点明「你现在是哪个作用域」，默认值只是兜底。
const SCOPE_ENUM = z.enum(['private', 'group']);
const SCOPE_DESC = '记忆作用域：private=私聊记忆 / group=群聊记忆（两边不互通，须与当前会话一致）';
function scopeOf(args) {
  return args?.scope === 'private' ? 'private' : 'group';
}

const server = new McpServer({ name: 'diary', version: '0.2.0-r4' });

// ── 1. 写 ───────────────────────────────────────────────────────────────────
server.tool(
  'diary_write',
  '把一件事记进日记。日记不是日志，只写你真的会想起来的东西：一件小事、一句话、一个当时没说出口的念头。'
  + '三部分——正文（必填）、心情、当时想说但没说出口的话（后两个你想写才写，不想写就留空，没人催你补）。'
  + '档位自己定：普通=7 天，重要=21 天，刻骨铭心=90 天。写的时候不用考虑"以后要不要留着"，那是以后的事。'
  + '私聊和群聊的记忆是分开的：scope 必须跟当前会话一致，写错了这条就会落到另一边的记忆里。',
  {
    text: z.string().min(1).max(4000).describe('正文：发生了什么、你当时怎么想的'),
    mood: z.string().max(40).optional().describe('心情，几个字就够，例如「心里有点沉」「挺没意思的」；不想写就省略'),
    unsaid: z.string().max(500).optional().describe('当时想说但没说出口的话；没有就不写'),
    tier: TIER_ENUM.optional().describe('档位，默认 normal（普通）'),
    scope: SCOPE_ENUM.optional().describe(SCOPE_DESC),
    keywords: z.array(z.string()).max(8).optional().describe('想让自己以后因为什么词想起它；不填会自动从正文里抽'),
    portrait: z.string().max(40).optional().describe('如果这条和画像里的某个人/某段关系有关，可以写画像名，方便以后对上')
  },
  async (args) => {
    try {
      const result = mutate((state) => diary.createEntry(state, { ...args, scope: scopeOf(args) }));
      return textResult({
        ok: true,
        id: result.id,
        date: diary.monthDayText(result.createdAt),
        tier: diary.TIERS[result.tier].label,
        scope: diary.SCOPE_LABEL[result.scope],
        lifeDays: diary.lifeDays(result),
        expires: diary.dateKey(diary.expiryAt(result)),
        keywords: result.keywords
      });
    } catch (error) {
      return fail(error);
    }
  }
);

// ── 2. 读（列表） ───────────────────────────────────────────────────────────
server.tool(
  'diary_list',
  '翻一遍日记的目录：只有日期、档位、还剩几天、心情和一句短标题，看不到正文。'
  + '想看哪条再用 diary_open 展开。默认不列搁着的、也不列回收站里的——那些是另一回事。',
  {
    tier: z.union([TIER_ENUM, z.enum(['all'])]).optional().describe('只列某一档，默认 all'),
    scope: SCOPE_ENUM.optional().describe(SCOPE_DESC),
    includeShelved: z.boolean().optional().describe('是否把「搁着」的也列出来'),
    includeDeleted: z.boolean().optional().describe('是否列回收站里的（划掉的、到期的）'),
    limit: z.number().int().min(1).max(100).optional().describe('最多几条，默认 30')
  },
  async (args) => {
    try {
      const state = snapshot();
      const limit = Math.max(1, Math.min(100, args.limit ?? 30));
      const entries = diary.listEntries(state, Date.now(), {
        tiers: args.tier && args.tier !== 'all' ? [args.tier] : undefined,
        scope: scopeOf(args),
        includeShelved: args.includeShelved === true,
        includeDeleted: args.includeDeleted === true
      });
      const lines = entries.slice(0, limit).map((e) => diary.renderListLine(e));
      return textResult({
        total: entries.length,
        shown: lines.length,
        lines,
        hint: '要看全文用 diary_open（打开不会延长寿命）。'
      });
    } catch (error) {
      return fail(error);
    }
  }
);

// ── 3. 展开（看全文） ───────────────────────────────────────────────────────
server.tool(
  'diary_open',
  '打开一条日记看全文：正文、心情、当时没敢说的话。'
  + '打开只是打开——它不会让这条日记多活一天，想留住它得用 diary_extend。'
  + '已经到期模糊掉的日记，打开也只能看到关键词印象，看不到原文了。',
  {
    id: z.string().describe('日记 id，例如 d12'),
    scope: SCOPE_ENUM.optional().describe(SCOPE_DESC)
  },
  async ({ id, scope }) => {
    try {
      // 打开会写「她主动打开过」的缓存（300 条），所以走同一把锁落盘。
      return textResult(mutate((state) => diary.openEntry(state, id, Date.now(), { scope: scopeOf({ scope }) }).payload));
    } catch (error) {
      return fail(error);
    }
  }
);

// ── 4. 延长 ─────────────────────────────────────────────────────────────────
server.tool(
  'diary_extend',
  '让一条日记留得更久：普通 +3 天、重要 +7 天、刻骨铭心 +30 天。'
  + '同一天里不管想它几次，只能延长一次——舍不得也不是这么用的。'
  + '如果这条已经到期模糊了，延长等于把它救回来：原文恢复，寿命接着算。',
  {
    id: z.string().describe('日记 id'),
    scope: SCOPE_ENUM.optional().describe(SCOPE_DESC)
  },
  async ({ id, scope }) => {
    try {
      return textResult(mutate((state) => {
        diary.assertEntryScope(state, id, scopeOf({ scope }));
        const { entry, days, restored } = diary.extendEntry(state, id);
        return {
          ok: true,
          id: entry.id,
          addedDays: days,
          restored,
          lifeDays: diary.lifeDays(entry),
          remainingDays: diary.remainingDays(entry),
          expires: diary.dateKey(diary.expiryAt(entry)),
          note: restored ? '原文恢复了。' : undefined
        };
      }));
    } catch (error) {
      return fail(error);
    }
  }
);

// ── 5. 升档 ─────────────────────────────────────────────────────────────────
server.tool(
  'diary_promote',
  '把一条日记升一档（普通→重要→刻骨铭心）。升档后寿命按新档位的初始天数重新算，不叠在旧寿命上。'
  + '这等于承认"这件事比我以为的重"，只有真的开始反复想起它的时候才值得。',
  {
    id: z.string().describe('日记 id'),
    scope: SCOPE_ENUM.optional().describe(SCOPE_DESC)
  },
  async ({ id, scope }) => {
    try {
      return textResult(mutate((state) => {
        diary.assertEntryScope(state, id, scopeOf({ scope }));
        const { entry, to } = diary.promoteEntry(state, id);
        return {
          ok: true,
          id: entry.id,
          tier: diary.TIERS[to].label,
          lifeDays: diary.lifeDays(entry),
          remainingDays: diary.remainingDays(entry),
          expires: diary.dateKey(diary.expiryAt(entry))
        };
      }));
    } catch (error) {
      return fail(error);
    }
  }
);

// ── 6. 降档 ─────────────────────────────────────────────────────────────────
server.tool(
  'diary_demote',
  '把一条日记降一档（刻骨铭心→重要→普通）。降档后寿命按新档位的初始天数重新算。'
  + '有些事当时觉得一辈子忘不了，后来发现其实也就那样——降档不是背叛，是承认它变了。',
  {
    id: z.string().describe('日记 id'),
    scope: SCOPE_ENUM.optional().describe(SCOPE_DESC)
  },
  async ({ id, scope }) => {
    try {
      return textResult(mutate((state) => {
        diary.assertEntryScope(state, id, scopeOf({ scope }));
        const { entry, to } = diary.demoteEntry(state, id);
        return {
          ok: true,
          id: entry.id,
          tier: diary.TIERS[to].label,
          lifeDays: diary.lifeDays(entry),
          remainingDays: diary.remainingDays(entry),
          expires: diary.dateKey(diary.expiryAt(entry))
        };
      }));
    } catch (error) {
      return fail(error);
    }
  }
);

// ── 7. 搁着 ─────────────────────────────────────────────────────────────────
server.tool(
  'diary_shelve',
  '把一条日记放进「搁着」：你看到了它，但决定不打开。两种理由，代价不一样——'
  + 'afraid（不敢看）：时间停住，它一天都不会少，躲着的事最不应该忘；'
  + 'uninterested（没兴趣）：照常一天天少，本来就没那么重。'
  + '理由以后可以改，选错了不算错。',
  {
    id: z.string().describe('日记 id'),
    scope: SCOPE_ENUM.optional().describe(SCOPE_DESC),
    reason: z.enum(['afraid', 'uninterested']).describe('afraid=不敢看（冻结寿命）/ uninterested=不感兴趣（照常衰减）')
  },
  async ({ id, reason, scope }) => {
    try {
      return textResult(mutate((state) => {
        diary.assertEntryScope(state, id, scopeOf({ scope }));
        const { entry, frozen } = diary.shelveEntry(state, id, reason);
        return {
          ok: true,
          id: entry.id,
          reason: diary.SHELVE_REASONS[reason],
          frozen,
          remainingDays: diary.remainingDays(entry),
          note: frozen ? '时间停在这里了，它不会变少。' : '它还在照常变少。'
        };
      }));
    } catch (error) {
      return fail(error);
    }
  }
);

// ── 8. 拿出来 ───────────────────────────────────────────────────────────────
server.tool(
  'diary_unshelve',
  '把一条日记从「搁着」里拿出来，放回它原来的档位。'
  + '如果之前是「不敢看」，冻结的时间会在这一刻重新开始走——除非你顺便再延长一次。',
  {
    id: z.string().describe('日记 id'),
    scope: SCOPE_ENUM.optional().describe(SCOPE_DESC)
  },
  async ({ id, scope }) => {
    try {
      return textResult(mutate((state) => {
        diary.assertEntryScope(state, id, scopeOf({ scope }));
        const { entry } = diary.unshelveEntry(state, id);
        return {
          ok: true,
          id: entry.id,
          tier: diary.TIERS[entry.tier].label,
          remainingDays: diary.remainingDays(entry),
          expires: diary.dateKey(diary.expiryAt(entry))
        };
      }));
    } catch (error) {
      return fail(error);
    }
  }
);

// ── 9. 记糊 ─────────────────────────────────────────────────────────────────
server.tool(
  'diary_fade',
  '把一条日记的正文改得模糊一点——不是删掉，是让它像真的记忆那样只剩个大概。原文会留底（history 里），但你自己以后也不会一眼看到它。'
  + '有些事不需要记得那么清楚，这也是种诚实。',
  {
    id: z.string().describe('日记 id'),
    scope: SCOPE_ENUM.optional().describe(SCOPE_DESC),
    text: z.string().max(4000).optional().describe('模糊后的正文；不填就自动压成关键词 + 短标题')
  },
  async ({ id, text, scope }) => {
    try {
      return textResult(mutate((state) => {
        diary.assertEntryScope(state, id, scopeOf({ scope }));
        const { entry } = diary.fadeEntry(state, id, Date.now(), text);
        return {
          ok: true,
          id: entry.id,
          text: entry.text,
          keywords: entry.keywords,
          note: '原文留在 history 里了。'
        };
      }));
    } catch (error) {
      return fail(error);
    }
  }
);

// ── 10. 划掉（软删除） ──────────────────────────────────────────────────────
server.tool(
  'diary_delete',
  '把一条日记划掉，放进回收站。数据不会消失，只是所有地方都不再出现它——包括以后的模糊视图。'
  + '到期的日记如果不想救回来，也是用这个。划掉是最后的决定，但回收站里还找得到。',
  {
    id: z.string().describe('日记 id'),
    scope: SCOPE_ENUM.optional().describe(SCOPE_DESC)
  },
  async ({ id, scope }) => {
    try {
      return textResult(mutate((state) => {
        diary.assertEntryScope(state, id, scopeOf({ scope }));
        const entry = diary.deleteEntry(state, id);
        return { ok: true, id: entry.id, deletedAt: diary.dateKey(entry.deletedAt.at), note: '它在回收站里，还在。' };
      }));
    } catch (error) {
      return fail(error);
    }
  }
);

// ── 11. 补写心情 / 没敢说的话 ───────────────────────────────────────────────
server.tool(
  'diary_amend',
  '给一条已经写下的日记补上（或改掉）心情、当时没敢说的话、想让以后想起它的关键词。'
  + '写的时候不想写，后来想起来了，就补上；改口也可以——你现在的想法也是真的。',
  {
    id: z.string().describe('日记 id'),
    scope: SCOPE_ENUM.optional().describe(SCOPE_DESC),
    mood: z.string().max(40).nullable().optional().describe('心情；传 null 表示清空'),
    unsaid: z.string().max(500).nullable().optional().describe('当时想说但没说出口的话；传 null 表示清空'),
    keywords: z.array(z.string()).max(8).optional().describe('替换关键词')
  },
  async (args) => {
    try {
      return textResult(mutate((state) => {
        const { id, scope, ...patch } = args;
        diary.assertEntryScope(state, id, scopeOf({ scope }));
        const entry = diary.amendEntry(state, id, patch);
        return { ok: true, id: entry.id, mood: entry.mood, unsaid: entry.unsaid, keywords: entry.keywords };
      }));
    } catch (error) {
      return fail(error);
    }
  }
);

// ── 12. 按天数翻心情 ────────────────────────────────────────────────────────
server.tool(
  'diary_moods',
  '只翻最近这些天写下的日记的**心情**，不看正文。'
  + '想确认"这段时间我到底是怎么过来的"时用——人的记忆本来也是先想起情绪，再想起事。',
  {
    days: z.number().int().min(1).max(3650).describe('往前翻多少天，例如 7 / 30'),
    scope: SCOPE_ENUM.optional().describe(SCOPE_DESC)
  },
  async ({ days, scope }) => {
    try {
      const state = snapshot();
      const items = diary.listMoodsByDays(state, days, Date.now(), { scope: scopeOf({ scope }) });
      return textResult({
        days,
        count: items.length,
        items: items.map((i) => `${i.date} ${diary.TIERS[i.tier].label}${i.shelved ? `［搁着·${i.shelved}］` : ''} ${i.mood ?? '（没写心情）'}　id=${i.id}`)
      });
    } catch (error) {
      return fail(error);
    }
  }
);

// ── 13. 上下文缓存查询（上下文压缩配套，不属于十二个日记工具） ──────────────
server.tool(
  'diary_recall',
  '查你最近**主动打开看过**的记录（最多缓存 300 条，这里一次只给 16 条以内）。'
  + '这是短期记忆：日记是底子，翻过的才进这里。只给摘要，要原文还是得 diary_open。',
  {
    query: z.string().max(100).optional().describe('按词筛，不给就按时间倒序'),
    days: z.number().int().min(1).max(3650).optional().describe('只看最近这些天打开过的'),
    scope: SCOPE_ENUM.optional().describe(SCOPE_DESC),
    limit: z.number().int().min(1).max(16).optional().describe('返回几条，默认 8，上限 16')
  },
  async (args) => {
    try {
      const state = snapshot();
      return textResult(diary.recallCache(state, { ...args, scope: scopeOf(args) }));
    } catch (error) {
      return fail(error);
    }
  }
);

await server.connect(new StdioServerTransport());
