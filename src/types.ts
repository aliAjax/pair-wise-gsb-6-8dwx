// 三档实排：桌面 / 平板 / 手机
export type TierId = 'desktop' | 'tablet' | 'mobile';

export interface TierConfig {
  id: TierId;
  /** 档位名（英文 UI 用） */
  label: string;
  /** 中文名，测量记录与导出里使用 */
  cn: string;
  /** 非激活档位离屏实排时使用的固定帧宽（px） */
  fixedWidth: number;
  /** 画布槽位高度（px），超出即纵向溢出 */
  height: number;
  padX: number;
  padY: number;
  /** 相对桌面字号的缩放，导出的媒体查询与实排共用 */
  fontScale: number;
}

export const TIERS: TierConfig[] = [
  { id: 'desktop', label: 'Desktop', cn: '桌面', fixedWidth: 560, height: 320, padX: 45, padY: 43, fontScale: 1 },
  { id: 'tablet', label: 'Tablet', cn: '平板', fixedWidth: 460, height: 300, padX: 38, padY: 40, fontScale: 0.9 },
  { id: 'mobile', label: 'Mobile', cn: '手机', fixedWidth: 320, height: 260, padX: 25, padY: 32, fontScale: 0.76 },
];

export const TIER_MAP: Record<TierId, TierConfig> = Object.fromEntries(TIERS.map((t) => [t.id, t])) as Record<TierId, TierConfig>;

/** 按窗口宽度判定当前实排档位：>1000 桌面，701–1000 平板，<=700 手机 */
export function tierForViewport(vw: number): TierId {
  if (vw <= 700) return 'mobile';
  if (vw <= 1000) return 'tablet';
  return 'desktop';
}

export interface Pair {
  id: number;
  title: string;
  heading: string;
  body: string;
  category: string;
  favorite: boolean;
}

export interface PairFields {
  headingFont: string;
  bodyFont: string;
  size: number;
  weight: number;
  leading: number;
  tracking: number;
}

export const FONT_LIST = ['Fraunces', 'DM Sans', 'Space Grotesk', 'Newsreader', 'IBM Plex Sans', 'Playfair Display'];

export const DEFAULT_FIELDS: PairFields = {
  headingFont: 'Fraunces',
  bodyFont: 'DM Sans',
  size: 46,
  weight: 600,
  leading: 1.25,
  tracking: 0,
};

/** 参与跨标签页冲突检测的字段：字号、字距、样例标题、样例正文 */
export type TrackedField = 'size' | 'tracking' | 'heading' | 'body';
export const TRACKED_FIELDS: TrackedField[] = ['size', 'tracking', 'heading', 'body'];

export function fieldLabel(f: TrackedField): string {
  return f === 'size' ? '字号 Size' : f === 'tracking' ? '字距 Tracking' : f === 'heading' ? '样例标题 Heading' : '样例正文 Body';
}

export function formatFieldValue(f: TrackedField, v: string | number): string {
  if (f === 'size') return `${v}px`;
  if (f === 'tracking') return `${v}px`;
  return `"${String(v).length > 24 ? String(v).slice(0, 24) + '…' : v}"`;
}

export type MeasureStatus = 'measured' | 'pending' | 'stale';

export interface Measurement {
  tier: TierId;
  status: MeasureStatus;
  /** 标题行数（待测/失效时保留上一次数值，无历史则为 0） */
  headingLines: number;
  /** 正文行数 */
  bodyLines: number;
  overflowX: boolean;
  overflowY: boolean;
  /** 人类可读的溢出明细，导出时带上 */
  overflowDetail: string;
  /** 实测帧宽 / 文本内容宽 */
  frameWidth: number;
  contentWidth: number;
  /** 输入签名：样例文字/字号/字距/字体等任一变化即失效 */
  signature: string;
  fontReady: boolean;
  measuredAt: number;
  /** 旧数据迁移补录的占位记录 */
  migrated?: boolean;
}

export interface Doc {
  version: 2;
  pairs: Pair[];
  fields: Record<number, PairFields>;
  /** 每个跟踪字段的提交修订号，跨标签页冲突判定依据 */
  revisions: Record<number, Partial<Record<TrackedField, number>>>;
  measurements: Record<number, Partial<Record<TierId, Measurement>>>;
  selectedId: number;
}

export const STORAGE_KEY = 'type-pairs-v2';
export const LEGACY_KEY = 'type-pairs';

export function buildSignature(p: Pair, f: PairFields, tier: TierId): string {
  return [tier, p.heading, p.body, f.headingFont, f.bodyFont, f.size, f.weight, f.leading, f.tracking, TIER_MAP[tier].fontScale].join('|');
}
