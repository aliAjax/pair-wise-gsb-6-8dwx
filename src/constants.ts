import type {ContentField} from './types';

export const FIELD_LABELS: Record<ContentField, string> = {
  title: '配对名称',
  category: '分类',
  heading: '标题样例',
  body: '正文样例',
  headingFont: '标题字体',
  bodyFont: '正文字体',
  size: '字号',
  weight: '字重',
  leading: '行高',
  tracking: '字距',
};

export const FONT_FIELDS: ContentField[] = ['headingFont', 'bodyFont'];
export const SAMPLE_FIELDS: ContentField[] = ['title', 'category', 'heading', 'body'];

export function formatFieldValue(field: ContentField, value: string | number): string {
  if (field === 'size') return `${value}px`;
  if (field === 'tracking') return `${value}px`;
  if (field === 'leading') return String(value);
  return String(value);
}
