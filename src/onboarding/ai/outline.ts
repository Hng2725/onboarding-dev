import { createHash } from 'node:crypto';
import type { EmployeeType, OutlineEdit, TemplateOutline, TemplateOutlineModule } from '../contracts';
import { outlineFrameLabel } from './frame-labels';
import { normalizeForMatch, type RawSourceRef } from './grounding';
import type { FeatureInventory, InventoryFeature } from './inventory';
import { AI_GENERATION_LIMITS } from './limits';
import { validateOutlineMetadata } from './outline-validation';
import { ADVANCED_FRAMES, NORMAL_FRAMES, type GeneratedFlag, type GeneratedTaskCoverage } from './validate';

export const GAP_NOTE = 'Chưa tìm thấy nội dung tài liệu cho module này.';
const MISSING_SOURCE_MESSAGE = 'Module chưa có đoạn tài liệu nguồn.';
const LEGACY_MISSING_SOURCE_MESSAGE = 'Missing source sections for module.';
const TASK_FLAG_PREFIX = 'Nhiệm vụ "';
const TASK_FLAG_SUFFIX = '" chưa được gắn với module nào.';
const LEGACY_TASK_FLAG_PREFIX = 'Missing module for responsibility:';

const usableSections = (refs: readonly RawSourceRef[]): string[] =>
  [...new Set(refs.filter((ref) => ref.sectionId.trim() && ref.quote.trim()).map((ref) => ref.sectionId))].sort();
