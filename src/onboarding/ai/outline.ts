import { createHash } from 'node:crypto';
import type { EmployeeType, OutlineEdit, TemplateOutline, TemplateOutlineModule } from '../contracts';
import { normalizeForMatch, type RawSourceRef } from './grounding';
import type { FeatureInventory } from './inventory';
import { validateOutlineMetadata } from './outline-validation';
import { ADVANCED_FRAMES, NORMAL_FRAMES, type GeneratedFlag, type GeneratedTaskCoverage } from './validate';

const usableSections = (refs: readonly RawSourceRef[]): string[] =>
  [...new Set(refs.filter((ref) => ref.sectionId.trim() && ref.quote.trim()).map((ref) => ref.sectionId))].sort();
const words = (s: string): string[] => normalizeForMatch(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
const score = (a: string, b: string): number => {
  const target = new Set(words(b));
  return words(a).filter((word) => target.has(word)).length;
};
const missingSource = (id: string): GeneratedFlag => ({
  type: 'missing', severity: 'blocking', message: 'Missing source sections for module.',
  questionForAdmin: 'Provide source material for this module.', location: { moduleLocalId: id }, evidence: [],
});
function coverage(tasks: readonly string[], modules: readonly TemplateOutlineModule[], flags: GeneratedFlag[]): GeneratedTaskCoverage[] {
  return tasks.map((task, index) => {
    const module = modules.find((item) => !item.tombstoned && item.responsibilityIndexes.includes(index));
    if (module) return { task, featureIds: module.featureIds, relevance: 'inferred', relevanceRationale: 'Assigned to outline module.', moduleLocalId: module.moduleLocalId, flagIndex: null };
    const flagIndex = flags.length;
    flags.push({ type: 'missing', severity: 'blocking', message: `Missing module for responsibility: ${task}`, questionForAdmin: 'Assign this responsibility to a module.', location: {}, evidence: [] });
    return { task, featureIds: [], relevance: 'inferred', relevanceRationale: 'No module assigned.', moduleLocalId: null, flagIndex };
  });
}
export function buildTemplateOutline(input: { jobId: string; templateKind: EmployeeType; inventory: FeatureInventory; responsibilities: readonly string[] }): TemplateOutline {
  const { jobId, templateKind, inventory, responsibilities } = input;
  const count = Math.min(6, Math.max(2, responsibilities.length));
  const frames: readonly string[] = templateKind === 'normal' ? NORMAL_FRAMES.slice(0, 4) : [...ADVANCED_FRAMES.slice(0, 2 + count), ...(count < 3 ? ['t2-collab'] : [])];
  const assignments = frames.map(() => [] as typeof inventory.features[number][]);
  const indexes = frames.map(() => [] as number[]);
  if (templateKind === 'advanced') responsibilities.forEach((_, i) => indexes[2 + Math.min(i, count - 1)].push(i));
  const sortedFeatures = [...inventory.features].sort((a, b) => a.featureId.localeCompare(b.featureId));
  for (const feature of sortedFeatures) {
    const text = `${feature.name} ${feature.module} ${feature.purpose}`;
    let best = templateKind === 'normal' ? 3 : 2;
    let bestScore = 0;
    frames.forEach((frame, index) => {
      const textForFrame = `${frame.replace(/t[12]-/u, '').replace(/-/gu, ' ')} ${indexes[index].map((i) => responsibilities[i]).join(' ')}`;
      const current = score(text, textForFrame);
      if (current > bestScore) { best = index; bestScore = current; }
    });
    if (bestScore > 0) assignments[best].push(feature);
  }
  const modules: TemplateOutlineModule[] = frames.map((frameKey, order) => {
    const features = assignments[order];
    const refs = features.flatMap((f) => [...f.sourceRefs, ...f.steps.flatMap((s) => s.sourceRefs)]);
    if (order === 0) refs.push(...inventory.systemSummary.sourceRefs);
    return { moduleLocalId: `outline-${createHash('sha256').update(JSON.stringify([jobId, frameKey])).digest('hex')}`, frameKey, order,
      title: frameKey, description: '', estimatedMinutes: 10, objectives: [], featureIds: features.map((f) => f.featureId),
      sourceSectionIds: usableSections(refs), responsibilityIndexes: indexes[order] };
  });
  const flags: GeneratedFlag[] = inventory.flags.map((flag) => ({ type: flag.type, severity: flag.severity, message: flag.message, questionForAdmin: flag.questionForAdmin, location: flag.featureId ? { featureId: flag.featureId } : {}, evidence: flag.evidence }));
  modules.filter((m) => !m.sourceSectionIds.length).forEach((m) => flags.push(missingSource(m.moduleLocalId)));
  return { revision: 1, modules, flags, taskCoverage: templateKind === 'advanced' ? coverage(responsibilities, modules, flags) : [] };
}
export { validateTemplateOutline } from './outline-validation';
export function applyTemplateOutlineEdits(outline: TemplateOutline, edits: readonly OutlineEdit[], newId: (frameKey: string) => string): TemplateOutline {
  let active = outline.modules.filter((m) => !m.tombstoned).sort((a, b) => a.order - b.order);
  const tombstones = outline.modules.filter((m) => m.tombstoned);
  for (const edit of edits) {
    if (edit.type === 'add') {
      if (active.some((m) => m.frameKey === edit.module.frameKey)) throw new Error('Frame already exists.');
      const id = newId(edit.module.frameKey);
      if (!id || [...active, ...tombstones].some((m) => m.moduleLocalId === id)) throw new Error('Module ID must be new.');
      const { order, frameKey, title, description, estimatedMinutes, objectives, featureIds, sourceSectionIds, responsibilityIndexes } = edit.module;
      active.splice(Math.max(0, Math.min(active.length, order)), 0, { moduleLocalId: id, frameKey, order, title, description, estimatedMinutes, objectives, featureIds, sourceSectionIds, responsibilityIndexes });
    } else {
      const index = active.findIndex((m) => m.moduleLocalId === edit.moduleLocalId);
      if (index < 0) throw new Error('Module not found.');
      const [module] = active.splice(index, 1);
      if (edit.type === 'delete') tombstones.push({ ...module, tombstoned: true });
      else if (edit.type === 'update') {
        const allowed = ['title', 'description', 'estimatedMinutes', 'objectives', 'featureIds', 'sourceSectionIds', 'responsibilityIndexes'];
        if (Object.keys(edit.patch).some((key) => !allowed.includes(key))) throw new Error('Outline identity cannot change.');
        active.splice(index, 0, { ...module, ...edit.patch });
      }
      else active.splice(Math.max(0, Math.min(active.length, edit.order)), 0, module);
    }
  }
  active = active.map((m, order) => ({ ...m, order }));
  const metadataErrors = validateOutlineMetadata(active);
  if (metadataErrors.length) throw new Error(metadataErrors[0].message);
  const allIds = new Set(outline.modules.map((m) => m.moduleLocalId));
  const flags = outline.flags.filter((f) => !(f.type === 'missing' && (f.message.startsWith('Missing module for responsibility:') || (f.message === 'Missing source sections for module.' && f.location.moduleLocalId && !active.some((m) => m.moduleLocalId === f.location.moduleLocalId)))));
  active.filter((m) => !m.sourceSectionIds.some((id) => id.trim()) && (!allIds.has(m.moduleLocalId) || !flags.some((f) => f.type === 'missing' && f.severity === 'blocking' && f.location.moduleLocalId === m.moduleLocalId))).forEach((m) => flags.push(missingSource(m.moduleLocalId)));
  return { revision: outline.revision + 1, modules: [...active, ...tombstones], flags, taskCoverage: coverage(outline.taskCoverage.map((c) => c.task), active, flags) };
}
