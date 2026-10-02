import {TIER_MAP} from './breakpoints';
import type {ContentValues, TierId} from './types';

/** 一档测量输入的签名：样例文字/字号/字距等任一变化都会换签名 */
export function tierSignature(values: ContentValues, tier: TierId): string {
  const spec = TIER_MAP[tier];
  return [
    tier,
    spec.width,
    spec.padX,
    spec.headingScale,
    values.headingFont,
    values.bodyFont,
    values.heading,
    values.body,
    values.size,
    values.weight,
    values.leading,
    values.tracking,
  ].join('|');
}

/**
 * 统计一个块级元素实际排成的行数。
 * 用 Range 取每行首字符的 clientRect 顶边聚类；取不到时退回高度/行高。
 */
export function countLines(el: HTMLElement): number {
  const text = (el.textContent || '').trim();
  if (!text) return 0;
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = Array.from(range.getClientRects());
    if (rects.length > 0) {
      const tops = new Set(rects.map((r) => Math.round(r.top)));
      return tops.size;
    }
  } catch {
    /* fall through */
  }
  const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 0;
  if (lineHeight > 0) return Math.max(1, Math.round(el.getBoundingClientRect().height / lineHeight));
  return 1;
}

/** 内容是否溢出固定舞台高度或版心宽度 */
export function detectOverflow(frame: HTMLElement, stage: HTMLElement): boolean {
  return stage.scrollHeight > stage.clientHeight + 1 || stage.scrollWidth > stage.clientWidth + 1;
}

/** 该档用到的字体是否都已加载完成；未完成时绝不当定稿 */
export async function fontsReadyFor(values: ContentValues, tier: TierId): Promise<boolean> {
  if (!('fonts' in document)) return true;
  const headingSize = Math.round(Number(values.size) * TIER_MAP[tier].headingScale);
  const checks: Array<[string, number]> = [
    [String(values.headingFont), Number(values.weight)],
    [String(values.bodyFont), 400],
  ];
  const results = await Promise.all(
    checks.map(([family, weight]) =>
      document.fonts
        .load(`${weight} ${headingSize}px "${family}"`)
        .then((faces) => faces.length > 0)
        .catch(() => false),
    ),
  );
  return results.every(Boolean) && document.fonts.status === 'loaded';
}
