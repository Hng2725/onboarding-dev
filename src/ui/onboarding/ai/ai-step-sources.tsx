import type { ReactNode } from 'react';

import type { EmployeeType } from '../../../onboarding/contracts';
import type { TemplateRequestErrors } from './ai-template-batch';

const KIND_OPTIONS: readonly { readonly kind: EmployeeType; readonly label: string; readonly hint: string }[] = [
  { kind: 'normal', label: 'Thông thường', hint: 'Kiến thức chung cho mọi nhân sự mới' },
  { kind: 'advanced', label: 'Nâng cao', hint: 'Theo vai trò và nhiệm vụ cụ thể' },
];

export interface AiStepSourcesProps {
  readonly kind: EmployeeType | null;
  readonly onKind: (kind: EmployeeType) => void;
  readonly templateTitle: string;
  readonly onTemplateTitle: (value: string) => void;
  readonly systemName: string;
  readonly onSystemName: (value: string) => void;
  readonly softwareVersion: string;
  readonly effectiveDate: string;
  readonly onMeta: (patch: { softwareVersion?: string; effectiveDate?: string }) => void;
  readonly responsibilities: string;
  readonly onResponsibilities: (value: string) => void;
  readonly errors: TemplateRequestErrors;
  readonly sourcePanel: ReactNode;
}

/** Step 1 "Nguồn & loại": template kind and naming on the left, source documents on the right. */
export function AiStepSources({
  kind,
  onKind,
  templateTitle,
  onTemplateTitle,
  systemName,
  onSystemName,
  softwareVersion,
  effectiveDate,
  onMeta,
  responsibilities,
  onResponsibilities,
  errors,
  sourcePanel,
}: AiStepSourcesProps) {
  const responsibilityCount = responsibilities.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).length;
  return (
    <div className="ai-step-sources">
      <section className="ai-step-sources-form" aria-label="Loại template">
        <span className="ai-label" id="ai-kind-label">Loại template</span>
        <div className="ai-kind-options" role="radiogroup" aria-labelledby="ai-kind-label">
          {KIND_OPTIONS.map((option) => (
            <button
              key={option.kind}
              type="button"
              role="radio"
              aria-checked={kind === option.kind}
              className={kind === option.kind ? 'ai-kind-option selected' : 'ai-kind-option'}
              onClick={() => onKind(option.kind)}
            >
              <strong>{option.label}</strong>
              <span>{option.hint}</span>
            </button>
          ))}
        </div>
        {kind === 'advanced' && (
          <label className="ai-field">
            <span className="ai-label">Nhiệm vụ chính <small>· 2–8 dòng</small></span>
            <textarea
              name="responsibilities"
              rows={5}
              value={responsibilities}
              aria-invalid={Boolean(errors.responsibilities)}
              aria-describedby={errors.responsibilities ? 'ai-responsibilities-error' : 'ai-responsibilities-count'}
              onChange={(event) => onResponsibilities(event.target.value)}
              placeholder={'Mỗi nhiệm vụ một dòng\nVí dụ: Tạo và gửi báo giá'}
            />
            <small id="ai-responsibilities-count">{responsibilityCount}/8 nhiệm vụ</small>
            {errors.responsibilities && (
              <small className="ai-field-error" id="ai-responsibilities-error">{errors.responsibilities}</small>
            )}
          </label>
        )}
        <label className="ai-field">
          <span className="ai-label">Tên template <small>· không bắt buộc</small></span>
          <input
            name="templateTitle"
            value={templateTitle}
            onChange={(event) => onTemplateTitle(event.target.value)}
            placeholder="AI tự đặt nếu để trống"
          />
        </label>
        <label className="ai-field">
          <span className="ai-label">Tên hệ thống / tổ chức</span>
          <input
            name="systemName"
            value={systemName}
            onChange={(event) => onSystemName(event.target.value)}
            placeholder="Ví dụ: Công ty ABC"
          />
        </label>
        <details className="ai-more">
          <summary>Thông tin thêm</summary>
          <div className="ai-more-fields">
            <label className="ai-field">
              <span className="ai-label">Phiên bản</span>
              <input
                name="softwareVersion"
                value={softwareVersion}
                onChange={(event) => onMeta({ softwareVersion: event.target.value })}
                placeholder="Ví dụ: 2.3"
              />
            </label>
            <label className="ai-field">
              <span className="ai-label">Ngày hiệu lực</span>
              <input
                name="effectiveDate"
                type="date"
                value={effectiveDate}
                onChange={(event) => onMeta({ effectiveDate: event.target.value })}
              />
            </label>
          </div>
        </details>
      </section>
      <div className="ai-step-sources-files">{sourcePanel}</div>
    </div>
  );
}
