/**
 * lib/data.js —— 只读：概览 / 日记目录 / 单篇日记 / 记忆条目 / 搜索 / 备份列表。
 *
 * 这里一个字节都不写（写全在 lib/write.js），所以可以被面板随便轮询。
 * 所有列表都按"最近在前"排，并且对坏文件/坏 JSON 保持沉默降级——面板不该因为
 * 一篇日记被手改成乱码就整页打不开。
 */
import fs from 'node:fs';
import path from 'node:path';
import { exists, fingerprint, readText, statOf, targetOfBackup } from './guards.js';
import { journalDirOf, isJournalName } from './paths.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const TIER_LABEL = { normal: '普通', important: '重要', heart: '刻骨铭心' };
const SCOPE_LABEL = { private: '私聊', group: '群聊' };

function iso(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function monthDay(ms) {
  const d = new Date(Number(ms) || Date.now());
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 与 diary-core 同一套寿命公式（只用于显示；真正到期判定在桥接/MCP 那边）。 */
function remainingDaysOf(entry, now = Date.now()) {
  const life = (Number(entry?.baseDays) || 0) + (Number(entry?.extendedDays) || 0);
  const anchor = Number(entry?.anchorAt) || Number(entry?.createdAt) || now;
  let frozen = Number(entry?.frozenMs) || 0;
  if (entry?.shelved && entry.shelved.reason === 'afraid') frozen += Math.max(0, now - Number(entry.shelved.at || now));
  const left = anchor + life * DAY_MS + frozen - now;
  return left <= 0 ? 0 : Math.ceil(left / DAY_MS);
}

export function listJournals(paths, kind, { limit = 60 } = {}) {
  const dir = journalDirOf(paths, kind);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter(isJournalName);
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const file = path.join(dir, name);
      const stat = statOf(file);
      return {
        date: name.slice(0, 10),
        file,
        bytes: stat ? stat.size : 0,
        mtime: stat ? stat.mtime.toISOString() : null
      };
    })
    .filter((item) => item.bytes > 0)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, Math.max(1, Math.min(365, Number(limit) || 60)));
}

export function readJournal(paths, kind, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ''))) return { ok: false, reason: 'bad-date' };
  const file = path.join(journalDirOf(paths, kind), `${date}.md`);
  if (!exists(file)) return { ok: false, reason: 'missing', date };
  const stat = statOf(file);
  return {
    ok: true,
    kind,
    date,
    file,
    bytes: stat ? stat.size : 0,
    mtime: stat ? stat.mtime.toISOString() : null,
    fingerprint: fingerprint(file),
    text: readText(file)
  };
}

// ─────────────────────────────────────────────────────────────── 记忆（state/diary.json）

export function readMemory(paths) {
  const file = paths.memoryFile;
  if (!exists(file)) return { ok: false, reason: 'missing', file };
  let parsed;
  try {
    const raw = readText(file);
    parsed = raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    return { ok: false, reason: 'broken-json', file, error: String(error?.message ?? error) };
  }
  return {
    ok: true,
    file,
    fingerprint: fingerprint(file),
    bytes: statOf(file)?.size ?? 0,
    state: parsed && typeof parsed === 'object' ? parsed : {}
  };
}

export function memoryEntries(paths, { scope = 'all', limit = 80 } = {}) {
  const mem = readMemory(paths);
  if (!mem.ok) return { ok: false, reason: mem.reason, file: mem.file, fingerprint: null, entries: [] };
  const now = Date.now();
  const entries = Object.values(mem.state.entries ?? {})
    .filter((e) => e && (scope === 'all' || (e.scope ?? 'group') === scope))
    .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
    .slice(0, Math.max(1, Math.min(500, Number(limit) || 80)))
    .map((e) => ({
      id: e.id,
      scope: e.scope ?? 'group',
      scopeLabel: SCOPE_LABEL[e.scope ?? 'group'] ?? '群聊',
      tier: e.tier ?? 'normal',
      tierLabel: TIER_LABEL[e.tier ?? 'normal'] ?? '普通',
      date: monthDay(e.createdAt),
      createdAt: iso(e.createdAt),
      mood: e.mood ?? null,
      unsaid: e.unsaid ?? null,
      shortTitle: e.shortTitle ?? String(e.text ?? '').slice(0, 16),
      text: String(e.text ?? ''),
      remainingDays: remainingDaysOf(e, now),
      shelved: e.shelved ? String(e.shelved.reason) : null,
      faded: Boolean(e.faded),
      deleted: Boolean(e.deletedAt)
    }));
  return {
    ok: true,
    file: mem.file,
    fingerprint: mem.fingerprint,
    bytes: mem.bytes,
    total: Object.keys(mem.state.entries ?? {}).length,
    entries
  };
}

export function memoryEntry(paths, id, scope = 'all') {
  const mem = readMemory(paths);
  if (!mem.ok) return { ok: false, reason: mem.reason };
  const entry = mem.state.entries?.[String(id ?? '')];
  if (!entry) return { ok: false, reason: 'missing-entry' };
  const entryScope = entry.scope ?? 'group';
  if (scope !== 'all' && entryScope !== scope) return { ok: false, reason: 'scope-mismatch', scope: entryScope };
  return {
    ok: true,
    fingerprint: mem.fingerprint,
    entry: {
      ...entry,
      scope: entryScope,
      scopeLabel: SCOPE_LABEL[entryScope],
      tierLabel: TIER_LABEL[entry.tier] ?? entry.tier,
      date: monthDay(entry.createdAt),
      remainingDays: remainingDaysOf(entry, Date.now())
    }
  };
}

