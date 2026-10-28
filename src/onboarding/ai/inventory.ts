import { createHash } from 'node:crypto';

import type { FlagType, RoleProfile } from '../contracts';
import { normalizeForMatch, type RawSourceRef } from './grounding';

export interface InventorySummary {
  readonly purpose: string;
  readonly modules: readonly string[];
  readonly sourceRefs: readonly RawSourceRef[];
}

export interface InventoryGlossaryItem {
  readonly term: string;
  readonly definition: string;
  readonly sourceRefs: readonly RawSourceRef[];
}

export interface InventoryStep {
  readonly order: number;
  readonly action: string;
  readonly sourceRefs: readonly RawSourceRef[];
}

export interface InventoryChunkFeature {
  readonly localId: string;
  readonly name: string;
  readonly module: string;
  readonly purpose: string;
  readonly steps: readonly InventoryStep[];
  readonly audience: 'all' | 'role_specific' | 'admin' | 'unclear';
  readonly departments: readonly string[];
  readonly roles: readonly string[];
  readonly sourceRefs: readonly RawSourceRef[];
}

export interface InventoryChunkFlag {
  readonly type: Exclude<FlagType, 'unsupported' | 'generation_error'>;
  readonly severity: 'blocking' | 'warning';
  readonly message: string;
  readonly questionForAdmin: string;
  readonly featureLocalId?: string;
  readonly evidence: readonly RawSourceRef[];
}

export interface InventoryChunk {
  readonly systemSummary: InventorySummary;
  readonly glossary: readonly InventoryGlossaryItem[];
  readonly features: readonly InventoryChunkFeature[];
  readonly flags: readonly InventoryChunkFlag[];
}

export interface InventoryFeature extends Omit<InventoryChunkFeature, 'localId'> {
  readonly featureId: string;
}

export interface InventoryFlag {
  readonly id: string;
  readonly type: FlagType;
  readonly severity: 'blocking' | 'warning';
  readonly message: string;
  readonly questionForAdmin: string;
  readonly featureId?: string;
  readonly evidence: readonly RawSourceRef[];
}

export interface FeatureInventory {
  readonly systemSummary: InventorySummary;
  readonly glossary: readonly InventoryGlossaryItem[];
  readonly features: readonly InventoryFeature[];
  readonly flags: readonly InventoryFlag[];
}

