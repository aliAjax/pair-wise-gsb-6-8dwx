import {pendingAll, pendingMeasure} from './breakpoints';
import {tierSignature} from './measure';
import type {
  CommitResult,
  ContentField,
  ContentValues,
  FieldBase,
  Measure,
  Measures,
  Pair,
  PairV1,
  StoreData,
  TierId,
} from './types';
import {CONTENT_FIELDS} from './types';

export const STORE_KEY = 'type-pairs';
export const STORE_VERSION = 2;

export const FONT_DEFAULT = {
  headingFont: 'Fraunces',
  bodyFont: 'DM Sans',
  size: 46,
  weight: 600,
  leading: 1.25,
  tracking: 0,
} as const;

function isV1(raw: unknown): raw is {pairs: PairV1[]} | PairV1[] {
  if (Array.isArray(raw)) return raw.length === 0 || typeof raw[0]?.heading === 'string';
  const o = raw as {pairs?: unknown; version?: number};
  return Array.isArray(o?.pairs) && o.version !== 2;
}

/** v1 数据升级：补齐字体字段与三档测量记录（待测，加载后立即重测） */
export function migrate(raw: unknown): StoreData {
  const v1pairs: PairV1[] = Array.isArray(raw)
    ? raw
    : ((raw as {pairs: PairV1[]})?.pairs ?? []);
  const pairs: Pair[] = v1pairs.map((p) => ({
    ...FONT_DEFAULT,
    title: p.title,
    category: p.category,
    heading: p.heading,
    body: p.body,
    id: p.id,
    favorite: !!p.favorite,
    measures: pendingAll('queued'),
  }));
  return {version: STORE_VERSION, rev: 1, pairs};
}

/** 防御性兜底：v2 但缺测量记录 / 字段缺失时补齐 */
export function normalize(data: StoreData): StoreData {
  let changed = data.version !== STORE_VERSION || typeof data.rev !== 'number';
  const pairs = data.pairs.map((p) => {
    const next: Pair = {...FONT_DEFAULT, ...p};
    const measures = {...p.measures} as Partial<Measures>;
    (['desktop', 'tablet', 'mobile'] as TierId[]).forEach((tier) => {
      if (!measures[tier]) {
        measures[tier] = {status: 'pending', signature: null, pendingReason: 'queued'};
        changed = true;
      }
    });
    next.measures = measures as Measures;
    if (JSON.stringify(next) !== JSON.stringify(p)) changed = true;
    return next;
  });
  return changed ? {version: STORE_VERSION, rev: data.rev || 1, pairs} : data;
}

export function readStore(): StoreData {
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  } catch {
    raw = null;
  }
  if (!raw) return {version: STORE_VERSION, rev: 0, pairs: []};
  if (isV1(raw)) return migrate(raw);
  return normalize(raw as StoreData);
}

export function writeStore(data: StoreData) {
  localStorage.setItem(STORE_KEY, JSON.stringify(data));
}

function bump(data: StoreData, pairs: Pair[]): StoreData {
  return {version: STORE_VERSION, rev: data.rev + 1, pairs};
}

/**
 * 三向合并。base=本次编辑开始时的快照，remote=当前存储（另一标签页已提交），
 * local=本地草稿。仅当同一字段 local 与 remote 都相对 base 改动且取值不同时冲突；
 * 只有一方改动则自动采纳。
 */
export function threeWayMerge(
  base: ContentValues,
  remote: ContentValues,
  local: ContentValues,
): {merged: ContentValues; conflicts: ContentField[]} {
  const merged = {...local};
  const conflicts: ContentField[] = [];
  for (const field of CONTENT_FIELDS) {
    const localChanged = local[field] !== base[field];
    const remoteChanged = remote[field] !== base[field];
    if (localChanged && remoteChanged && local[field] !== remote[field]) {
      conflicts.push(field);
      merged[field] = local[field]; // 冲突先放本地值，解决弹窗二选一
    } else if (remoteChanged && !localChanged) {
      merged[field] = remote[field];
    }
  }
  return {merged, conflicts};
}

export function extractValues(p: Pair): ContentValues {
  const out = {} as ContentValues;
  for (const f of CONTENT_FIELDS) out[f] = p[f] as never;
  return out;
}

function sameValues(a: ContentValues, b: ContentValues): boolean {
  return CONTENT_FIELDS.every((f) => a[f] === b[f]);
}

