import type {Measure, Measures, TierId} from './types';

export interface TierSpec {
  id: TierId;
  label: string;
  /** 实排版心宽度（px），与 CSS 媒体查询断点对齐 */
  width: number;
  /** 版心水平内边距 */
  padX: number;
  /** 固定舞台高度，溢出以此为界 */
  height: number;
  /** 该档标题相对基准字号的缩放 */
  headingScale: number;
}

export const TIERS: TierSpec[] = [
  {id: 'desktop', label: '桌面', width: 760, padX: 45, height: 300, headingScale: 1},
  {id: 'tablet', label: '平板', width: 560, padX: 34, height: 300, headingScale: 0.82},
  {id: 'mobile', label: '手机', width: 375, padX: 25, height: 340, headingScale: 0.72},
];

export const TIER_MAP: Record<TierId, TierSpec> = Object.fromEntries(
  TIERS.map((t) => [t.id, t]),
) as Record<TierId, TierSpec>;

/** 窗口宽度 -> 当前所属档 */
export function tierForViewport(width: number): TierId {
  if (width <= 700) return 'mobile';
  if (width <= 1000) return 'tablet';
  return 'desktop';
}

export function pendingMeasure(reason: Measure['pendingReason'], signature: string | null = null): Measure {
  return {status: 'pending', signature, pendingReason: reason};
}

export function pendingAll(reason: Measure['pendingReason'], signature: string | null = null): Measures {
  return {
    desktop: pendingMeasure(reason, signature),
    tablet: pendingMeasure(reason, signature),
    mobile: pendingMeasure(reason, signature),
  };
}
