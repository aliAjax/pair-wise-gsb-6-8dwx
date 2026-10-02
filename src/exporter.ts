import {Doc, Measurement, Pair, PairFields, TIER_MAP, TIERS, TierId} from './types';

function pad(s: string, n: number): string {
  return s + ' '.repeat(Math.max(0, n - s.length));
}

function cssForTier(f: PairFields, tier: TierId): string {
  const c = TIER_MAP[tier];
  const headingSize = Math.round(f.size * c.fontScale);
  const bodySize = +(13 * c.fontScale).toFixed(1);
  return [
    `  .heading {`,
    `    font-family: '${f.headingFont}', serif;`,
    `    font-size: ${headingSize}px;`,
    `    font-weight: ${f.weight};`,
    `    line-height: 1.05;`,
    `    letter-spacing: ${f.tracking}px;`,
    `  }`,
    `  .body {`,
    `    font-family: '${f.bodyFont}', sans-serif;`,
    `    font-size: ${bodySize}px;`,
    `    line-height: ${f.leading};`,
    `    letter-spacing: ${f.tracking / 2}px;`,
    `  }`,
  ].join('\n');
}

function statusCN(m?: Measurement): string {
  if (!m) return '未测量 (not measured)';
  if (m.status === 'pending') return '待测·字体未就绪 (pending fonts)';
  if (m.status === 'stale') return '已失效·待重测 (stale)';
  return '已定稿 (measured)';
}

/** 导出：响应式 CSS 三档都带，并附各档标题行数 / 正文行数 / 溢出状态的测量报告 */
export function buildExport(pair: Pair, fields: PairFields, meas: Partial<Record<TierId, Measurement>>): string {
  const lines: string[] = [];
  lines.push(`/* ============================================================`);
  lines.push(` * Type Pairer 导出 — ${pair.title} (PAIRING 0${pair.id})`);
  lines.push(` * 分类: ${pair.category}`);
  lines.push(` * 桌面/平板/手机三档实排测量报告（行数基于真实排版测量）`);
  lines.push(` * ============================================================ */`);
  lines.push('');
  lines.push(`/* ---- 三档实排测量报告 / measured layout report ---- */`);
  lines.push(`/* 档位        帧宽×槽高        标题行  正文行  横向溢出  纵向溢出  状态 / 明细 */`);
  for (const t of TIERS) {
    const m = meas[t.id];
    const c = TIER_MAP[t.id];
    const sizeCol = pad(`${m?.frameWidth || c.fixedWidth}×${c.height}`, 14);
    const h = m ? String(m.headingLines) : '-';
    const b = m ? String(m.bodyLines) : '-';
    const ox = m ? (m.overflowX ? '是 YES' : '否 no') : '-';
    const oy = m ? (m.overflowY ? '是 YES' : '否 no') : '-';
    lines.push(
      `/* ${pad(t.cn, 4)}  ${sizeCol} ${pad(h, 5)}  ${pad(b, 5)}  ${pad(ox, 7)}  ${pad(oy, 7)}  ${statusCN(m)}${m ? ' · ' + m.overflowDetail : ''} */`,
    );
  }
  const anyUnfinal = TIERS.some((t) => {
    const m = meas[t.id];
    return !m || m.status !== 'measured';
  });
  if (anyUnfinal) {
    lines.push(`/* 注意：存在待测/已失效档位，以上数值不是定稿；请在画布中重排后再交付。 */`);
  }
  lines.push('');
  lines.push(`/* ---- 响应式 CSS / responsive ---- */`);
  lines.push(`/* 桌面 desktop（默认，>1000px） */`);
  lines.push(cssForTier(fields, 'desktop'));
  lines.push('');
  lines.push(`/* 平板 tablet（701–1000px），字号 ×${TIER_MAP.tablet.fontScale} */`);
  lines.push(`@media (max-width: 1000px) {`);
  lines.push(cssForTier(fields, 'tablet'));
  lines.push(`}`);
  lines.push('');
  lines.push(`/* 手机 mobile（≤700px），字号 ×${TIER_MAP.mobile.fontScale} */`);
  lines.push(`@media (max-width: 700px) {`);
  lines.push(cssForTier(fields, 'mobile'));
  lines.push(`}`);
  lines.push('');
  return lines.join('\n');
}

export function downloadCss(filename: string, content: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], {type: 'text/css'}));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
