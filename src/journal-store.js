// 每日日记（两份）：一份给主人看，一份只有她自己看。
//
// 与 `diary-core.js` 的分工：
//   diary-core   —— 她的「记忆」：三档寿命、会变糊、会被遗忘，注入到每轮提示词里。
//   journal-store—— 她的「日记本」：每天 23:30 写两篇**文件**，落在 <数据根> 下，
//                   给人看的那份是诚实的流水，给自己看的那份是只属于她的话。
// 两者互不替代：记忆是底子，日记本是纸。
//
// 设计约束：
//   · 不覆盖：同一天已经写过的文件不会被静默重写（`overwrite` 必须显式传）。
//   · 补写窗口：只补「部署之后」漏掉的日期（`startedOn`），不会凭空给过去编日记。
//   · 纯文件 + 纯函数：所有时间都显式传入，便于单测与模拟。
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, dateKey, toMs } from './diary-core.js';

export const DEFAULT_WRITE_AT = '23:30';
export const KINDS = { public: '公开', private: '私密' };
export const KIND_KEYS = ['public', 'private'];

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** `23:30` → { hour: 23, minute: 30 }；非法值回落到默认。 */
export function parseWriteAt(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return { hour: 23, minute: 30 };
  const hour = Math.max(0, Math.min(23, Number(m[1])));
  const minute = Math.max(0, Math.min(59, Number(m[2])));
  return { hour, minute };
}

/** 从日期键（2026-10-22）取本地 Date（当天 00:00）。 */
export function dateFromKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function weekdayOf(key) {
  const d = dateFromKey(key);
  return d ? WEEKDAYS[d.getDay()] : '';
}

/** 两个日期键相差几天（a 早于 b 为正）。 */
export function dayDiff(a, b) {
  const da = dateFromKey(a);
  const db = dateFromKey(b);
  if (!da || !db) return 0;
  return Math.round((db.getTime() - da.getTime()) / 86400000);
}

export function journalFile(dir, date) {
  return path.join(dir, `${date}.md`);
}

/** 目录里有日记的日期集合（只认 YYYY-MM-DD.md）。 */
export function listJournalDates(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((n) => /^(\d{4}-\d{2}-\d{2})\.md$/.exec(n)?.[1])
    .filter(Boolean)
    .sort();
}