// ─────────────────────────────────────────────────────────────── 概览

export function overview(paths) {
  const pub = listJournals(paths, 'public', { limit: 400 });
  const priv = listJournals(paths, 'private', { limit: 400 });
  const mem = readMemory(paths);
  const entries = mem.ok ? Object.values(mem.state.entries ?? {}) : [];
  const live = entries.filter((e) => !e.deletedAt);
  const byTier = { normal: 0, important: 0, heart: 0 };
  const byScope = { private: 0, group: 0 };
  let shelved = 0;
  let faded = 0;
  for (const e of live) {
    if (byTier[e.tier] !== undefined) byTier[e.tier] += 1;
    const scope = e.scope ?? 'group';
    if (byScope[scope] !== undefined) byScope[scope] += 1;
    if (e.shelved) shelved += 1;
    if (e.faded) faded += 1;
  }
  let chatLogDays = 0;
  let chatLogLatest = null;
  try {
    const names = fs.readdirSync(paths.chatLogDir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
    chatLogDays = names.length;
    chatLogLatest = names.length ? names[names.length - 1].slice(0, 10) : null;
  } catch {}
  let backupCount = 0;
  let backupBytes = 0;
  try {
    for (const name of fs.readdirSync(paths.backupDir)) {
      backupCount += 1;
      try { backupBytes += statOf(path.join(paths.backupDir, name))?.size ?? 0; } catch {}
    }
  } catch {}
  return {
    ok: true,
    root: paths.root,
    project: paths.project,
    publicDir: paths.publicDir,
    privateDir: paths.privateDir,
    memoryFile: paths.memoryFile,
    memoryOk: mem.ok,
    memoryReason: mem.ok ? null : mem.reason,
    journals: {
      public: { count: pub.length, latest: pub[0]?.date ?? null, bytes: pub.reduce((n, x) => n + x.bytes, 0) },
      private: { count: priv.length, latest: priv[0]?.date ?? null, bytes: priv.reduce((n, x) => n + x.bytes, 0) }
    },
    memory: {
      total: entries.length,
      live: live.length,
      deleted: entries.length - live.length,
      byTier,
      byScope,
      shelved,
      faded
    },
    chatLog: { days: chatLogDays, latest: chatLogLatest },
    backups: { count: backupCount, bytes: backupBytes },
    today: new Date().toISOString().slice(0, 10)
  };
}

// ─────────────────────────────────────────────────────────────── 搜索

/** 全库检索：日记正文 + 记忆条目（正文/心情/没敢说的话）。返回带上下文的片段。 */
export function search(paths, query, { limit = 40, days = 120 } = {}) {
  const q = String(query ?? '').trim().toLowerCase();
  if (q.length < 1) return { ok: true, hits: [], query: q };
  const max = Math.max(1, Math.min(200, Number(limit) || 40));
  const hits = [];

  for (const kind of ['public', 'private']) {
    for (const item of listJournals(paths, kind, { limit: Math.max(1, Math.min(400, Number(days) || 120)) })) {
      const read = readJournal(paths, kind, item.date);
      if (!read.ok) continue;
      const text = read.text;
      const at = text.toLowerCase().indexOf(q);
      if (at < 0) continue;
      hits.push({
        kind: 'journal',
        journalKind: kind,
        date: item.date,
        label: `${kind === 'private' ? '私密' : '公开'}日记 · ${item.date}`,
        snippet: snippetOf(text, at, q.length)
      });
      if (hits.length >= max) return { ok: true, hits, query: q, truncated: true };
    }
  }

  const mem = readMemory(paths);
  if (mem.ok) {
    for (const [id, e] of Object.entries(mem.state.entries ?? {})) {
      const haystack = `${e.shortTitle ?? ''} ${e.text ?? ''} ${e.mood ?? ''} ${e.unsaid ?? ''}`;
      const at = haystack.toLowerCase().indexOf(q);
      if (at < 0) continue;
      hits.push({
        kind: 'memory',
        id,
        scope: e.scope ?? 'group',
        label: `记忆 · ${monthDay(e.createdAt)} · ${TIER_LABEL[e.tier] ?? e.tier}${e.deletedAt ? '（回收站）' : ''}`,
        snippet: snippetOf(haystack, at, q.length)
      });
      if (hits.length >= max) return { ok: true, hits, query: q, truncated: true };
    }
  }
  return { ok: true, hits, query: q };
}

function snippetOf(text, at, length, pad = 24) {
  const start = Math.max(0, at - pad);
  const end = Math.min(text.length, at + length + pad);
  const head = start > 0 ? '…' : '';
  const tail = end < text.length ? '…' : '';
  return `${head}${text.slice(start, end).replace(/\s+/g, ' ')}${tail}`;
}

// ─────────────────────────────────────────────────────────────── 备份

export function listBackups(paths, { limit = 100 } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(paths.backupDir).filter((n) => n.endsWith('.bak'));
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const file = path.join(paths.backupDir, name);
      const stat = statOf(file);
      return {
        name,
        file,
        target: targetOfBackup(name),
        bytes: stat ? stat.size : 0,
        mtime: stat ? stat.mtime.toISOString() : null
      };
    })
    .sort((a, b) => String(b.name).localeCompare(String(a.name)))
    .slice(0, Math.max(1, Math.min(500, Number(limit) || 100)));
}
