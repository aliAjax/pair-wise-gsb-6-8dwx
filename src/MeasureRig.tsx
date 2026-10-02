import {useCallback, useEffect, useRef} from 'react';
import {TIERS, TIER_MAP, pendingMeasure} from './breakpoints';
import {countLines, fontsReadyFor, tierSignature} from './measure';
import StageDocument from './StageDocument';
import type {ContentValues, Measure, Measures, TierId} from './types';

interface Props {
  pairId: number;
  values: ContentValues;
  measures: Measures;
  /** 窗口跨入某档时递增，只强制重测被触及的那一档 */
  retouch: {tier: TierId; n: number} | null;
  onMeasure: (pairId: number, tier: TierId, measure: Measure, signature: string) => void;
}

export default function MeasureRig({pairId, values, measures, retouch, onMeasure}: Props) {
  const headingRefs = useRef<Partial<Record<TierId, HTMLHeadingElement | null>>>({});
  const bodyRefs = useRef<Partial<Record<TierId, HTMLParagraphElement | null>>>({});
  const stageRefs = useRef<Partial<Record<TierId, HTMLDivElement | null>>>({});
  // 用 ref 承载最新输入，保证 runTier 身份稳定，避免状态回写引发的反复重测
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const onMeasureRef = useRef(onMeasure);
  onMeasureRef.current = onMeasure;

  const runTier = useCallback(
    async (tier: TierId, token: {cancelled: boolean}) => {
      const currentValues = valuesRef.current;
      const signature = tierSignature(currentValues, tier);
      const ready = await fontsReadyFor(currentValues, tier);
      if (token.cancelled) return;
      if (!ready) {
        // 字体没加载完：标待测，绝不当定稿；字体就绪后由 loadingdone 补测
        onMeasureRef.current(pairId, tier, pendingMeasure('font-loading', signature), signature);
        return;
      }
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      if (token.cancelled) return;
      const headingEl = headingRefs.current[tier];
      const bodyEl = bodyRefs.current[tier];
      const stageEl = stageRefs.current[tier];
      if (!headingEl || !bodyEl || !stageEl) return;
      onMeasureRef.current(
        pairId,
        tier,
        {
          status: 'measured',
          signature,
          headingLines: countLines(headingEl),
          bodyLines: countLines(bodyEl),
          overflow:
            stageEl.scrollHeight > stageEl.clientHeight + 1 ||
            stageEl.scrollWidth > stageEl.clientWidth + 1,
          measuredAt: Date.now(),
        },
        signature,
      );
    },
    [pairId],
  );

  return (
    <div className="measure-rig" aria-hidden>
      {TIERS.map((spec) => (
        <TierFrame
          key={spec.id}
          pairId={pairId}
          tier={spec.id}
          values={values}
          measure={measures[spec.id]}
          retouchN={retouch?.tier === spec.id ? retouch.n : 0}
          runTier={runTier}
          headingRef={(el) => {
            headingRefs.current[spec.id] = el;
          }}
          bodyRef={(el) => {
            bodyRefs.current[spec.id] = el;
          }}
          stageRef={(el) => {
            stageRefs.current[spec.id] = el;
          }}
        />
      ))}
    </div>
  );
}

interface FrameProps {
  pairId: number;
  tier: TierId;
  values: ContentValues;
  measure: Measure;
  retouchN: number;
  runTier: (tier: TierId, token: {cancelled: boolean}) => void;
  headingRef: (el: HTMLHeadingElement | null) => void;
  bodyRef: (el: HTMLParagraphElement | null) => void;
  stageRef: (el: HTMLDivElement | null) => void;
}

function TierFrame({tier, values, measure, retouchN, runTier, headingRef, bodyRef, stageRef}: FrameProps) {
  const spec = TIER_MAP[tier];
  const signature = tierSignature(values, tier);
  // 需要重测：待测（字体未就绪/刚改完）、签名过期（样例文字/字号/字距等变化）、或窗口跨入该档
  const dirty = measure.status === 'pending' || measure.signature !== signature;
  const force = dirty || retouchN > 0;

  useEffect(() => {
    if (!force) return;
    const token = {cancelled: false};
    const retry = () => runTier(tier, token);
    if ('fonts' in document) document.fonts.addEventListener?.('loadingdone', retry);
    runTier(tier, token);
    return () => {
      token.cancelled = true;
      if ('fonts' in document) document.fonts.removeEventListener?.('loadingdone', retry);
    };
    // runTier 身份稳定；输入变化经 signature -> force 触发，窗口跨档经 retouchN 触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [force, retouchN, runTier, tier]);

  return (
    <div
      ref={stageRef}
      className="measure-stage"
      style={{width: spec.width, height: spec.height, padding: `0 ${spec.padX}px`}}
      data-tier={tier}
    >
      <StageDocument
        values={values}
        headingPx={Math.round(Number(values.size) * spec.headingScale)}
        headingRef={headingRef}
        bodyRef={bodyRef}
      />
    </div>
  );
}
