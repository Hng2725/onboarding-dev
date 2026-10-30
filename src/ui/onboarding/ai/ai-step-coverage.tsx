import { useState, type ChangeEvent } from 'react';

import type { AiJobRecord, OutlineEdit, TemplateOutlineModule } from '../../../onboarding/contracts';
import { AI_GENERATION_LIMITS } from '../../../onboarding/ai/limits';
import { isModuleCovered, moduleHasUsableSources, retryableSupplementSourceId } from '../../../onboarding/ai/outline-coverage';
import { outlineModuleDisplayTitle } from '../../../onboarding/ai/frame-labels';
import { ADVANCED_FRAMES, NORMAL_FRAMES } from '../../../onboarding/ai/validate';

/** Ready room sources from `list_module_sources`; `usable` says whether a section can ground a module. */
export type ModuleSourceCatalog = readonly {
  readonly sourceId: string;
  readonly fileName: string;
  readonly sections: readonly {
    readonly id: string;
    readonly headingPath: readonly string[];
    readonly usable: boolean;
  }[];
}[];

export interface AiStepCoverageProps {
  readonly job: AiJobRecord;
  readonly usableSectionIds: ReadonlySet<string>;
  readonly sourceCatalog: ModuleSourceCatalog;
  readonly sourceNames: ReadonlyMap<string, string>;
  readonly busy: boolean;
  /** Opens the section picker of this module, e.g. when coming back from AI tạo nội dung. */
  readonly initialPickerModuleId?: string | null;
  onEdit(edits: readonly OutlineEdit[]): void;
  onUploadFor(moduleLocalId: string, file: File): void;
  onPickSections(moduleLocalId: string, sourceIds: string[], sectionIds: string[]): void;
  onOverride(moduleLocalId: string): void;
  /** Re-reads the batches a new-file supplement skipped, from the source it recorded. */
  onRetrySupplement(moduleLocalId: string, sourceId: string): void;
  onAddModule(title: string, description: string): void;
}

type Module = TemplateOutlineModule;
type OpenPanel = { readonly moduleLocalId: string; readonly kind: 'edit' | 'pick' } | { readonly moduleLocalId: null; readonly kind: 'add' } | null;

/** Frames that the template must keep: removing them would make the outline invalid. */
const REQUIRED_NORMAL_FRAMES: ReadonlySet<string> = new Set(['t1-overview', 't1-core']);
const MAX_OBJECTIVES = 4;
const DEFAULT_GAP_NOTE = 'AI chưa tìm thấy đủ tài liệu cho module này.';

function fileLabel(fileName: string): string {
  return fileName.replace(/\.[a-z0-9]{1,5}$/i, '');
}

/** "Sổ tay hội nhập · Mục 1, Mục 2 · An toàn · Mục 3": file names with the headings used from each. */
function sourceLine(module: Module, catalog: ModuleSourceCatalog, sourceNames: ReadonlyMap<string, string>): string {
  const groups = new Map<string, { name: string; headings: string[] }>();
  for (const sectionId of module.sourceSectionIds) {
    const source = catalog.find((candidate) => candidate.sections.some((section) => section.id === sectionId));
    const section = source?.sections.find((candidate) => candidate.id === sectionId);
    const sourceId = source?.sourceId ?? sectionId.split('#')[0];
    const name = source?.fileName ?? sourceNames.get(sourceId);
    if (!name) continue;
    const group = groups.get(sourceId) ?? { name: fileLabel(name), headings: [] };
    const heading = section?.headingPath[section.headingPath.length - 1]?.trim();
    if (heading && !group.headings.includes(heading)) group.headings.push(heading);
    groups.set(sourceId, group);
  }
  if (groups.size === 0) return 'Chưa có đoạn tài liệu nào';
  return [...groups.values()].map((group) => [group.name, group.headings.join(', ')].filter(Boolean).join(' · ')).join(' · ');
}

