/**
 * dsh-diary —— 客户端半边：设置页里的「日记」。
 *
 * 三条自我约束（照抄 dsh-memory-board 踩出来的规矩）：
 *   ① 只依赖 `react` 与 `--dsw-alias-*` 主题令牌，**不 import 任何 Harness Client 包**
 *      —— 那些接口会变，而一个纯 JS 插件没有类型检查，升级后最坏是样式退化，不会白屏；
 *   ② 渲染一律"软失败"：字段缺了就显示"（读不到）"，接口出错显示一行错误，不抛到 slot 里；
 *   ③ 所有写操作都走 Host（带指纹守卫 + 改前备份），这边只负责把人的字原样送过去。
 */
window.__ModuleLoader__.load({
  id: 'dsh-diary',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useState } = React;

    const API = '/api/diary';
    const MISSING = '（读不到）';

    const TABS = [
      { id: 'overview', label: '概览' },
      { id: 'public', label: '公开日记' },
      { id: 'private', label: '私密日记' },
      { id: 'memory', label: '记忆' },
      { id: 'search', label: '搜索' },
      { id: 'backups', label: '备份' }
    ];

    // ── 样式：只用主题令牌，取不到就用中性色兜底 ──────────────────────────────
    const C = {
      fg: 'var(--dsw-alias-text-1, #e6e6e6)',
      dim: 'var(--dsw-alias-text-3, #9aa0a6)',
      line: 'var(--dsw-alias-border-1, #333)',
      card: 'var(--dsw-alias-bg-2, #1b1c1f)',
      accent: 'var(--dsw-alias-brand-1, #4f8cff)',
      danger: 'var(--dsw-alias-danger-1, #e5534b)'
    };
    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 12, color: C.fg, fontSize: 13 },
      tabs: { display: 'flex', gap: 4, flexWrap: 'wrap', borderBottom: `1px solid ${C.line}`, paddingBottom: 8 },
      tab: { padding: '4px 10px', borderRadius: 6, cursor: 'pointer', color: C.dim, background: 'transparent', border: 'none' },
      tabOn: { padding: '4px 10px', borderRadius: 6, cursor: 'pointer', color: '#fff', background: C.accent, border: 'none' },
      row: { display: 'flex', gap: 10, alignItems: 'flex-start' },
      col: { display: 'flex', flexDirection: 'column', gap: 8 },
      list: { width: 180, maxHeight: 420, overflow: 'auto', borderRight: `1px solid ${C.line}`, paddingRight: 8 },
      item: { padding: '5px 8px', borderRadius: 6, cursor: 'pointer', color: C.dim },
      itemOn: { padding: '5px 8px', borderRadius: 6, cursor: 'pointer', color: '#fff', background: 'rgba(79,140,255,.18)' },
      pane: { flex: 1, minWidth: 0 },
      card: { background: C.card, border: `1px solid ${C.line}`, borderRadius: 8, padding: '10px 12px', marginBottom: 10 },
      kv: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '2px 0' },
      btn: { padding: '4px 12px', borderRadius: 6, border: `1px solid ${C.line}`, background: 'transparent', color: C.fg, cursor: 'pointer' },
      btnOn: { padding: '4px 12px', borderRadius: 6, border: `1px solid ${C.accent}`, background: C.accent, color: '#fff', cursor: 'pointer' },
      input: { width: '100%', padding: '6px 8px', borderRadius: 6, border: `1px solid ${C.line}`, background: 'transparent', color: C.fg },
      area: { width: '100%', minHeight: 320, padding: 10, borderRadius: 8, border: `1px solid ${C.line}`, background: 'transparent', color: C.fg, fontFamily: 'inherit', lineHeight: 1.7, resize: 'vertical' },
      meta: { color: C.dim, fontSize: 12 },
      err: { color: C.danger },
      pill: { display: 'inline-block', padding: '1px 8px', borderRadius: 999, border: `1px solid ${C.line}`, color: C.dim, fontSize: 11, marginRight: 6 }
    };

    // ── HTTP ────────────────────────────────────────────────────────────────
    async function api(path, { method = 'GET', body } = {}) {
      try {
        const res = await fetch(`${API}${path}`, {
          method,
          headers: body ? { 'content-type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined
        });
        let data = null;
        try { data = await res.json(); } catch { data = null; }
        return { status: res.status, ok: res.ok, data: data ?? {} };
      } catch (error) {
        return { status: 0, ok: false, data: { reason: 'network', error: String(error?.message ?? error) } };
      }
    }

    function reasonText(result) {
      const r = result?.data?.reason;
      const map = {
        'no-root': '认不出日记项目根：请在插件设置里填 root（或设 DSH_DIARY_ROOT）',
        'read-only': '插件配置里 readOnly=true，写操作不可用',
        'confirm-required': '缺 confirm=yes（这是写操作的第二道闸）',
        'bad-origin': '写操作只接受本机面板的请求',
        'stale-fingerprint': '文件已被别的进程改过（桥接刚写过/别处编辑过），请刷新后再改',
        'changed-since-read': '保存前一刻文件又被改了，请刷新后再改',
        'missing-file': '文件不存在（也许刚被移动/删除）',
        'missing-entry': '找不到这条记忆',
        'verify-failed': '内容校验没通过，已放弃写入',
        'verify-mismatch': '写完复核不一致，已把备份放回去',
        'scope-mismatch': '这条记忆不属于当前作用域',
        network: '请求失败：DSH 服务可能刚重启'
      };
      return map[r] ?? (result?.data?.error || r || `HTTP ${result?.status}`);
    }

    function ErrorLine({ result }) {
      if (!result || result.ok) return null;
      return h('div', { style: styles.err }, `✗ ${reasonText(result)}`);
    }

    function Card({ title, children }) {
      return h('div', { style: styles.card },
        title ? h('div', { style: { fontWeight: 600, marginBottom: 6 } }, title) : null,
        children);
    }

    function KV({ k, v }) {
      return h('div', { style: styles.kv }, h('span', { style: styles.meta }, k), h('span', null, v ?? MISSING));
    }

    // ── 概览 ────────────────────────────────────────────────────────────────
    function OverviewPane({ overview, reload }) {
      if (!overview) return h('div', { style: styles.meta }, '读取中…');
      const j = overview.journals ?? {};
      const m = overview.memory ?? {};
      return h('div', null,
        h(Card, { title: '日记本' },
          h(KV, { k: '公开', v: `${j.public?.count ?? 0} 篇 · 最近 ${j.public?.latest ?? '—'}` }),
          h(KV, { k: '私密', v: `${j.private?.count ?? 0} 篇 · 最近 ${j.private?.latest ?? '—'}` }),
          h(KV, { k: '位置', v: `${overview.publicDir}` })
        ),
        h(Card, { title: '记忆（会变糊的那种）' },
          h(KV, { k: '条目', v: `${m.live ?? 0} 条（回收站 ${m.deleted ?? 0}）` }),
          h(KV, { k: '档位', v: `普通 ${m.byTier?.normal ?? 0} / 重要 ${m.byTier?.important ?? 0} / 刻骨铭心 ${m.byTier?.heart ?? 0}` }),
          h(KV, { k: '作用域', v: `群聊 ${m.byScope?.group ?? 0} / 私聊 ${m.byScope?.private ?? 0}` }),
          h(KV, { k: '搁着 / 模糊临存', v: `${m.shelved ?? 0} / ${m.faded ?? 0}` }),
          overview.memoryOk === false ? h('div', { style: styles.err }, `记忆文件读不了：${overview.memoryReason}`) : null
        ),
        h(Card, { title: '写日记的素材' },
          h(KV, { k: '聊天流水', v: `${overview.chatLog?.days ?? 0} 天 · 最近 ${overview.chatLog?.latest ?? '—'}` }),
          h('div', { style: styles.meta }, '桥接每天 23:30 用这份流水按小时取样，写成两份日记文件。')
        ),
        h(ScopeCard, null),
        h(Card, { title: '备份' },
          h(KV, { k: '份数', v: `${overview.backups?.count ?? 0}` }),
          h(KV, { k: '占用', v: `${((overview.backups?.bytes ?? 0) / 1024).toFixed(1)} KB` }),
          h('div', { style: { marginTop: 8 } }, h('button', { style: styles.btn, onClick: reload }, '刷新'))
        )
      );
    }

    // ── 位置（作用范围） ────────────────────────────────────────────────────
    // 数据根决定日记默认放在哪、面板允许写哪棵子树；项目根决定 config.json 与 state 从哪读。
    function ScopeCard() {
      const [info, setInfo] = useState(null);
      const [root, setRoot] = useState('');
      const [project, setProject] = useState('');
      const [result, setResult] = useState(null);

      const load = useCallback(async () => {
        const res = await api('/info');
        setInfo(res.data);
        setRoot(res.data?.root ?? '');
        setProject(res.data?.project ?? '');
      }, []);
      useEffect(() => { load(); }, [load]);

      const save = useCallback(async () => {
        const res = await api('/scope', {
          method: 'POST',
          body: { root: root.trim(), project: project.trim(), confirm: 'yes' }
        });
        setResult(res);
        if (res.ok) await load();
      }, [root, project, load]);

      return h(Card, { title: '位置（作用范围）' },
        h('div', { style: styles.meta }, '数据根：日记文件所在，也是面板允许写的那棵子树（要含 日记/ 与 日记-私密/）。'),
        h('input', { style: { ...styles.input, marginTop: 6 }, value: root, onChange: (e) => setRoot(e.target.value), placeholder: 'C:\\deepseek' }),
        h('div', { style: { ...styles.meta, marginTop: 8 } }, '项目根：config.json 与 state/ 所在（要含 config.json 与 src/diary-core.js）。'),
        h('input', { style: { ...styles.input, marginTop: 6 }, value: project, onChange: (e) => setProject(e.target.value), placeholder: 'C:\\deepseek\\qqbot' }),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 } },
          h('button', { style: styles.btnOn, onClick: save }, '切换到这个范围'),
          h('span', { style: styles.meta }, `当前来源：${info?.origin ?? '—'}`)
        ),
        h(ErrorLine, { result }),
        result?.ok ? h('div', { style: styles.meta }, '已切换（记在 ~/.dsh/diary-panel.json，机器本地生效）') : null,
        info && info.ok === false
          ? h('div', { style: styles.err }, `认不出：${(info.tried ?? []).map((t) => `${t.origin} root=${t.root ?? '—'}（缺 ${t.rootMissing?.join('、') || '无'}）/ project=${t.project ?? '—'}（缺 ${t.projectMissing?.join('、') || '无'}）`).join('；')}`)
          : null
      );
    }

    // ── 日记（公开/私密共用） ────────────────────────────────────────────────
    function JournalPane({ kind, items, loading, onPick, current, onSaved }) {
      const [draft, setDraft] = useState(null);
      const [result, setResult] = useState(null);
      const [busy, setBusy] = useState(false);

      useEffect(() => {
        setDraft(current?.ok ? current.text : null);
        setResult(null);
      }, [current?.date, current?.fingerprint, current?.ok]);

      const save = useCallback(async () => {
        if (!current?.ok || draft == null) return;
        setBusy(true);
        const res = await api('/journal', {
          method: 'POST',
          body: { kind, date: current.date, text: draft, expect: current.fingerprint, confirm: 'yes' }
        });
        setBusy(false);
        setResult(res);
        if (res.ok) onSaved?.();
      }, [current, draft, kind, onSaved]);

      return h('div', { style: styles.row },
        h('div', { style: styles.list },
          loading ? h('div', { style: styles.meta }, '读取中…') : null,
          (items ?? []).map((it) => h('div', {
            key: it.date,
            style: it.date === current?.date ? styles.itemOn : styles.item,
            onClick: () => onPick(it.date)
          }, it.date))
        ),
        h('div', { style: styles.pane },
          !current ? h('div', { style: styles.meta }, '左边选一天') : null,
          current && !current.ok ? h('div', { style: styles.meta }, `这篇读不到：${current.reason}`) : null,
          current?.ok ? h('div', null,
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 } },
              h('div', { style: styles.meta }, `${current.date} · ${(current.bytes / 1024).toFixed(1)} KB · 改于 ${new Date(current.mtime).toLocaleString()}`),
              h('div', { style: { display: 'flex', gap: 8 } },
                h('button', { style: styles.btn, onClick: () => setDraft(current.text) }, '还原'),
                h('button', { style: busy ? styles.btn : styles.btnOn, disabled: busy, onClick: save }, busy ? '保存中…' : '保存')
              )
            ),
            h('textarea', {
              style: styles.area,
              value: draft ?? '',
              onChange: (e) => setDraft(e.target.value),
              spellCheck: false
            }),
            h('div', { style: { marginTop: 8 } },
              h(ErrorLine, { result }),
              result?.ok ? h('div', { style: styles.meta }, `已保存${result.data.changed ? '' : '（内容没变）'}${result.data.backup ? '，旧版已备份' : ''}`) : null,
              h('div', { style: styles.meta }, '保存走指纹守卫：如果这期间她刚写过这篇，会拒绝而不是覆盖。')
            )
          ) : null
        )
      );
    }

    // ── 记忆 ────────────────────────────────────────────────────────────────
    function MemoryPane() {
      const [scope, setScope] = useState('all');
      const [data, setData] = useState(null);
      const [picked, setPicked] = useState(null);
      const [mood, setMood] = useState('');
      const [unsaid, setUnsaid] = useState('');
      const [result, setResult] = useState(null);

      const load = useCallback(async () => {
        const res = await api(`/memory?scope=${scope}&limit=200`);
        setData(res.data);
      }, [scope]);

      useEffect(() => { load(); }, [load]);

      const open = useCallback(async (id) => {
        const res = await api(`/entry?id=${encodeURIComponent(id)}`);
        setPicked(res.data?.ok ? res.data : null);
        setMood(res.data?.entry?.mood ?? '');
        setUnsaid(res.data?.entry?.unsaid ?? '');
        setResult(null);
      }, []);

      const save = useCallback(async () => {
        if (!picked?.entry) return;
        const res = await api('/entry', {
          method: 'POST',
          body: {
            id: picked.entry.id,
            mood: mood === '' ? null : mood,
            unsaid: unsaid === '' ? null : unsaid,
            expect: picked.fingerprint,
            confirm: 'yes'
          }
        });
        setResult(res);
        if (res.ok) { await open(picked.entry.id); await load(); }
      }, [picked, mood, unsaid, load, open]);

      return h('div', { style: styles.row },
        h('div', { style: styles.list },
          h('div', { style: { display: 'flex', gap: 4, marginBottom: 6 } },
            ['all', 'group', 'private'].map((s) => h('button', {
              key: s,
              style: scope === s ? styles.btnOn : styles.btn,
              onClick: () => { setScope(s); setPicked(null); }
            }, s === 'all' ? '全部' : s === 'group' ? '群聊' : '私聊'))
          ),
          (data?.entries ?? []).map((e) => h('div', {
            key: e.id,
            style: picked?.entry?.id === e.id ? styles.itemOn : styles.item,
            onClick: () => open(e.id)
          }, `${e.date} ${e.tierLabel}${e.mood ? `｜${e.mood}` : ''}`))
        ),
        h('div', { style: styles.pane },
          data && data.ok === false ? h('div', { style: styles.err }, `记忆文件读不了：${data.reason}`) : null,
          !picked ? h('div', { style: styles.meta }, '左边选一条记忆') : null,
          picked?.entry ? h('div', null,
            h('div', { style: { marginBottom: 8 } },
              h('span', { style: styles.pill }, picked.entry.scopeLabel),
              h('span', { style: styles.pill }, picked.entry.tierLabel),
              h('span', { style: styles.pill }, `还剩 ${picked.entry.remainingDays} 天`)
            ),
            h(Card, { title: '正文（只读）' },
              h('div', { style: { whiteSpace: 'pre-wrap', lineHeight: 1.7 } }, picked.entry.text)
            ),
            h(Card, { title: '心情' },
              h('input', { style: styles.input, value: mood ?? '', onChange: (e) => setMood(e.target.value), placeholder: '她当时的心情' })
            ),
            h(Card, { title: '当时想说但没说出口的话' },
              h('input', { style: styles.input, value: unsaid ?? '', onChange: (e) => setUnsaid(e.target.value), placeholder: '没敢说出口的那句' })
            ),
            h('button', { style: styles.btnOn, onClick: save }, '保存心情与没说出口的话'),
            h('div', { style: { marginTop: 8 } },
              h(ErrorLine, { result }),
              result?.ok ? h('div', { style: styles.meta }, '已保存，旧版已备份') : null,
              h('div', { style: styles.meta }, '记忆的正文不给改：那条线是「会变糊、会遗忘」，改了就没有意义了。')
            )
          ) : null
        )
      );
    }

    // ── 搜索 ────────────────────────────────────────────────────────────────
    function SearchPane() {
      const [q, setQ] = useState('');
      const [res, setRes] = useState(null);
      const run = useCallback(async () => {
        if (!q.trim()) { setRes(null); return; }
        const r = await api(`/search?q=${encodeURIComponent(q)}&limit=60`);
        setRes(r.data);
      }, [q]);
      return h('div', { style: styles.col },
        h('div', { style: { display: 'flex', gap: 8 } },
          h('input', {
            style: styles.input, value: q, placeholder: '搜日记正文、记忆正文/心情/没敢说的话',
            onChange: (e) => setQ(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') run(); }
          }),
          h('button', { style: styles.btnOn, onClick: run }, '搜索')
        ),
        res && res.ok === false ? h('div', { style: styles.err }, `搜索失败：${res.reason}`) : null,
        res?.ok ? h('div', { style: styles.meta }, `命中 ${res.hits.length} 条${res.truncated ? '（已截断）' : ''}`) : null,
        (res?.hits ?? []).map((hit, i) => h(Card, { key: `${hit.kind}-${hit.date ?? hit.id}-${i}`, title: hit.label },
          h('div', { style: { lineHeight: 1.7 } }, hit.snippet)
        ))
      );
    }

    // ── 备份 ────────────────────────────────────────────────────────────────
    function BackupPane({ onRestored }) {
      const [items, setItems] = useState([]);
      const [result, setResult] = useState(null);
      const load = useCallback(async () => {
        const res = await api('/backups?limit=200');
        setItems(res.data?.items ?? []);
      }, []);
      useEffect(() => { load(); }, [load]);

      const restore = useCallback(async (name) => {
        const target = items.find((x) => x.name === name)?.target;
        if (!target) return setResult({ ok: false, data: { reason: 'bad-backup-target' } });
        // 恢复同样要指纹：先读当前文件拿指纹（读不到说明原文件没了，直接拒）
        const cur = await api(`/journal?kind=${target.includes('私密') ? 'private' : 'public'}&date=${target.slice(-13, -3)}`);
        const expect = cur.data?.fingerprint;
        if (!expect) return setResult({ ok: false, data: { reason: 'missing-file' } });
        const res = await api('/restore', { method: 'POST', body: { name, expect, confirm: 'yes' } });
        setResult(res);
        if (res.ok) { await load(); onRestored?.(); }
      }, [items, load, onRestored]);

      return h('div', { style: styles.col },
        h('div', { style: styles.meta }, '每次由面板写入前都会自动备份旧版。恢复也走指纹守卫：原文件被别人改过就拒绝。'),
        h(ErrorLine, { result }),
        result?.ok ? h('div', { style: styles.meta }, '已从备份恢复，并又留了一份"恢复前"的备份') : null,
        items.length === 0 ? h('div', { style: styles.meta }, '还没有备份') : null,
        items.map((it) => h(Card, { key: it.name, title: it.target ?? it.name },
          h('div', { style: styles.meta }, `${(it.bytes / 1024).toFixed(1)} KB · ${new Date(it.mtime).toLocaleString()}`),
          h('div', { style: { marginTop: 6 } },
            h('button', { style: styles.btn, onClick: () => restore(it.name) }, '恢复这一份')
          )
        ))
      );
    }

    // ── 主面板 ──────────────────────────────────────────────────────────────
    function DiaryPanel() {
      const [tab, setTab] = useState('overview');
      const [overview, setOverview] = useState(null);
      const [journals, setJournals] = useState({ public: [], private: [] });
      const [current, setCurrent] = useState(null);
      const [loading, setLoading] = useState(false);
      const [info, setInfo] = useState(null);

      const loadOverview = useCallback(async () => {
        const res = await api('/overview');
        setOverview(res.data);
        setInfo(res.data);
      }, []);

      const loadJournals = useCallback(async (kind) => {
        setLoading(true);
        const res = await api(`/journals?kind=${kind}&limit=120`);
        setLoading(false);
        setJournals((prev) => ({ ...prev, [kind]: res.data?.items ?? [] }));
      }, []);

      useEffect(() => { loadOverview(); }, [loadOverview]);
      useEffect(() => {
        if (tab === 'public' || tab === 'private') {
          loadJournals(tab);
          setCurrent(null);
        }
      }, [tab, loadJournals]);

      const pick = useCallback(async (date) => {
        const res = await api(`/journal?kind=${tab}&date=${date}`);
        setCurrent(res.data);
      }, [tab]);

      const body = (() => {
        if (tab === 'overview') return h(OverviewPane, { overview, reload: loadOverview });
        if (tab === 'public' || tab === 'private') {
          return h(JournalPane, {
            kind: tab,
            items: journals[tab],
            loading,
            onPick: pick,
            current,
            onSaved: () => { pick(current?.date); loadOverview(); }
          });
        }
        if (tab === 'memory') return h(MemoryPane, null);
        if (tab === 'search') return h(SearchPane, null);
        return h(BackupPane, { onRestored: loadOverview });
      })();

      return h('div', { style: styles.wrap },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 } },
          h('div', { style: { fontWeight: 700, fontSize: 15 } }, '日记'),
          h('div', { style: styles.meta }, info?.root ? `根目录：${info.root}${info.readOnly ? '（只读）' : ''}` : MISSING)
        ),
        info && info.ok === false ? h('div', { style: styles.err }, `认不出日记项目根：${info.tried?.map((t) => `${t.origin}:${t.path}（缺 ${t.missing?.join('、')}）`).join('；')}`) : null,
        h('div', { style: styles.tabs },
          TABS.map((t) => h('button', {
            key: t.id,
            style: tab === t.id ? styles.tabOn : styles.tab,
            onClick: () => setTab(t.id)
          }, t.label))
        ),
        body
      );
    }

    // ── 注册 ────────────────────────────────────────────────────────────────
    return {
      inject: ['slots'],
      apply(ctx) {
        // 只在 apply 的同步阶段碰已 inject 的 slots；别的服务一律不读（读了会抛，整页打不开）
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'diary', order: 121, label: '日记' },
            DiaryPanel
          )
        );
        try {
          console.info('[dsh-diary] 已注册设置页「日记」（id=diary / order=121）');
        } catch {
          /* 没有控制台也要活 */
        }
      }
    };
  }
});
