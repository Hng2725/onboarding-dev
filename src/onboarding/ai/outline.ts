import { createHash } from 'node:crypto';
import type { EmployeeType, OutlineEdit, TemplateOutline, TemplateOutlineModule } from '../contracts';
import { normalizeForMatch, type RawSourceRef } from './grounding';
import type { FeatureInventory } from './inventory';
import { AI_GENERATION_LIMITS } from './limits';
import { ADVANCED_FRAMES, NORMAL_FRAMES, type GeneratedFlag, type GeneratedTaskCoverage, type ValidationError } from './validate';

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
export function validateTemplateOutline(outline: TemplateOutline, input: { templateKind: EmployeeType; responsibilities: readonly string[] }): readonly ValidationError[] {
  const errors: ValidationError[] = [];
  const add = (code: string, path: string, message: string) => errors.push({ code, path, message });
  const modules = outline.modules.filter((m) => !m.tombstoned);
  const frames: readonly string[] = input.templateKind === 'normal' ? NORMAL_FRAMES : ADVANCED_FRAMES;
  const range = input.templateKind === 'normal' ? AI_GENERATION_LIMITS.normalModuleRange : AI_GENERATION_LIMITS.advancedModuleRange;
  if (modules.length < range.min || modules.length > range.max) add('MODULE_COUNT', 'modules', 'Invalid module count.');
  if (new Set(outline.modules.map((m) => m.moduleLocalId)).size !== outline.modules.length) add('DUPLICATE_ID', 'modules', 'Module IDs must be unique.');
  if (new Set(modules.map((m) => m.frameKey)).size !== modules.length) add('DUPLICATE_FRAME', 'modules', 'Frames must be unique.');
  let previous = -1;
  modules.forEach((m, i) => {
    const frameIndex = frames.indexOf(m.frameKey);
    if (frameIndex < 0 || frameIndex <= previous || m.order !== i) add('FRAME_ORDER', `modules[${i}]`, 'Frames must follow authoritative order.');
    previous = frameIndex;
    if (!m.sourceSectionIds.some((id) => id.trim()) && !outline.flags.some((f) => f.type === 'missing' && f.severity === 'blocking' && f.location.moduleLocalId === m.moduleLocalId)) add('MISSING_SOURCE', `modules[${i}]`, 'A blocking missing-source flag is required.');
    if (m.responsibilityIndexes.some((index) => !Number.isInteger(index) || index < 0 || index >= input.responsibilities.length)) add('RESPONSIBILITY_INDEX', `modules[${i}]`, 'Invalid responsibility index.');
  });
  if (input.templateKind === 'normal') ['t1-overview', 't1-core'].forEach((frame) => {
    if (!modules.some((m) => m.frameKey === frame) && !outline.flags.some((f) => f.type === 'missing' && f.severity === 'blocking' && f.location.frameKey === frame)) add('REQUIRED_FRAME', 'modules', `Missing required frame ${frame}.`);
  });
  if (input.templateKind === 'advanced') {
    const normalized = input.responsibilities.map(normalizeForMatch);
    if (normalized.length < 2 || normalized.length > 8 || normalized.some((x) => !x) || new Set(normalized).size !== normalized.length) add('RESPONSIBILITIES', 'responsibilities', 'Provide 2 to 8 unique responsibilities.');
    input.responsibilities.forEach((task, i) => {
      const item = outline.taskCoverage[i];
      const module = modules.find((m) => m.moduleLocalId === item?.moduleLocalId && m.responsibilityIndexes.includes(i));
      const flag = item?.flagIndex == null ? undefined : outline.flags[item.flagIndex];
      if (!item || item.task !== task || (!module && !(flag?.type === 'missing' && flag.severity === 'blocking'))) add('TASK_COVERAGE', `taskCoverage[${i}]`, 'Responsibility requires a module or blocking missing flag.');
    });
    if (outline.taskCoverage.length !== input.responsibilities.length) add('TASK_COVERAGE', 'taskCoverage', 'Coverage must match responsibilities.');
  }
  return errors;
}
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
  const allIds = new Set(outline.modules.map((m) => m.moduleLocalId));
  const flags = outline.flags.filter((f) => !(f.type === 'missing' && (f.message.startsWith('Missing module for responsibility:') || (f.message === 'Missing source sections for module.' && f.location.moduleLocalId && !active.some((m) => m.moduleLocalId === f.location.moduleLocalId)))));
  active.filter((m) => !m.sourceSectionIds.some((id) => id.trim()) && (!allIds.has(m.moduleLocalId) || !flags.some((f) => f.type === 'missing' && f.severity === 'blocking' && f.location.moduleLocalId === m.moduleLocalId))).forEach((m) => flags.push(missingSource(m.moduleLocalId)));
  return { revision: outline.revision + 1, modules: [...active, ...tombstones], flags, taskCoverage: coverage(outline.taskCoverage.map((c) => c.task), active, flags) };
}
