import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  AlertTriangle,
  BookOpen,
  Check,
  ChevronDown,
  Download,
  Grid3X3,
  Heart,
  Monitor,
  Plus,
  RefreshCw,
  Settings2,
  SlidersHorizontal,
  Smartphone,
  Star,
  Tablet,
  Trash2,
  Type,
} from 'lucide-react';
import TierFrame from './TierFrame';
import {buildExport, downloadCss} from './exporter';
import {useCrossTabDoc} from './sync';
import {
  buildSignature,
  fieldLabel,
  FONT_LIST,
  formatFieldValue,
  Measurement,
  Pair,
  PairFields,
  TierId,
  tierForViewport,
  TIERS,
  TrackedField,
} from './types';

type Drafts = {size: number; tracking: number; heading: string; body: string};

const tierIcon = {desktop: Monitor, tablet: Tablet, mobile: Smartphone} as const;

const FALLBACK_FIELDS: PairFields = {
  headingFont: 'Fraunces',
  bodyFont: 'DM Sans',
  size: 46,
  weight: 600,
  leading: 1.25,
  tracking: 0,
};

export default function App() {
  const {
    doc,
    pairId,
    conflicts,
    lastRemote,
    commitTracked,
    markDirty,
    updateFields,
    addPair,
    deletePair,
    toggleFav,
    selectPair,
    acceptRemote,
    keepLocal,
    saveMeasurement,
  } = useCrossTabDoc();

  const current: Pair | undefined = doc.pairs.find((p) => p.id === pairId) || doc.pairs[0];
  const fields: PairFields = (current && doc.fields[current.id]) || FALLBACK_FIELDS;

  // 跟踪字段本地草稿：滑杆拖动 / 输入中先不提交，松手 / 停顿 / 失焦后提交
  const [drafts, setDrafts] = useState<Drafts>(() => ({
    size: fields.size,
    tracking: fields.tracking,
    heading: current?.heading ?? '',
    body: current?.body ?? '',
  }));
  const dirtyRef = useRef<Set<TrackedField>>(new Set());

  // 远端变化或切换配对时，未编辑的字段同步成最新（冲突字段保持本地草稿）
  useEffect(() => {
    setDrafts((d) => ({
      size: dirtyRef.current.has('size') ? d.size : fields.size,
      tracking: dirtyRef.current.has('tracking') ? d.tracking : fields.tracking,
      heading: current && !dirtyRef.current.has('heading') ? current.heading : d.heading,
      body: current && !dirtyRef.current.has('body') ? current.body : d.body,
    }));
  }, [current?.id, current?.heading, current?.body, fields.size, fields.tracking]); // eslint-disable-line

  // 当前窗口档位：>1000 桌面 / ≤1000 平板 / ≤700 手机。也可手动钉选
  const [viewportTier, setViewportTier] = useState<TierId>(() => tierForViewport(window.innerWidth));
  const [pinnedTier, setPinnedTier] = useState<TierId | null>(null);
  useEffect(() => {
    const onResize = () => setViewportTier(tierForViewport(window.innerWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const activeTier: TierId = pinnedTier ?? viewportTier;

  const [showAdd, setShowAdd] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [justSaved, setJustSaved] = useState(false);

  const measurements = (current && doc.measurements[current.id]) || {};

  // 稳定的测量回写：只有内容真的变化才更新文档（具体去重在 sync.saveMeasurement 内）
  const onMeasure = useCallback(
    (tier: Measurement['tier'], m: Measurement) => {
      saveMeasurement(pairId, tier, m);
    },
    [pairId, saveMeasurement],
  );

  // 三档帧吃实时草稿（拖动/输入时画布立即重排）；提交后与文档一致。
  // useMemo 保证值不变时引用稳定，否则 TierFrame 会因 props 引用每次变化陷入
  // “测量→setDoc→重渲染→再测量”的无限循环（防抖写入会被无限重置）。
  const liveFields: PairFields = useMemo(
    () => ({...fields, size: drafts.size, tracking: drafts.tracking}),
    [fields, drafts.size, drafts.tracking],
  );
  const livePair: Pair | null = useMemo(
    () => (current ? {...current, heading: drafts.heading, body: drafts.body} : null),
    [current, drafts.heading, drafts.body],
  );
  const isDrafting =
    dirtyRef.current.size > 0 ||
    !current ||
    drafts.size !== fields.size ||
    drafts.tracking !== fields.tracking ||
    drafts.heading !== current.heading ||
    drafts.body !== current.body;

  // 展示用记录：以“文档签名”判定已定稿，以“实时签名”判定是否正在失效重测
  const shown = useMemo(() => {
    const out: Partial<Record<TierId, Measurement>> = {};
    if (!current) return out;
    for (const t of TIERS) {
      const m = measurements[t.id];
      if (!m) {
        out[t.id] = undefined;
        continue;
      }
      let status = m.status;
      // pending（字体未就绪 / 迁移占位）/ stale 不参与签名比对
      if (status === 'measured') {
        const docSig = buildSignature(current, fields, t.id);
        const liveSig = buildSignature(livePair ?? current, liveFields, t.id);
        if (m.signature !== docSig) status = 'stale';
        // 实时输入已改变排版但还没提交定稿：这一档进入失效重测
        else if (liveSig !== docSig) status = 'stale';
      }
      out[t.id] = status === m.status ? m : {...m, status};
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measurements, current, fields, drafts]);

  if (!current) {
    return (
      <div className="empty-state">
        <Type size={26} />
        <p>还没有配对，新建一套开始三档实排。</p>
        <button className="primary" onClick={() => setShowAdd(true)}>
          <Plus size={15} /> 新建配对
        </button>
        {showAdd && <AddModal title={newTitle} setTitle={setNewTitle} onClose={() => setShowAdd(false)} onCreate={() => {
          if (newTitle.trim()) {
            addPair(newTitle);
            setNewTitle('');
            setShowAdd(false);
          }
        }} />}
      </div>
    );
  }

  const commit = (key: TrackedField, value: string | number) => {
    dirtyRef.current.delete(key);
    commitTracked(key, value);
  };

  const onRange = (key: 'size' | 'tracking', raw: number) => {
    dirtyRef.current.add(key);
    markDirty(key, raw);
    setDrafts((d) => ({...d, [key]: raw})); // 相关档位立即失效，帧重排
  };

  const onText = (key: 'heading' | 'body', raw: string) => {
    dirtyRef.current.add(key);
    markDirty(key, raw);
    setDrafts((d) => ({...d, [key]: raw}));
  };

  const exportCss = () => {
    // 导出始终以文档定稿数据为准，草稿不作为定稿
    const docMeas: Partial<Record<TierId, Measurement>> = {};
    for (const t of TIERS) {
      const m = measurements[t.id];
      if (m && m.status === 'measured' && m.signature === buildSignature(current, fields, t.id)) docMeas[t.id] = m;
      else docMeas[t.id] = m ? {...m, status: 'stale'} : undefined;
    }
    const css = buildExport(current, fields, docMeas);
    downloadCss(`type-pair-${current.id}-${current.title.replace(/\s+/g, '-').toLowerCase()}.css`, css);
  };

  const resolveAccept = (key: TrackedField) => {
    const c = conflicts.find((x) => x.field === key);
    dirtyRef.current.delete(key);
    if (c) {
      if (key === 'size') setDrafts((d) => ({...d, size: Number(c.remote)}));
      else if (key === 'tracking') setDrafts((d) => ({...d, tracking: Number(c.remote)}));
      else if (key === 'heading') setDrafts((d) => ({...d, heading: String(c.remote)}));
      else setDrafts((d) => ({...d, body: String(c.remote)}));
    }
    acceptRemote(key);
  };

  const resolveKeep = (key: TrackedField) => {
    const c = conflicts.find((x) => x.field === key);
    dirtyRef.current.delete(key);
    if (c) {
      if (key === 'size') setDrafts((d) => ({...d, size: Number(c.local)}));
      else if (key === 'tracking') setDrafts((d) => ({...d, tracking: Number(c.local)}));
      else if (key === 'heading') setDrafts((d) => ({...d, heading: String(c.local)}));
      else setDrafts((d) => ({...d, body: String(c.local)}));
    }
    keepLocal(key);
  };

  const create = () => {
    if (!newTitle.trim()) return;
    addPair(newTitle);
    setNewTitle('');
    setShowAdd(false);
  };

  const unfinalCount = TIERS.filter((t) => shown[t.id]?.status !== 'measured').length;
  const conflictSet = new Set(conflicts.map((c) => c.field));

  return (
    <div className="app">
      <aside>
        <div className="brand">
          <div className="brand-mark">
            <Type size={18} />
          </div>
          <div>
            <b>Type Pairer</b>
            <small>FIND YOUR VOICE</small>
          </div>
        </div>
        <div className="nav-section">
          <span>LIBRARY</span>
          <button className="nav active">
            <Grid3X3 size={16} />
            All pairings <b>{doc.pairs.length}</b>
          </button>
          <button className="nav">
            <Heart size={16} />
            Favorites <b>{doc.pairs.filter((p) => p.favorite).length}</b>
          </button>
        </div>
        <div className="saved">
          <div className="saved-head">
            <span>COLLECTIONS</span>
            <button onClick={() => setShowAdd(true)}>
              <Plus size={14} />
            </button>
          </div>
          <button className="collection">
            <i style={{background: '#e8b7a0'}} />
            Editorial <b>{doc.pairs.filter((p) => p.category === 'Editorial').length}</b>
          </button>
          <button className="collection">
            <i style={{background: '#9fc9be'}} />
            Portfolio <b>{doc.pairs.filter((p) => p.category === 'Portfolio').length}</b>
          </button>
          <button className="collection">
            <i style={{background: '#b4add8'}} />
            Brand voice <b>{doc.pairs.filter((p) => p.category === 'Brand').length}</b>
          </button>
        </div>
        <div className="aside-foot">
          <button className="nav">
            <Settings2 size={16} />
            Preferences
          </button>
          <div className="profile">
            <div className="avatar">YL</div>
            <div>
              <b>Yuki Lin</b>
              <small>Design workspace · 多标签同步</small>
            </div>
            <ChevronDown size={14} />
          </div>
        </div>
      </aside>

      <main>
        <header>
          <div>
            <div className="crumb">
              TYPE LIBRARY / <b>PAIRING STUDIO</b>
            </div>
            <h1>Find the right conversation.</h1>
            <p>桌面 / 平板 / 手机三档实排，标题与正文行数、溢出随窗口和字号真实测量。</p>
          </div>
          <div className="actions">
            <button
              className="outline"
              onClick={exportCss}
              title={unfinalCount ? `有 ${unfinalCount} 档未定稿，导出报告会标注` : '三档均已定稿'}
            >
              <Download size={15} />
              导出 CSS{unfinalCount > 0 && <span className="warn-dot" />}
            </button>
            <button className="primary" onClick={() => setShowAdd(true)}>
              <Plus size={16} />
              New pairing
            </button>
          </div>
        </header>

        {conflicts.length > 0 && (
          <div className="conflict-bar">
            {conflicts.map((c) => (
              <div className="conflict" key={c.field}>
                <AlertTriangle size={15} />
                <div className="conflict-body">
                  <b>字段冲突 · {fieldLabel(c.field)}</b>
                  <span>
                    另一标签页已先提交 {formatFieldValue(c.field, c.remote)}，你这边是 {formatFieldValue(c.field, c.local)}
                    （原值 {formatFieldValue(c.field, c.base)}）。后提交不会静默覆盖，请选择保留哪一版。
                  </span>
                </div>
                <button className="conflict-remote" onClick={() => resolveAccept(c.field)}>
                  采用对方值
                </button>
                <button className="conflict-local" onClick={() => resolveKeep(c.field)}>
                  保留我的值
                </button>
              </div>
            ))}
          </div>
        )}
        {conflicts.length === 0 && lastRemote && (
          <div className="sync-note">
            <Check size={13} /> 另一标签页的修改已同步（{lastRemote.changedFields.map((f) => fieldLabel(f)).join('、')}）
          </div>
        )}

        <div className="layout">
          <section className="gallery">
            <div className="gallery-head">
              <div>
                <h2>Saved pairings</h2>
                <span>{doc.pairs.length} compositions</span>
              </div>
              <div className="view-toggle">
                <button className="on">
                  <Grid3X3 size={14} />
                </button>
                <button>
                  <BookOpen size={14} />
                </button>
              </div>
            </div>
            <div className="pair-list">
              {doc.pairs.map((p) => {
                const ms = doc.measurements[p.id] || {};
                const pf = doc.fields[p.id] || FALLBACK_FIELDS;
                const allMeasured = TIERS.every((t) => {
                  const m = ms[t.id];
                  return m && m.status === 'measured' && m.signature === buildSignature(p, pf, t.id);
                });
                const anyPending = TIERS.some((t) => !ms[t.id] || ms[t.id]!.status === 'pending');
                return (
                  <button key={p.id} className={current.id === p.id ? 'pair selected' : 'pair'} onClick={() => selectPair(p.id)}>
                    <div className="pair-top">
                      <span>{p.category}</span>
                      <span className="meas-badge">
                        {allMeasured ? (
                          <span className="badge-ok">
                            <Check size={10} /> 三档已定稿
                          </span>
                        ) : anyPending ? (
                          <span className="badge-pending">
                            <RefreshCw size={10} /> 待测
                          </span>
                        ) : (
                          <span className="badge-stale">
                            <AlertTriangle size={10} /> 有失效档
                          </span>
                        )}
                        <Heart size={15} fill={p.favorite ? '#e88769' : 'none'} color={p.favorite ? '#e88769' : '#aeb5b7'} />
                      </span>
                    </div>
                    <strong style={{fontFamily: pf.headingFont}}>{p.heading}</strong>
                    <p style={{fontFamily: pf.bodyFont}}>{p.body}</p>
                    <div className="pair-foot">
                      <span>{p.title}</span>
                      <small>
                        桌 {ms.desktop && ms.desktop.status !== 'pending' ? `${ms.desktop.headingLines}/${ms.desktop.bodyLines}` : '…'} · 板{' '}
                        {ms.tablet && ms.tablet.status !== 'pending' ? `${ms.tablet.headingLines}/${ms.tablet.bodyLines}` : '…'} · 机{' '}
                        {ms.mobile && ms.mobile.status !== 'pending' ? `${ms.mobile.headingLines}/${ms.mobile.bodyLines}` : '…'} 行
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
                <span>PAIRING CANVAS</span>
                <h2>{current.title}</h2>
              </div>
              <button className="favorite" onClick={() => toggleFav(current.id)}>
                <Star size={16} fill={current.favorite ? '#e5a35e' : 'none'} color={current.favorite ? '#e5a35e' : '#98a4a7'} />
              </button>
            </div>

            <div className="canvas">
              <div className="canvas-bar">
                <span>
                  PREVIEW · 窗口当前为 {TIERS.find((t) => t.id === viewportTier)!.cn}档
                  {pinnedTier && pinnedTier !== viewportTier && '（已手动钉选）'}
                </span>
                <div>
                  {TIERS.map((t) => {
                    const Icon = tierIcon[t.id];
                    return (
                      <button
                        key={t.id}
                        className={activeTier === t.id ? 'tab-on' : ''}
                        onClick={() => setPinnedTier((p) => (p === t.id ? null : t.id))}
                        title={pinnedTier === t.id ? `${t.cn}档（手动钉选，再点恢复跟随窗口）` : `查看${t.cn}档实排`}
                      >
                        <Icon size={12} /> {t.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 三档同时挂载实排：激活档可见且宽度流式，另两档离屏固定宽；
                  窗口变化只改变/重测激活档，离屏档不重跑 */}
              <div className="tiers-stage">
                {TIERS.map((t) => (
                  <TierFrame
                    key={`${current.id}-${t.id}`}
                    tier={t}
                    pair={livePair!}
                    fields={liveFields}
                    active={activeTier === t.id}
                    onResult={onMeasure}
                  />
                ))}
              </div>

              {/* 各档标题行数 / 正文行数 / 溢出 / 状态 */}
              <div className="meas-row">
                {TIERS.map((t) => {
                  const m = shown[t.id];
                  const Icon = tierIcon[t.id];
                  const cls = !m ? 'none' : m.status;
                  return (
                    <div key={t.id} className={`meas-chip ${cls}${activeTier === t.id ? ' chip-active' : ''}`}>
                      <div className="chip-head">
                        <Icon size={13} />
                        <b>{t.cn}</b>
                        <span className="chip-status">
                          {!m ? '未测量' : m.status === 'pending' ? '待测·字体加载中' : m.status === 'stale' ? '已失效·重测中' : '已定稿'}
                        </span>
                      </div>
                      <div className="chip-lines">
                        <span>
                          标题 <b>{m && m.status === 'measured' ? m.headingLines : '–'}</b> 行
                        </span>
                        <span>
                          正文 <b>{m && m.status === 'measured' ? m.bodyLines : '–'}</b> 行
                        </span>
                        <span className={m?.overflowX || m?.overflowY ? 'chip-over' : ''}>
                          {m && m.status === 'measured' ? (m.overflowX || m.overflowY ? '溢出' : '无溢出') : '–'}
                        </span>
                      </div>
                      <small>{m ? m.overflowDetail : `字号 ×${t.fontScale}，等待首帧实排`}</small>
                    </div>
                  );
                })}
              </div>
              {isDrafting && <div className="draft-note">编辑中：相关档位已立即失效重测，提交后才标定稿；导出只采用定稿数据。</div>}
            </div>

            <div className="controls">
              <div className="control-head">
                <div>
                  <span>TYPE CONTROLS</span>
                  <h3>Fine tune your pairing</h3>
                </div>
                <SlidersHorizontal size={17} />
              </div>
              <div className="font-row">
                <label>
                  Heading font
                  <select value={fields.headingFont} onChange={(e) => updateFields({headingFont: e.target.value})}>
                    {FONT_LIST.map((f) => (
                      <option key={f}>{f}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Body font
                  <select value={fields.bodyFont} onChange={(e) => updateFields({bodyFont: e.target.value})}>
                    {FONT_LIST.map((f) => (
                      <option key={f}>{f}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="range-row">
                <label className={conflictSet.has('size') ? 'field-conflict' : ''}>
                  字号 Size <b>{drafts.size}px</b>
                  <input
                    type="range"
                    min="28"
                    max="76"
                    value={drafts.size}
                    onChange={(e) => onRange('size', Number(e.target.value))}
                    onPointerUp={(e) => dirtyRef.current.has('size') && commit('size', Number((e.target as HTMLInputElement).value))}
                    onKeyUp={(e) => {
                      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
                        commit('size', Number((e.target as HTMLInputElement).value));
                    }}
                    onBlur={(e) => dirtyRef.current.has('size') && commit('size', Number(e.target.value))}
                  />
                </label>
                <label className={conflictSet.has('tracking') ? 'field-conflict' : ''}>
                  字距 Letter spacing <b>{drafts.tracking}px</b>
                  <input
                    type="range"
                    min="-1"
                    max="3"
                    step=".5"
                    value={drafts.tracking}
                    onChange={(e) => onRange('tracking', Number(e.target.value))}
                    onPointerUp={(e) => dirtyRef.current.has('tracking') && commit('tracking', Number((e.target as HTMLInputElement).value))}
                    onKeyUp={(e) => {
                      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
                        commit('tracking', Number((e.target as HTMLInputElement).value));
                    }}
                    onBlur={(e) => dirtyRef.current.has('tracking') && commit('tracking', Number(e.target.value))}
                  />
                </label>
              </div>
              <div className="range-row">
                <label>
                  Weight <b>{fields.weight}</b>
                  <input
                    type="range"
                    min="300"
                    max="800"
                    step="100"
                    value={fields.weight}
                    onChange={(e) => updateFields({weight: Number(e.target.value)})}
                  />
                </label>
                <label>
                  Line height <b>{fields.leading.toFixed(2)}</b>
                  <input
                    type="range"
                    min="1"
                    max="1.8"
                    step=".05"
                    value={fields.leading}
                    onChange={(e) => updateFields({leading: Number(e.target.value)})}
                  />
                </label>
              </div>
              <div className="sample-row">
                <DebouncedText
                  label="样例标题 Heading"
                  value={drafts.heading}
                  conflict={conflictSet.has('heading')}
                  onChange={(v) => onText('heading', v)}
                  onCommit={(v) => dirtyRef.current.has('heading') && commit('heading', v)}
                />
                <DebouncedText
                  label="样例正文 Body"
                  textarea
                  value={drafts.body}
                  conflict={conflictSet.has('body')}
                  onChange={(v) => onText('body', v)}
                  onCommit={(v) => dirtyRef.current.has('body') && commit('body', v)}
                />
              </div>
            </div>

            <div className="studio-foot">
              <button className="delete" onClick={() => deletePair(current.id)}>
                <Trash2 size={15} />
                Delete pairing
              </button>
              <button
                className="save"
                onClick={() => {
                  (['size', 'tracking', 'heading', 'body'] as TrackedField[]).forEach((k) => {
                    if (dirtyRef.current.has(k)) {
                      commit(k, k === 'size' ? drafts.size : k === 'tracking' ? drafts.tracking : k === 'heading' ? drafts.heading : drafts.body);
                    }
                  });
                  setJustSaved(true);
                  setTimeout(() => setJustSaved(false), 1600);
                }}
              >
                {justSaved ? <Check size={13} /> : <RefreshCw size={13} />}
                {justSaved ? '已提交并同步到其它标签页' : '提交修改（同步到其它标签页）'}
              </button>
            </div>
          </section>
        </div>
      </main>

      {showAdd && <AddModal title={newTitle} setTitle={setNewTitle} onClose={() => setShowAdd(false)} onCreate={create} />}
    </div>
  );
}

function DebouncedText({
  label,
  value,
  onChange,
  onCommit,
  textarea,
  conflict,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onCommit: (v: string) => void;
  textarea?: boolean;
  conflict?: boolean;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shared = {
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      onChange(e.target.value);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => onCommit(e.target.value), 700);
    },
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (timer.current) clearTimeout(timer.current);
      onCommit(e.target.value);
    },
  };
  return (
    <label className={conflict ? 'field-conflict' : ''}>
      {label}
      {textarea ? <textarea rows={3} {...shared} /> : <input type="text" {...shared} />}
    </label>
  );
}

function AddModal({
  title,
  setTitle,
  onClose,
  onCreate,
}: {
  title: string;
  setTitle: (v: string) => void;
  onClose: () => void;
  onCreate: () => void;
}) {
  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New pairing</h2>
        <label>
          Pairing name
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onCreate()}
            placeholder="e.g. Quiet confidence"
          />
        </label>
        <div className="modal-actions">
          <button className="outline" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={onCreate}>
            Create pairing
          </button>
        </div>
      </div>
    </div>
  );
}