function SkeletonList({ label }: { readonly label: string }) {
  return (
    <div className="ai-coverage ai-coverage-loading" role="status" aria-busy="true">
      <p className="ai-coverage-loading-label"><span className="ai-coverage-pulse" aria-hidden="true" />{label}</p>
      <div className="ai-coverage-summary ai-coverage-skeleton" aria-hidden="true">
        {[0, 1, 2, 3].map((index) => <div className="ai-coverage-stat" key={index}><i className="ai-skeleton-bar short" /><i className="ai-skeleton-bar" /></div>)}
      </div>
      <div className="ai-coverage-modules ai-coverage-skeleton" aria-hidden="true">
        {[0, 1, 2, 3].map((index) => (
          <div className="ai-coverage-module" key={index}>
            <i className="ai-skeleton-bar dot" />
            <div><i className="ai-skeleton-bar" /><i className="ai-skeleton-bar short" /></div>
            <i className="ai-skeleton-bar chip" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The loading state of the coverage step, also shown while the module catalog loads. */
export function AiCoverageSkeleton({ label }: { readonly label: string }) {
  return <SkeletonList label={label} />;
}

export function AiStepCoverage({
  job,
  usableSectionIds,
  sourceCatalog,
  sourceNames,
  busy,
  initialPickerModuleId,
  onEdit,
  onUploadFor,
  onPickSections,
  onOverride,
  onRetrySupplement,
  onAddModule,
}: AiStepCoverageProps) {
  const [panel, setPanel] = useState<OpenPanel>(() => initialPickerModuleId
    ? { moduleLocalId: initialPickerModuleId, kind: 'pick' }
    : null);

  const liveCalls = job.calls.filter((call) => call.status === 'pending' || call.status === 'dispatched');
  const readingModuleIds = new Set(liveCalls
    .filter((call) => call.stage === 'S' && call.supplementModuleLocalId)
    .map((call) => call.supplementModuleLocalId!));
  // A planner pass (P) rewrites the whole outline, so nothing from the previous one is shown.
  const planning = job.planPending && (readingModuleIds.size === 0 || liveCalls.some((call) => call.stage === 'P'));
  if (planning || !job.outline) return <SkeletonList label="AI đang lập lộ trình…" />;

  const templateKind = job.templateKind ?? 'normal';
  const responsibilities = job.roleProfile?.responsibilities ?? [];
  const modules = job.outline.modules.filter((module) => !module.tombstoned).sort((left, right) => left.order - right.order);
  const range = templateKind === 'normal' ? AI_GENERATION_LIMITS.normalModuleRange : AI_GENERATION_LIMITS.advancedModuleRange;
  const frames: readonly string[] = templateKind === 'normal' ? NORMAL_FRAMES : ADVANCED_FRAMES;
  const locked = busy || job.planPending;
  const coveredCount = modules.filter((module) => isModuleCovered(module, usableSectionIds)).length;
  const minutes = modules.reduce((sum, module) => sum + (Number.isFinite(module.estimatedMinutes) ? module.estimatedMinutes : 0), 0);
  const canAdd = modules.length < range.max && frames.some((frame) => !modules.some((module) => module.frameKey === frame));
  const togglePanel = (next: Exclude<OpenPanel, null>) => setPanel((current) =>
    current && current.kind === next.kind && current.moduleLocalId === next.moduleLocalId ? null : next);

  return (
    <div className="ai-coverage">
      <div className="ai-coverage-summary" role="group" aria-label="Tóm tắt độ phủ">
        <div className="ai-coverage-stat"><b>{modules.length}</b><span>module đề xuất</span></div>
        <div className="ai-coverage-stat ok"><b>{coveredCount}</b><span>đủ tài liệu</span></div>
        <div className="ai-coverage-stat warn"><b>{modules.length - coveredCount}</b><span>cần bổ sung</span></div>
        <div className="ai-coverage-stat"><b>~{minutes}</b><span>phút học</span></div>
      </div>

      <ol className="ai-coverage-modules" aria-label="Lộ trình module">
        {modules.map((module, index) => {
          const title = outlineModuleDisplayTitle(module);
          const covered = isModuleCovered(module, usableSectionIds);
          const confirmed = covered && module.coverage === 'insufficient' && module.coverageOverride === true;
          const reading = readingModuleIds.has(module.moduleLocalId);
          const removeBlock = modules.length <= range.min
            ? `Lộ trình cần tối thiểu ${range.min} module`
            : templateKind === 'normal' && REQUIRED_NORMAL_FRAMES.has(module.frameKey)
              ? 'Module bắt buộc của lộ trình'
              : null;
          const open = panel && panel.moduleLocalId === module.moduleLocalId ? panel.kind : null;
          const retrySourceId = covered || reading ? undefined : retryableSupplementSourceId(job, module.moduleLocalId);
          return (
            <li className={'ai-coverage-module' + (covered || reading ? '' : ' warn')} key={module.moduleLocalId}>
              <span className="ai-coverage-order">{index + 1}</span>
              <div className="ai-coverage-title">
                <strong>{title}</strong>
                <small>{sourceLine(module, sourceCatalog, sourceNames)}</small>
              </div>
              {reading
                ? <span className="ai-chip run">AI đang đọc tài liệu bổ sung…</span>
                : <span className={'ai-chip ' + (covered ? 'ok' : 'warn')}>
                    {covered ? confirmed ? 'Đủ tài liệu (Admin xác nhận)' : 'Đủ tài liệu' : 'Cần bổ sung'}
                  </span>}
              <div className="ai-coverage-actions">
                <button className="button button-ghost button-sm" type="button" disabled={locked} aria-expanded={open === 'edit'}
                  onClick={() => togglePanel({ moduleLocalId: module.moduleLocalId, kind: 'edit' })}>Sửa</button>
                <span title={removeBlock ?? undefined}>
                  <button className="button button-ghost button-sm" type="button" disabled={locked || Boolean(removeBlock)}
                    onClick={() => { setPanel(null); onEdit([{ type: 'delete', moduleLocalId: module.moduleLocalId }]); }}>Bỏ module</button>
                </span>
              </div>
              {!covered && !reading && (
                <div className="ai-coverage-gap">
                  <p>{module.gapNote?.trim() || DEFAULT_GAP_NOTE}</p>
                  <div className="ai-coverage-gap-actions">
                    {retrySourceId && (
                      <button className="button button-secondary button-sm" type="button" disabled={locked}
                        onClick={() => onRetrySupplement(module.moduleLocalId, retrySourceId)}>Thử lại</button>
                    )}
                    <label className={'button button-secondary button-sm ai-coverage-upload' + (locked ? ' disabled' : '')}>
                      Tải tài liệu bổ sung
                      <input
                        type="file"
                        accept=".pdf,.docx,.txt,.md,.markdown"
                        aria-label={`Tải tài liệu bổ sung cho ${title}`}
                        disabled={locked}
                        onChange={(event: ChangeEvent<HTMLInputElement>) => {
                          const file = event.target.files?.[0];
                          event.target.value = '';
                          if (file) onUploadFor(module.moduleLocalId, file);
                        }}
                      />
                    </label>
                    <button className="button button-secondary button-sm" type="button" disabled={locked} aria-expanded={open === 'pick'}
                      onClick={() => togglePanel({ moduleLocalId: module.moduleLocalId, kind: 'pick' })}>Chọn đoạn từ tài liệu đã có</button>
                    {moduleHasUsableSources(module, usableSectionIds) && (
                      <button className="button button-ghost button-sm" type="button" disabled={locked}
                        onClick={() => onOverride(module.moduleLocalId)}>Vẫn dùng tài liệu hiện có</button>
                    )}
                  </div>
                </div>
              )}
              {open === 'pick' && (
                <SectionPicker
                  module={module}
                  catalog={sourceCatalog}
                  busy={locked}
                  onClose={() => setPanel(null)}
                  onPick={(sourceIds, sectionIds) => { setPanel(null); onPickSections(module.moduleLocalId, sourceIds, sectionIds); }}
                />
              )}
              {open === 'edit' && (
                <ModuleEditPanel
                  module={module}
                  title={title}
                  modules={modules}
                  advanced={templateKind === 'advanced'}
                  responsibilities={responsibilities}
                  busy={locked}
                  onClose={() => setPanel(null)}
                  onSave={(edits) => { setPanel(null); onEdit(edits); }}
                />
              )}
            </li>
          );
        })}
      </ol>

      {panel?.kind === 'add' ? (
        <AddModulePanel busy={locked} onClose={() => setPanel(null)} onAdd={(title, description) => { setPanel(null); onAddModule(title, description); }} />
      ) : (
        <span className="ai-coverage-add" title={canAdd ? undefined : `Lộ trình đã có tối đa ${range.max} module`}>
          <button className="button button-ghost" type="button" disabled={locked || !canAdd}
            onClick={() => setPanel({ moduleLocalId: null, kind: 'add' })}>+ Thêm module</button>
        </span>
      )}
    </div>
  );
}

function SectionPicker({
  module,
  catalog,
  busy,
  onClose,
  onPick,
}: {
  readonly module: Module;
  readonly catalog: ModuleSourceCatalog;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onPick: (sourceIds: string[], sectionIds: string[]) => void;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const sources = catalog
    .map((source) => ({ ...source, sections: source.sections.filter((section) => section.usable && !module.sourceSectionIds.includes(section.id)) }))
    .filter((source) => source.sections.length > 0);
  return (
    <div className="ai-coverage-panel" role="region" aria-label="Chọn tài liệu bổ sung">
      {sources.length > 0 ? sources.map((source) => (
        <fieldset className="ai-coverage-picker-source" key={source.sourceId}>
          <legend>{fileLabel(source.fileName)}</legend>
          {source.sections.map((section) => (
            <label className="ai-coverage-check" key={section.id}>
              <input
                type="checkbox"
                disabled={busy}
                checked={selected.has(section.id)}
                onChange={(event) => setSelected((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(section.id);
                  else next.delete(section.id);
                  return next;
                })}
              />
              <span>{section.headingPath.join(' › ') || 'Đoạn không có tiêu đề'}</span>
            </label>
          ))}
        </fieldset>
      )) : <p className="ai-coverage-empty">Chưa có đoạn tài liệu nào dùng được. Hãy tải tài liệu bổ sung.</p>}
      <div className="ai-coverage-panel-actions">
        <button className="button button-ghost button-sm" type="button" onClick={onClose}>Đóng</button>
        <button
          className="button button-secondary button-sm"
          type="button"
          disabled={busy || selected.size === 0}
          onClick={() => onPick(
            sources.filter((source) => source.sections.some((section) => selected.has(section.id))).map((source) => source.sourceId),
            [...selected],
          )}
        >Thêm đoạn đã chọn</button>
      </div>
    </div>
  );
}

function ModuleEditPanel({
  module,
  title: displayTitle,
  modules,
  advanced,
  responsibilities,
  busy,
  onClose,
  onSave,
}: {
  readonly module: Module;
  readonly title: string;
  readonly modules: readonly Module[];
  readonly advanced: boolean;
  readonly responsibilities: readonly string[];
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onSave: (edits: readonly OutlineEdit[]) => void;
}) {
  const [title, setTitle] = useState(displayTitle);
  const [description, setDescription] = useState(module.description);
  const [minutes, setMinutes] = useState(String(module.estimatedMinutes));
  const [objectives, setObjectives] = useState(module.objectives.join('\n'));
  const [assigned, setAssigned] = useState<ReadonlySet<number>>(new Set(module.responsibilityIndexes));
  const objectiveList = objectives.split('\n').map((value) => value.trim()).filter(Boolean);
  const minuteValue = Number(minutes);
  const error = !title.trim()
    ? 'Nhập tên module.'
    : title.trim().length > 80
      ? 'Tên module tối đa 80 ký tự.'
      : description.trim().length > 500
        ? 'Mô tả tối đa 500 ký tự.'
        : !Number.isFinite(minuteValue) || minuteValue < 1
          ? 'Thời lượng cần ít nhất 1 phút.'
          : objectiveList.length > MAX_OBJECTIVES
            ? `Tối đa ${MAX_OBJECTIVES} mục tiêu.`
            : null;
  const ownerOf = (index: number) => modules.find((candidate) => candidate.moduleLocalId !== module.moduleLocalId
    && candidate.responsibilityIndexes.includes(index));

  function save() {
    const patch: Extract<OutlineEdit, { type: 'update' }>['patch'] = {
      title: title.trim(),
      description: description.trim(),
      estimatedMinutes: minuteValue,
      objectives: objectiveList,
      ...(advanced ? { responsibilityIndexes: [...assigned].sort((left, right) => left - right) } : {}),
    };
    const edits: OutlineEdit[] = [{ type: 'update', moduleLocalId: module.moduleLocalId, patch }];
    if (advanced) {
      // A responsibility belongs to one module: taking it here releases it from its previous module.
      for (const other of modules) {
        if (other.moduleLocalId === module.moduleLocalId) continue;
        const kept = other.responsibilityIndexes.filter((index) => !assigned.has(index));
        if (kept.length !== other.responsibilityIndexes.length) {
          edits.push({ type: 'update', moduleLocalId: other.moduleLocalId, patch: { responsibilityIndexes: kept } });
        }
      }
    }
    onSave(edits);
  }

  return (
    <section className="ai-coverage-panel" aria-label={`Sửa module ${displayTitle}`}>
      <div className="ai-coverage-fields">
        <label className="ai-field"><span className="ai-label">Tên module</span>
          <input aria-label="Tên module" maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="ai-field"><span className="ai-label">Thời lượng (phút)</span>
          <input aria-label="Thời lượng (phút)" type="number" min={1} value={minutes} onChange={(event) => setMinutes(event.target.value)} />
        </label>
        <label className="ai-field ai-coverage-wide"><span className="ai-label">Mô tả ngắn</span>
          <textarea aria-label="Mô tả ngắn" rows={2} maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <label className="ai-field ai-coverage-wide"><span className="ai-label">Mục tiêu học tập <small>· mỗi dòng một mục tiêu, tối đa {MAX_OBJECTIVES}</small></span>
          <textarea aria-label="Mục tiêu học tập" rows={3} value={objectives} onChange={(event) => setObjectives(event.target.value)} />
        </label>
        {advanced && (
          <fieldset className="ai-coverage-wide ai-coverage-tasks">
            <legend className="ai-label">Nhiệm vụ công việc</legend>
            {responsibilities.length === 0 && <p className="ai-coverage-empty">Chưa có nhiệm vụ công việc.</p>}
            {responsibilities.map((task, index) => {
              const owner = ownerOf(index);
              return (
                <label className="ai-coverage-check" key={index}>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={assigned.has(index)}
                    onChange={(event) => setAssigned((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(index);
                      else next.delete(index);
                      return next;
                    })}
                  />
                  <span>{task}{owner && !assigned.has(index) ? <small> · đang thuộc {outlineModuleDisplayTitle(owner)}</small> : null}</span>
                </label>
              );
            })}
          </fieldset>
        )}
      </div>
      {error && <p className="ai-field-error" role="alert">{error}</p>}
      <div className="ai-coverage-panel-actions">
        <button className="button button-ghost button-sm" type="button" onClick={onClose}>Hủy</button>
        <button className="button button-secondary button-sm" type="button" disabled={busy || Boolean(error)} onClick={save}>Lưu</button>
      </div>
    </section>
  );
}

function AddModulePanel({
  busy,
  onClose,
  onAdd,
}: {
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onAdd: (title: string, description: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  return (
    <section className="ai-coverage-panel ai-coverage-add-panel" aria-label="Thêm module">
      <p className="ai-coverage-hint">AI sẽ tìm đoạn phù hợp trong tài liệu đã có cho module mới.</p>
      <div className="ai-coverage-fields">
        <label className="ai-field ai-coverage-wide"><span className="ai-label">Tên module</span>
          <input aria-label="Tên module mới" maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="ai-field ai-coverage-wide"><span className="ai-label">Mô tả <small>· không bắt buộc</small></span>
          <textarea aria-label="Mô tả module mới" rows={2} maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
      </div>
      <div className="ai-coverage-panel-actions">
        <button className="button button-ghost button-sm" type="button" onClick={onClose}>Hủy</button>
        <button className="button button-secondary button-sm" type="button" disabled={busy || !title.trim()}
          onClick={() => onAdd(title.trim(), description.trim())}>Thêm vào lộ trình</button>
      </div>
    </section>
  );
}
