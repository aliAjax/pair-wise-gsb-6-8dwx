import {useCallback, useEffect, useRef, useState} from 'react';
import {flushSave, loadDoc, saveDoc, saveMeasurements} from './storage';
import {
  Doc,
  Measurement,
  Pair,
  PairFields,
  STORAGE_KEY,
  TrackedField,
  TRACKED_FIELDS,
} from './types';

/** 一个字段的冲突信息：后看到对方提交的一方看到本地值与对方值 */
export interface Conflict {
  field: TrackedField;
  base: string | number;
  local: string | number;
  remote: string | number;
  remoteRev: number;
  remoteAt: number;
}

type Conflicts = Partial<Record<TrackedField, Conflict>>;

function trackedValue(p: Pair, f: PairFields, key: TrackedField): string | number {
  if (key === 'heading') return p.heading;
  if (key === 'body') return p.body;
  return f[key]; // size | tracking
}

function setTrackedOnDoc(d: Doc, pid: number, key: TrackedField, value: string | number): Doc {
  if (key === 'heading' || key === 'body') {
    return {...d, pairs: d.pairs.map((p) => (p.id === pid ? {...p, [key]: String(value)} : p))};
  }
  return {...d, fields: {...d.fields, [pid]: {...d.fields[pid], [key]: Number(value)}}};
}

/**
 * 合并另一个标签页写入的文档。
 * 规范文档始终保存“已提交”的最新值：跟踪字段以修订号高者为准；
 * 本地未提交草稿不属于文档，它只存在 dirtyRef / UI 草稿里（由调用方保留），
 * 因此冲突时这里仍采用对方已提交的值，冲突信息单独由 conflicts 承载。
 * 测量记录按各档最新 measuredAt 合并。
 */
function mergeRemote(local: Doc, remote: Doc): Doc {
  const outPairs: Pair[] = remote.pairs.map((rp) => {
    const lp = local.pairs.find((x) => x.id === rp.id);
    if (!lp) return rp;
    const merged: Pair = {...rp};
    for (const key of TRACKED_FIELDS) {
      if (key !== 'heading' && key !== 'body') continue;
      if ((local.revisions[lp.id]?.[key] ?? 0) > (remote.revisions[rp.id]?.[key] ?? 0)) {
        merged[key] = lp[key];
      }
    }
    return merged;
  });
  for (const lp of local.pairs) {
    if (!outPairs.some((rp) => rp.id === lp.id)) outPairs.push(lp);
  }

  const numericKeys = (a: object, b: object): number[] =>
    Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).map(Number);

  const outFields: Doc['fields'] = {};
  for (const id of numericKeys(remote.fields, local.fields)) {
    const rf = remote.fields[id];
    const lf = local.fields[id];
    if (!rf) {
      outFields[id] = lf;
      continue;
    }
    if (!lf) {
      outFields[id] = rf;
      continue;
    }
    // 已提交值按修订号取高者（size/tracking）
    const merged: PairFields = {...lf, ...rf};
    for (const key of ['size', 'tracking'] as const) {
      if ((local.revisions[id]?.[key] ?? 0) > (remote.revisions[id]?.[key] ?? 0)) merged[key] = lf[key];
    }
    outFields[id] = merged;
  }

  const outRev: Doc['revisions'] = {};
  for (const id of numericKeys(remote.revisions, local.revisions)) {
    outRev[id] = {...(local.revisions[id] || {}), ...(remote.revisions[id] || {})};
  }

  const outMeas: Doc['measurements'] = {};
  for (const id of numericKeys(remote.measurements, local.measurements)) {
    outMeas[id] = {...(local.measurements[id] || {})};
    for (const t of Object.keys(remote.measurements[id] || {}) as Measurement['tier'][]) {
      const rm = remote.measurements[id]![t]!;
      const lm = outMeas[id]![t];
      if (!lm || rm.measuredAt > lm.measuredAt) outMeas[id]![t] = rm;
    }
  }

  return {
    version: 2,
    pairs: outPairs,
    fields: outFields,
    revisions: outRev,
    measurements: outMeas,
    selectedId: remote.selectedId && outPairs.some((p) => p.id === remote.selectedId) ? remote.selectedId : local.selectedId,
  };
}

interface RemoteChange {
  pairId: number;
  changedFields: TrackedField[];
  ts: number;
}

