import { useEffect, useState } from 'react';

import type { EmployeeType, OutlineEdit, TemplateOutline } from '../../../onboarding/contracts';
import { validateAdminOutline } from '../../../onboarding/ai/outline-validation';
import { ADVANCED_FRAMES, NORMAL_FRAMES } from '../../../onboarding/ai/validate';

export type ModuleSourceCatalog = readonly {
  readonly sourceId: string;
  readonly fileName: string;
  readonly sections: readonly {
    readonly id: string;
    readonly headingPath: readonly string[];
  }[];
}[];

type OutlineModule = TemplateOutline['modules'][number];

const FRAME_LABELS: Readonly<Record<string, string>> = {
  't1-overview': 'Tổng quan',
  't1-access': 'Tài khoản và quyền truy cập',
  't1-navigation': 'Làm quen giao diện',
  't1-core': 'Quy trình công việc chính',
  't1-core-2': 'Quy trình bổ sung',
  't1-data': 'Dữ liệu và báo cáo',
  't1-security': 'Bảo mật và an toàn',
  't1-support': 'Hỗ trợ và xử lý sự cố',
  't2-role': 'Vai trò và mục tiêu',
  't2-permissions': 'Quyền truy cập chuyên sâu',
  't2-task-1': 'Nhiệm vụ chuyên sâu 1',
  't2-task-2': 'Nhiệm vụ chuyên sâu 2',
  't2-task-3': 'Nhiệm vụ chuyên sâu 3',
  't2-task-4': 'Nhiệm vụ chuyên sâu 4',
  't2-task-5': 'Nhiệm vụ chuyên sâu 5',
  't2-task-6': 'Nhiệm vụ chuyên sâu 6',
  't2-collab': 'Phối hợp công việc',
  't2-reports': 'Báo cáo chuyên sâu',
  't2-control': 'Kiểm soát và tuân thủ',
};

export function outlineFrameLabel(frameKey: string): string {
  return FRAME_LABELS[frameKey] ?? frameKey;
}

export function outlineModuleDisplayTitle(module: OutlineModule): string {
  const title = module.title.trim();
  return !title || title === module.frameKey ? outlineFrameLabel(module.frameKey) : title;
}

