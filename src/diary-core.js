// 日记核心（v2 重做）：像人的记忆一样会变糊、会淡忘，也会因为被反复想起而留得更久。
//
// 设计要点（与「日记插件重做」方案一一对应）：
//
//   四个栏位   normal(普通) / important(重要) / heart(刻骨铭心) / shelved(搁着，非常规)
//   记录三件   text(正文) + mood(心情) + unsaid(当时想说但没说出口的话)
//              —— 后两件由她**自己决定写不写**，缺省就是 null，不补默认值。
//   寿命       从写下那天算**绝对时长**，不跟「最后一次想起」走；翻看不续命。
//              只有明确调用 extend 才加天数；同一天只算一次延长。
//   升降档     按新档位的初始寿命**重新算**（anchor 重置为当天），不在旧寿命上叠加。
//   搁着       afraid(不敢看) → 冻结计时，不扣寿命；uninterested(没兴趣) → 照常扣。
//              理由可随时改（再次 shelve 即覆盖），选错了不算错。
//   记糊       fade：正文改写为模糊版，原文留底到 history。
//   回收站     delete：只标 deletedAt，不删数据；所有注入与列表默认过滤。
//   到期       先模糊关键词化、临存 N 天（默认 3），期间可用 extend 恢复；
//              grace 结束仍未恢复 → 自动移入回收站（数据仍在）。
//
// 本模块**不依赖桥接**：不读 config.json、不写日志、不碰网络。
// 所有函数都显式接收 `now`，便于单测与「模拟时间快进」。
// 副作用只有 loadDiary / mutateDiary 读写 state/diary.json（带文件锁 + 原子写）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DAY_MS = 24 * 60 * 60 * 1000;

// ── 三档参数 ────────────────────────────────────────────────────────────────
//
// warnEveryDays    到期提醒频率（用 warnedAt 控制，过了几天才再报一次）
// warnRemainingDays「快到期」的判定窗口：剩余天数 <= 这个值才算快到
// promoteAfterDays 寿命超过多少天提示可升档
// demoteBelowDays  剩余低于多少天提示可降档（heart/normal 无降档空间）
export const TIERS = {
  normal: {
    key: 'normal', label: '普通', initialDays: 7, extendDays: 3,
    warnEveryDays: 1, warnRemainingDays: 3, promoteAfterDays: 13
  },
  important: {
    key: 'important', label: '重要', initialDays: 21, extendDays: 7,
    warnEveryDays: 3, warnRemainingDays: 7, promoteAfterDays: 60, demoteBelowDays: 10
  },
  heart: {
    key: 'heart', label: '刻骨铭心', initialDays: 90, extendDays: 30,
    warnEveryDays: 7, warnRemainingDays: 21, demoteBelowDays: 30
  }
};

export const TIER_KEYS = ['normal', 'important', 'heart'];
const TIER_RANK = { normal: 1, important: 2, heart: 3 };

// 记忆作用域：私聊与群聊的记忆**互不相通**。
// 同一个人在两个场合本来就会有两套记忆——私聊里说的话不该出现在群里的模糊视图里。
// 每天 23:30 的两份日记文件是个例外：那是她自己的日记本，两边都会写进去（见 journal-store）。
export const SCOPES = ['private', 'group'];
export const SCOPE_LABEL = { private: '私聊', group: '群聊' };

// 搁着的两种理由。afraid 冻结计时，uninterested 照常衰减。
export const SHELVE_REASONS = { afraid: '不敢看', uninterested: '没兴趣' };
export const FROZEN_REASONS = new Set(['afraid']);

export const MAX_TEXT_CHARS = 4000;
export const MAX_MOOD_CHARS = 40;
export const MAX_UNSAID_CHARS = 500;
export const MAX_ENTRIES = 2000;
export const MAX_CACHE = 300;
export const CACHE_QUERY_MAX = 16;

export const DEFAULT_OPTIONS = {
  fadeGraceDays: 3,          // 到期后模糊临存几天
  heartRemindEveryDays: 7,   // 刻骨铭心的客观提示最多几天一次
  hintCooldownDays: 3,       // 升/降档提示的冷却
  injectMaxEntries: 12,      // 每轮模糊视图最多几条
  injectMaxChars: 1400,      // 模糊视图的字符上限
  portraitThreshold: 80,     // 画像强度达到多少才算「被强化到一定程度」
  portraitFile: ''           // 空 = 不读（没有画像插件时静默跳过）
};

// ── 时间与日期工具 ──────────────────────────────────────────────────────────
// 全部按**本地日历**算：凌晨结算、同日只延长一次、warnedAt 比较都依赖本地日期。

