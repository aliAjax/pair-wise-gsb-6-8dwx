import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  AlertTriangle,
  BookOpen,
  ChevronDown,
  Download,
  Grid3X3,
  Heart,
  Monitor,
  Plus,
  RotateCcw,
  Settings2,
  SlidersHorizontal,
  Smartphone,
  Star,
  Tablet,
  Trash2,
  Type,
} from 'lucide-react';
import {TIERS, TIER_MAP, pendingAll, pendingMeasure, tierForViewport} from './breakpoints';
import ConflictModal from './ConflictModal';
import {FIELD_LABELS} from './constants';
import {buildCss} from './export';
import MeasureRig from './MeasureRig';
import {tierSignature} from './measure';
import StageDocument from './StageDocument';
import {
  FONT_DEFAULT,
  STORE_KEY,
  commitMeasuresBatch,
  extractValues,
  mutatePairs,
  readStore,
  tryCommit,
  writeStore,
} from './store';
import type {
  ContentField,
  ContentValues,
  Measure,
  Measures,
  Pair,
  PairV1,
  StoreData,
  TierId,
} from './types';

const fonts = ['Fraunces', 'DM Sans', 'Space Grotesk', 'Newsreader', 'IBM Plex Sans', 'Playfair Display'];

const seedV1: PairV1[] = [
  {id: 1, title: 'Editorial calm', heading: 'A slower way to see', body: 'Good typography creates space for ideas to breathe. Pair a confident display face with a quiet, generous text face.', category: 'Editorial', favorite: true},
  {id: 2, title: 'Studio notes', heading: 'Make room for the unexpected', body: 'A thoughtful pairing can add rhythm to even the simplest interface. Try contrast in shape, not just size.', category: 'Portfolio', favorite: false},
  {id: 3, title: 'Field guide', heading: 'Small details, lasting impressions', body: 'Typography is the voice of a page. Find a combination that feels clear, warm and distinctly yours.', category: 'Brand', favorite: false},
];

interface DraftBase {
  base: ContentValues;
  rev: number;
}

interface ConflictState {
  conflicts: ContentField[];
  /** 解决后以此为新 base 提交（=对方已提交值） */
  remoteBase: ContentValues;
  rev: number;
  local: ContentValues;
}

interface Retouch {
  tier: TierId;
  n: number;
  scope: 'all' | 'active';
}

type MeasurePatch = {pairId: number; tier: TierId; measure: Measure};

function initialData(): StoreData {
  if (localStorage.getItem(STORE_KEY) === null) {
    // 首次使用：灌入种子数据（带待测测量记录）
    return mutatePairs(() =>
      seedV1.map((p) => ({
        ...FONT_DEFAULT,
        id: p.id,
        title: p.title,
        heading: p.heading,
        body: p.body,
        category: p.category,
        favorite: p.favorite,
        measures: pendingAll('queued'),
      })),
    );
  }
  // 旧数据升级：迁移/规范化后落盘，补齐三档测量记录
  const migrated = readStore();
  const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
  if (raw.version !== 2) {
    writeStore(migrated);
  }
  return migrated;
}

