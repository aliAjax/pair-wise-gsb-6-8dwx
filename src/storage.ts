import {
  DEFAULT_FIELDS,
  Doc,
  LEGACY_KEY,
  Measurement,
  Pair,
  STORAGE_KEY,
  TIERS,
  TierId,
} from './types';

export const seed: Pair[] = [
  {
    id: 1,
    title: 'Editorial calm',
    heading: 'A slower way to see',
    body: 'Good typography creates space for ideas to breathe. Pair a confident display face with a quiet, generous text face.',
    category: 'Editorial',
    favorite: true,
  },
  {
    id: 2,
    title: 'Studio notes',
    heading: 'Make room for the unexpected',
    body: 'A thoughtful pairing can add rhythm to even the simplest interface. Try contrast in shape, not just size.',
    category: 'Portfolio',
    favorite: false,
  },
  {
    id: 3,
    title: 'Field guide',
    heading: 'Small details, lasting impressions',
    body: 'Typography is the voice of a page. Find a combination that feels clear, warm and distinctly yours.',
    category: 'Brand',
    favorite: false,
  },
];

function pendingPlaceholder(tier: TierId): Measurement {
  // 旧数据升级：先补一档位测量记录占位，明确标记待测，绝不能当成定稿
  return {
    tier,
    status: 'pending',
    headingLines: 0,
    bodyLines: 0,
    overflowX: false,
    overflowY: false,
    overflowDetail: '从旧版数据升级，尚未实排（pending reflow after migration）',
    frameWidth: 0,
    contentWidth: 0,
    signature: '',
    fontReady: false,
    measuredAt: 0,
    migrated: true,
  };
}

function docFromPairs(pairs: Pair[], markMigrated: boolean): Doc {
  const fields: Doc['fields'] = {};
  const revisions: Doc['revisions'] = {};
  const measurements: Doc['measurements'] = {};
  for (const p of pairs) {
    fields[p.id] = { ...DEFAULT_FIELDS };
    revisions[p.id] = {};
    measurements[p.id] = markMigrated
      ? Object.fromEntries(TIERS.map((t) => [t.id, pendingPlaceholder(t.id)])) as Doc['measurements'][number]
      : {};
  }
  return { version: 2, pairs, fields, revisions, measurements, selectedId: pairs[0]?.id ?? 0 };
}

/**
 * 读取并升级：
 * - v2 数据直接用
 * - v1（type-pairs，仅 Pair[]）升级，为每套配对补三档待测记录
 * - 没有数据用种子，三档留空（首挂帧后实测，不需要 migrated 占位）
 */
export function loadDoc(): Doc {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const doc = JSON.parse(raw) as Doc;
      if (doc && doc.version === 2 && Array.isArray(doc.pairs)) {
        // 兜底：补全缺失结构（如老 v2 写入被截断）
        for (const p of doc.pairs) {
          doc.fields[p.id] = { ...DEFAULT_FIELDS, ...(doc.fields?.[p.id] || {}) };
          doc.revisions[p.id] = doc.revisions?.[p.id] || {};
          doc.measurements[p.id] = doc.measurements?.[p.id] || {};
        }
        if (!doc.selectedId || !doc.pairs.some((p) => p.id === doc.selectedId)) {
          doc.selectedId = doc.pairs[0]?.id ?? 0;
        }
        return doc;
      }
    } catch {
      /* 落坏数据，继续尝试旧 key */
    }
  }
  const legacy = localStorage.getItem(LEGACY_KEY);
  if (legacy) {
    try {
      const pairs = JSON.parse(legacy) as Pair[];
      if (Array.isArray(pairs) && pairs.length) {
        const doc = docFromPairs(pairs, true);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
        return doc;
      }
    } catch {
      /* 旧数据损坏，走种子 */
    }
  }
  return docFromPairs(seed, false);
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;
let pendingMeas: Doc['measurements'] | null = null;

/**
 * 持久化整份文档（提交类写入，立即生效）。
 * 会取消任何排队中的测量合并写（其数据已包含在传入文档或已更早落盘）。
 */
export function saveDoc(doc: Doc, immediate = true): void {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  pendingMeas = null;
  if (immediate) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
    return;
  }
  // 非立即的整文档写（如收藏）：仍立即落盘，避免旧快照排队覆盖
  localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
}

function readLiveDoc(): Doc | null {
  try {
    const cur = JSON.parse(localStorage.getItem(STORAGE_KEY) || '') as Doc | null;
    if (cur && cur.version === 2) return cur;
  } catch {
    /* 落坏数据 */
  }
  return null;
}

/**
 * 只持久化测量子树（写入频繁，统一 300ms 合并）。
 * 触发时以 localStorage 里的最新文档为底，仅叠加 measurements，绝不触碰
 * 字号/字距/样例等字段——测量排队期间发生的提交因此不会被旧快照冲掉。
 */
export function saveMeasurements(meas: Doc['measurements']): void {
  pendingMeas = meas;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    const live = readLiveDoc();
    if (!live || !pendingMeas) {
      writeTimer = null;
      return;
    }
    const merged: Doc = {...live, measurements: JSON.parse(JSON.stringify(live.measurements || {}))};
    for (const id of Object.keys(pendingMeas).map(Number)) {
      merged.measurements[id] = {...(merged.measurements[id] || {}), ...(pendingMeas[id] || {})};
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    writeTimer = null;
  }, 300);
}

export function flushSave(): void {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
    const live = readLiveDoc();
    if (live && pendingMeas) {
      const merged: Doc = {...live, measurements: JSON.parse(JSON.stringify(live.measurements || {}))};
      for (const id of Object.keys(pendingMeas).map(Number)) {
        merged.measurements[id] = {...(merged.measurements[id] || {}), ...(pendingMeas[id] || {})};
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    }
    pendingMeas = null;
  }
}
