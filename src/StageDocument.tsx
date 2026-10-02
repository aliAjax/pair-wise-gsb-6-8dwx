import type {ContentValues} from './types';

interface Props {
  values: ContentValues;
  /** 该档标题实际像素字号 */
  headingPx: number;
  headingRef?: React.Ref<HTMLHeadingElement>;
  bodyRef?: React.Ref<HTMLParagraphElement>;
}

/** 可见预览与测量台共用的实排内容，保证测到的就是看到的 */
export default function StageDocument({values, headingPx, headingRef, bodyRef}: Props) {
  return (
    <>
      <span className="preview-kicker">A NOTE ON TYPE</span>
      <h3
        ref={headingRef}
        style={{
          fontFamily: String(values.headingFont),
          fontSize: `${headingPx}px`,
          fontWeight: Number(values.weight),
          letterSpacing: `${values.tracking}px`,
          lineHeight: 1.05,
        }}
      >
        {values.heading}
      </h3>
      <p
        ref={bodyRef}
        style={{
          fontFamily: String(values.bodyFont),
          lineHeight: Number(values.leading),
          letterSpacing: `${Number(values.tracking) / 2}px`,
        }}
      >
        {values.body}
      </p>
      <div className="preview-rule" />
      <span className="preview-meta">{String(values.category).toUpperCase()}</span>
    </>
  );
}