export default function App() {
  const [data, setData] = useState<StoreData>(initialData);
  const [selected, setSelected] = useState<number>(() => readStore().pairs[0]?.id ?? 1);
  const [drafts, setDrafts] = useState<Record<number, ContentValues>>({});
  const [draftBase, setDraftBase] = useState<Record<number, DraftBase>>({});
  const [liveMeasures, setLiveMeasures] = useState<Record<number, Measures>>({});
  const [activeTier, setActiveTier] = useState<TierId>(() => tierForViewport(window.innerWidth));
  const [manualTier, setManualTier] = useState(false);
  const [retouch, setRetouch] = useState<Retouch | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [remoteMissing, setRemoteMissing] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newTitle, setNewTitle] = useState('');

  const flushTimer = useRef<number | null>(null);
  const buffer = useRef(new Map<string, MeasurePatch>());
  const valuesRef = useRef<Record<number, ContentValues>>({});

  const current = data.pairs.find((p) => p.id === selected) ?? data.pairs[0];
  const draft = current ? drafts[current.id] : undefined;
  const isDirty = !!draft;
  const values: ContentValues = useMemo(
    () => (current ? draft ?? extractValues(current) : ({} as ContentValues)),
    [current, draft],
  );
  valuesRef.current[current?.id ?? -1] = values;

  const shownMeasures: Measures =
    (current && liveMeasures[current.id]) || current?.measures || pendingAll('new');

  const flash = useCallback((msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 2600);
  }, []);

  /* ---------- 测量回写：签名守卫 + 批量持久化 ---------- */
  const handleMeasure = useCallback(
    (pairId: number, tier: TierId, measure: Measure, signature: string) => {
      const currentValues = valuesRef.current[pairId];
      // 测量结果到达时输入可能已经又改过：签名对不上直接丢弃
      if (!currentValues || tierSignature(currentValues, tier) !== signature) return;
      setLiveMeasures((prev) => {
        const old = prev[pairId];
        if (old) {
          const cur = old[tier];
          const fresher =
            measure.status === 'measured' ||
            cur.status !== 'measured' ||
            cur.signature === signature;
          if (!fresher) return prev;
        }
        return {...prev, [pairId]: {...(old || pendingAll('new')), [tier]: measure}};
      });
      if (measure.status === 'measured' && !drafts[pairId]) {
        buffer.current.set(`${pairId}:${tier}`, {pairId, tier, measure});
        if (flushTimer.current === null) {
          flushTimer.current = window.setTimeout(() => {
            const entries = Array.from(buffer.current.values());
            buffer.current.clear();
            flushTimer.current = null;
            if (entries.length === 0) return;
            const next = commitMeasuresBatch(entries);
            if (next) setData(next);
          }, 120);
        }
      }
    },
    [drafts],
  );

  /* ---------- 窗口变化：只重做跨入的那一档（所有配对的该档） ---------- */
  const autoTierRef = useRef(activeTier);
  useEffect(() => {
    const onResize = () => {
      const next = tierForViewport(window.innerWidth);
      if (next !== autoTierRef.current) {
        autoTierRef.current = next;
        setRetouch((r) => ({tier: next, n: (r?.n ?? 0) + 1, scope: 'all'}));
        setActiveTier(next); // 未手动切换时跟随窗口；手动选择也同步校正
        setManualTier(false);
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /* ---------- 跨标签页同步 ---------- */
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORE_KEY || !e.newValue) return;
      const incoming = readStore();
      setData(incoming);
      // 远程测量结果并入实时表（本标签页有草稿的档位不覆盖，由本地实排负责）
      setLiveMeasures((prev) => {
        const next = {...prev};
        for (const p of incoming.pairs) {
          if (drafts[p.id]) continue;
          next[p.id] = p.measures;
        }
        return next;
      });
      const stillExists = incoming.pairs.some((p) => p.id === selected);
      if (!stillExists && current) {
        if (drafts[current.id]) {
          setRemoteMissing(true);
        } else {
          setSelected(incoming.pairs[0]?.id ?? 0);
        }
      }
      flash('已同步另一标签页的更改');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [selected, current, drafts, flash]);

  if (!current) {
    return (
      <div className="app">
        <EmptyShell onAdd={() => setShowAdd(true)} />
      </div>
    );
  }

  /* ---------- 编辑：本地草稿，立即失效相关档位 ---------- */
  const editField = (field: ContentField, value: string | number) => {
    const id = current.id;
    setDrafts((prev) => {
      const next = {...(prev[id] ?? extractValues(current)), [field]: value};
      // 立即失效：对比新旧签名，只让真正受影响的档位变待测（携带新输入签名拦截旧回报）
      const old = prev[id] ?? extractValues(current);
      const mask: Measures = {} as Measures;
      for (const spec of TIERS) {
        mask[spec.id] =
          tierSignature(next, spec.id) !== tierSignature(old, spec.id)
            ? pendingMeasure('dirty', tierSignature(next, spec.id))
            : liveMeasures[id]?.[spec.id] ?? current.measures[spec.id];
      }
      setLiveMeasures((lm) => ({...lm, [id]: mask}));
      return {...prev, [id]: next};
    });
    setDraftBase((prev) =>
      prev[id]
        ? prev
        : {
            ...prev,
            [id]: {base: extractValues(current), rev: data.rev},
          },
    );
  };

  const save = (override?: ContentValues, overrideBase?: {base: ContentValues; rev: number}) => {
    const id = current.id;
    const local = override ?? drafts[id];
    const baseInfo =
      overrideBase ?? draftBase[id] ?? {base: extractValues(current), rev: data.rev};
    if (!local) return;
    const res = tryCommit({pairId: id, base: baseInfo.base, baseRev: baseInfo.rev, values: local});
    if (res.ok && res.data) {
      setData(res.data);
      setDrafts((d) => {
        const n = {...d};
        delete n[id];
        return n;
      });
      setDraftBase((b) => {
        const n = {...b};
        delete n[id];
        return n;
      });
      setConflict(null);
      setRemoteMissing(false);
      setLiveMeasures((lm) => ({...lm, [id]: res.data!.pairs.find((p) => p.id === id)!.measures}));
      flash('已保存，三档按新输入重测');
    } else if (res.reason === 'conflict') {
      setConflict({conflicts: res.conflicts!, remoteBase: res.remote!, rev: res.rev, local});
    } else if (res.reason === 'missing') {
      setRemoteMissing(true);
    }
  };

  const resolveConflict = (picks: Partial<Record<ContentField, string | number>>) => {
    if (!conflict) return;
    // 以对方已提交值为新 base：用户选择的字段相对 base 有改动，其余沿用对方
    save({...conflict.remoteBase, ...picks}, {base: conflict.remoteBase, rev: conflict.rev});
  };

  const revert = () => {
    const id = current.id;
    setDrafts((d) => {
      const n = {...d};
      delete n[id];
      return n;
    });
    setDraftBase((b) => {
      const n = {...b};
      delete n[id];
      return n;
    });
    setLiveMeasures((lm) => ({...lm, [id]: current.measures}));
  };

  const toggleFav = () => {
    setData(mutatePairs((ps) => ps.map((p) => (p.id === current.id ? {...p, favorite: !p.favorite} : p))));
  };

  const create = () => {
    if (!newTitle.trim()) return;
    const id = Date.now();
    const pair: Pair = {
      ...FONT_DEFAULT,
      id,
      title: newTitle.trim(),
      heading: 'Your new headline',
      body: 'Start with a sentence that lets your type pairing show its character.',
      category: 'Untitled',
      favorite: false,
      measures: pendingAll('new'),
    };
    setData(mutatePairs((ps) => [...ps, pair]));
    setSelected(id);
    setNewTitle('');
    setShowAdd(false);
  };

  const remove = () => {
    const remaining = data.pairs.filter((p) => p.id !== current.id);
    setData(mutatePairs((ps) => ps.filter((p) => p.id !== current.id)));
    setDrafts((d) => {
      const n = {...d};
      delete n[current.id];
      return n;
    });
    setSelected(remaining[0]?.id ?? 0);
  };

  const saveAsNew = () => {
    const id = Date.now();
    const pair: Pair = {...current, ...drafts[current.id], id, title: `${values.title} 副本`, measures: pendingAll('new')};
    setData(mutatePairs((ps) => [...ps, pair]));
    setSelected(id);
    setConflict(null);
    setRemoteMissing(false);
    revert();
  };

  const exportCss = () => {
    const exportPair: Pair = {...current, ...(draft ?? {}), measures: shownMeasures};
    const css = buildCss(exportPair);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([css], {type: 'text/css'}));
    a.download = 'type-pair.css';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const pickTier = (tier: TierId) => {
    setManualTier(true);
    setActiveTier(tier);
    // 手动切档只让当前配对的这一档重新校验，不动另外两档
    setRetouch((r) => ({tier, n: (r?.n ?? 0) + 1, scope: 'active'}));
  };

  const tierSpec = TIER_MAP[activeTier];

  return (
    <div className="app">
      {/* 全部配对的三档实排测量台（屏幕外固定宽度，不受预览缩放影响） */}
      {data.pairs.map((p) => {
        const rigDraft = drafts[p.id];
        const rigValues = rigDraft ?? extractValues(p);
        const rigMeasures = liveMeasures[p.id] ?? p.measures;
        const rigRetouch =
          retouch && (retouch.scope === 'all' || p.id === current.id) ? retouch : null;
        return (
          <MeasureRig
            key={p.id}
            pairId={p.id}
            values={rigValues}
            measures={rigMeasures}
            retouch={rigRetouch}
            onMeasure={handleMeasure}
          />
        );
      })}

      <aside>
        <div className="brand">
          <div className="brand-mark"><Type size={18} /></div>
          <div><b>Type Pairer</b><small>FIND YOUR VOICE</small></div>
        </div>
        <div className="nav-section">
          <span>LIBRARY</span>
          <button className="nav active"><Grid3X3 size={16} />All pairings <b>{data.pairs.length}</b></button>
          <button className="nav"><Heart size={16} />Favorites <b>{data.pairs.filter((p) => p.favorite).length}</b></button>
        </div>
        <div className="aside-foot">
          <button className="nav"><Settings2 size={16} />Preferences</button>
          <div className="profile">
            <div className="avatar">YL</div>
            <div><b>Yuki Lin</b><small>Design workspace</small></div>
            <ChevronDown size={14} />
          </div>
        </div>
      </aside>

      <main>
        <header>
          <div>
            <div className="crumb">TYPE LIBRARY / <b>PAIRING STUDIO</b></div>
            <h1>Find the right conversation.</h1>
            <p>三档实排、即时失效重测，字号字距与样例文字跨标签页安全合并。</p>
          </div>
          <div className="actions">
            <button className="outline" onClick={exportCss}><Download size={15} />导出 CSS</button>
            <button className="primary" onClick={() => setShowAdd(true)}><Plus size={16} />New pairing</button>
          </div>
        </header>

        {notice && <div className="notice">{notice}</div>}
        {remoteMissing && (
          <div className="conflict-banner">
            <AlertTriangle size={14} />
            该配对已在另一标签页被删除，当前草稿尚未提交。
            <button className="link" onClick={saveAsNew}>保存为新配对</button>
            <button className="link" onClick={revert}>放弃草稿</button>
          </div>
        )}

        <div className="layout">
          <section className="gallery">
            <div className="gallery-head">
              <div><h2>Saved pairings</h2><span>{data.pairs.length} compositions</span></div>
              <div className="view-toggle">
                <button className="on"><Grid3X3 size={14} /></button>
                <button><BookOpen size={14} /></button>
              </div>
            </div>
            <div className="pair-list">
              {data.pairs.map((p) => {
                const m = liveMeasures[p.id]?.desktop ?? p.measures.desktop;
                return (
                  <button
                    key={p.id}
                    className={selected === p.id ? 'pair selected' : 'pair'}
                    onClick={() => setSelected(p.id)}
                  >
                    <div className="pair-top">
                      <span>{p.category}</span>
                      <Heart size={15} fill={p.favorite ? '#e88769' : 'none'} color={p.favorite ? '#e88769' : '#aeb5b7'} />
                    </div>
                    <strong style={{fontFamily: String(p.headingFont)}}>{p.heading}</strong>
                    <p style={{fontFamily: String(p.bodyFont)}}>{p.body}</p>
                    <div className="pair-foot">
                      <span>{p.title}{drafts[p.id] ? ' · 未保存' : ''}</span>
                      <small className={m.status === 'pending' ? 'measure-pending' : m.overflow ? 'measure-bad' : 'measure-ok'}>
                        {m.status === 'pending'
                          ? `桌面待测${m.pendingReason === 'font-loading' ? '·字体加载中' : ''}`
                          : `桌面 ${m.headingLines}/${m.bodyLines} 行${m.overflow ? ' · 溢出' : ''}`}
                      </small>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="studio">
            <div className="studio-head">
              <div>
                <span>PAIRING CANVAS{isDirty && <em className="dirty-tag">有未保存改动</em>}</span>
                <h2>{values.title}</h2>
              </div>
              <button className="favorite" onClick={toggleFav}>
                <Star size={16} fill={current.favorite ? '#e5a35e' : 'none'} color={current.favorite ? '#e5a35e' : '#98a4a7'} />
              </button>
            </div>

            <div className="canvas">
              <div className="canvas-bar">
                <span>PREVIEW · {tierSpec.width}px</span>
                <div className="tier-tabs">
                  <button className={activeTier === 'desktop' ? 'active' : ''} onClick={() => pickTier('desktop')}><Monitor size={12} />桌面</button>
                  <button className={activeTier === 'tablet' ? 'active' : ''} onClick={() => pickTier('tablet')}><Tablet size={12} />平板</button>
                  <button className={activeTier === 'mobile' ? 'active' : ''} onClick={() => pickTier('mobile')}><Smartphone size={12} />手机</button>
                </div>
              </div>
              <PreviewShell
                tier={activeTier}
                values={values}
                measure={shownMeasures[activeTier]}
              />
            </div>

            <div className="measure-row">
              {TIERS.map((spec) => (
                <MeasureCard
                  key={spec.id}
                  tier={spec.id}
                  label={spec.label}
                  width={spec.width}
                  measure={shownMeasures[spec.id]}
                  active={activeTier === spec.id}
                  onClick={() => pickTier(spec.id)}
                />
              ))}
            </div>

            <div className="controls">
              <div className="control-head">
                <div><span>TYPE CONTROLS</span><h3>Fine tune your pairing</h3></div>
                <SlidersHorizontal size={17} />
              </div>
              <div className="sample-row">
                <label>标题样例
                  <input value={values.heading} onChange={(e) => editField('heading', e.target.value)} />
                </label>
                <label>正文样例
                  <textarea rows={2} value={values.body} onChange={(e) => editField('body', e.target.value)} />
                </label>
              </div>
              <div className="font-row">
                <label>标题字体
                  <select value={values.headingFont} onChange={(e) => editField('headingFont', e.target.value)}>
                    {fonts.map((f) => <option key={f}>{f}</option>)}
                  </select>
                </label>
                <label>正文字体
                  <select value={values.bodyFont} onChange={(e) => editField('bodyFont', e.target.value)}>
                    {fonts.map((f) => <option key={f}>{f}</option>)}
                  </select>
                </label>
              </div>
              <div className="range-row">
                <label>Size <b>{values.size}px</b>
                  <input type="range" min="28" max="76" value={Number(values.size)} onChange={(e) => editField('size', Number(e.target.value))} />
                </label>
                <label>Weight <b>{values.weight}</b>
                  <input type="range" min="300" max="800" step="100" value={Number(values.weight)} onChange={(e) => editField('weight', Number(e.target.value))} />
                </label>
              </div>
              <div className="range-row">
                <label>Line height <b>{Number(values.leading).toFixed(2)}</b>
                  <input type="range" min="1" max="1.8" step=".05" value={Number(values.leading)} onChange={(e) => editField('leading', Number(e.target.value))} />
                </label>
                <label>Letter spacing <b>{values.tracking}px</b>
                  <input type="range" min="-1" max="3" step=".5" value={Number(values.tracking)} onChange={(e) => editField('tracking', Number(e.target.value))} />
                </label>
              </div>
            </div>

            <div className="studio-foot">
              <button className="delete" onClick={remove}><Trash2 size={15} />Delete pairing</button>
              <div className="foot-actions">
                <button className="revert" onClick={revert} disabled={!isDirty}><RotateCcw size={13} />还原</button>
                <button className="save" onClick={() => save()} disabled={!isDirty}>
                  {isDirty ? '保存（提交时检测字段冲突）' : '已是最新保存版本'}
                </button>
              </div>
            </div>
          </section>
        </div>
      </main>

      {conflict && (
        <ConflictModal
          conflicts={conflict.conflicts}
          base={conflict.remoteBase}
          remote={conflict.remoteBase}
          local={conflict.local}
          onResolve={resolveConflict}
          onCancel={() => setConflict(null)}
        />
      )}

      {showAdd && (
        <div className="backdrop" onClick={() => setShowAdd(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>New pairing</h2>
            <label>Pairing name
              <input autoFocus value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="e.g. Quiet confidence" />
            </label>
            <div className="modal-actions">
              <button className="outline" onClick={() => setShowAdd(false)}>Cancel</button>
              <button className="primary" onClick={create}>Create pairing</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- 可见预览（缩放到画布宽度，测量在屏外固定版心上完成） ---------------- */

function PreviewShell({tier, values, measure}: {tier: TierId; values: ContentValues; measure: Measure}) {
  const spec = TIER_MAP[tier];
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setScale(Math.min(1, el.clientWidth / spec.width));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [spec.width]);

  const headingPx = Math.round(Number(values.size) * spec.headingScale);

  return (
    <div className="preview-shell" ref={wrapRef}>
      <div
        className={`preview preview-${tier}${measure.status === 'measured' && measure.overflow ? ' is-overflow' : ''}`}
        style={{
          width: spec.width,
          height: spec.height,
          padding: `0 ${spec.padX}px`,
          transform: `scale(${scale})`,
        }}
      >
        <StageDocument values={values} headingPx={headingPx} />
        {measure.status === 'measured' && measure.overflow && (
          <span className="overflow-flag"><AlertTriangle size={11} />溢出舞台</span>
        )}
      </div>
    </div>
  );
}

function MeasureCard({
  tier,
  label,
  width,
  measure,
  active,
  onClick,
}: {
  tier: TierId;
  label: string;
  width: number;
  measure: Measure;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`measure-card${active ? ' active' : ''}`} onClick={onClick}>
      <div className="mc-head">
        <b>{label}</b>
        <span>{width}px</span>
      </div>
      {measure.status === 'pending' ? (
        <div className="mc-pending">
          待测
          <small>{measure.pendingReason === 'font-loading' ? '字体加载中…' : '等待重测'}</small>
        </div>
      ) : (
        <div className="mc-nums">
          <span><b>{measure.headingLines}</b>标题行</span>
          <span><b>{measure.bodyLines}</b>正文行</span>
          <span className={measure.overflow ? 'mc-bad' : 'mc-ok'}>
            {measure.overflow ? '溢出 ⚠' : '无溢出'}
          </span>
        </div>
      )}
    </button>
  );
}

function EmptyShell({onAdd}: {onAdd: () => void}) {
  return (
    <main style={{padding: 60}}>
      <h1>还没有配对</h1>
      <p>创建一套字体配对开始三档实排。</p>
      <button className="primary" style={{marginTop: 16}} onClick={onAdd}><Plus size={16} />New pairing</button>
    </main>
  );
}