export function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? ms : Date.now();
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 本地日期键 YYYY-MM-DD（不受 UTC 偏移影响）。 */
export function dateKey(value = Date.now()) {
  const d = new Date(toMs(value));
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function monthDayText(value = Date.now()) {
  const d = new Date(toMs(value));
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 两个时间点之间跨了几个本地日期（同一天 = 0）。 */
export function dayGap(fromValue, toValue = Date.now()) {
  const a = new Date(toMs(fromValue));
  const b = new Date(toMs(toValue));
  const aStart = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const bStart = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return Math.round((bStart - aStart) / DAY_MS);
}

// ── 正文派生字段 ────────────────────────────────────────────────────────────

/**
 * 短标题：正文第一小句，截 16 字。
 * 句读按中文习惯切（。！？；，、换行），切不出来就整段截断。
 */
export function shortTitleOf(text, limit = 16) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const first = flat.split(/[。！？!?；;，,、\n]/).map((s) => s.trim()).filter(Boolean)[0] ?? flat;
  return first.length > limit ? `${first.slice(0, limit)}…` : first;
}

/**
 * 关键词：用于模糊检索与到期模糊化。
 *
 * 显式传入的关键词优先（她说的就是最准的）；否则从正文里**粗抽中文二元组**——
 * 不做分词，但把虚词/代词/助词排除掉，这样「失恋」「奶茶」这种会反复出现的词能留下，
 * 「他说自己」「晚上风很」这种切歪的 4 字块不会污染检索（切歪的长块几乎永远不会再命中，
 * 等于关键词白存了）。
 */
export function deriveKeywords(text, explicit) {
  const given = Array.isArray(explicit)
    ? explicit.map((k) => String(k ?? '').trim()).filter((k) => k.length >= 2 && k.length <= 12)
    : [];
  if (given.length) return [...new Set(given)].slice(0, 8);

  const out = [];
  const push = (word) => {
    const w = String(word ?? '').trim();
    if (w.length < 2 || w.length > 12) return;
    if (STOPWORDS.has(w)) return;
    if (!out.includes(w)) out.push(w);
  };
  const flat = String(text ?? '');
  for (const m of flat.matchAll(/[A-Za-z][A-Za-z0-9_+.-]{1,20}/g)) push(m[0]);
  // 中文不分词：按二元组滑窗，首/尾是虚词或整词是常用词的直接丢；
  // 常见虚词词（自己/晚上/那天…）先整段遮蔽，避免在它两侧切出「己失」「天晚」这种碎块。
  for (const m of flat.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const run = m[0];
    const masked = new Array(run.length).fill(false);
    for (const word of MASK_WORDS) {
      let at = run.indexOf(word);
      while (at >= 0) {
        for (let k = at; k < at + word.length; k += 1) masked[k] = true;
        at = run.indexOf(word, at + 1);
      }
    }
    for (let i = 0; i + 2 <= run.length && out.length < 8; i += 1) {
      if (masked[i] || masked[i + 1]) continue;
      const bi = run.slice(i, i + 2);
      if (FUNCTION_CHARS.has(bi[0]) || FUNCTION_CHARS.has(bi[1])) continue;
      push(bi);
    }
  }
  return out.slice(0, 8);
}

// 出现在关键词首/尾就说明这半截是虚词，二元组没有意义（「他」「的」「了」开头/结尾）。
const FUNCTION_CHARS = new Set([...'的了过是在说他她它我你咱您都很就也又还并且但然后着地得把被给让对从向于与及或吗呢吧啊呀嘛哦哈这那哪什么怎谁个些']);

// 高频虚词整词：先遮蔽再切二元组，减少「己失/天晚/上风」这类跨词碎块。
const MASK_WORDS = ['自己', '我们', '你们', '他们', '咱们', '今天', '昨天', '明天', '那天', '这天', '晚上', '早上', '中午', '下午', '时候', '现在', '刚才', '后来', '什么', '怎么', '这个', '那个', '一个', '一下', '有点', '觉得', '好像', '其实', '然后', '因为', '所以', '但是', '还是', '可以', '不是', '没有', '已经', '东西', '事情', '地方', '感觉', '真的', '应该', '一直', '很大', '很小']; 

const STOPWORDS = new Set([
  '这个', '那个', '什么', '怎么', '就是', '其实', '然后', '因为', '所以', '但是',
  '今天', '昨天', '明天', '现在', '时候', '一个', '一下', '有点', '觉得', '知道',
  '我们', '你们', '他们', '自己', '已经', '还是', '可以', '不是', '没有', '这样',
  '东西', '事情', '地方', '感觉', '真的', '好像', '可能', '应该', '一下', '一直'
]);

/** 模糊化后的正文（到期后只保留"关键词化"的骨架，原文在 history 里）。 */
export function fuzzyTextOf(entry) {
  const title = entry?.shortTitle || shortTitleOf(entry?.text);
  const kw = Array.isArray(entry?.keywords) ? entry.keywords : [];
  // 自动抽的关键词只是检索用的坐标，不适合出现在正文里（会变成「己失、天晚」这种碎块）；
  // 只有她自己写的关键词才当作"还记得的那几个词"。
  if (entry?.keywordMode === 'explicit' && kw.length) {
    return `（模糊了）${kw.join('、')}${title ? ` · ${title}` : ''}`;
  }
  return `（模糊了）${title || '只剩下一点印象'}`;
}

// ── 状态装载 ────────────────────────────────────────────────────────────────

export function emptyState() {
  return {
    version: 2,
    seq: 0,
    entries: {},
    cache: [],
    // settle 按作用域分开：两边的结算清单不能混着给（群里的清单不该出现私聊的条目）
    settle: {
      lastRunDate: null,
      pending: { private: null, group: null },
      heartRemindedAt: { private: null, group: null },
      portraitNotified: {}
    }
  };
}

function normalizeEntry(raw, id) {
  const createdAt = toMs(raw?.createdAt);
  const tier = TIER_KEYS.includes(raw?.tier) ? raw.tier : 'normal';
  const base = TIERS[tier];
  const baseDays = Number.isFinite(raw?.baseDays) ? Number(raw.baseDays) : base.initialDays;
  const entry = {
    id: String(raw?.id ?? id),
    createdAt,
    updatedAt: toMs(raw?.updatedAt ?? createdAt),
    tier,
    baseDays,
    extendedDays: Number.isFinite(raw?.extendedDays) ? Number(raw.extendedDays) : 0,
    anchorAt: Number.isFinite(raw?.anchorAt) ? Number(raw.anchorAt) : createdAt,
    frozenMs: Number.isFinite(raw?.frozenMs) ? Number(raw.frozenMs) : 0,
    text: String(raw?.text ?? '').slice(0, MAX_TEXT_CHARS),
    mood: raw?.mood == null || raw.mood === '' ? null : String(raw.mood).slice(0, MAX_MOOD_CHARS),
    unsaid: raw?.unsaid == null || raw.unsaid === '' ? null : String(raw.unsaid).slice(0, MAX_UNSAID_CHARS),
    // 旧数据没有 scope：按群聊处理（历史上大部分条目来自群聊，且这个默认不会把私聊内容泄进群）
    scope: SCOPES.includes(raw?.scope) ? raw.scope : 'group',
    shortTitle: String(raw?.shortTitle ?? '') || shortTitleOf(raw?.text),
    keywords: Array.isArray(raw?.keywords) ? raw.keywords.map(String).slice(0, 12) : [],
    keywordMode: raw?.keywordMode === 'explicit' ? 'explicit' : 'auto',
    portrait: raw?.portrait ? String(raw.portrait) : null,
    history: Array.isArray(raw?.history)
      ? raw.history.filter((h) => h && typeof h.text === 'string').slice(-20)
        .map((h) => ({ at: toMs(h.at), text: String(h.text).slice(0, MAX_TEXT_CHARS) }))
      : [],
    extendLog: Array.isArray(raw?.extendLog)
      ? raw.extendLog.filter((x) => x && Number.isFinite(Number(x.at))).slice(-50)
        .map((x) => ({ at: Number(x.at), days: Number(x.days) || 0 }))
      : [],
    lastExtendedDate: raw?.lastExtendedDate ? String(raw.lastExtendedDate) : null,
    warnedAt: raw?.warnedAt ? String(raw.warnedAt) : null,
    promoteHintedAt: raw?.promoteHintedAt ? String(raw.promoteHintedAt) : null,
    demoteHintedAt: raw?.demoteHintedAt ? String(raw.demoteHintedAt) : null,
    shelved: raw?.shelved && SHELVE_REASONS[raw.shelved.reason]
      ? { reason: raw.shelved.reason, at: toMs(raw.shelved.at) }
      : null,
    faded: raw?.faded && Number.isFinite(Number(raw.faded.until))
      ? { at: toMs(raw.faded.at), until: Number(raw.faded.until) }
      : null,
    deletedAt: raw?.deletedAt
      ? { at: toMs(raw.deletedAt.at), reason: String(raw.deletedAt.reason ?? 'manual') }
      : null
  };
  return entry;
}

/** 把磁盘上的（可能被手改/旧版）状态整理成规范结构；坏条目丢弃而不是让整份状态炸掉。 */
export function normalizeState(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object') return state;
  const entries = raw.entries && typeof raw.entries === 'object' ? raw.entries : {};
  for (const [id, value] of Object.entries(entries)) {
    if (!value || typeof value !== 'object') continue;
    if (!String(value.text ?? '').trim()) continue;
    const entry = normalizeEntry({ ...value, id: value.id ?? id }, id);
    state.entries[entry.id] = entry;
  }
  state.seq = Number.isSafeInteger(raw.seq) ? raw.seq : Object.keys(state.entries).length;
  if (Array.isArray(raw.cache)) {
    state.cache = raw.cache
      .filter((c) => c && c.id && c.at)
      .map((c) => ({
        id: String(c.id),
        at: toMs(c.at),
        tier: TIER_KEYS.includes(c.tier) ? c.tier : 'normal',
        mood: c.mood == null ? null : String(c.mood).slice(0, MAX_MOOD_CHARS),
        head: String(c.head ?? '').slice(0, 160)
      }))
      .slice(-MAX_CACHE);
  }
  const settle = raw.settle && typeof raw.settle === 'object' ? raw.settle : {};
  const pendingOf = (scope) => {
    const value = settle.pending?.[scope];
    return value && value.text
      ? { at: toMs(value.at), text: String(value.text), deliveredAt: value.deliveredAt ? toMs(value.deliveredAt) : null }
      : null;
  };
  state.settle = {
    lastRunDate: settle.lastRunDate ? String(settle.lastRunDate) : null,
    pending: { private: pendingOf('private'), group: pendingOf('group') },
    heartRemindedAt: {
      private: settle.heartRemindedAt?.private ? toMs(settle.heartRemindedAt.private) : null,
      group: settle.heartRemindedAt?.group ? toMs(settle.heartRemindedAt.group) : null
    },
    portraitNotified: settle.portraitNotified && typeof settle.portraitNotified === 'object' ? { ...settle.portraitNotified } : {}
  };
  return state;
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy wait */ }
  }
}

