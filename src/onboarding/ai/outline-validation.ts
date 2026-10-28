import type { EmployeeType, TemplateOutline, TemplateOutlineModule } from '../contracts';
import { normalizeForMatch } from './grounding';
import { AI_GENERATION_LIMITS } from './limits';
import { ADVANCED_FRAMES, NORMAL_FRAMES, type ValidationError } from './validate';

export function validateOutlineMetadata(modules: readonly TemplateOutlineModule[]): readonly ValidationError[] {
  const strings = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
  if (modules.some((module) => !module || typeof module.title !== 'string' || !module.title.trim() || module.title.length > 80 || typeof module.description !== 'string' || module.description.length > 500 || !Number.isFinite(module.estimatedMinutes) || module.estimatedMinutes <= 0 || !strings(module.objectives) || module.objectives.length > 4 || module.objectives.some((item) => !item.trim()) || !strings(module.featureIds) || module.featureIds.some((id) => !id.trim()) || !strings(module.sourceSectionIds) || !Array.isArray(module.responsibilityIndexes))) return [{ code: 'METADATA', path: 'modules', message: 'Outline metadata is invalid.' }];
  return [];
}

export function validateTemplateOutline(outline: TemplateOutline, input: { templateKind: EmployeeType; responsibilities: readonly string[] }): readonly ValidationError[] {
  const metadataErrors = validateOutlineMetadata(outline.modules);
  if (metadataErrors.length) return metadataErrors;
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

/** Rules for an explicitly edited Admin outline; frame order is user controlled. */
export function validateAdminOutline(outline: TemplateOutline, input: { templateKind: EmployeeType; responsibilities: readonly string[] }): readonly ValidationError[] {
  const errors = validateTemplateOutline(outline, input).filter((error) => error.code !== 'FRAME_ORDER');
  if (errors.some((error) => error.code === 'METADATA')) return errors;
  const frames: readonly string[] = input.templateKind === 'normal' ? NORMAL_FRAMES : ADVANCED_FRAMES;
  if (outline.modules.filter((module) => !module.tombstoned).some((module, order) => !frames.includes(module.frameKey) || module.order !== order)) errors.push({ code: 'FRAME_ORDER', path: 'modules', message: 'Outline frames and order must be valid.' });
  return errors;
}