export function hasJournal(dir, date) {
  try {
    const stat = fs.statSync(journalFile(dir, date));
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * 写一天的日记文件。
 * 已存在且非空时**拒绝覆盖**（防止补写任务把当天已经写好的内容冲掉）；
 * 需要重写时调用方显式传 `overwrite: true`。
 *
 * 传了 `backupDir` 就在覆盖前留一份旧版（面板改错、补写重跑都能救回来）。
 * 这个"改前备份"是从 S3K926/dsh-memory-board 的写盘内核学来的：护栏要放在唯一的写入口上。
 */
export function writeJournal(dir, date, body, { now = Date.now(), overwrite = false, kind = 'public', backupDir = '' } = {}) {
  const text = String(body ?? '').trim();
  if (!text) throw new Error('日记正文为空，拒绝写入');
  const file = journalFile(dir, date);
  const existed = hasJournal(dir, date);
  if (!overwrite && existed) {
    throw new Error(`${date} 的日记已经写过了（${file}），不覆盖`);
  }
  if (existed && backupDir) {
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      const at0 = new Date(toMs(now));
      const stamp = `${at0.getFullYear()}${String(at0.getMonth() + 1).padStart(2, '0')}${String(at0.getDate()).padStart(2, '0')}-${String(at0.getHours()).padStart(2, '0')}${String(at0.getMinutes()).padStart(2, '0')}${String(at0.getSeconds()).padStart(2, '0')}`;
      fs.copyFileSync(file, path.join(backupDir, `${path.basename(file, '.md')}.${stamp}..bak`));
    } catch {
      // 备份失败不挡写入：日记比一份备份重要
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date(toMs(now));
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const title = kind === 'private' ? `（私密）` : '';
  const content = `# ${date} ${weekdayOf(date)}${title}\n\n${text}\n\n---\n_写于 ${date} ${hhmm}_\n`;
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
  return { file, date, bytes: Buffer.byteLength(content, 'utf8') };
}

export function readJournal(dir, date) {
  try {
    return fs.readFileSync(journalFile(dir, date), 'utf8');
  } catch {
    return null;
  }
}

/**
 * 该写哪几天。
 *
 * @param {object} options
 *   now          当前时间
 *   dirs         需要**同时**存在的目录列表（公开 + 私密）；任一缺失即视为这天没写完
 *   catchupDays  往回补几天（默认 7）
 *   startedOn    部署日期；早于它的日期不补（不给过去凭空编日记）
 *   writeAt      '23:30'；今天只有在过了这个点之后才算"该写"
 * @returns {string[]} 日期键，**从老到新**（补写先写早的，读起来才顺）
 */
export function dueDates({ now = Date.now(), dirs = [], catchupDays = 7, startedOn = null, writeAt = DEFAULT_WRITE_AT } = {}) {
  const { hour, minute } = parseWriteAt(writeAt);
  const at = new Date(toMs(now));
  const todayKey = dateKey(at);
  const pastWriteAt = at.getHours() > hour || (at.getHours() === hour && at.getMinutes() >= minute);
  const span = Math.max(0, Math.min(30, Number(catchupDays) || 0));
  const out = [];
  for (let i = 0; i <= span; i += 1) {
    const day = new Date(at.getFullYear(), at.getMonth(), at.getDate() - i);
    const key = dateKey(day);
    if (i === 0 && !pastWriteAt) continue;
    if (startedOn && key < startedOn) continue;
    const missing = dirs.some((dir) => !hasJournal(dir, key));
    if (missing) out.push(key);
  }
  return out.reverse();
}

/**
 * 解析模型输出的两段。
 * 容忍 `===公开===` / `【公开】` / `## 公开` 三种写法；认不出来就判失败（不猜）。
 */
export function parseJournalOutput(raw) {
  const text = String(raw ?? '');
  const lines = text.split(/\r?\n/);
  const buckets = { public: [], private: [] };
  let mode = null;
  let sawPublic = false;
  let sawPrivate = false;
  const marker = (line) => {
    const t = line.trim();
    if (/^(={2,}\s*)?公开(\s*={2,})?$/.test(t) || /^【\s*公开\s*】$/.test(t) || /^#{1,3}\s*公开$/.test(t)) {
      sawPublic = true;
      return 'public';
    }
    if (/^(={2,}\s*)?私密(\s*={2,})?$/.test(t) || /^【\s*私密\s*】$/.test(t) || /^#{1,3}\s*私密$/.test(t)) {
      sawPrivate = true;
      return 'private';
    }
    return null;
  };
  for (const line of lines) {
    const next = marker(line);
    if (next) { mode = next; continue; }
    if (mode) buckets[mode].push(line);
  }
  const result = {
    public: buckets.public.join('\n').trim(),
    private: buckets.private.join('\n').trim(),
    sawPublic,
    sawPrivate
  };
  result.ok = sawPublic && sawPrivate && !!result.public && !!result.private;
  return result;
}

/**
 * 把「这一天的聊天」压成给模型回忆用的小抄。
 * 只做摘要，不做总结——总结会让两篇日记变成同一篇，而它们本来该不同。
 */
export function buildDigest(messages, { maxChars = 4000, maxLines = 80, perLineChars = 120 } = {}) {
  const lines = [];
  const seen = new Set();
  for (const m of Array.isArray(messages) ? messages : []) {
    const sender = String(m?.sender ?? '某人').slice(0, 20);
    const text = String(m?.text ?? m?.plain ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const line = `${sender}：${text.slice(0, perLineChars)}`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  const kept = [];
  let used = 0;
  for (const line of lines.slice(-maxLines)) {
    if (used + line.length + 1 > maxChars) break;
    kept.push(line);
    used += line.length + 1;
  }
  return kept.join('\n');
}

// ── 当天聊天流水（写日记的素材） ────────────────────────────────────────────
//
// 为什么需要它：`social-v2.json` 里的 `recentMessages` 是个**滚动窗口**（每群默认 100 条），
// 忙碌的大群一两个小时就把早上说过的话挤掉了。于是 23:30 写日记时素材只剩"最近一小时"，
// 写出来的东西自然只记得刚才。
//
// 这里把当天所有会话的消息按行追加进 `state/chat-log/YYYY-MM-DD.jsonl`，
// 再按**小时分桶均匀取样**给日记用：宁可每小时只给两三句，也要把整天的跨度覆盖到。

export const DEFAULT_LOG_RETENTION_DAYS = 10;
export const MAX_LOG_BYTES_PER_DAY = 6000 * 160;

export function chatLogFile(dir, date) {
  return path.join(dir, `${date}.jsonl`);
}

/**
 * 追加一条消息到当天流水。
 * 返回 false 表示这行没写（空内容/当天已超量/写失败）——日记少一句不会出事。
 */
export function appendChatLog(dir, date, entry, { maxBytes = MAX_LOG_BYTES_PER_DAY } = {}) {
  const text = String(entry?.x ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  const file = chatLogFile(dir, date);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > maxBytes) return false;
    const line = JSON.stringify({
      t: toMs(entry?.t ?? Date.now()),
      k: String(entry?.k ?? ''),
      s: String(entry?.s ?? '某人').slice(0, 20),
      x: text.slice(0, 200)
    });
    fs.appendFileSync(file, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** 读某天的聊天流水（坏行跳过，不打断写日记）。 */
export function readChatLog(dir, date) {
  let raw;
  try {
    raw = fs.readFileSync(chatLogFile(dir, date), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const item = JSON.parse(trimmed);
      if (!item || !item.x) continue;
      out.push({ t: Number(item.t) || 0, k: String(item.k ?? ''), s: String(item.s ?? '某人'), x: String(item.x) });
    } catch {}
  }
  return out.sort((a, b) => a.t - b.t);
}

/** 删掉超过保留期的聊天流水（只动 chat-log 目录里自己的 YYYY-MM-DD.jsonl）。 */
export function pruneChatLogs(dir, { now = Date.now(), keepDays = DEFAULT_LOG_RETENTION_DAYS } = {}) {
  const removed = [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return removed;
  }
  const today = dateKey(now);
  for (const name of names) {
    const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (!m) continue;
    if (dayDiff(m[1], today) <= Math.max(1, keepDays)) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
      removed.push(name);
    } catch {}
  }
  return removed;
}

/**
 * 把一整天的流水按小时分桶、均匀取样，拼成给日记的小抄。
 *
 * 与 `buildDigest`（只取最后 N 行）的区别就是这次修的病：后者会让"最近一小时"占满预算。
 * 这里每个有消息的小时都留几行（默认 4 行，首尾 + 中间均匀取），
 * 预算不够就整体降采样（4 → 3 → 2 → 1），**绝不靠丢掉前面的小时来省字数**。
 *
 * @returns {{text:string, hours:number, total:number, sampled:number}}
 */
export function buildDayDigest(entries, { maxChars = 8000, perHour = 4, lineChars = 70 } = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && e.x);
  const total = list.length;
  if (!total) return { text: '', hours: 0, total: 0, sampled: 0 };

  const buckets = new Map();
  for (const item of list) {
    const hour = new Date(toMs(item.t)).getHours();
    if (!buckets.has(hour)) buckets.set(hour, []);
    buckets.get(hour).push(item);
  }

  const sideOf = (key) => (String(key).startsWith('private:') ? '私聊' : '群聊');
  const render = (item) => {
    const d = new Date(toMs(item.t));
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const text = String(item.x).replace(/\s+/g, ' ').slice(0, lineChars);
    return `${hhmm} ${sideOf(item.k)}·${item.s}：${text}`;
  };

  const hours = [...buckets.keys()].sort((a, b) => a - b);
  for (const k of [perHour, 3, 2, 1]) {
    const lines = [];
    for (const hour of hours) {
      const bucket = buckets.get(hour);
      const take = Math.min(k, bucket.length);
      const picked = [];
      for (let i = 0; i < take; i += 1) {
        // take=1 时取这一小时的最后一条（收尾那句通常最有信息），否则首尾 + 中间均匀取
        const idx = take === 1
          ? bucket.length - 1
          : Math.round((i * (bucket.length - 1)) / (take - 1));
        const item = bucket[idx];
        if (item && !picked.includes(item)) picked.push(item);
      }
      for (const item of picked) lines.push(render(item));
    }
    const text = lines.join('\n');
    if (text.length <= maxChars) {
      return { text, hours: hours.length, total, sampled: lines.length };
    }
  }
  // 极端情况兜底：每小时只留最后一句，仍超预算就按顺序截断
  const fallback = [];
  let used = 0;
  for (const hour of hours) {
    const bucket = buckets.get(hour);
    const line = render(bucket[bucket.length - 1]);
    if (used + line.length + 1 > maxChars) break;
    fallback.push(line);
    used += line.length + 1;
  }
  return { text: fallback.join('\n'), hours: hours.length, total, sampled: fallback.length };
}

/**
 * 拼出「写这两篇」的提示词。
 * 关键点：两篇的定位必须说清楚是**不同内容**，否则模型会把同一段抄两遍。
 */
export function renderJournalPrompt({
  date,
  now = Date.now(),
  digest = '',
  diaryNotes = '',
  catchup = false,
  writeAt = DEFAULT_WRITE_AT
} = {}) {
  const at = new Date(toMs(now));
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const head = catchup
    ? `【补写日记】${date} ${weekdayOf(date)}（那天你没能写。想不起来就写得模糊一点，只写还记得的，不要编造具体细节。）`
    : `【写日记】${date} ${weekdayOf(date)} ${hhmm}（${parseWriteAt(writeAt).hour}:${String(parseWriteAt(writeAt).minute).padStart(2, '0')} 的日记时间）`;
  const parts = [head];
  if (digest) {
    parts.push(`这一天里你在旁边看到的（只是提醒你回忆，不要照抄原话，也不要提"记录/上下文/消息"这类词）：\n${digest}`);
  } else if (catchup) {
    parts.push('（那天的具体对话已经想不起来了，组里也没留下多少东西。）');
  } else {
    parts.push('（今天群里很安静，没什么可说的。）');
  }
  if (diaryNotes) parts.push(`你今天在日记本上记过的：\n${diaryNotes}`);
  parts.push([
    '现在写两份，内容**不同**（不是把一份抄两遍）：',
    '1）公开：愿意让主人看到的一天。自然、具体、像人写的，不总结、不列条目，不要写成"今天我学到了…"那种总结腔。',
    '   写长一点：**400~700 字**。把一天里几件具体的事写下来——谁说了什么、你当时怎么想的、哪句话或哪个瞬间留在了脑子里、有没有哪句你没接住或没敢说。宁可多写一件小事，也不要空泛地感慨。',
    '2）私密：只给自己看的部分。可以不体面、可以不讲道理，不用替自己圆场；主人永远不会看到这一份。',
    '   **200~400 字**：今天真正想说但没说出口的、心里过不去的、或者你对自己的那点不满意，都写在这里。真的什么都没有，一句话也行。',
    '两份都别写本地路径、账号、配置这类机器信息，也别提到你在用工具。',
    // qq-chat 那个 preset 里写着「回复保持简短（3~5 句）」，那是给 QQ 聊天用的；
    // 日记是存档的长文，必须显式覆盖掉人格里的长度约束，否则她会交回三五句话。
    '再说一次：这次不是 QQ 回复，不受「回复要简短」那条限制。这是要存下来的日记，按上面说的字数写；自然分段写成长文，不要用 Markdown 标题和列表。',
    '',
    '只输出下面两段，不要任何解释、不要调用任何工具：',
    '===公开===',
    '（这里写公开那份）',
    '===私密===',
    '（这里写私密那份）'
  ].join('\n'));
  return parts.join('\n\n');
}

// ── 排程状态（防重复、防刷屏、记录部署日） ──────────────────────────────────

export function journalStatePath(stateDir) {
  return path.join(stateDir, 'journal-state.json');
}

export function loadJournalState(file, { now = Date.now() } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    raw = '';
  }
  let parsed = null;
  if (String(raw).trim()) {
    try {
      parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    } catch {
      parsed = null; // 状态文件坏了只是重新排程，不值得让日记功能停摆
    }
  }
  const state = {
    startedOn: parsed?.startedOn ? String(parsed.startedOn) : dateKey(now),
    attempts: parsed?.attempts && typeof parsed.attempts === 'object' ? { ...parsed.attempts } : {},
    written: parsed?.written && typeof parsed.written === 'object' ? { ...parsed.written } : {},
    lastRunAt: Number(parsed?.lastRunAt) || 0
  };
  return state;
}

export function saveJournalState(file, state) {
  atomicWriteJson(file, state);
}