export function AiOutlineReview({
  outline,
  templateKind,
  responsibilities,
  busy,
  onEdit,
  onApprove,
  sourceCatalog = [],
  onSupplement,
}: {
  outline: TemplateOutline;
  templateKind: EmployeeType;
  responsibilities: readonly string[];
  busy: boolean;
  onEdit: (edits: readonly OutlineEdit[]) => void;
  onApprove: () => void;
  sourceCatalog?: ModuleSourceCatalog;
  onSupplement?: (moduleLocalId: string, sourceIds: string[], sectionIds: string[]) => void;
}) {
  const modules = outline.modules.filter((module) => !module.tombstoned).sort((left, right) => left.order - right.order);
  const [selectedModuleId, setSelectedModuleId] = useState(() => modules[0]?.moduleLocalId ?? '');
  const [panel, setPanel] = useState<'closed' | 'edit' | 'add'>('closed');
  const [editorDirty, setEditorDirty] = useState(false);
  const moduleIds = modules.map((module) => module.moduleLocalId).join('|');
  useEffect(() => {
    if (!modules.some((module) => module.moduleLocalId === selectedModuleId)) {
      setSelectedModuleId(modules[0]?.moduleLocalId ?? '');
      setPanel('closed');
      setEditorDirty(false);
    }
  }, [moduleIds, selectedModuleId]);

  const selectedModule = modules.find((module) => module.moduleLocalId === selectedModuleId) ?? modules[0];
  const errors = validateAdminOutline(outline, { templateKind, responsibilities });
  const frames: readonly string[] = templateKind === 'normal' ? NORMAL_FRAMES : ADVANCED_FRAMES;
  const availableFrames = frames.filter((frame) => !modules.some((module) => module.frameKey === frame));
  const minimum = templateKind === 'normal' ? 4 : 5;
  const invalid = errors.length > 0;
  const closePanel = () => {
    setPanel('closed');
    setEditorDirty(false);
  };

  return (
    <section className="ai-outline-review">
      <header className="ai-roadmap-heading">
        <div>
          <h3>Kiểm tra lộ trình đề xuất</h3>
          <p>
            {templateKind === 'normal'
              ? 'Tất cả module dưới đây tạo thành một lộ trình theo thứ tự. Chọn module để xem hoặc chỉnh sửa.'
              : 'Tất cả module dưới đây tạo thành một lộ trình theo thứ tự. Kiểm tra mục tiêu và nhiệm vụ công việc trước khi tiếp tục.'}
          </p>
        </div>
        <span>{modules.length} module</span>
      </header>

      <div className="ai-roadmap-grid" role="list" aria-label="Lộ trình module">
        {modules.map((module, index) => {
          const title = outlineModuleDisplayTitle(module);
          const hasSources = module.sourceSectionIds.length > 0;
          return (
            <article className="ai-roadmap-card" role="listitem" key={module.moduleLocalId}>
              <button
                type="button"
                aria-pressed={module.moduleLocalId === selectedModule?.moduleLocalId}
                disabled={editorDirty && module.moduleLocalId !== selectedModule?.moduleLocalId}
                onClick={() => {
                  setSelectedModuleId(module.moduleLocalId);
                  setPanel('closed');
                  setEditorDirty(false);
                }}
              >
                <strong>{index + 1}. {title}</strong>
                <span>{module.description || 'Chưa có mô tả ngắn.'}</span>
                <span className="ai-roadmap-meta">
                  <small>{module.estimatedMinutes} phút</small>
                  <small className={hasSources ? 'ready' : 'missing'}>
                    {hasSources ? 'Đủ tài liệu' : 'Cần bổ sung tài liệu'}
                  </small>
                  {templateKind === 'advanced' && module.responsibilityIndexes.length > 0 && (
                    <small>{module.responsibilityIndexes.length} nhiệm vụ công việc</small>
                  )}
                </span>
                <small>Chưa duyệt</small>
              </button>
            </article>
          );
        })}
      </div>

      {panel === 'add' && (
        <AddModulePanel
          availableFrames={availableFrames}
          busy={busy}
          disabled={modules.length >= 8}
          onAdd={(frameKey) => {
            onEdit([{ type: 'add', module: {
              frameKey,
              order: modules.length,
              title: outlineFrameLabel(frameKey),
              description: '',
              estimatedMinutes: 10,
              objectives: [],
              featureIds: [],
              sourceSectionIds: [],
              responsibilityIndexes: [],
            } }]);
            closePanel();
          }}
          onClose={closePanel}
        />
      )}

      {panel === 'edit' && selectedModule && (
        <ModuleEditPanel
          key={`${selectedModule.moduleLocalId}:${outline.revision}`}
          module={selectedModule}
          templateKind={templateKind}
          responsibilities={responsibilities}
          index={modules.indexOf(selectedModule)}
          total={modules.length}
          removable={modules.length > minimum && !['t1-overview', 't1-core'].includes(selectedModule.frameKey)}
          busy={busy}
          sourceCatalog={sourceCatalog}
          onSupplement={onSupplement}
          onDirty={setEditorDirty}
          onEdit={onEdit}
          onClose={closePanel}
        />
      )}

      {invalid && <p role="alert">Khung chưa hợp lệ: {errors.map((error) => error.message).join(' · ')}</p>}

      <div className="ai-roadmap-actions">
        <button
          type="button"
          disabled={busy || editorDirty || availableFrames.length === 0 || modules.length >= 8}
          onClick={() => { setPanel('add'); setEditorDirty(false); }}
        >Thêm module bổ sung</button>
        <button
          type="button"
          disabled={busy || !selectedModule}
          onClick={() => { setPanel('edit'); setEditorDirty(false); }}
        >Chỉnh sửa module</button>
        <button
          type="button"
          className="button button-primary"
          disabled={busy || invalid || editorDirty}
          onClick={onApprove}
        >Duyệt lộ trình và tiếp tục</button>
      </div>
    </section>
  );
}

function AddModulePanel({
  availableFrames,
  busy,
  disabled,
  onAdd,
  onClose,
}: {
  availableFrames: readonly string[];
  busy: boolean;
  disabled: boolean;
  onAdd: (frameKey: string) => void;
  onClose: () => void;
}) {
  const [selectedFrame, setSelectedFrame] = useState('');
  return (
    <section className="ai-roadmap-panel" aria-label="Thêm module bổ sung">
      <header><div><strong>Thêm module bổ sung</strong><small>Module mới sẽ nằm cuối lộ trình.</small></div></header>
      <label>Loại module
        <select aria-label="Chọn module bổ sung" value={selectedFrame} disabled={busy || disabled} onChange={(event) => setSelectedFrame(event.target.value)}>
          <option value="">Chọn nội dung cần bổ sung</option>
          {availableFrames.map((frame) => <option value={frame} key={frame}>{outlineFrameLabel(frame)}</option>)}
        </select>
      </label>
      <div className="ai-roadmap-panel-actions">
        <button type="button" onClick={onClose}>Đóng</button>
        <button type="button" disabled={busy || disabled || !availableFrames.includes(selectedFrame)} onClick={() => onAdd(selectedFrame)}>Thêm vào lộ trình</button>
      </div>
    </section>
  );
}