export interface RoleProfileError {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface InventoryValidationError {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export type InventoryChunkValidation =
  | { readonly ok: true; readonly value: InventoryChunk; readonly errors: readonly [] }
  | { readonly ok: false; readonly errors: readonly InventoryValidationError[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errors: InventoryValidationError[],
): void {
  Object.keys(value).forEach((key) => {
    if (!allowed.includes(key)) {
      errors.push({ code: 'UNKNOWN_FIELD', path: path + '.' + key, message: 'Unknown field.' });
    }
  });
}

function requireString(
  value: unknown,
  path: string,
  errors: InventoryValidationError[],
): void {
  if (typeof value !== 'string' || !value.trim()) {
    errors.push({ code: 'FIELD_INVALID', path, message: 'A non-empty string is required.' });
  }
}

function requireStringArray(
  value: unknown,
  path: string,
  errors: InventoryValidationError[],
): void {
  if (!Array.isArray(value)) {
    errors.push({ code: 'FIELD_INVALID', path, message: 'A string array is required.' });
    return;
  }
  value.forEach((item, index) => requireString(item, path + '[' + String(index) + ']', errors));
}

function validateRawRefs(
  value: unknown,
  path: string,
  errors: InventoryValidationError[],
): void {
  if (!Array.isArray(value)) {
    errors.push({ code: 'FIELD_INVALID', path, message: 'A source reference array is required.' });
    return;
  }
  value.forEach((item, index) => {
    const itemPath = path + '[' + String(index) + ']';
    if (!isRecord(item)) {
      errors.push({ code: 'FIELD_INVALID', path: itemPath, message: 'A source reference is required.' });
      return;
    }
    exactFields(item, ['sectionId', 'quote'], itemPath, errors);
    requireString(item.sectionId, itemPath + '.sectionId', errors);
    requireString(item.quote, itemPath + '.quote', errors);
  });
}

export function validateInventoryChunk(value: unknown): InventoryChunkValidation {
  const errors: InventoryValidationError[] = [];
  if (!isRecord(value)) {
    return {
      ok: false,
      errors: [{ code: 'FIELD_INVALID', path: 'root', message: 'An inventory object is required.' }],
    };
  }
  exactFields(value, ['systemSummary', 'glossary', 'features', 'flags'], 'root', errors);
  if (!isRecord(value.systemSummary)) {
    errors.push({ code: 'FIELD_INVALID', path: 'root.systemSummary', message: 'A summary is required.' });
  } else {
    exactFields(value.systemSummary, ['purpose', 'modules', 'sourceRefs'], 'root.systemSummary', errors);
    requireString(value.systemSummary.purpose, 'root.systemSummary.purpose', errors);
    requireStringArray(value.systemSummary.modules, 'root.systemSummary.modules', errors);
    validateRawRefs(value.systemSummary.sourceRefs, 'root.systemSummary.sourceRefs', errors);
  }

  if (!Array.isArray(value.glossary)) {
    errors.push({ code: 'FIELD_INVALID', path: 'root.glossary', message: 'glossary must be an array.' });
  } else {
    value.glossary.forEach((item, index) => {
      const path = 'root.glossary[' + String(index) + ']';
      if (!isRecord(item)) {
        errors.push({ code: 'FIELD_INVALID', path, message: 'A glossary item is required.' });
        return;
      }
      exactFields(item, ['term', 'definition', 'sourceRefs'], path, errors);
      requireString(item.term, path + '.term', errors);
      requireString(item.definition, path + '.definition', errors);
      validateRawRefs(item.sourceRefs, path + '.sourceRefs', errors);
    });
  }

  const featureIds = new Set<string>();
  if (!Array.isArray(value.features)) {
    errors.push({ code: 'FIELD_INVALID', path: 'root.features', message: 'features must be an array.' });
  } else {
    value.features.forEach((item, index) => {
      const path = 'root.features[' + String(index) + ']';
      if (!isRecord(item)) {
        errors.push({ code: 'FIELD_INVALID', path, message: 'A feature is required.' });
        return;
      }
      exactFields(item, [
        'localId', 'name', 'module', 'purpose', 'steps',
        'audience', 'departments', 'roles', 'sourceRefs',
      ], path, errors);
      requireString(item.localId, path + '.localId', errors);
      if (typeof item.localId === 'string') {
        if (featureIds.has(item.localId)) {
          errors.push({
            code: 'DUPLICATE_FEATURE_ID',
            path: path + '.localId',
            message: 'Feature local IDs must be unique.',
          });
        }
        featureIds.add(item.localId);
      }
      requireString(item.name, path + '.name', errors);
      requireString(item.module, path + '.module', errors);
      requireString(item.purpose, path + '.purpose', errors);
      if (!['all', 'role_specific', 'admin', 'unclear'].includes(String(item.audience))) {
        errors.push({ code: 'FEATURE_AUDIENCE', path: path + '.audience', message: 'Invalid audience.' });
      }
      requireStringArray(item.departments, path + '.departments', errors);
      requireStringArray(item.roles, path + '.roles', errors);
      validateRawRefs(item.sourceRefs, path + '.sourceRefs', errors);
      if (!Array.isArray(item.steps)) {
        errors.push({ code: 'FIELD_INVALID', path: path + '.steps', message: 'steps must be an array.' });
      } else {
        item.steps.forEach((step, stepIndex) => {
          const stepPath = path + '.steps[' + String(stepIndex) + ']';
          if (!isRecord(step)) {
            errors.push({ code: 'FIELD_INVALID', path: stepPath, message: 'A step is required.' });
            return;
          }
          exactFields(step, ['order', 'action', 'sourceRefs'], stepPath, errors);
          if (step.order !== stepIndex + 1) {
            errors.push({ code: 'STEP_ORDER', path: stepPath + '.order', message: 'Steps must start at one.' });
          }
          requireString(step.action, stepPath + '.action', errors);
          validateRawRefs(step.sourceRefs, stepPath + '.sourceRefs', errors);
        });
      }
    });
  }

  if (!Array.isArray(value.flags)) {
    errors.push({ code: 'FIELD_INVALID', path: 'root.flags', message: 'flags must be an array.' });
  } else {
    value.flags.forEach((item, index) => {
      const path = 'root.flags[' + String(index) + ']';
      if (!isRecord(item)) {
        errors.push({ code: 'FIELD_INVALID', path, message: 'A flag is required.' });
        return;
      }
      exactFields(item, [
        'type', 'severity', 'message', 'questionForAdmin', 'featureLocalId', 'evidence',
      ], path, errors);
      requireString(item.type, path + '.type', errors);
      requireString(item.severity, path + '.severity', errors);
      requireString(item.message, path + '.message', errors);
      requireString(item.questionForAdmin, path + '.questionForAdmin', errors);
      validateRawRefs(item.evidence, path + '.evidence', errors);
    });
  }
  return errors.length > 0
    ? { ok: false, errors: errors.slice(0, 30) }
    : { ok: true, value: value as unknown as InventoryChunk, errors: [] };
}

function withoutDiacritics(value: string): string {
  return normalizeForMatch(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd');
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

function stableHash(value: unknown, length = 20): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
    .slice(0, length);
}

function refKey(ref: RawSourceRef): string {
  return ref.sectionId + '\u0000' + normalizeForMatch(ref.quote);
}

function uniqueRefs(refs: readonly RawSourceRef[]): readonly RawSourceRef[] {
  const byKey = new Map<string, RawSourceRef>();
  refs.forEach((ref) => byKey.set(refKey(ref), ref));
  return [...byKey.values()].sort((left, right) => refKey(left).localeCompare(refKey(right)));
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  const byNormalized = new Map<string, string>();
  values.forEach((value) => {
    const trimmed = value.trim();
    if (trimmed) byNormalized.set(normalizeForMatch(trimmed), trimmed);
  });
  return [...byNormalized.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}

function flag(
  type: FlagType,
  severity: 'blocking' | 'warning',
  message: string,
  questionForAdmin: string,
  evidence: readonly RawSourceRef[],
  featureId?: string,
): InventoryFlag {
  const normalizedEvidence = uniqueRefs(evidence);
  const identity = {
    type,
    severity,
    message: normalizeForMatch(message),
    questionForAdmin: normalizeForMatch(questionForAdmin),
    evidence: normalizedEvidence.map(refKey),
    featureId,
  };
  return {
    id: 'flag-' + stableHash(identity),
    type,
    severity,
    message,
    questionForAdmin,
    ...(featureId ? { featureId } : {}),
    evidence: normalizedEvidence,
  };
}

function featureKey(feature: InventoryChunkFeature): string {
  return normalizeForMatch(feature.module) + '\u0000' + normalizeForMatch(feature.name);
}

function featureVariantKey(feature: InventoryChunkFeature): string {
  return JSON.stringify(canonical({
    name: normalizeForMatch(feature.name),
    module: normalizeForMatch(feature.module),
    purpose: normalizeForMatch(feature.purpose),
    steps: feature.steps.map((step) => ({
      order: step.order,
      action: normalizeForMatch(step.action),
    })),
  }));
}

export function mergeInventoryChunks(chunks: readonly InventoryChunk[]): FeatureInventory {
  const summaries = chunks.map((chunk) => chunk.systemSummary);
  const grouped = new Map<string, InventoryChunkFeature[]>();
  chunks.flatMap((chunk) => chunk.features).forEach((feature) => {
    const key = featureKey(feature);
    grouped.set(key, [...(grouped.get(key) ?? []), feature]);
  });

  const features: InventoryFeature[] = [];
  const conflictFlags: InventoryFlag[] = [];
  for (const [key, candidates] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const sorted = [...candidates].sort((left, right) => featureVariantKey(left).localeCompare(featureVariantKey(right)));
    const selected = sorted[0];
    const featureId = 'feat-' + stableHash(key);
    const allRefs = uniqueRefs(sorted.flatMap((candidate) => candidate.sourceRefs));
    features.push({
      featureId,
      name: selected.name,
      module: selected.module,
      purpose: selected.purpose,
      steps: selected.steps,
      audience: selected.audience,
      departments: uniqueStrings(sorted.flatMap((candidate) => candidate.departments)),
      roles: uniqueStrings(sorted.flatMap((candidate) => candidate.roles)),
      sourceRefs: allRefs,
    });
    if (new Set(sorted.map(featureVariantKey)).size > 1) {
      conflictFlags.push(flag(
        'conflict',
        'blocking',
        'Các tài liệu mô tả khác nhau cho tính năng "' + selected.name + '".',
        'Phiên bản thao tác nào là phiên bản đang áp dụng?',
        uniqueRefs(sorted.flatMap((candidate) =>
          candidate.steps.flatMap((step) => step.sourceRefs).concat(candidate.sourceRefs))),
        featureId,
      ));
    }
  }

  const localToStable = new Map<string, string>();
  chunks.forEach((chunk) => chunk.features.forEach((feature) => {
    localToStable.set(feature.localId, 'feat-' + stableHash(featureKey(feature)));
  }));
  const suppliedFlags = chunks.flatMap((chunk) => chunk.flags).map((item) => flag(
    item.type,
    item.severity,
    item.message,
    item.questionForAdmin,
    item.evidence,
    item.featureLocalId ? localToStable.get(item.featureLocalId) : undefined,
  ));
  const flags = [...new Map(
    [...suppliedFlags, ...conflictFlags].map((item) => [item.id, item]),
  ).values()].sort((left, right) => left.id.localeCompare(right.id));

  const summaryRefs = uniqueRefs(summaries.flatMap((summary) => summary.sourceRefs));
  const summaryPurpose = uniqueStrings(summaries.map((summary) => summary.purpose)).join(' / ');
  const glossaryByTerm = new Map<string, InventoryGlossaryItem>();
  chunks.flatMap((chunk) => chunk.glossary).forEach((item) => {
    const key = normalizeForMatch(item.term);
    const existing = glossaryByTerm.get(key);
    glossaryByTerm.set(key, existing ? {
      term: existing.term,
      definition: uniqueStrings([existing.definition, item.definition]).join(' / '),
      sourceRefs: uniqueRefs([...existing.sourceRefs, ...item.sourceRefs]),
    } : item);
  });

  return {
    systemSummary: {
      purpose: summaryPurpose,
      modules: uniqueStrings(summaries.flatMap((summary) => summary.modules)),
      sourceRefs: summaryRefs,
    },
    glossary: [...glossaryByTerm.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, item]) => item),
    features,
    flags,
  };
}

export function validateRoleProfile(profile: RoleProfile): readonly RoleProfileError[] {
  const errors: RoleProfileError[] = [];
  const responsibilities = profile.responsibilities.map((item) => item.trim()).filter(Boolean);
  if (
    responsibilities.length < 2
    || responsibilities.length > 8
    || new Set(responsibilities.map(normalizeForMatch)).size !== responsibilities.length
  ) {
    errors.push({
      code: 'ROLE_RESPONSIBILITY_COUNT',
      path: 'responsibilities',
      message: 'Provide 2 to 8 unique responsibilities.',
    });
  }
  return errors;
}

function featureSearchText(feature: InventoryFeature): string {
  return withoutDiacritics([
    feature.name,
    feature.module,
    feature.purpose,
    ...feature.steps.map((step) => step.action),
    ...feature.roles,
    ...feature.departments,
  ].join(' '));
}

function matchesResponsibility(feature: InventoryFeature, responsibility: string): boolean {
  const taskTokens = withoutDiacritics(responsibility)
    .split(/\s+/)
    .filter((token) => token.length >= 4);
  const featureText = featureSearchText(feature);
  return taskTokens.length > 0 && taskTokens.every((token) => featureText.includes(token));
}

export function flagsForAdvancedRole(
  inventory: FeatureInventory,
  profile: RoleProfile,
): readonly InventoryFlag[] {
  const flags: InventoryFlag[] = [];
  const permissionTerms = ['quyen', 'phan quyen', 'permission', 'access'];
  const hasPermissions = inventory.features.some((feature) =>
    permissionTerms.some((term) => featureSearchText(feature).includes(term)));
  if (!hasPermissions) {
    flags.push(flag(
      'missing',
      'blocking',
      'Tài liệu chưa mô tả quyền hạn cho vai trò chuyên sâu.',
      'Vai trò này được xem, sửa hoặc duyệt những dữ liệu nào?',
      [],
    ));
  }
  for (const responsibility of [...profile.responsibilities].sort((left, right) =>
    normalizeForMatch(left).localeCompare(normalizeForMatch(right)))) {
    if (!inventory.features.some((feature) => matchesResponsibility(feature, responsibility))) {
      flags.push(flag(
        'missing',
        'blocking',
        'Tài liệu chưa mô tả tính năng phục vụ nhiệm vụ "' + responsibility + '".',
        'Nhiệm vụ này được thực hiện ở đâu trong hệ thống?',
        [],
      ));
    }
  }
  return flags.sort((left, right) => left.message.localeCompare(right.message, 'vi'));
}