const words = (s: string): string[] => normalizeForMatch(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
const score = (a: string, b: string): number => {
  const target = new Set(words(b));
  return words(a).filter((word) => target.has(word)).length;
};
const titleOf = (text: string): string => text.trim().slice(0, 80).trim();
const featureRefs = (features: readonly InventoryFeature[]): RawSourceRef[] => features.flatMap((f) => [...f.sourceRefs, ...f.steps.flatMap((s) => s.sourceRefs)]);
const moduleId = (jobId: string, frameKey: string, salt = 0): string =>
  `outline-${createHash('sha256').update(JSON.stringify(salt ? [jobId, frameKey, salt] : [jobId, frameKey])).digest('hex')}`;
const union = <T>(lists: readonly (readonly T[])[]): T[] => [...new Set(lists.flat())];
export const missingSource = (id: string): GeneratedFlag => ({
  type: 'missing', severity: 'blocking', message: MISSING_SOURCE_MESSAGE,
  questionForAdmin: 'Bổ sung tài liệu cho module này hoặc bỏ module.', location: { moduleLocalId: id }, evidence: [],
});
export const isMissingSourceFlag = (f: GeneratedFlag): boolean => f.message === MISSING_SOURCE_MESSAGE || f.message === LEGACY_MISSING_SOURCE_MESSAGE;
export const isTaskCoverageFlag = (f: GeneratedFlag): boolean =>
  f.message.startsWith(LEGACY_TASK_FLAG_PREFIX) || (f.message.startsWith(TASK_FLAG_PREFIX) && f.message.endsWith(TASK_FLAG_SUFFIX));
/** Maps each responsibility to the first live module that claims it, pushing a blocking flag for any unassigned one. */
export function coverage(tasks: readonly string[], modules: readonly TemplateOutlineModule[], flags: GeneratedFlag[]): GeneratedTaskCoverage[] {
  return tasks.map((task, index) => {
    const module = modules.find((item) => !item.tombstoned && item.responsibilityIndexes.includes(index));
    if (module) return { task, featureIds: module.featureIds, relevance: 'inferred', relevanceRationale: 'Assigned to outline module.', moduleLocalId: module.moduleLocalId, flagIndex: null };
    const flagIndex = flags.length;
    flags.push({ type: 'missing', severity: 'blocking', message: TASK_FLAG_PREFIX + task + TASK_FLAG_SUFFIX, questionForAdmin: 'Gắn nhiệm vụ này vào một module.', location: {}, evidence: [] });
    return { task, featureIds: [], relevance: 'inferred', relevanceRationale: 'No module assigned.', moduleLocalId: null, flagIndex };
  });
}
const withCoverage = (module: Omit<TemplateOutlineModule, 'coverage' | 'gapNote'>): TemplateOutlineModule =>
  module.sourceSectionIds.length ? { ...module, coverage: 'sufficient' } : { ...module, coverage: 'insufficient', gapNote: GAP_NOTE };

function mergeModules(modules: readonly TemplateOutlineModule[]): TemplateOutlineModule {
  const head = modules[0];
  const coverages = modules.map((m) => m.coverage).filter((c) => c !== undefined);
  const insufficient = coverages.length > 0 && coverages.every((c) => c === 'insufficient');
  const { gapNote, coverage: _coverage, ...rest } = head;
  return {
    ...rest,
    estimatedMinutes: modules.reduce((sum, m) => sum + m.estimatedMinutes, 0),
    objectives: union(modules.map((m) => m.objectives)).slice(0, 4),
    featureIds: union(modules.map((m) => m.featureIds)),
    sourceSectionIds: union(modules.map((m) => m.sourceSectionIds)).sort(),
    responsibilityIndexes: union(modules.map((m) => m.responsibilityIndexes)).sort((a, b) => a - b),
    ...(coverages.length ? { coverage: insufficient ? 'insufficient' : 'sufficient' } : {}),
    ...(insufficient && gapNote !== undefined ? { gapNote } : {}),
  };
}

/**
 * Brings an outline's module list into the template kind's module range: pads with empty
 * `insufficient` modules (Vietnamese frame-label titles) up to the minimum, merges the tail into
 * the last module above the maximum, then reassigns `order` and positional `frameKey`. Only live
 * modules are normalized; tombstones are appended unchanged and their IDs are never reused.
 */
export function normalizeOutlineModuleCount(modules: readonly TemplateOutlineModule[], input: { jobId: string; templateKind: EmployeeType }): TemplateOutlineModule[] {
  const frames: readonly string[] = input.templateKind === 'normal' ? NORMAL_FRAMES : ADVANCED_FRAMES;
  const range = input.templateKind === 'normal' ? AI_GENERATION_LIMITS.normalModuleRange : AI_GENERATION_LIMITS.advancedModuleRange;
  const live = modules.filter((module) => !module.tombstoned);
  const tombstones = modules.filter((module) => module.tombstoned);
  const sorted = live.map((module, index) => ({ module, index })).sort((a, b) => a.module.order - b.module.order || a.index - b.index).map((item) => item.module);
  const list = sorted.length > range.max ? [...sorted.slice(0, range.max - 1), mergeModules(sorted.slice(range.max - 1))] : [...sorted];
  const usedTitles = new Set(list.map((m) => normalizeForMatch(m.title.trim())));
  const usedIds = new Set(modules.map((m) => m.moduleLocalId));
  for (let position = list.length; position < range.min; position += 1) {
    const frameKey = frames[position];
    const candidates = [...frames.slice(position), ...frames.slice(0, position)].map(outlineFrameLabel);
    const title = candidates.find((label) => !usedTitles.has(normalizeForMatch(label))) ?? outlineFrameLabel(frameKey);
    usedTitles.add(normalizeForMatch(title));
    let salt = 0;
    while (usedIds.has(moduleId(input.jobId, frameKey, salt))) salt += 1;
    const id = moduleId(input.jobId, frameKey, salt);
    usedIds.add(id);
    list.push({ moduleLocalId: id, frameKey, order: position, title, description: '', estimatedMinutes: 10, objectives: [], featureIds: [], sourceSectionIds: [], responsibilityIndexes: [], coverage: 'insufficient', gapNote: GAP_NOTE });
  }
  return [...list.map((module, order) => ({ ...module, order, frameKey: frames[order] })), ...tombstones];
}

/** Groups features by the inventory's own summary modules, in summary order. */
function summaryGroups(inventory: FeatureInventory, features: readonly InventoryFeature[]): { title: string; features: InventoryFeature[] }[] {
  const groups: { key: string; text: string; title: string; features: InventoryFeature[] }[] = [];
  const addGroup = (text: string) => {
    const key = normalizeForMatch(text.trim());
    if (key && !groups.some((group) => group.key === key)) groups.push({ key, text: text.trim(), title: titleOf(text), features: [] });
  };
  inventory.systemSummary.modules.forEach(addGroup);
  // An inventory without summary modules falls back to the features' own module names.
  if (!groups.length) features.forEach((feature) => addGroup(feature.module));
  if (!groups.length) addGroup(outlineFrameLabel(NORMAL_FRAMES[0]));
  for (const feature of features) {
    const key = normalizeForMatch(feature.module.trim());
    let target = groups.find((group) => group.key === key);
    if (!target) {
      const text = `${feature.name} ${feature.module} ${feature.purpose}`;
      let bestScore = 0;
      target = groups[0];
      for (const group of groups) {
        const current = score(text, group.text);
        if (current > bestScore) { target = group; bestScore = current; }
      }
    }
    target.features.push(feature);
  }
  return groups;
}

function buildNormalModules(jobId: string, inventory: FeatureInventory, features: readonly InventoryFeature[]): TemplateOutlineModule[] {
  const groups = summaryGroups(inventory, features);
  const modules = groups.map((group, order) => {
    const refs = featureRefs(group.features);
    if (order === 0) refs.push(...inventory.systemSummary.sourceRefs);
    // Groups past the frame list are merged away by normalizeOutlineModuleCount; their key only needs to be unique.
    const frameKey = NORMAL_FRAMES[order] ?? `t1-extra-${order}`;
    return withCoverage({ moduleLocalId: moduleId(jobId, frameKey), frameKey, order, title: group.title, description: '', estimatedMinutes: 10,
      objectives: [], featureIds: group.features.map((f) => f.featureId), sourceSectionIds: usableSections(refs), responsibilityIndexes: [] });
  });
  return normalizeOutlineModuleCount(modules, { jobId, templateKind: 'normal' });
}

/**
 * Advanced outlines keep the responsibility-driven frame layout (role, permissions, one task slot
 * per responsibility, collab when short), because task slots cannot be derived from summary modules.
 */
function buildAdvancedModules(jobId: string, inventory: FeatureInventory, features: readonly InventoryFeature[], responsibilities: readonly string[]): TemplateOutlineModule[] {
  const count = Math.min(6, Math.max(2, responsibilities.length));
  const frames: readonly string[] = [...ADVANCED_FRAMES.slice(0, 2 + count), ...(count < 3 ? ['t2-collab'] : [])];
  const assignments = frames.map(() => [] as InventoryFeature[]);
  const indexes = frames.map(() => [] as number[]);
  responsibilities.forEach((_, i) => indexes[2 + Math.min(i, count - 1)].push(i));
  for (const feature of features) {
    const text = `${feature.name} ${feature.module} ${feature.purpose}`;
    let best = 2;
    let bestScore = 0;
    frames.forEach((frame, index) => {
      const textForFrame = `${frame.replace(/t[12]-/u, '').replace(/-/gu, ' ')} ${indexes[index].map((i) => responsibilities[i]).join(' ')}`;
      const current = score(text, textForFrame);
      if (current > bestScore) { best = index; bestScore = current; }
    });
    if (bestScore > 0) assignments[best].push(feature);
  }
  return frames.map((frameKey, order) => {
    const refs = featureRefs(assignments[order]);
    if (order === 0) refs.push(...inventory.systemSummary.sourceRefs);
    const single = indexes[order].length === 1 ? titleOf(responsibilities[indexes[order][0]]) : '';
    return withCoverage({ moduleLocalId: moduleId(jobId, frameKey), frameKey, order, title: single || outlineFrameLabel(frameKey), description: '', estimatedMinutes: 10,
      objectives: [], featureIds: assignments[order].map((f) => f.featureId), sourceSectionIds: usableSections(refs), responsibilityIndexes: indexes[order] });
  });
}

export function buildTemplateOutline(input: { jobId: string; templateKind: EmployeeType; inventory: FeatureInventory; responsibilities: readonly string[] }): TemplateOutline {
  const { jobId, templateKind, inventory, responsibilities } = input;
  const sortedFeatures = [...inventory.features].sort((a, b) => a.featureId.localeCompare(b.featureId));
  const modules = templateKind === 'normal' ? buildNormalModules(jobId, inventory, sortedFeatures) : buildAdvancedModules(jobId, inventory, sortedFeatures, responsibilities);
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
      const { order, frameKey, title, description, estimatedMinutes, objectives, featureIds, sourceSectionIds, responsibilityIndexes, coverage: moduleCoverage, gapNote, coverageOverride } = edit.module;
      active.splice(Math.max(0, Math.min(active.length, order)), 0, { moduleLocalId: id, frameKey, order, title, description, estimatedMinutes, objectives, featureIds, sourceSectionIds, responsibilityIndexes,
        ...(moduleCoverage !== undefined ? { coverage: moduleCoverage } : {}), ...(gapNote !== undefined ? { gapNote } : {}), ...(coverageOverride !== undefined ? { coverageOverride } : {}) });
    } else {
      const index = active.findIndex((m) => m.moduleLocalId === edit.moduleLocalId);
      if (index < 0) throw new Error('Module not found.');
      const [module] = active.splice(index, 1);
      if (edit.type === 'delete') tombstones.push({ ...module, tombstoned: true });
      else if (edit.type === 'update') {
        const allowed = ['title', 'description', 'estimatedMinutes', 'objectives', 'featureIds', 'sourceSectionIds', 'responsibilityIndexes', 'coverageOverride', 'gapNote', 'coverage'];
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
  // A missing-source flag stays only while its module is live and still has no source section.
  const lacksSources = (id: string): boolean => active.some((m) => m.moduleLocalId === id && !m.sourceSectionIds.some((s) => s.trim()));
  const flags = outline.flags.filter((f) => !(f.type === 'missing' && (isTaskCoverageFlag(f) || (isMissingSourceFlag(f) && f.location.moduleLocalId && !lacksSources(f.location.moduleLocalId)))));
  active.filter((m) => !m.sourceSectionIds.some((id) => id.trim()) && (!allIds.has(m.moduleLocalId) || !flags.some((f) => f.type === 'missing' && f.severity === 'blocking' && f.location.moduleLocalId === m.moduleLocalId))).forEach((m) => flags.push(missingSource(m.moduleLocalId)));
  return { revision: outline.revision + 1, modules: [...active, ...tombstones], flags, taskCoverage: coverage(outline.taskCoverage.map((c) => c.task), active, flags) };
}