function ModuleEditPanel({
  module,
  templateKind,
  responsibilities,
  index,
  total,
  removable,
  busy,
  sourceCatalog,
  onSupplement,
  onDirty,
  onEdit,
  onClose,
}: {
  module: OutlineModule;
  templateKind: EmployeeType;
  responsibilities: readonly string[];
  index: number;
  total: number;
  removable: boolean;
  busy: boolean;
  sourceCatalog: ModuleSourceCatalog;
  onSupplement?: (moduleLocalId: string, sourceIds: string[], sectionIds: string[]) => void;
  onDirty: (dirty: boolean) => void;
  onEdit: (edits: readonly OutlineEdit[]) => void;
  onClose: () => void;
}) {
  const initialTitle = outlineModuleDisplayTitle(module);
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(module.description);
  const [estimatedMinutes, setEstimatedMinutes] = useState(module.estimatedMinutes);
  const [objectives, setObjectives] = useState(module.objectives.join('\n'));
  const [assignments, setAssignments] = useState(module.responsibilityIndexes.join(', '));
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  const [selectedSections, setSelectedSections] = useState<ReadonlySet<string>>(new Set());
  const dirty = title !== initialTitle
    || description !== module.description
    || estimatedMinutes !== module.estimatedMinutes
    || objectives !== module.objectives.join('\n')
    || assignments !== module.responsibilityIndexes.join(', ');

  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  const displayTitle = outlineModuleDisplayTitle(module);
  const mappedResponsibilities = module.responsibilityIndexes
    .map((responsibilityIndex) => responsibilities[responsibilityIndex])
    .filter(Boolean);

  return (
    <section className="ai-roadmap-panel" aria-label={`Chỉnh sửa ${displayTitle}`}>
      <header>
        <div><strong>Chỉnh sửa module</strong><small>{displayTitle}</small></div>
        <div>
          <button type="button" aria-label={`Đưa ${displayTitle} lên`} disabled={busy || dirty || index === 0} onClick={() => onEdit([{ type: 'reorder', moduleLocalId: module.moduleLocalId, order: index - 1 }])}>↑</button>
          <button type="button" aria-label={`Đưa ${displayTitle} xuống`} disabled={busy || dirty || index === total - 1} onClick={() => onEdit([{ type: 'reorder', moduleLocalId: module.moduleLocalId, order: index + 1 }])}>↓</button>
        </div>
      </header>

      <div className="ai-roadmap-fields">
        <label>Tên module<input aria-label="Tên module" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>Mô tả ngắn<input value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        <label>Thời lượng (phút)<input type="number" min={1} value={estimatedMinutes} onChange={(event) => setEstimatedMinutes(Number(event.target.value))} /></label>
        <label>Mục tiêu học tập<textarea value={objectives} onChange={(event) => setObjectives(event.target.value)} /></label>
        {templateKind === 'advanced' && (
          <>
            <p>{mappedResponsibilities.length > 0
              ? `${mappedResponsibilities.length} nhiệm vụ công việc: ${mappedResponsibilities.join(', ')}`
              : 'Chưa gắn nhiệm vụ công việc.'}</p>
            <label>Chỉ số nhiệm vụ công việc (bắt đầu từ 0)<input value={assignments} onChange={(event) => setAssignments(event.target.value)} /></label>
          </>
        )}
      </div>

      {onSupplement && (
        <div className="ai-roadmap-source-action">
          <button type="button" disabled={busy || dirty} onClick={() => setSourcePickerOpen((open) => !open)}>Bổ sung tài liệu</button>
          {sourcePickerOpen && (
            <div className="ai-roadmap-source-picker" role="region" aria-label="Chọn tài liệu bổ sung">
              {sourceCatalog.length > 0 ? sourceCatalog.map((source) => (
                <section key={source.sourceId}>
                  <strong>{source.fileName}</strong>
                  {source.sections.map((section) => (
                    <label key={section.id}>
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={selectedSections.has(section.id)}
                        onChange={(event) => setSelectedSections((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(section.id);
                          else next.delete(section.id);
                          return next;
                        })}
                      />
                      {section.headingPath.join(' / ') || section.id}
                    </label>
                  ))}
                </section>
              )) : <p>Chưa có tài liệu nào để bổ sung.</p>}
              <button
                type="button"
                disabled={busy || selectedSections.size === 0}
                onClick={() => {
                  const sectionIds = [...selectedSections];
                  const sourceIds = sourceCatalog
                    .filter((source) => source.sections.some((section) => selectedSections.has(section.id)))
                    .map((source) => source.sourceId);
                  onSupplement(module.moduleLocalId, sourceIds, sectionIds);
                  setSelectedSections(new Set());
                  setSourcePickerOpen(false);
                }}
              >Thêm tài liệu đã chọn</button>
            </div>
          )}
        </div>
      )}

      <div className="ai-roadmap-panel-actions">
        <button type="button" onClick={onClose}>Đóng chỉnh sửa</button>
        <button type="button" disabled={busy || dirty || !removable} onClick={() => onEdit([{ type: 'delete', moduleLocalId: module.moduleLocalId }])}>Xóa module</button>
        <button
          type="button"
          disabled={busy || !title.trim() || estimatedMinutes < 1}
          onClick={() => {
            const nextObjectives = objectives.split('\n').map((value) => value.trim()).filter(Boolean);
            const nextAssignments = templateKind === 'advanced' && assignments.trim()
              ? assignments.split(',').map((value) => Number(value.trim()))
              : module.responsibilityIndexes;
            onEdit([{ type: 'update', moduleLocalId: module.moduleLocalId, patch: {
              title: title.trim(),
              description: description.trim(),
              estimatedMinutes,
              objectives: nextObjectives,
              sourceSectionIds: module.sourceSectionIds,
              responsibilityIndexes: nextAssignments,
            } }]);
            onClose();
          }}
        >Lưu thay đổi</button>
      </div>
    </section>
  );
}
