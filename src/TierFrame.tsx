import {useCallback, useEffect, useLayoutEffect, useRef} from 'react';
import {
  buildSignature,
  Measurement,
  Pair,
  PairFields,
  TierConfig,
  TierId,
} from './types';

interface Props {
  tier: TierConfig;
  pair: Pair;
  fields: PairFields;
  active: boolean;
  onResult: (tier: TierId, m: Measurement) => void;
}

function countLines(span: HTMLElement): number {
  const rects = span.getClientRects();
  let lines = 0;
  let lastTop = Number.NaN;
  for (const r of rects) {
    if (r.width <= 0 || r.height <= 0) continue;
    if (Number.isNaN(lastTop) || Math.abs(r.top - lastTop) > 1) {
      lines += 1;
      lastTop = r.top;
    }
  }
  // 空文本按 0 行
  return span.textContent && span.textContent.trim() ? Math.max(lines, 1) : 0;
}

/** 用画布宽度判断字体族是否真正生效（而不是回退到了系统字体） */
function familyIsRendering(font: string, weight: number): boolean {
  // 通用字体族名直接由系统提供，无需等待 Web 字体
  if (/^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace)$/i.test(font.trim())) {
    return true;
  }
  const base = baselineFor(weight);
  if (!base.length) return true; // 首帧无法比对，交给轮询重测
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return true;
    ctx.font = `${weight} 40px "${font}", sans-serif`;
    const wSans = ctx.measureText('MmwH0123456789标题正文Ag').width;
    ctx.font = `${weight} 40px "${font}", serif`;
    const wSerif = ctx.measureText('MmwH0123456789标题正文Ag').width;
    const EPS = 0.5;
    // 任一回退基线宽度与当前一致，即目标字体还没生效（正在用回退字体）
    return !(Math.abs(base[0] - wSans) <= EPS || Math.abs(base[1] - wSerif) <= EPS);
  } catch {
    return true;
  }
}

/** 各字重的 sans / serif 回退基线宽度（模块级缓存，canvas 测量无副作用） */
const baselineMap = new Map<number, number[]>();
function baselineFor(weight: number): number[] {
  const cached = baselineMap.get(weight);
  if (cached) return cached;
  let v: number[] = [];
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    if (ctx) {
      ctx.font = `${weight} 40px sans-serif`;
      const a = ctx.measureText('MmwH0123456789标题正文Ag').width;
      ctx.font = `${weight} 40px serif`;
      const b = ctx.measureText('MmwH0123456789标题正文Ag').width;
      v = [a, b];
    }
  } catch {
    v = [];
  }
  baselineMap.set(weight, v);
  return v;
}

/** 同步判断两族字体（各按所需字重）是否已真正渲染；未加载完只能待测 */
function checkFonts(headingFont: string, bodyFont: string, weight: number): boolean {
  const fonts = (document as Document & {fonts?: FontFaceSet}).fonts;
  if (fonts && typeof fonts.check === 'function') {
    try {
      const apiReady =
        fonts.check(`${weight} 40px "${headingFont}"`, 'Hg标题') &&
        fonts.check(`400 16px "${bodyFont}"`, 'Hg正文');
      if (!apiReady) return false;
    } catch {
      /* check 异常时继续用画布指纹验证 */
    }
  }
  // 画布指纹确认字体确实生效（fonts.check 对不存在的字体族也返回 true，必须再验证）
  return familyIsRendering(headingFont, weight) && familyIsRendering(bodyFont, 400);
}

function kickFontLoad(headingFont: string, bodyFont: string, weight: number) {
  const fonts = (document as Document & {fonts?: FontFaceSet}).fonts;
  if (!fonts || typeof fonts.load !== 'function') return;
  Promise.allSettled([
    fonts.load(`${weight} 40px "${headingFont}"`, 'Hg标题'),
    fonts.load(`400 16px "${bodyFont}"`, 'Hg正文'),
  ]).catch(() => undefined);
}

