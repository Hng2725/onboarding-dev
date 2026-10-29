// Browser-safe: imported by the outline UI, so no node-only modules here.
import type { EmployeeType, SourceRecord, TemplateOutline, TemplateOutlineModule } from '../contracts';
import { normalizeForMatch } from './grounding';
import { AI_GENERATION_LIMITS } from './limits';

/**
 * Section IDs that can ground a module: from a ready, non-deleted source, with trimmed text of at
 * least `minQuoteChars` containing a letter or digit. An ID found in more than one live section is
 * ambiguous and never usable.
 */
export function usableSectionIds(sources: readonly SourceRecord[]): ReadonlySet<string> {
  const seen = new Map<string, number>();
  const qualified = new Set<string>();
  for (const source of sources) {
    if (source.status !== 'ready' || source.deletedAt) continue;
    for (const section of source.sections ?? []) {
      seen.set(section.id, (seen.get(section.id) ?? 0) + 1);
      const text = section.text.trim();
      if (section.id.trim() && text.length >= AI_GENERATION_LIMITS.minQuoteChars && /[\p{L}\p{N}]/u.test(normalizeForMatch(text))) qualified.add(section.id);
    }
  }
  return new Set([...qualified].filter((id) => seen.get(id) === 1));
}

export function moduleHasUsableSources(module: TemplateOutlineModule, usable: ReadonlySet<string>): boolean {
  return module.sourceSectionIds.length > 0 && module.sourceSectionIds.every((id) => usable.has(id));
}

/** Outlines persisted before coverage existed have no `coverage`; that counts as not insufficient. */
export function isModuleCovered(module: TemplateOutlineModule, usable: ReadonlySet<string>): boolean {
  return moduleHasUsableSources(module, usable) && (module.coverage !== 'insufficient' || module.coverageOverride === true);
}

export function outlineReadiness(
  outline: TemplateOutline,
  usable: ReadonlySet<string>,
  input: { templateKind: EmployeeType; responsibilities: readonly string[] },
): { readonly ready: boolean; readonly reasons: readonly string[] } {
  const modules = outline.modules.filter((module) => !module.tombstoned);
  const reasons: string[] = [];
  const uncovered = modules.filter((module) => !isModuleCovered(module, usable)).length;
  if (uncovered > 0) reasons.push(`Còn ${uncovered} module cần bổ sung hoặc bỏ`);
  const range = input.templateKind === 'normal' ? AI_GENERATION_LIMITS.normalModuleRange : AI_GENERATION_LIMITS.advancedModuleRange;
  if (modules.length < range.min || modules.length > range.max) reasons.push(`Cần từ ${range.min} đến ${range.max} module`);
  if (input.templateKind === 'advanced') {
    const assigned = new Set(modules.flatMap((module) => module.responsibilityIndexes));
    if (input.responsibilities.some((_, index) => !assigned.has(index))) reasons.push('Còn nhiệm vụ chưa gắn module');
  }
  return { ready: reasons.length === 0, reasons };
}