/** 三档待测，每档携带各自新输入的签名（字号缩放因子按档不同） */
export function pendingForValues(values: ContentValues, reason: Measure['pendingReason']): Measures {
  return {
    desktop: pendingMeasure(reason, tierSignature(values, 'desktop')),
    tablet: pendingMeasure(reason, tierSignature(values, 'tablet')),
    mobile: pendingMeasure(reason, tierSignature(values, 'mobile')),
  };
}

/**
 * 提交一次编辑。baseRev 是编辑开始时看到的版本号：
 * - 期间无人提交（rev 未变）：直接写入
 * - 期间另一标签页先提交：三向合并；同字段分歧则把 conflicts 交还后提交者
 * 冲突解决后用同一 base 再调一次即可（会再做一次三向合并）。
 */
export function tryCommit(params: {
  pairId: number;
  base: ContentValues;
  baseRev: number;
  values: ContentValues;
  favorite?: boolean;
}): CommitResult {
  const data = readStore();
  const remote = data.pairs.find((p) => p.id === params.pairId);
  if (!remote) return {ok: false, reason: 'missing', rev: data.rev};

  let finalValues = params.values;
  const remoteValues = extractValues(remote);
  // 无论 rev 是否一致都做三向合并：另一标签页的提交可能已通过 storage 事件
  // 同步进本地 rev，但草稿 base 仍是编辑开始时的旧值。
  if (data.rev !== params.baseRev || !sameValues(params.base, remoteValues)) {
    const {merged, conflicts} = threeWayMerge(params.base, remoteValues, params.values);
    if (conflicts.length > 0) {
      return {ok: false, reason: 'conflict', conflicts, merged, remote: remoteValues, rev: data.rev};
    }
    finalValues = merged;
  }

  const next: Pair = {
    ...remote,
    ...finalValues,
    favorite: params.favorite ?? remote.favorite,
    // 内容提交后三档签名全部失效，待测记录上携带新签名用于拦截旧测量回写
    measures: pendingForValues(finalValues, 'dirty'),
  };
  const nextData = bump(
    data,
    data.pairs.map((p) => (p.id === remote.id ? next : p)),
  );
  writeStore(nextData);
  return {ok: true, data: nextData, rev: nextData.rev};
}

/** 收藏/新建/删除等元数据操作（不参与字段冲突，最后写入获胜） */
export function mutatePairs(fn: (pairs: Pair[]) => Pair[]): StoreData {
  const data = readStore();
  const nextData = bump(data, fn(data.pairs));
  writeStore(nextData);
  return nextData;
}

/** 写入一档测量结果；返回 null 表示配对已不存在 */
export function commitMeasure(
  pairId: number,
  tier: TierId,
  measure: Measure,
): StoreData | null {
  const data = readStore();
  if (!data.pairs.some((p) => p.id === pairId)) return null;
  const nextData = bump(
    data,
    data.pairs.map((p) => (p.id === pairId ? {...p, measures: {...p.measures, [tier]: measure}} : p)),
  );
  writeStore(nextData);
  return nextData;
}

/** 批量写入多档测量（一次 rev 递增）；同签名或待测才覆盖，防止旧测量顶掉新输入 */
export function commitMeasuresBatch(patches: {pairId: number; tier: TierId; measure: Measure}[]): StoreData | null {
  const data = readStore();
  const byPair = new Map<number, Map<TierId, Measure>>();
  for (const patch of patches) {
    if (!byPair.has(patch.pairId)) byPair.set(patch.pairId, new Map());
    byPair.get(patch.pairId)!.set(patch.tier, patch.measure);
  }
  let touched = false;
  const pairs = data.pairs.map((p) => {
    const incoming = byPair.get(p.id);
    if (!incoming) return p;
    const measures = {...p.measures};
    for (const [tier, measure] of incoming) {
      const old = measures[tier];
      // 待测档记录的是"等待的输入签名"：与回报签名不符即丢弃，防止旧测量顶掉新输入
      if (measure.signature && old.signature && old.signature !== measure.signature) continue;
      if (old.status === 'measured' && measure.status === 'pending') continue;
      measures[tier] = measure;
      touched = true;
    }
    return touched ? {...p, measures} : p;
  });
  if (!touched) return null;
  const nextData = bump(data, pairs);
  writeStore(nextData);
  return nextData;
}
