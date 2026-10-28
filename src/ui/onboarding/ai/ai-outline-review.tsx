import { useState } from 'react';
import type { EmployeeType, OutlineEdit, TemplateOutline } from '../../../onboarding/contracts';
import { validateTemplateOutline } from '../../../onboarding/ai/outline-validation';

export function AiOutlineReview({ outline, templateKind, responsibilities, busy, onEdit, onApprove }: {
  outline: TemplateOutline; templateKind: EmployeeType; responsibilities: readonly string[]; busy: boolean;
  onEdit: (edits: readonly OutlineEdit[]) => void; onApprove: () => void;
}) {
  const modules = outline.modules.filter((m) => !m.tombstoned).sort((a, b) => a.order - b.order);
  const errors = validateTemplateOutline(outline, { templateKind, responsibilities });
  const invalid = errors.length > 0;
  return <section className="ai-outline-review"><h3>Rà soát khung lộ trình</h3><p>Kiểm tra thứ tự, mục tiêu, nhiệm vụ và nguồn trước khi viết.</p>
    {modules.map((module, index) => <OutlineCard key={module.moduleLocalId} module={module} index={index} total={modules.length} responsibilities={responsibilities} busy={busy} onEdit={onEdit} />)}
    {invalid && <p role="alert">Khung chưa hợp lệ: {errors.map((error) => error.message).join(" · ")}</p>}
    <button type="button" className="button button-primary" disabled={busy || invalid} onClick={onApprove}>Duyệt khung và bắt đầu viết</button>
  </section>;
}
function OutlineCard({ module, index, total, responsibilities, busy, onEdit }: { module: TemplateOutline['modules'][number]; index: number; total: number; responsibilities: readonly string[]; busy: boolean; onEdit: (edits: readonly OutlineEdit[]) => void }) {
  const [title, setTitle] = useState(module.title);
  const [objectives, setObjectives] = useState(module.objectives.join('\n'));
  const [description, setDescription] = useState(module.description);
  const [sources, setSources] = useState(module.sourceSectionIds.join('\n'));
  const [assignments, setAssignments] = useState(module.responsibilityIndexes.join(', '));
  return <article className="ai-outline-card"><header><strong>{index + 1}. {module.frameKey}</strong><div><button type="button" disabled={busy || index === 0} onClick={() => onEdit([{ type: 'reorder', moduleLocalId: module.moduleLocalId, order: index - 1 }])}>↑</button><button type="button" disabled={busy || index === total - 1} onClick={() => onEdit([{ type: 'reorder', moduleLocalId: module.moduleLocalId, order: index + 1 }])}>↓</button></div></header>
    <label>Tên<input value={title} onChange={(e) => setTitle(e.target.value)} /></label><label>Mô tả<input value={description} onChange={(e) => setDescription(e.target.value)} /></label><label>Mục tiêu<textarea value={objectives} onChange={(e) => setObjectives(e.target.value)} /></label>
    <p>Nhiệm vụ hiện tại: {module.responsibilityIndexes.map((i) => responsibilities[i]).join(', ') || '—'}</p><label>Chỉ số nhiệm vụ (bắt đầu từ 0)<input value={assignments} onChange={(e) => setAssignments(e.target.value)} /></label><label>Mã phần nguồn (mỗi dòng một mã)<textarea value={sources} onChange={(e) => setSources(e.target.value)} /></label>
    <button type="button" disabled={busy} onClick={() => onEdit([{ type: 'update', moduleLocalId: module.moduleLocalId, patch: { title, description, objectives: objectives.split('\n').map((x) => x.trim()).filter(Boolean), sourceSectionIds: sources.split('\n').map((x) => x.trim()).filter(Boolean), responsibilityIndexes: assignments.trim() ? assignments.split(',').map((x) => Number(x.trim())) : [] } }])}>Lưu thay đổi</button>
  </article>;
}