function renameWithRetry(from, to, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error;
      sleepSync(30 * (i + 1));
    }
  }
  throw lastError;
}

/** 原子写 JSON：唯一临时文件 + rename 重试（Windows 上目标被占用时会 EPERM）。 */
export function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

/**
 * 读日记状态。
 * 与桥接的 sessions.json 同一条铁律：**读坏了不能静默回空**——那会在下一次写入时
 * 把整本日记覆盖掉。这里改成抛错，让调用方（工具/桥接）明确报「日记读取失败」。
 * 唯一例外是文件不存在：那是「还没开始写」，正常返回空状态。
 */
export function loadDiary(file, { now = Date.now() } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState();
    throw new Error(`日记读取失败（${file}）：${error?.message ?? error}`);
  }
  if (!String(raw).trim()) return emptyState();
  let parsed;
  try {
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (error) {
    throw new Error(`日记文件内容损坏（${file}），已停止读写以免覆盖：${error?.message ?? error}`);
  }
  const state = normalizeState(parsed);
  state.__now = toMs(now);
  return state;
}

/**
 * 落盘。原子写之前先留一份上一版 `<file>.bak`（滚动一份，覆盖前一份）。
 *
 * 为什么还要这一手：原子写只保证"不会写半个文件"，救不了"逻辑写坏了"——
 * 比如某次 bug 把 entries 清空，原子写会忠实地把这个空状态写下去。
 * 一份滚动备份足够把上一秒救回来，而且成本是一个小文件的复制。
 */
export function saveDiary(file, state) {
  const clean = { ...state };
  delete clean.__now;
  try {
    if (fs.existsSync(file) && fs.statSync(file).size < 5 * 1024 * 1024) {
      fs.copyFileSync(file, `${file}.bak`);
    }
  } catch {
    // 备份失败不能挡住保存（磁盘满/被杀软占用都不该让日记写不进去）
  }
  atomicWriteJson(file, clean);
}

/**
 * 带文件锁的读-改-写。
 * 桥接进程与 MCP 服务进程会同时碰同一份 diary.json，靠 `diary.json.lock` 串行化。
 * 锁持有者崩溃时靠 mtime 超时接管（10 秒），不会把日记永久锁死。
 */
export function mutateDiary(file, mutator, { now = Date.now(), lockTimeoutMs = 4000 } = {}) {
  const lockFile = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + lockTimeoutMs;
  let acquired = false;
  for (;;) {
    try {
      fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx', mode: 0o600 });
      acquired = true;
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const st = fs.statSync(lockFile);
        if (Date.now() - st.mtimeMs > 10000) { fs.unlinkSync(lockFile); continue; }
      } catch {}
      if (Date.now() > deadline) throw new Error('日记文件正被另一个进程写入，请稍后重试');
      sleepSync(20);
    }
  }
  try {
    const state = loadDiary(file, { now });
    const result = mutator(state);
    saveDiary(file, state);
    return result;
  } finally {
    if (acquired) { try { fs.unlinkSync(lockFile); } catch {} }
  }
}

/** 只读快照（不拿锁）：注入路径每轮都要读一次，读一半被替换的窗口由原子写兜住。 */
export function readDiary(file, options = {}) {
  try {
    return loadDiary(file, options);
  } catch {
    return null; // 读坏了不能打断聊天，注入层静默跳过
  }
}

// ── 寿命计算 ────────────────────────────────────────────────────────────────

export function lifeDays(entry) {
  return Math.max(0, Number(entry?.baseDays) || 0) + Math.max(0, Number(entry?.extendedDays) || 0);
}

/**
 * 冻结补偿：搁着(afraid) 期间时间不流动。
 * 返回「应当推迟到期」的毫秒数——包含历史累积的 frozenMs 和当前正在冻结的时长。
 */
export function frozenOffsetMs(entry, now) {
  let frozen = Math.max(0, Number(entry?.frozenMs) || 0);
  if (entry?.shelved && FROZEN_REASONS.has(entry.shelved.reason)) {
    frozen += Math.max(0, toMs(now) - toMs(entry.shelved.at));
  }
  return frozen;
}

