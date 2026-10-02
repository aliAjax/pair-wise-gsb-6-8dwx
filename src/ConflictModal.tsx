import {AlertTriangle} from 'lucide-react';
import {FIELD_LABELS, formatFieldValue} from './constants';
import type {ContentField, ContentValues} from './types';

interface Props {
  conflicts: ContentField[];
  base: ContentValues;
  remote: ContentValues | null;
  local: ContentValues;
  onResolve: (picks: Partial<Record<ContentField, string | number>>) => void;
  onCancel: () => void;
}

/** 后提交者看到的字段冲突：逐字段选择保留本地草稿还是采用另一标签页的值 */
export default function ConflictModal({conflicts, remote, local, onResolve, onCancel}: Props) {
  return (
    <div className="backdrop">
      <div className="modal conflict-modal">
        <h2>
          <AlertTriangle size={17} color="#c17a4a" /> 字段冲突
        </h2>
        <p className="conflict-intro">
          另一个标签页已经先提交，并且改动了相同字段。逐字段选择要保留的值，非冲突字段已自动合并。
        </p>
        <div className="conflict-list">
          {conflicts.map((field) => (
            <div key={field} className="conflict-row" data-field={field}>
              <span className="conflict-name">{FIELD_LABELS[field]}</span>
              <label className="conflict-choice">
                <input
                  type="radio"
                  name={`conflict-${field}`}
                  defaultChecked
                  value="local"
                />
                <span className="choice-tag local">本标签页</span>
                <b>{formatFieldValue(field, local[field])}</b>
              </label>
              <label className="conflict-choice">
                <input type="radio" name={`conflict-${field}`} value="remote" />
                <span className="choice-tag remote">另一标签页</span>
                <b>{remote ? formatFieldValue(field, remote[field]) : '—'}</b>
              </label>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="outline" onClick={onCancel}>
            保留草稿，稍后处理
          </button>
          <button
            className="primary"
            onClick={() => {
              // 读取用户在每组单选里的选择
              const picks: Partial<Record<ContentField, string | number>> = {};
              conflicts.forEach((field) => {
                const checked = document.querySelector<HTMLInputElement>(
                  `.conflict-row[data-field="${field}"] input:checked`,
                );
                if (checked?.value === 'remote' && remote) picks[field] = remote[field];
                else picks[field] = local[field];
              });
              onResolve(picks);
            }}
          >
            按选择合并并保存
          </button>
        </div>
      </div>
    </div>
  );
}