export function useCrossTabDoc() {
  // docRef 是唯一真相源，所有更新基于它计算，杜绝异步 setState 期间使用过期快照
  const docRef = useRef<Doc>(null as unknown as Doc);
  if (!docRef.current) docRef.current = loadDoc();
  const [, setTick] = useState(0);
  const rerender = useCallback(() => setTick((n) => n + 1), []);

  // 每个标签页的编辑基线：最后一次“同步/提交”时各字段的值与修订号
  const baseRef = useRef<Map<TrackedField, {value: string | number; rev: number}>>(new Map());
  // 本地尚未提交的脏草稿（拖动/输入中实时登记）
  const dirtyRef = useRef<Partial<Record<TrackedField, string | number>>>({});
  const conflictsRef = useRef<Conflicts>({});
  const [conflicts, setConflictsState] = useState<Conflict[]>([]);
  const [lastRemote, setLastRemote] = useState<RemoteChange | null>(null);

  const pairId = docRef.current.selectedId;

  const setConflicts = useCallback((c: Conflicts) => {
    conflictsRef.current = c;
    setConflictsState(Object.values(c) as Conflict[]);
  }, []);

  // 初始化 / 切换配对时重建基线，清掉上一套配对的冲突提示
  useEffect(() => {
    // 首次挂载：把初始（含迁移/种子）文档落盘，作为后续测量子树合并写的基底
    if (!localStorage.getItem(STORAGE_KEY)) saveDoc(docRef.current, true);
    const d = docRef.current;
    const p = d.pairs.find((x) => x.id === d.selectedId);
    const f = d.fields[d.selectedId];
    const base = new Map<TrackedField, {value: string | number; rev: number}>();
    if (p && f) {
      for (const key of TRACKED_FIELDS) {
        base.set(key, {value: trackedValue(p, f, key), rev: d.revisions[d.selectedId]?.[key] ?? 0});
      }
    }
    baseRef.current = base;
    dirtyRef.current = {};
    setConflicts({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairId]);

  // 收到另一个标签页写入：无本地改动直接采用；双方都改过则登记冲突
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY || !e.newValue) return;
      let remote: Doc;
      try {
        remote = JSON.parse(e.newValue) as Doc;
      } catch {
        return;
      }
      if (remote.version !== 2) return;
      const local = docRef.current;
      const pid = local.selectedId;
      const localPair = local.pairs.find((p) => p.id === pid);
      const localFields = local.fields[pid];
      const remotePair = remote.pairs.find((p) => p.id === pid);
      if (!localPair || !localFields || !remotePair) {
        docRef.current = mergeRemote(local, remote);
        rerender();
        return;
      }
      const changed: TrackedField[] = [];
      const nextConflicts: Conflicts = {...conflictsRef.current};
      for (const key of TRACKED_FIELDS) {
        const remoteRev = remote.revisions[pid]?.[key] ?? 0;
        const base = baseRef.current.get(key);
        if (!base || remoteRev <= base.rev) continue;
        const remoteVal = trackedValue(remotePair, remote.fields[pid], key);
        const dirty = dirtyRef.current[key];
        const localVal = dirty !== undefined ? dirty : trackedValue(localPair, localFields, key);
        const hadLocalEdit = dirty !== undefined && localVal !== base.value;
        if (!hadLocalEdit || localVal === remoteVal) {
          baseRef.current.set(key, {value: remoteVal, rev: remoteRev});
          delete nextConflicts[key];
          changed.push(key);
        } else {
          nextConflicts[key] = {
            field: key,
            base: base.value,
            local: localVal,
            remote: remoteVal,
            remoteRev,
            remoteAt: Date.now(),
          };
          changed.push(key);
        }
      }
      const next = mergeRemote(local, remote);
      docRef.current = next;
      setConflicts(nextConflicts);
      rerender();
      // 不整体回写（会用本标签页刚合并的视图覆盖对方的字段）；
      // 测量子树若有更新则单独叠加落盘
      saveMeasurements(next.measurements);
      if (changed.length) setLastRemote({pairId: pid, changedFields: changed, ts: Date.now()});
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [rerender, setConflicts]);

  // 离开页面前落盘
  useEffect(() => () => flushSave(), []);

  const persist = useCallback(
    (next: Doc, immediate = true) => {
      docRef.current = next;
      saveDoc(next, immediate);
      rerender();
    },
    [rerender],
  );

  /** 登记未提交的本地草稿（滑杆拖动 / 文本输入过程中实时调用） */
  const markDirty = useCallback((key: TrackedField, value: string | number) => {
    dirtyRef.current[key] = value;
  }, []);

  /**
   * 提交一个跟踪字段（字号/字距/样例标题/样例正文）。
   * 若远端修订已高于基线（对方先提交）且值不同，提交者看到冲突而不是静默覆盖。
   */
  const commitTracked = useCallback(
    (key: TrackedField, passedValue?: string | number): {conflicted: boolean} => {
      const d = docRef.current;
      const pid = d.selectedId;
      const pair = d.pairs.find((p) => p.id === pid);
      if (!pair || !d.fields[pid]) return {conflicted: false};
      const value = dirtyRef.current[key] !== undefined ? dirtyRef.current[key] : passedValue;
      if (value === undefined) return {conflicted: false};
      const base = baseRef.current.get(key);
      const remoteRev = d.revisions[pid]?.[key] ?? 0;
      const currentDocVal = trackedValue(pair, d.fields[pid], key);
      if (base && remoteRev > base.rev && value !== currentDocVal) {
        setConflicts({
          ...conflictsRef.current,
          [key]: {
            field: key,
            base: base.value,
            local: value,
            remote: currentDocVal,
            remoteRev,
            remoteAt: Date.now(),
          },
        });
        dirtyRef.current[key] = value;
        return {conflicted: true};
      }
      const rev = Math.max(remoteRev, base?.rev ?? 0) + 1;
      const next: Doc = {
        ...setTrackedOnDoc(d, pid, key, value),
        revisions: {...d.revisions, [pid]: {...d.revisions[pid], [key]: rev}},
      };
      baseRef.current.set(key, {value, rev});
      delete dirtyRef.current[key];
      const c = {...conflictsRef.current};
      delete c[key];
      setConflicts(c);
      persist(next);
      return {conflicted: false};
    },
    [persist, setConflicts],
  );

  /** 非跟踪字段（字体/字重/行高）直接提交，last-write-wins */
  const updateFields = useCallback(
    (patch: Partial<PairFields>) => {
      const d = docRef.current;
      const pid = d.selectedId;
      if (!d.fields[pid]) return;
      persist({...d, fields: {...d.fields, [pid]: {...d.fields[pid], ...patch}}});
    },
    [persist],
  );

  const addPair = useCallback(
    (title: string) => {
      const d = docRef.current;
      const id = Date.now();
      const pair: Pair = {
        id,
        title: title.trim(),
        heading: 'Your new headline',
        body: 'Start with a sentence that lets your type pairing show its character.',
        category: 'Untitled',
        favorite: false,
      };
      const fields: PairFields = {
        ...(d.fields[d.selectedId] || {
          headingFont: 'Fraunces',
          bodyFont: 'DM Sans',
          size: 46,
          weight: 600,
          leading: 1.25,
          tracking: 0,
        }),
      };
      const next: Doc = {
        ...d,
        pairs: [...d.pairs, pair],
        fields: {...d.fields, [id]: fields},
        revisions: {...d.revisions, [id]: {}},
        measurements: {...d.measurements, [id]: {}},
        selectedId: id,
      };
      docRef.current = next;
      const base = new Map<TrackedField, {value: string | number; rev: number}>();
      for (const key of TRACKED_FIELDS) base.set(key, {value: trackedValue(pair, fields, key), rev: 0});
      baseRef.current = base;
      dirtyRef.current = {};
      setConflicts({});
      saveDoc(next, true);
      rerender();
      return id;
    },
    [rerender, setConflicts],
  );

  const deletePair = useCallback(
    (id: number) => {
      const d = docRef.current;
      const rest = d.pairs.filter((p) => p.id !== id);
      const fields = {...d.fields};
      const revisions = {...d.revisions};
      const measurements = {...d.measurements};
      delete fields[id];
      delete revisions[id];
      delete measurements[id];
      persist({...d, pairs: rest, fields, revisions, measurements, selectedId: rest[0]?.id ?? 0});
    },
    [persist],
  );

  const toggleFav = useCallback(
    (id: number) => {
      const d = docRef.current;
      persist({...d, pairs: d.pairs.map((p) => (p.id === id ? {...p, favorite: !p.favorite} : p))}, false);
    },
    [persist],
  );

  const selectPair = useCallback(
    (id: number) => {
      const d = docRef.current;
      if (id === d.selectedId) return;
      persist({...d, selectedId: id});
    },
    [persist],
  );

  const resolveConflict = useCallback(
    (key: TrackedField, choose: 'local' | 'remote') => {
      const c = conflictsRef.current[key];
      if (!c) return;
      const d = docRef.current;
      const pid = d.selectedId;
      const chosenVal = choose === 'remote' ? c.remote : c.local;
      const rev = choose === 'remote' ? c.remoteRev : c.remoteRev + 1;
      const next: Doc = {
        ...setTrackedOnDoc(d, pid, key, chosenVal),
        revisions: {...d.revisions, [pid]: {...d.revisions[pid], [key]: rev}},
      };
      baseRef.current.set(key, {value: chosenVal, rev});
      delete dirtyRef.current[key];
      const cs = {...conflictsRef.current};
      delete cs[key];
      setConflicts(cs);
      persist(next);
    },
    [persist, setConflicts],
  );

  /** 测量记录落库（频繁，走防抖合并写）。按“除时间戳外完全相同”去重 */
  const saveMeasurement = useCallback(
    (pairIdKey: number, tier: Measurement['tier'], m: Measurement) => {
      const cur = docRef.current.measurements[pairIdKey]?.[tier];
      const same =
        !!cur &&
        cur.status === m.status &&
        cur.signature === m.signature &&
        cur.headingLines === m.headingLines &&
        cur.bodyLines === m.bodyLines &&
        cur.overflowX === m.overflowX &&
        cur.overflowY === m.overflowY &&
        cur.frameWidth === m.frameWidth &&
        cur.fontReady === m.fontReady;
      if (same) return;
      const d = docRef.current;
      const next: Doc = {
        ...d,
        measurements: {
          ...d.measurements,
          [pairIdKey]: {...(d.measurements[pairIdKey] || {}), [tier]: m},
        },
      };
      docRef.current = next;
      saveMeasurements(next.measurements);
      rerender();
    },
    [rerender],
  );

  return {
    doc: docRef.current,
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
    acceptRemote: (key: TrackedField) => resolveConflict(key, 'remote'),
    keepLocal: (key: TrackedField) => resolveConflict(key, 'local'),
    saveMeasurement,
  };
}