/** 到期时间戳（含冻结补偿）。 */
export function expiryAt(entry, now = Date.now()) {
  return toMs(entry?.anchorAt) + lifeDays(entry) * DAY_MS + frozenOffsetMs(entry, now);
}

/** 剩余天数（向上取整；已过期 = 0）。 */
export function remainingDays(entry, now = Date.now()) {
  const left = expiryAt(entry, now) - toMs(now);
  return left <= 0 ? 0 : Math.ceil(left / DAY_MS);
}

/** 剩余比例（用于注入时决定给多少信息）。 */
export function remainingRatio(entry, now = Date.now()) {
  const life = lifeDays(entry) || 1;
  return Math.max(0, Math.min(1, remainingDays(entry, now) / life));
}

export function isDeleted(entry) {
  return !!entry?.deletedAt;
}

export function isFaded(entry, now = Date.now()) {
  return !!entry?.faded && toMs(now) < Number(entry.faded.until);
}

export function isShelved(entry) {
  return !!entry?.shelved;
}

/**
 * 可见性：注入与「读」列表默认都走这套过滤。
 * includeDeleted  回收站（默认 false）
 * includeShelved  搁着栏位（默认 false：搁着的不参与每轮模糊视图）
 * includeFaded    已到期模糊临存的（默认 true：它还在"最后决定"窗口里，要能看到）
 */
export function isVisible(entry, now, { includeDeleted = false, includeShelved = false } = {}) {
  if (!includeDeleted && isDeleted(entry)) return false;
  if (!includeShelved && isShelved(entry)) return false;
  return true;
}

export function listEntries(state, now, opts = {}) {
  const tiers = Array.isArray(opts.tiers) && opts.tiers.length ? opts.tiers : TIER_KEYS;
  const scope = opts.scope && opts.scope !== 'all' ? opts.scope : null;
  return Object.values(state.entries ?? {})
    .filter((e) => tiers.includes(e.tier))
    .filter((e) => !scope || e.scope === scope)
    .filter((e) => isVisible(e, now, opts))
    .sort((a, b) => (TIER_RANK[b.tier] - TIER_RANK[a.tier]) || (b.createdAt - a.createdAt));
}

// ── 模糊视图（注入用的那一小块） ────────────────────────────────────────────

/**
 * 单条模糊行。按剩余比例分三档（方案原文）：
 *   剩余 > 50%     心情 + 短标题
 *   20% ~ 50%      只给心情；没写心情的给短标题
 *   剩余 < 20%     只给心情；没写心情的只剩日期
 * 已到期（模糊临存）的条目永远按最低档渲染，且不给标题。
 */
export function renderFuzzyLine(entry, now = Date.now()) {
  const ratio = remainingRatio(entry, now);
  const expired = entry.faded && toMs(now) < Number(entry.faded.until);
  const mood = entry.mood ? ` · ${entry.mood}` : '';
  let tail = '';
  if (!expired && ratio > 0.5) {
    tail = entry.shortTitle || shortTitleOf(entry.text);
  } else if (!expired && ratio >= 0.2) {
    tail = entry.mood ? '' : (entry.shortTitle || shortTitleOf(entry.text));
  } else {
    tail = entry.mood ? '' : '';
  }
  const head = `【${TIERS[entry.tier].label}】${monthDayText(entry.createdAt)}${mood}`;
  const body = tail ? `　${tail}` : '';
  return `${head}${body}　id=${entry.id}`;
}

/**
 * 每轮的模糊视图。**只给模糊，不给正文**——想看正文必须调 diary_open。
 *
 * @param {object} state
 * @param {object} options
 *   now           当前时间
 *   matchedIds    本轮聊天关键词命中的条目（排在最前，并标注"聊到了什么"）
 *   matchedWords  命中的词
 *   maxEntries    最多几条
 *   maxChars      字符预算（超了从尾部丢，优先保住刻骨铭心）
 * 返回空串表示没有可注入的内容（此时桥接不会加任何标题，避免空块污染上下文）。
 */
