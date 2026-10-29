import { useEffect, useState } from 'react';
import type { EmployeeType, OutlineEdit, TemplateOutline } from '../../../onboarding/contracts';
import { ADVANCED_FRAMES, NORMAL_FRAMES } from '../../../onboarding/ai/validate';
import { validateAdminOutline } from '../../../onboarding/ai/outline-validation';

export type ModuleSourceCatalog = readonly { readonly sourceId: string; readonly fileName: string; readonly sections: readonly { readonly id: string; readonly headingPath: readonly string[] }[] }[];

export function AiOutlineReview({ outline, templateKind, responsibilities, busy, onEdit, onApprove, sourceCatalog = [], onSupplement }: {
  outline: TemplateOutline; templateKind: EmployeeType; responsibilities: readonly string[]; busy: boolean;
  onEdit: (edits: readonly OutlineEdit[]) => void; onApprove: () => void; sourceCatalog?: ModuleSourceCatalog; onSupplement?: (moduleLocalId: string, sourceIds: string[], sectionIds: string[]) => void;
}) {
  const [selectedFrame, setSelectedFrame] = useState('');
  const [dirtyIds, setDirtyIds] = useState<ReadonlySet<string>>(new Set());
  const setDirty = (id: string, dirty: boolean) => setDirtyIds((current) => { const next = new Set(current); if (dirty) next.add(id); else next.delete(id); return next; });
  const modules = outline.modules.filter((m) => !m.tombstoned).sort((a, b) => a.order - b.order);
  const errors = validateAdminOutline(outline, { templateKind, responsibilities });
  const invalid = errors.length > 0;
  const frames: readonly string[] = templateKind === 'normal' ? NORMAL_FRAMES : ADVANCED_FRAMES;
  const available = frames.filter((frame) => !modules.some((module) => module.frameKey === frame));
  const minimum = templateKind === 'normal' ? 4 : 5;
  return <section className="ai-outline-review"><h3>Rà soát khung lộ trình</h3><p>Kiểm tra thứ tự, mục tiêu, nhiệm vụ và nguồn trước khi viết.</p>
    <div className="ai-review-scroll" role="region" aria-label="Các module trong khung" tabIndex={0}>{modules.map((module, index) => <OutlineCard key={module.moduleLocalId} module={module} index={index} total={modules.length} responsibilities={responsibilities} busy={busy} sourceCatalog={sourceCatalog} onSupplement={onSupplement} removable={modules.length > minimum && !['t1-overview', 't1-core'].includes(module.frameKey)} onEdit={onEdit} onDirty={(dirty) => setDirty(module.moduleLocalId, dirty)} />)}</div>
    <p>Xóa module sẽ hủy phê duyệt và có thể bỏ trống nhiệm vụ. Module mới cần nguồn và rà soát.</p>
    <label>Thêm khung<select aria-label="Add frame" value={selectedFrame} disabled={busy || !available.length || modules.length >= 8 || dirtyIds.size > 0} onChange={(event) => setSelectedFrame(event.target.value)}><option value="">Chọn khung</option>{available.map((frame) => <option key={frame} value={frame}>{frame}</option>)}</select></label>
    <button type="button" aria-label="Add frame" disabled={busy || !available.includes(selectedFrame) || modules.length >= 8 || dirtyIds.size > 0} onClick={() => { onEdit([{ type: 'add', module: { frameKey: selectedFrame, order: modules.length, title: selectedFrame, description: '', estimatedMinutes: 10, objectives: [], featureIds: [], sourceSectionIds: [], responsibilityIndexes: [] } }]); setSelectedFrame(''); }}>Thêm module</button>
    {invalid && <p role="alert">Khung chưa hợp lệ: {errors.map((error) => error.message).join(" · ")}</p>}
    <button type="button" className="button button-primary" disabled={busy || invalid || dirtyIds.size > 0} onClick={onApprove}>Duyệt khung và bắt đầu viết</button>
  </section>;
}
function OutlineCard({ module, index, total, responsibilities, busy, removable, sourceCatalog, onSupplement, onEdit, onDirty }: { module: TemplateOutline['modules'][number]; index: number; total: number; responsibilities: readonly string[]; busy: boolean; removable: boolean; sourceCatalog: ModuleSourceCatalog; onSupplement?: (moduleLocalId: string, sourceIds: string[], sectionIds: string[]) => void; onEdit: (edits: readonly OutlineEdit[]) => void; onDirty: (dirty: boolean) => void }) {
  const [selectedSections, setSelectedSections] = useState<ReadonlySet<string>>(new Set());
  const [title, setTitle] = useState(module.title);
  const [objectives, setObjectives] = useState(module.objectives.join('\n'));
  const [description, setDescription] = useState(module.description);
  const [sources, setSources] = useState(module.sourceSectionIds.join('\n'));
  useEffect(() => { setSources(module.sourceSectionIds.join('\n')); }, [module.sourceSectionIds.join('\n')]);
  const [assignments, setAssignments] = useState(module.responsibilityIndexes.join(', '));
  const dirty = title !== module.title || description !== module.description || objectives !== module.objectives.join('\n') || sources !== module.sourceSectionIds.join('\n') || assignments !== module.responsibilityIndexes.join(', ');
  useEffect(() => { onDirty(dirty); }, [dirty, module.moduleLocalId]);
  return <article className="ai-outline-card"><details><summary><strong>{index + 1}. {title}</strong><small>{module.sourceSectionIds.length} phần nguồn · {module.responsibilityIndexes.length} nhiệm vụ{dirty ? ' · Chưa lưu' : ''}</small></summary><header><strong>{module.frameKey}</strong><div><button type="button" aria-label={`Đưa ${title} lên`} disabled={busy || dirty || index === 0} onClick={() => onEdit([{ type: 'reorder', moduleLocalId: module.moduleLocalId, order: index - 1 }])}>↑</button><button type="button" aria-label={`Đưa ${title} xuống`} disabled={busy || dirty || index === total - 1} onClick={() => onEdit([{ type: 'reorder', moduleLocalId: module.moduleLocalId, order: index + 1 }])}>↓</button></div></header>
    <label>Tên<input value={title} onChange={(e) => { setTitle(e.target.value); onDirty(dirty || e.target.value !== title); }} /></label><label>Mô tả<input value={description} onChange={(e) => { setDescription(e.target.value); onDirty(dirty || e.target.value !== description); }} /></label><label>Mục tiêu<textarea value={objectives} onChange={(e) => { setObjectives(e.target.value); onDirty(dirty || e.target.value !== objectives); }} /></label>
    <p>Nhiệm vụ hiện tại: {module.responsibilityIndexes.map((i) => responsibilities[i]).join(', ') || '—'}</p><label>Chỉ số nhiệm vụ (bắt đầu từ 0)<input value={assignments} onChange={(e) => { setAssignments(e.target.value); onDirty(dirty || e.target.value !== assignments); }} /></label><label>Mã phần nguồn (mỗi dòng một mã)<textarea value={sources} onChange={(e) => { setSources(e.target.value); onDirty(dirty || e.target.value !== sources); }} /></label>
    {onSupplement && <fieldset><legend>Nguồn và phần tài liệu</legend>{sourceCatalog.map((source) => <div key={source.sourceId}><strong>{source.fileName}</strong>{source.sections.map((section) => <label key={section.id}><input type="checkbox" disabled={busy} checked={selectedSections.has(section.id)} onChange={(event) => setSelectedSections((current) => { const next = new Set(current); if (event.target.checked) next.add(section.id); else next.delete(section.id); return next; })} />{section.headingPath.join(' / ') || section.id}</label>)}</div>)}<button type="button" aria-label="Add selected sources" disabled={busy || dirty || selectedSections.size === 0} onClick={() => { const ids = [...selectedSections]; const sourceIds = sourceCatalog.filter((source) => source.sections.some((section) => selectedSections.has(section.id))).map((source) => source.sourceId); onSupplement(module.moduleLocalId, sourceIds, ids); setSelectedSections(new Set()); }}>Thêm nguồn đã chọn</button></fieldset>}
    <button type="button" aria-label={`Remove ${title}`} disabled={busy || dirty || !removable} onClick={() => onEdit([{ type: 'delete', moduleLocalId: module.moduleLocalId }])}>Xóa module</button>
    <button type="button" disabled={busy} onClick={() => { const nextObjectives = objectives.split('\n').map((x) => x.trim()).filter(Boolean); const nextSources = sources.split('\n').map((x) => x.trim()).filter(Boolean); const nextAssignments = assignments.trim() ? assignments.split(',').map((x) => Number(x.trim())) : []; setObjectives(nextObjectives.join('\n')); setSources(nextSources.join('\n')); setAssignments(nextAssignments.join(', ')); onEdit([{ type: 'update', moduleLocalId: module.moduleLocalId, patch: { title, description, objectives: nextObjectives, sourceSectionIds: nextSources, responsibilityIndexes: nextAssignments } }]); }}>Lưu thay đổi</button>
  </details></article>;
}
