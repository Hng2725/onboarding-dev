import { useEffect, useState } from 'react';
import type { EmployeeType, OutlineEdit, TemplateOutline } from '../../../onboarding/contracts';
import { validateAdminOutline } from '../../../onboarding/ai/outline-validation';

export function AiOutlineReview({ outline, templateKind, responsibilities, busy, onEdit, onApprove }: {
  outline: TemplateOutline; templateKind: EmployeeType; responsibilities: readonly string[]; busy: boolean;
  onEdit: (edits: readonly OutlineEdit[]) => void; onApprove: () => void;
}) {
  const [dirtyIds, setDirtyIds] = useState<ReadonlySet<string>>(new Set());
  const setDirty = (id: string, dirty: boolean) => setDirtyIds((current) => { const next = new Set(current); if (dirty) next.add(id); else next.delete(id); return next; });
  const modules = outline.modules.filter((m) => !m.tombstoned).sort((a, b) => a.order - b.order);
  const errors = validateAdminOutline(outline, { templateKind, responsibilities });
  const invalid = errors.length > 0;
  return <section className="ai-outline-review"><h3>Rà soát khung lộ trình</h3><p>Kiểm tra thứ tự, mục tiêu, nhiệm vụ và nguồn trước khi viết.</p>
    {modules.map((module, index) => <OutlineCard key={module.moduleLocalId} module={module} index={index} total={modules.length} responsibilities={responsibilities} busy={busy} onEdit={onEdit} onDirty={(dirty) => setDirty(module.moduleLocalId, dirty)} />)}
    {invalid && <p role="alert">Khung chưa hợp lệ: {errors.map((error) => error.message).join(" · ")}</p>}
    <button type="button" className="button button-primary" disabled={busy || invalid || dirtyIds.size > 0} onClick={onApprove}>Duyệt khung và bắt đầu viết</button>
  </section>;
}
function OutlineCard({ module, index, total, responsibilities, busy, onEdit, onDirty }: { module: TemplateOutline['modules'][number]; index: number; total: number; responsibilities: readonly string[]; busy: boolean; onEdit: (edits: readonly OutlineEdit[]) => void; onDirty: (dirty: boolean) => void }) {
  const [title, setTitle] = useState(module.title);
  const [objectives, setObjectives] = useState(module.objectives.join('\n'));
  const [description, setDescription] = useState(module.description);
  const [sources, setSources] = useState(module.sourceSectionIds.join('\n'));
  const [assignments, setAssignments] = useState(module.responsibilityIndexes.join(', '));
  const dirty = title !== module.title || description !== module.description || objectives !== module.objectives.join('\n') || sources !== module.sourceSectionIds.join('\n') || assignments !== module.responsibilityIndexes.join(', ');
  useEffect(() => { onDirty(dirty); }, [dirty, module.moduleLocalId]);
  return <article className="ai-outline-card"><header><strong>{index + 1}. {module.frameKey}</strong><div><button type="button" disabled={busy || index === 0} onClick={() => onEdit([{ type: 'reorder', moduleLocalId: module.moduleLocalId, order: index - 1 }])}>↑</button><button type="button" disabled={busy || index === total - 1} onClick={() => onEdit([{ type: 'reorder', moduleLocalId: module.moduleLocalId, order: index + 1 }])}>↓</button></div></header>
    <label>Tên<input value={title} onChange={(e) => { setTitle(e.target.value); onDirty(dirty || e.target.value !== title); }} /></label><label>Mô tả<input value={description} onChange={(e) => { setDescription(e.target.value); onDirty(dirty || e.target.value !== description); }} /></label><label>Mục tiêu<textarea value={objectives} onChange={(e) => { setObjectives(e.target.value); onDirty(dirty || e.target.value !== objectives); }} /></label>
    <p>Nhiệm vụ hiện tại: {module.responsibilityIndexes.map((i) => responsibilities[i]).join(', ') || '—'}</p><label>Chỉ số nhiệm vụ (bắt đầu từ 0)<input value={assignments} onChange={(e) => { setAssignments(e.target.value); onDirty(dirty || e.target.value !== assignments); }} /></label><label>Mã phần nguồn (mỗi dòng một mã)<textarea value={sources} onChange={(e) => { setSources(e.target.value); onDirty(dirty || e.target.value !== sources); }} /></label>
    <button type="button" disabled={busy} onClick={() => { const nextObjectives = objectives.split('\n').map((x) => x.trim()).filter(Boolean); const nextSources = sources.split('\n').map((x) => x.trim()).filter(Boolean); const nextAssignments = assignments.trim() ? assignments.split(',').map((x) => Number(x.trim())) : []; setObjectives(nextObjectives.join('\n')); setSources(nextSources.join('\n')); setAssignments(nextAssignments.join(', ')); onEdit([{ type: 'update', moduleLocalId: module.moduleLocalId, patch: { title, description, objectives: nextObjectives, sourceSectionIds: nextSources, responsibilityIndexes: nextAssignments } }]); }}>Lưu thay đổi</button>
  </article>;
}
