import {TIERS, TIER_MAP} from './breakpoints';
import type {Measures, Pair} from './types';

const MEDIA: Record<string, string> = {
  tablet: '@media (max-width: 1000px)',
  mobile: '@media (max-width: 700px)',
};

function measureLine(tier: string, m: Measures[keyof Measures]): string {
  if (m.status !== 'measured' || m.headingLines === undefined) {
    return ` * ${tier}: 待测（字体未就绪或尚未重测，不得视为定稿）`;
  }
  return ` * ${tier}: 标题 ${m.headingLines} 行 · 正文 ${m.bodyLines} 行 · 溢出 ${m.overflow ? '是 ⚠' : '否'}`;
}

/** 导出 CSS：桌面基准 + 平板/手机媒体查询，并在注释里带上各档行数与溢出状态 */
export function buildCss(pair: Pair): string {
  const lines: string[] = [];
  lines.push(`/* ${pair.title} — Type Pairer 实排测量导出 */`);
  lines.push('/* 三档实排结果：');
  for (const spec of TIERS) lines.push(measureLine(spec.id, pair.measures[spec.id]));
  lines.push('*/');
  lines.push('');
  lines.push(`.heading { font-family: '${pair.headingFont}'; font-size: ${pair.size}px; font-weight: ${pair.weight}; letter-spacing: ${pair.tracking}px; line-height: 1.05; }`);
  lines.push(`.body { font-family: '${pair.bodyFont}'; line-height: ${pair.leading}; letter-spacing: ${Number(pair.tracking) / 2}px; font-size: 13px; }`);
  for (const spec of TIERS) {
    if (spec.id === 'desktop') continue;
    const headingPx = Math.round(Number(pair.size) * spec.headingScale);
    const m = pair.measures[spec.id];
    lines.push('');
    lines.push(MEDIA[spec.id]);
    lines.push('{');
    lines.push(
      `  .heading { font-size: ${headingPx}px; } /* ${spec.label} 标题 ${m.status === 'measured' ? `${m.headingLines} 行，溢出 ${m.overflow ? '是' : '否'}` : '待测'} */`,
    );
    lines.push('}');
  }
  return lines.join('\n');
}

/** 导出用的数据片段（便于测试） */
export function tierSummary(measures: Measures) {
  return TIERS.map((spec) => {
    const m = measures[spec.id];
    return {
      tier: spec.id,
      label: spec.label,
      width: TIER_MAP[spec.id].width,
      ...(m.status === 'measured'
        ? {
            status: 'measured' as const,
            headingLines: m.headingLines,
            bodyLines: m.bodyLines,
            overflow: m.overflow,
          }
        : {status: 'pending' as const, reason: m.pendingReason}),
    };
  });
}
