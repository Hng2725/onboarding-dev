// Browser-safe: imported by the outline UI, so no node-only modules here.
import type { AiCallRecord, AiJobRecord, EmployeeType, SourceRecord, TemplateOutline, TemplateOutlineModule } from '../contracts';
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

/** Gap note of a module whose new-file supplement skipped a batch AI could not read. */
export const SUPPLEMENT_FAILED_NOTE = 'AI chưa đọc được tài liệu bổ sung. Hãy thử lại hoặc chọn đoạn thủ công.';

const SUPPLEMENT_ROOT_CALL = /^supplement-(\d+)-b\d+$/;

/**
 * The new-file source whose latest, settled supplement request for this module skipped batches,
 * so "Thử lại" can re-read just those through `supplement_module_document`. Mirrors the
 * server's skipped-batch check: a root S call of the request without a stored result.
 */
export function retryableSupplementSourceId(
  job: Pick<AiJobRecord, 'outline' | 'calls' | 'stageOutputs'>,
  moduleLocalId: string,
): string | undefined {
  const module = job.outline?.modules.find((item) => !item.tombstoned && item.moduleLocalId === moduleLocalId);
  if (!module || module.gapNote !== SUPPLEMENT_FAILED_NOTE) return undefined;
  const roots = job.calls.filter((call) => call.stage === 'S' && !call.repairOf && call.supplementModuleLocalId === moduleLocalId
    && SUPPLEMENT_ROOT_CALL.test(call.callId));
  const requestOf = (call: AiCallRecord) => Number(SUPPLEMENT_ROOT_CALL.exec(call.callId)![1]);
  const latest = Math.max(0, ...roots.map(requestOf));
  if (!latest || job.stageOutputs['applied:supplement-' + String(latest)] !== true) return undefined;
  const request = roots.filter((call) => requestOf(call) === latest);
  const sourceId = request.find((call) => call.supplementSourceId)?.supplementSourceId;
  const skipped = request.some((call) => job.stageOutputs['result:' + call.callId] === undefined);
  return sourceId && skipped ? sourceId : undefined;
}