export function buildFuzzyBlock(state, options = {}) {
  const now = toMs(options.now ?? Date.now());
  if (!state) return '';
  const maxEntries = Math.max(1, Math.min(40, Number(options.maxEntries ?? DEFAULT_OPTIONS.injectMaxEntries) || 12));
  const maxChars = Math.max(200, Number(options.maxChars ?? DEFAULT_OPTIONS.injectMaxChars) || 1400);
  const hitIds = new Set((options.matchedIds ?? []).map(String));

  const candidates = listEntries(state, now, { includeShelved: false, includeDeleted: false, scope: options.scope });
  if (!candidates.length) return '';

  // 排序：命中词条的优先，其次档位高，其次剩余比例低的（越糊的越该被想起）
  const ranked = candidates.slice().sort((a, b) => {
    const hit = (hitIds.has(b.id) ? 1 : 0) - (hitIds.has(a.id) ? 1 : 0);
    if (hit) return hit;
    const rank = TIER_RANK[b.tier] - TIER_RANK[a.tier];
    if (rank) return rank;
    return remainingRatio(a, now) - remainingRatio(b, now);
  });

  const picked = [];
  for (const entry of ranked) {
    picked.push(entry);
    if (picked.length >= maxEntries) break;
  }

  const hitWords = (options.matchedWords ?? []).filter(Boolean).slice(0, 4);
  const header = hitWords.length
    ? `【日记·模糊印象】聊到「${hitWords.join('、')}」的时候，这几条忽然冒了出来——你只记得个大概，看不到原文：`
    : '【日记·模糊印象】你只记得个大概，看不到原文：';
  const footer = '（想看哪条就用 diary_open 展开；不打开就一直是这个样子。展开不算留住。）';

  const lines = [];
  let used = header.length + footer.length;
  for (const entry of picked) {
    const line = renderFuzzyLine(entry, now);
    if (used + line.length + 1 > maxChars && lines.length) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return '';
  return `${header}\n${lines.join('\n')}\n${footer}`;
}

/**
 * 聊天文本 → 命中的日记条目。
 * 关键词匹配是**故意宽松**的：日记里记过的词再出现，人就会"突然想起"。
 * 返回 { ids, words }，word 只保留真正出现在文本里的前几个。
 */
export function matchByKeywords(state, text, now = Date.now(), { scope = null } = {}) {
  const flat = String(text ?? '');
  if (!flat.trim() || !state) return { ids: [], words: [] };
  const haystack = flat.toLowerCase();
  const ids = [];
  const words = [];
  for (const entry of Object.values(state.entries ?? {})) {
    if (scope && scope !== 'all' && entry.scope !== scope) continue; // 两边记忆不互通
    if (!isVisible(entry, now, { includeShelved: false, includeDeleted: false })) continue;
    for (const kw of entry.keywords ?? []) {
      const needle = String(kw).toLowerCase();
      if (needle.length < 2) continue;
      if (!haystack.includes(needle)) continue;
      if (!ids.includes(entry.id)) ids.push(entry.id);
      if (!words.includes(kw)) words.push(kw);
      break;
    }
  }
  // 命中词可能很多，只留最长的几个（通常最具体）
  words.sort((a, b) => String(b).length - String(a).length);
  return { ids, words: words.slice(0, 6) };
}

// ── 结算（凌晨清单） ────────────────────────────────────────────────────────

/**
 * 凌晨结算：**只报事实，不加「你该看看了」的引导**。
 *
 * 做四件事（都是对状态的最小改动）：
 *   1. 到期 → 标 faded（临存 fadeGraceDays 天）；grace 过了仍未恢复 → 移入回收站；
 *   2. 快到期 → 按档位频率（warnedAt）报一次；
 *   3. 可升档 / 可降档 → 按冷却报一次；
 *   4. 画像强度达标 → 提示"可以考虑记进日记"，记哪档她自己定。
 *
 * @returns {{ran:boolean, date:string, byScope:object}}
 */
export function runSettle(state, options = {}) {
  const now = toMs(options.now ?? Date.now());
  const today = dateKey(now);
  const opts = { ...DEFAULT_OPTIONS, ...(options.options ?? {}) };
  const portraits = Array.isArray(options.portraits) ? options.portraits : [];
  const emptyByScope = () => Object.fromEntries(SCOPES.map((scope) => [scope, {
    facts: { expiring: [], expired: [], archiving: [], promoted: [], demoted: [], hearts: [], portraits: [] },
    text: ''
  }]));
  if (!state) return { ran: false, date: today, byScope: emptyByScope() };
  if (state.settle?.lastRunDate === today && options.force !== true) {
    return { ran: false, date: today, byScope: emptyByScope() };
  }
  state.settle ??= {};
  state.settle.pending ??= { private: null, group: null };
  state.settle.heartRemindedAt ??= { private: null, group: null };

  const byScope = emptyByScope();
  const entries = Object.values(state.entries ?? {}).filter((e) => !isDeleted(e));

  for (const entry of entries) {
    const tier = TIERS[entry.tier];
    const left = remainingDays(entry, now);
    const life = lifeDays(entry);
    const facts = byScope[entry.scope]?.facts ?? byScope.group.facts;

    // 1) 到期：先模糊化临存，再回收。搁着(afraid) 的不衰减，不会走到这里。
    if (left <= 0) {
      if (!entry.faded) {
        entry.faded = { at: now, until: now + Math.max(1, Number(opts.fadeGraceDays) || 3) * DAY_MS };
        entry.updatedAt = now;
        facts.expired.push({ id: entry.id, tier: entry.tier, until: entry.faded.until, created: entry.createdAt });
        continue;
      }
      if (now >= Number(entry.faded.until)) {
        entry.deletedAt = { at: now, reason: 'expired' };
        entry.updatedAt = now;
        facts.archiving.push({ id: entry.id, tier: entry.tier, createdAt: entry.createdAt });
        continue;
      }
      facts.expired.push({ id: entry.id, tier: entry.tier, until: entry.faded.until, created: entry.createdAt });
      continue;
    }

    // 2) 快到期：按档位频率提醒（普通 1 天 / 重要 3 天 / 刻骨铭心 7 天）
    if (left <= tier.warnRemainingDays) {
      const gap = entry.warnedAt ? dayGap(entry.warnedAt, now) : 999;
      if (gap >= tier.warnEveryDays) {
        entry.warnedAt = today;
        facts.expiring.push({ id: entry.id, tier: entry.tier, created: entry.createdAt, left });
      }
    }

    // 3) 升档 / 降档提示（带冷却，避免每天念）
    if (tier.promoteAfterDays && life > tier.promoteAfterDays) {
      const gap = entry.promoteHintedAt ? dayGap(entry.promoteHintedAt, now) : 999;
      if (gap >= (Number(opts.hintCooldownDays) || 3)) {
        entry.promoteHintedAt = today;
        facts.promoted.push({ id: entry.id, tier: entry.tier, life, to: TIER_KEYS[TIER_KEYS.indexOf(entry.tier) + 1] });
      }
    }
    if (tier.demoteBelowDays && left < tier.demoteBelowDays) {
      const gap = entry.demoteHintedAt ? dayGap(entry.demoteHintedAt, now) : 999;
      if (gap >= (Number(opts.hintCooldownDays) || 3)) {
        entry.demoteHintedAt = today;
        facts.demoted.push({ id: entry.id, tier: entry.tier, left, to: TIER_KEYS[TIER_KEYS.indexOf(entry.tier) - 1] });
      }
    }

    // 4) 刻骨铭心：客观陈述 + 把决定权交给她；最多几天一次，避免变成每日催促
    if (entry.tier === 'heart' && entry.createdAt) {
      facts.hearts.push({ id: entry.id, left });
    }
  }

  for (const scope of SCOPES) {
    const facts = byScope[scope].facts;

    // 画像联动：strength 被加强到阈值以上的条目，提示可以考虑记进日记（记哪档她定）。
    // 画像不属于任何一侧，两边都提一次（各自只提示一次）。
    if (portraits.length) {
      state.settle.portraitNotified ??= {};
      for (const p of portraits) {
        const name = String(p?.name ?? '').trim();
        const strength = Number(p?.strength) || 0;
        if (!name || strength < (Number(opts.portraitThreshold) || 80)) continue;
        if (state.settle.portraitNotified[`${scope}:${name}`]) continue;
        state.settle.portraitNotified[`${scope}:${name}`] = today;
        facts.portraits.push({ name, strength, summary: String(p?.summary ?? '').slice(0, 80) });
      }
    }

    // 刻骨铭心：每条都进清单是客观事实；长提示另外受 heartRemindEveryDays 限制，
    // 否则每天一句「这些是你最沉重的内容」就变成了催促。
    const lastHeart = state.settle.heartRemindedAt[scope];
    const heartGap = lastHeart ? dayGap(lastHeart, now) : 999;
    if (facts.hearts.length && heartGap >= (Number(opts.heartRemindEveryDays) || 7)) {
      const nearest = facts.hearts.slice().sort((a, b) => a.left - b.left)[0];
      facts.heartReminder = { total: facts.hearts.length, nearestLeft: nearest.left };
      state.settle.heartRemindedAt[scope] = now;
    }

    const text = renderSettleReport(facts, { now, scope, options: opts });
    byScope[scope].text = text;
    state.settle.pending[scope] = text ? { at: now, text, deliveredAt: null } : null;
  }

  state.settle.lastRunDate = today;
  return { ran: true, date: today, byScope };
}

/** 把结算事实渲染成清单。措辞刻意保持中性：只给状态，不催。 */
export function renderSettleReport(facts, { now = Date.now(), scope = 'group', options = DEFAULT_OPTIONS } = {}) {
  const lines = [];
  const push = (s) => lines.push(s);

  if (facts.expiring?.length) {
    push('【快到期的日记】');
    for (const item of facts.expiring) {
      push(`- ${monthDayText(item.created)} ${TIERS[item.tier].label} 还剩 ${item.left} 天　id=${item.id}`);
    }
  }
  if (facts.expired?.length) {
    push('【已到期·模糊临存】');
    for (const item of facts.expired) {
      const left = Math.max(0, Math.ceil((Number(item.until) - toMs(now)) / DAY_MS));
      push(`- ${monthDayText(item.created ?? now)} ${TIERS[item.tier].label} 原文已模糊，临存 ${left} 天　id=${item.id}`);
    }
    push('  到期处理：延长(diary_extend)可恢复原文并续命；划掉(diary_delete)进回收站；什么都不做则临存结束后自动进回收站。');
  }
  if (facts.archiving?.length) {
    push('【已超过临存期】');
    for (const item of facts.archiving) {
      push(`- ${monthDayText(item.created)} ${TIERS[item.tier].label} 已移入回收站　id=${item.id}`);
    }
  }
  if (facts.promoted?.length) {
    push('【达到升档条件】');
    for (const item of facts.promoted) {
      push(`- ${TIERS[item.tier].label} 已存 ${item.life} 天，可升到 ${TIERS[item.to].label}　id=${item.id}`);
    }
  }
  if (facts.demoted?.length) {
    push('【达到降档条件】');
    for (const item of facts.demoted) {
      push(`- ${TIERS[item.tier].label} 还剩 ${item.left} 天，可降到 ${TIERS[item.to].label}　id=${item.id}`);
    }
  }
  if (facts.heartReminder) {
    const { total, nearestLeft } = facts.heartReminder;
    lines.unshift(`【刻骨铭心】共 ${total} 条，最近一条 ${nearestLeft ? `还剩 ${nearestLeft} 天` : '已到期'}。这些是你最沉重也最幸福的内容；要不要看、要不要留，由你决定。`);
  }
  if (facts.portraits?.length) {
    push('【画像·可入日记】');
    for (const p of facts.portraits) {
      push(`- 「${p.name}」强度 ${p.strength}${p.summary ? `：${p.summary}` : ''}（记哪一档由你自己定）　id=portrait:${p.name}`);
    }
  }
  if (!lines.length) return '';
  return `【日记结算】${monthDayText(now)} · ${SCOPE_LABEL[scope] ?? scope}\n${lines.join('\n')}`;
}

/** 取走某个作用域待展示的结算清单（取一次就标记已送达，避免每轮重复注入）。 */
export function takePendingSettle(state, scope = 'group', now = Date.now()) {
  const pending = state?.settle?.pending?.[scope];
  if (!pending || pending.deliveredAt) return '';
  pending.deliveredAt = toMs(now);
  return String(pending.text ?? '');
}

/** 校验某条日记属于当前记忆作用域（工具层用；不通过就抛错）。 */
export function assertEntryScope(state, id, scope) {
  const entry = requireEntry(state, id);
  if (scope && scope !== 'all' && entry.scope !== scope) {
    throw new Error(`这条日记不在当前的记忆里（它是${SCOPE_LABEL[entry.scope] ?? entry.scope}的）`);
  }
  return entry;
}

// ── 摘要：给「读」列表用的一行 ──────────────────────────────────────────────

export function renderListLine(entry, now = Date.now()) {
  const tier = TIERS[entry.tier].label;
  const badges = [];
  if (isShelved(entry)) badges.push(`搁着·${SHELVE_REASONS[entry.shelved.reason]}`);
  if (isFaded(entry, now)) badges.push('已模糊临存');
  if (isDeleted(entry)) badges.push(`回收站·${entry.deletedAt.reason === 'expired' ? '到期' : '划掉'}`);
  const left = remainingDays(entry, now);
  const tail = badges.length ? `　[${badges.join('/')}]` : '';
  return `${monthDayText(entry.createdAt)} ${tier} · 剩${left}天${tail}　${entry.mood ? `${entry.mood}｜` : ''}${entry.shortTitle || shortTitleOf(entry.text)}　id=${entry.id}`;
}

// ── 变更操作 ────────────────────────────────────────────────────────────────
// 每个操作都返回 { ok, entry, message }；失败抛错（由 MCP 层转成可读错误）。

function requireEntry(state, id) {
  const entry = state.entries?.[String(id ?? '')];
  if (!entry) throw new Error(`没有这条日记：${id ?? '(空)'}`);
  return entry;
}

function assertAlive(entry, action) {
  if (isDeleted(entry)) throw new Error(`这条日记在回收站里，不能${action}（回收站只用于回看）`);
}

function nextId(state) {
  state.seq = (Number(state.seq) || 0) + 1;
  return `d${state.seq}`;
}

/**
 * 写一条日记。
 * mood / unsaid 都是可选的：她不想写就不写，不塞默认值。
 */
export function createEntry(state, input = {}, now = Date.now()) {
  const at = toMs(now);
  const text = String(input.text ?? '').trim();
  if (!text) throw new Error('日记正文不能为空');
  if (text.length > MAX_TEXT_CHARS) throw new Error(`日记正文过长（${text.length} 字，上限 ${MAX_TEXT_CHARS}）`);
  if (Object.keys(state.entries ?? {}).length >= MAX_ENTRIES) throw new Error(`日记条数已达上限 ${MAX_ENTRIES}，请先整理`);
  const tier = TIER_KEYS.includes(input.tier) ? input.tier : 'normal';
  const id = nextId(state);
  const scope = SCOPES.includes(input.scope) ? input.scope : 'group';
  const explicit = Array.isArray(input.keywords)
    && input.keywords.map((k) => String(k ?? '').trim()).filter((k) => k.length >= 2).length > 0;
  const entry = normalizeEntry({
    id,
    createdAt: at,
    updatedAt: at,
    tier,
    scope,
    baseDays: TIERS[tier].initialDays,
    extendedDays: 0,
    anchorAt: at,
    text,
    mood: input.mood,
    unsaid: input.unsaid,
    keywords: deriveKeywords(text, input.keywords),
    keywordMode: explicit ? 'explicit' : 'auto',
    portrait: input.portrait,
    shortTitle: shortTitleOf(text)
  }, id);
  state.entries[id] = entry;
  return entry;
}

/** 延长寿命：按档位加天数；同一天只算一次；对模糊临存的条目等于「恢复正常并续命」。 */
export function extendEntry(state, id, now = Date.now()) {
  const at = toMs(now);
  const entry = requireEntry(state, id);
  assertAlive(entry, '延长');
  const today = dateKey(at);
  if (entry.lastExtendedDate === today) {
    throw new Error(`今天已经延长过这条日记了（同一天只算一次），它在 ${monthDayText(entry.faded?.until ?? expiryAt(entry, at))} ${entry.faded ? '临存结束' : '到期'}`);
  }
  const days = TIERS[entry.tier].extendDays;
  entry.extendedDays = (Number(entry.extendedDays) || 0) + days;
  entry.lastExtendedDate = today;
  entry.extendLog = [...(entry.extendLog ?? []), { at, days }].slice(-50);
  const restored = !!entry.faded;
  if (restored) entry.faded = null;
  entry.updatedAt = at;
  return { entry, days, restored };
}

/** 升档：档位提高一级，寿命按新档位初始天数**重新算**（不加在旧寿命上）。 */
export function promoteEntry(state, id, now = Date.now()) {
  const at = toMs(now);
  const entry = requireEntry(state, id);
  assertAlive(entry, '升档');
  const index = TIER_KEYS.indexOf(entry.tier);
  if (index >= TIER_KEYS.length - 1) throw new Error('已经是最高档（刻骨铭心），不能再升');
  const next = TIER_KEYS[index + 1];
  entry.tier = next;
  entry.baseDays = TIERS[next].initialDays;
  entry.extendedDays = 0;
  entry.anchorAt = at;
  entry.frozenMs = 0;
  entry.faded = null;
  entry.warnedAt = null;
  entry.promoteHintedAt = null;
  entry.demoteHintedAt = null;
  entry.updatedAt = at;
  return { entry, to: next };
}

/** 降档：档位降低一级，寿命同样按新档位初始天数重新算。 */
export function demoteEntry(state, id, now = Date.now()) {
  const at = toMs(now);
  const entry = requireEntry(state, id);
  assertAlive(entry, '降档');
  const index = TIER_KEYS.indexOf(entry.tier);
  if (index <= 0) throw new Error('已经是最低档（普通），不能再降');
  const prev = TIER_KEYS[index - 1];
  entry.tier = prev;
  entry.baseDays = TIERS[prev].initialDays;
  entry.extendedDays = 0;
  entry.anchorAt = at;
  entry.frozenMs = 0;
  entry.faded = null;
  entry.warnedAt = null;
  entry.promoteHintedAt = null;
  entry.demoteHintedAt = null;
  entry.updatedAt = at;
  return { entry, to: prev };
}

/**
 * 搁着。两种理由的寿命算法不同：
 *   afraid       冻结计时（frozenMs 累积），不扣寿命；
 *   uninterested 照常扣，本来就没那么重。
 * 重复调用等于改理由：从 afraid 改成 uninterested 时，把已冻结的时长结算掉（时间重新开始走）。
 */
export function shelveEntry(state, id, reason, now = Date.now()) {
  const at = toMs(now);
  const entry = requireEntry(state, id);
  assertAlive(entry, '搁着');
  const why = String(reason ?? '').trim();
  if (!SHELVE_REASONS[why]) throw new Error('搁着的理由只能是 afraid（不敢看）或 uninterested（没兴趣）');
  if (entry.shelved && FROZEN_REASONS.has(entry.shelved.reason)) {
    entry.frozenMs = Math.max(0, Number(entry.frozenMs) || 0) + Math.max(0, at - toMs(entry.shelved.at));
  }
  entry.shelved = { reason: why, at };
  entry.updatedAt = at;
  return { entry, reason: why, frozen: FROZEN_REASONS.has(why) };
}

/** 拿出来：离开搁着栏位。冻结的时长在这里结算，之后恢复自然衰减。 */
export function unshelveEntry(state, id, now = Date.now()) {
  const at = toMs(now);
  const entry = requireEntry(state, id);
  assertAlive(entry, '拿出来');
  if (!entry.shelved) throw new Error('这条日记没有搁着');
  if (FROZEN_REASONS.has(entry.shelved.reason)) {
    entry.frozenMs = Math.max(0, Number(entry.frozenMs) || 0) + Math.max(0, at - toMs(entry.shelved.at));
  }
  entry.shelved = null;
  entry.updatedAt = at;
  return { entry, frozenMs: entry.frozenMs };
}

/** 记糊：把正文改写成模糊版，原文进 history 留底。 */
export function fadeEntry(state, id, now = Date.now(), replacement) {
  const at = toMs(now);
  const entry = requireEntry(state, id);
  assertAlive(entry, '记糊');
  const old = entry.text;
  const next = String(replacement ?? '').trim() || fuzzyTextOf(entry);
  entry.history = [...(entry.history ?? []), { at, text: old }].slice(-20);
  entry.text = next.slice(0, MAX_TEXT_CHARS);
  entry.shortTitle = shortTitleOf(entry.text);
  entry.keywords = deriveKeywords(entry.text, entry.keywordMode === 'explicit' ? entry.keywords : undefined);
  entry.updatedAt = at;
  return { entry, replaced: old };
}

/** 划掉（软删除）：不删数据，只标 deletedAt；所有注入与列表默认过滤。 */
export function deleteEntry(state, id, now = Date.now(), reason = 'manual') {
  const at = toMs(now);
  const entry = requireEntry(state, id);
  if (isDeleted(entry)) throw new Error('这条日记已经在回收站里了');
  entry.deletedAt = { at, reason };
  entry.shelved = null;
  entry.updatedAt = at;
  return entry;
}

/** 收拾回收站：把很早以前的软删除条目彻底移除（默认关闭，只在她明确要求时用）。 */
export function purgeDeleted(state, now = Date.now(), olderThanDays = 365) {
  const at = toMs(now);
  const removed = [];
  for (const [id, entry] of Object.entries(state.entries ?? {})) {
    if (!isDeleted(entry)) continue;
    if (dayGap(entry.deletedAt.at, at) < olderThanDays) continue;
    delete state.entries[id];
    removed.push(id);
  }
  return removed;
}

/**
 * 补写心情 / 没敢说的话。
 * 这是**修改**不是追加：她可以改口（"其实我不是烦，是怕"），改口本身也是记忆的一部分。
 */
export function amendEntry(state, id, patch = {}, now = Date.now()) {
  const at = toMs(now);
  const entry = requireEntry(state, id);
  assertAlive(entry, '补写');
  let touched = false;
  if (Object.hasOwn(patch, 'mood')) {
    const mood = patch.mood == null ? null : String(patch.mood).trim();
    if (mood && mood.length > MAX_MOOD_CHARS) throw new Error(`心情太长（上限 ${MAX_MOOD_CHARS} 字）`);
    entry.mood = mood || null;
    touched = true;
  }
  if (Object.hasOwn(patch, 'unsaid')) {
    const unsaid = patch.unsaid == null ? null : String(patch.unsaid).trim();
    if (unsaid && unsaid.length > MAX_UNSAID_CHARS) throw new Error(`没敢说的话太长（上限 ${MAX_UNSAID_CHARS} 字）`);
    entry.unsaid = unsaid || null;
    touched = true;
  }
  if (Object.hasOwn(patch, 'keywords')) {
    entry.keywords = deriveKeywords(entry.text, patch.keywords);
    entry.keywordMode = 'explicit';
    touched = true;
  }
  if (!touched) throw new Error('没有要补写的内容（mood / unsaid / keywords 至少给一个）');
  entry.updatedAt = at;
  return entry;
}

/** 按天数翻心情：只看最近 N 天写下的日记的**心情**，正文不出现。 */
export function listMoodsByDays(state, days, now = Date.now(), { scope = null } = {}) {
  const at = toMs(now);
  const span = Math.max(1, Math.min(3650, Number(days) || 7));
  return Object.values(state.entries ?? {})
    .filter((e) => !isDeleted(e))
    .filter((e) => !scope || scope === 'all' || e.scope === scope)
    .filter((e) => dayGap(e.createdAt, at) < span)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((e) => ({
      id: e.id,
      date: monthDayText(e.createdAt),
      tier: e.tier,
      mood: e.mood,
      shelved: e.shelved ? SHELVE_REASONS[e.shelved.reason] : null
    }));
}

// ── 展开：看全文 ────────────────────────────────────────────────────────────

/** 展开一条日记的完整内容（会进历史缓存——缓存的是「她主动打开看过的」）。 */
export function openEntry(state, id, now = Date.now(), { scope = null } = {}) {
  const at = toMs(now);
  const entry = requireEntry(state, id);
  // 记忆不互通：群聊里打开的只能是群聊的记忆，私聊反之。
  if (scope && scope !== 'all' && entry.scope !== scope) {
    throw new Error(`这条日记不在当前的记忆里（它是${SCOPE_LABEL[entry.scope] ?? entry.scope}的）`);
  }
  if (isDeleted(entry)) {
    return {
      entry,
      deleted: true,
      payload: {
        id: entry.id,
        date: monthDayText(entry.createdAt),
        tier: entry.tier,
        deletedAt: dateKey(entry.deletedAt.at),
        reason: entry.deletedAt.reason,
        text: entry.text,
        mood: entry.mood,
        unsaid: entry.unsaid
      }
    };
  }
  const faded = isFaded(entry, at);
  const payload = {
    id: entry.id,
    date: monthDayText(entry.createdAt),
    tier: TIERS[entry.tier].label,
    mood: entry.mood,
    unsaid: entry.unsaid,
    text: faded ? null : entry.text,
    shortTitle: entry.shortTitle,
    keywords: entry.keywords,
    remainingDays: remainingDays(entry, at),
    lifeDays: lifeDays(entry),
    shelved: entry.shelved ? SHELVE_REASONS[entry.shelved.reason] : null,
    faded: faded ? { until: dateKey(entry.faded.until) } : null
  };
  if (faded) payload.note = '这条已经到期、原文模糊了，只剩关键词印象；延长可以恢复正常并续命。';
  pushCache(state, entry, at);
  return { entry, deleted: false, payload };
}

/** 300 条「她主动打开过」的缓存（FIFO，同一条重复打开只更新时间并挪到末尾）。 */
export function pushCache(state, entry, now = Date.now()) {
  const at = toMs(now);
  state.cache ??= [];
  const head = `${entry.mood ? `${entry.mood}｜` : ''}${String(entry.text ?? '').replace(/\s+/g, ' ').slice(0, 120)}`;
  state.cache = state.cache.filter((c) => c.id !== entry.id);
  state.cache.push({ id: entry.id, at, tier: entry.tier, mood: entry.mood ?? null, head, scope: entry.scope });
  if (state.cache.length > MAX_CACHE) state.cache = state.cache.slice(-MAX_CACHE);
}

/**
 * 上下文缓存查询（不在「十二个工具」里，属于上下文压缩配套）。
 * 只查她**主动打开看过**的；默认 8 条，上限 16 条。
 */
export function recallCache(state, query = {}, now = Date.now()) {
  const at = toMs(now);
  const limit = Math.max(1, Math.min(CACHE_QUERY_MAX, Number(query.limit) || 8));
  const days = Number(query.days);
  const q = String(query.query ?? '').trim().toLowerCase();
  let pool = (state?.cache ?? []).slice();
  if (query.scope && query.scope !== 'all') pool = pool.filter((c) => c.scope === query.scope);
  if (Number.isFinite(days) && days > 0) pool = pool.filter((c) => dayGap(c.at, at) < Math.min(3650, days));
  if (q) {
    pool = pool.filter((c) => `${c.head} ${c.mood ?? ''}`.toLowerCase().includes(q));
  }
  pool.sort((a, b) => b.at - a.at);
  return {
    total: state?.cache?.length ?? 0,
    matched: pool.length,
    limit,
    items: pool.slice(0, limit).map((c) => ({
      id: c.id,
      date: monthDayText(c.at),
      tier: TIERS[c.tier].label,
      mood: c.mood,
      head: c.head
    }))
  };
}

// ── 画像联动（接口层） ──────────────────────────────────────────────────────

/**
 * 读画像文件。约定格式（换成真画像插件时只要保持这个形状即可）：
 *   { "portraits": [ { "name": "她", "strength": 92, "summary": "怕黑，但不说" } ] }
 * 也接受顶层就是数组。文件不存在/读坏 → 返回空数组（不打断结算）。
 */
export function readPortraits(file) {
  if (!file) return [];
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.portraits) ? parsed.portraits : []);
    return list
      .filter((p) => p && (p.name ?? p.title))
      .map((p) => ({
        name: String(p.name ?? p.title).slice(0, 40),
        strength: Number(p.strength ?? p.score ?? 0) || 0,
        summary: String(p.summary ?? p.note ?? '').slice(0, 120)
      }));
  } catch {
    return [];
  }
}