export default function TierFrame({tier, pair, fields, active, onResult}: Props) {
  const slotRef = useRef<HTMLDivElement>(null);
  const headProbe = useRef<HTMLSpanElement>(null);
  const bodyProbe = useRef<HTMLSpanElement>(null);
  const headEl = useRef<HTMLHeadingElement>(null);
  const paraEl = useRef<HTMLParagraphElement>(null);
  // 已发布结果的去重指纹（不含 measuredAt，避免时间戳抖动造成无限回写循环）
  const lastFingerprint = useRef<string>('');

  const signature = buildSignature(pair, fields, tier.id);

  const publishPending = useCallback(() => {
    const m: Measurement = {
      tier: tier.id,
      status: 'pending',
      headingLines: 0,
      bodyLines: 0,
      overflowX: false,
      overflowY: false,
      overflowDetail: '字体尚未加载完成，待重排（waiting for web fonts）',
      frameWidth: slotRef.current?.clientWidth ?? 0,
      contentWidth: 0,
      signature,
      fontReady: false,
      measuredAt: Date.now(),
    };
    const fp = JSON.stringify({...m, measuredAt: 0});
    if (fp !== lastFingerprint.current) {
      lastFingerprint.current = fp;
      onResult(tier.id, m);
    }
  }, [onResult, signature, tier.id]);

  const measure = useCallback(() => {
    const slot = slotRef.current;
    if (!slot) return;
    if (!checkFonts(fields.headingFont, fields.bodyFont, fields.weight)) {
      kickFontLoad(fields.headingFont, fields.bodyFont, fields.weight);
      publishPending();
      return;
    }
    const headSpan = headProbe.current!;
    const bodySpan = bodyProbe.current!;
    const h = headEl.current!;
    const p = paraEl.current!;

    const headingLines = countLines(headSpan);
    const bodyLines = countLines(bodySpan);

    // 横向溢出：单个块元素内容比自身客户区宽（长词、大字、字距）
    const headOverflowX = h.scrollWidth > h.clientWidth + 1;
    const bodyOverflowX = p.scrollWidth > p.clientWidth + 1;
    const overflowX = headOverflowX || bodyOverflowX;

    // 纵向溢出：首元素顶 / 末元素底 是否超出固定槽位
    const slotRect = slot.getBoundingClientRect();
    const kids = Array.from(slot.children) as HTMLElement[];
    let top = Infinity;
    let bottom = -Infinity;
    for (const k of kids) {
      const r = k.getBoundingClientRect();
      if (r.height === 0) continue;
      top = Math.min(top, r.top - slotRect.top);
      bottom = Math.max(bottom, r.bottom - slotRect.top);
    }
    const overflowY = top < -0.5 || bottom > slot.clientHeight + 0.5;

    const details: string[] = [];
    if (headOverflowX) details.push('标题横向溢出');
    if (bodyOverflowX) details.push('正文横向溢出');
    if (overflowY) {
      details.push(
        `纵向溢出 ${Math.max(0, Math.round(bottom - slot.clientHeight))}px（内容 ${Math.round(bottom - Math.max(top, 0))}px / 槽位 ${slot.clientHeight}px）`,
      );
    }
    if (!overflowX && !overflowY) details.push('无溢出');

    const m: Measurement = {
      tier: tier.id,
      status: 'measured',
      headingLines,
      bodyLines,
      overflowX,
      overflowY,
      overflowDetail: details.join('；'),
      frameWidth: slot.clientWidth,
      contentWidth: Math.max(h.scrollWidth, p.scrollWidth),
      signature,
      fontReady: true,
      measuredAt: Date.now(),
    };
    const fp = JSON.stringify({...m, measuredAt: 0});
    if (fp !== lastFingerprint.current) {
      lastFingerprint.current = fp;
      onResult(tier.id, m);
    }
  }, [fields, onResult, publishPending, signature]);

  // 样例文字 / 字号 / 字距 / 字体 / 档位变化：只让这一档失效重测。
  // 不在这里重置去重指纹：相同布局的重复测量（含 ResizeObserver 的微小抖动）应被吞掉，
  // 否则会触发“测量→setDoc→重渲染→再测量”的无限循环。
  useLayoutEffect(() => {
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [measure]);

  // 激活档位是流式宽度，窗口变化只重测受影响（激活）档位
  useEffect(() => {
    if (!active) return;
    const slot = slotRef.current;
    if (!slot || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(slot);
    return () => ro.disconnect();
  }, [active, measure]);

  // 字体从网络/磁盘到位后重测；并做有限次轮询兜底（loadingdone 可能错过或不触发）
  useEffect(() => {
    const fonts = (document as Document & {fonts?: FontFaceSet}).fonts;
    const done = () => measure();
    fonts?.addEventListener?.('loadingdone', done);
    kickFontLoad(fields.headingFont, fields.bodyFont, fields.weight);
    let tries = 0;
    // 慢网络下 Web 字体可能要数十秒；轮询约 40s（100 次 ×400ms），到位即停并立即重测
    const timer = setInterval(() => {
      tries += 1;
      const ready = checkFonts(fields.headingFont, fields.bodyFont, fields.weight);
      if (ready || tries >= 100) {
        clearInterval(timer);
        if (ready) measure();
      }
    }, 400);
    return () => {
      clearInterval(timer);
      fonts?.removeEventListener?.('loadingdone', done);
    };
  }, [fields.headingFont, fields.bodyFont, fields.weight, measure]);

  const headingSize = Math.round(fields.size * tier.fontScale);
  const bodySize = +(13 * tier.fontScale).toFixed(1);

  return (
    <div
      className={`tier-frame${active ? ' is-active' : ''}`}
      style={active ? undefined : {width: tier.fixedWidth}}
      data-tier={tier.id}
    >
      <div
        ref={slotRef}
        className="preview"
        style={{padding: `${tier.padY}px ${tier.padX}px`, minHeight: tier.height, height: tier.height}}
      >
        <span className="preview-kicker">A NOTE ON TYPE</span>
        <h3
          ref={headEl}
          style={{
            fontFamily: fields.headingFont,
            fontSize: `${headingSize}px`,
            fontWeight: fields.weight,
            letterSpacing: `${fields.tracking}px`,
            lineHeight: 1.05,
          }}
        >
          <span ref={headProbe}>{pair.heading}</span>
        </h3>
        <p
          ref={paraEl}
          style={{
            fontFamily: fields.bodyFont,
            fontSize: `${bodySize}px`,
            lineHeight: fields.leading,
            letterSpacing: `${fields.tracking / 2}px`,
          }}
        >
          <span ref={bodyProbe}>{pair.body}</span>
        </p>
        <div className="preview-rule" />
        <span className="preview-meta">
          PAIRING 0{pair.id} · {pair.category.toUpperCase()} · {tier.label.toUpperCase()} {tier.fixedWidth}×
          {tier.height}
        </span>
      </div>
    </div>
  );
}
