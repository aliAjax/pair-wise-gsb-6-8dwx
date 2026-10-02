export type TierId = 'desktop' | 'tablet' | 'mobile';

/** 参与合并的全部字段：样例文字、字体、字号、字距等 */
export const CONTENT_FIELDS = [
  'title',
  'category',
  'heading',
  'body',
  'headingFont',
  'bodyFont',
  'size',
  'weight',
  'leading',
  'tracking',
] as const;
export type ContentField = (typeof CONTENT_FIELDS)[number];

/** 不进入三向合并、只做本地即时状态的字段 */
export type ContentValues = Record<ContentField, string | number>;

export type MeasureStatus = 'measured' | 'pending';
export type PendingReason = 'font-loading' | 'dirty' | 'new' | 'queued';

export interface Measure {
  status: MeasureStatus;
  /** 测量时对应的输入签名；签名一致才允许沿用 */
  signature: string | null;
  headingLines?: number;
  bodyLines?: number;
  overflow?: boolean;
  measuredAt?: number;
  pendingReason?: PendingReason;
}

export type Measures = Record<TierId, Measure>;

export interface Pair extends ContentValues {
  id: number;
  favorite: boolean;
  measures: Measures;
}

export interface PairV1 {
  id: number;
  title: string;
  heading: string;
  body: string;
  category: string;
  favorite: boolean;
}

export interface StoreData {
  version: 2;
  /** 单调递增版本号，每次写入 +1，用于检测另一标签页的并发提交 */
  rev: number;
  pairs: Pair[];
}

export type FieldBase = Partial<Record<ContentField, string | number>>;

export interface CommitResult {
  ok: boolean;
  reason?: 'conflict' | 'missing';
  conflicts?: ContentField[];
  /** 三向合并后的本地结果（冲突时供解决界面预选） */
  merged?: ContentValues;
  /** 冲突时对方标签页已提交的字段值，作为解决后的新 base */
  remote?: ContentValues;
  data?: StoreData;
  rev: number;
}
