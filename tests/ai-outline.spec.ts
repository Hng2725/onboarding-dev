import { describe, expect, it } from 'vitest';
import { applyTemplateOutlineEdits, buildTemplateOutline, normalizeOutlineModuleCount, validateTemplateOutline } from '../src/onboarding/ai/outline';
import type { FeatureInventory } from '../src/onboarding/ai/inventory';
import { validateAdminOutline } from '../src/onboarding/ai/outline-validation';

const inventory: FeatureInventory = {
  systemSummary: { purpose: 'System', modules: [], sourceRefs: [{ sectionId: 's1', quote: 'System overview' }] },
  glossary: [],
  features: [{ featureId: 'f1', name: 'Create report', module: 'Reports', purpose: 'Create report', steps: [], audience: 'all', departments: [], roles: [], sourceRefs: [{ sectionId: 's2', quote: 'Create report' }] }],
  flags: [],
};
const responsibilities = ['Create report', 'Review access'];
const build = (templateKind: 'normal' | 'advanced' = 'normal', data = inventory) =>
  buildTemplateOutline({ jobId: 'job-1', templateKind, inventory: data, responsibilities });

describe('template outlines', () => {
  it('rejects responsibility assignments duplicated within or across modules', () => {
    const outline = build('advanced');
    const assigned = outline.modules.findIndex((m) => m.responsibilityIndexes.includes(0));
    for (const duplicate of [assigned, assigned === 0 ? 1 : 0]) {
      const modules = outline.modules.map((m, i) => i === duplicate ? { ...m, responsibilityIndexes: [...m.responsibilityIndexes, 0] } : m);
      expect(validateAdminOutline({ ...outline, modules }, { templateKind: 'advanced', responsibilities })).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'DUPLICATE_RESPONSIBILITY' })]));
    }
  });
  it('covers all eight responsibilities within eight immutable authoritative frames', () => {
    const tasks = ['Create report', 'Review access', 'Manage users', 'Check orders', 'Audit changes', 'Resolve issues', 'Train users', 'Export records'];
    const outline = buildTemplateOutline({ jobId: 'eight', templateKind: 'advanced', inventory, responsibilities: tasks });
    expect(outline.modules).toHaveLength(8);
    expect(outline.modules.map((m) => m.frameKey)).toEqual(['t2-role', 't2-permissions', 't2-task-1', 't2-task-2', 't2-task-3', 't2-task-4', 't2-task-5', 't2-task-6']);
    expect(outline.taskCoverage.map((item) => item.task)).toEqual(tasks);
    for (const [index, item] of outline.taskCoverage.entries()) expect(outline.modules.find((m) => m.moduleLocalId === item.moduleLocalId)?.responsibilityIndexes).toContain(index);
    expect(validateTemplateOutline(outline, { templateKind: 'advanced', responsibilities: tasks })).toEqual([]);
  });
  it.each([{ responsibilityIndexes: null }, { sourceSectionIds: null }, { sourceSectionIds: [123] }])('validates malformed Admin metadata before structural traversal %j', (patch) => {
    const outline = build('advanced');
    const malformed = { ...outline, modules: [{ ...outline.modules[0], ...patch }, ...outline.modules.slice(1)] };
    expect(validateAdminOutline(malformed as never, { templateKind: 'advanced', responsibilities })).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'METADATA' })]));
  });
  it('builds deterministic ordered normal frames with required frames', () => {
    const outline = build();
    expect(build()).toEqual(outline);
    expect(outline.modules.map((m) => m.frameKey)).toEqual(['t1-overview', 't1-access', 't1-navigation', 't1-core']);
    expect(validateTemplateOutline(outline, { templateKind: 'normal', responsibilities })).toEqual([]);
  });
  it('covers each responsibility in ordered advanced frames', () => {
    const outline = build('advanced');
    expect(outline.modules.map((m) => m.frameKey)).toEqual(['t2-role', 't2-permissions', 't2-task-1', 't2-task-2', 't2-collab']);
    expect(outline.taskCoverage.map((c) => c.task)).toEqual(responsibilities);
    expect(outline.taskCoverage.every((c) => c.moduleLocalId !== null)).toBe(true);
    expect(validateTemplateOutline(outline, { templateKind: 'advanced', responsibilities })).toEqual([]);
  });
  it('flags each module without usable source sections', () => {
    const outline = build('normal', { ...inventory, systemSummary: { ...inventory.systemSummary, sourceRefs: [] }, features: [] });
    for (const module of outline.modules) {
      expect(outline.flags.some((f) => f.type === 'missing' && f.severity === 'blocking' && f.location.moduleLocalId === module.moduleLocalId)).toBe(true);
    }
  });
  it('preserves IDs when reordered and never reuses a deleted ID', () => {
    const outline = build();
    const { moduleLocalId: id, frameKey: frame } = outline.modules[1];
    const idFactory = () => 'replacement';
    const reordered = applyTemplateOutlineEdits(outline, [{ type: 'reorder', moduleLocalId: id, order: 0 }], idFactory);
    expect(reordered.modules.find((module) => module.frameKey === frame)?.moduleLocalId).toBe(id);
    const deleted = applyTemplateOutlineEdits(reordered, [{ type: 'delete', moduleLocalId: id }], idFactory);
    const added = applyTemplateOutlineEdits(deleted, [{ type: 'add', module: { ...outline.modules[1], order: 1 } }], idFactory);
    expect(added.modules.find((m) => m.frameKey === frame && !m.tombstoned)?.moduleLocalId).toBe('replacement');
    expect(added.modules.find((m) => m.moduleLocalId === id)?.tombstoned).toBe(true);
  });
  it('rejects invalid ordering, duplicate frames, and duplicate responsibilities', () => {
    const outline = build('advanced');
    const invalid = { ...outline, modules: [outline.modules[1], outline.modules[0], ...outline.modules.slice(2), outline.modules[2]] };
    expect(validateTemplateOutline(invalid, { templateKind: 'advanced', responsibilities: ['A', 'a'] }).length).toBeGreaterThan(0);
  });
});

describe('outline edit safeguards', () => {
  it('rejects reuse of a tombstoned ID and flags uncovered responsibilities', () => {
    const outline = build('advanced');
    const module = outline.modules[2];
    const deleted = applyTemplateOutlineEdits(outline, [{ type: 'delete', moduleLocalId: module.moduleLocalId }], () => 'unused');
    expect(deleted.taskCoverage[0].moduleLocalId).toBeNull();
    expect(deleted.flags[deleted.taskCoverage[0].flagIndex!]).toMatchObject({ type: 'missing', severity: 'blocking' });
    expect(() => applyTemplateOutlineEdits(deleted, [{ type: 'add', module }], () => module.moduleLocalId)).toThrow();
  });
  it('does not accept a supplied tombstone on a newly added frame', () => {
    const outline = build();
    const module = outline.modules[1];
    const deleted = applyTemplateOutlineEdits(outline, [{ type: 'delete', moduleLocalId: module.moduleLocalId }], () => 'new');
    const added = applyTemplateOutlineEdits(deleted, [{ type: 'add', module: { ...module, tombstoned: true } }], () => 'new');
    expect(added.modules.find((m) => m.moduleLocalId === 'new')?.tombstoned).not.toBe(true);
  });
});

describe('outline source and required-frame safeguards', () => {
  it('creates a blocking missing-source flag for added modules with whitespace-only section IDs', () => {
    const outline = build();
    const removed = applyTemplateOutlineEdits(outline, [{ type: 'delete', moduleLocalId: outline.modules[1].moduleLocalId }], () => 'new');
    const module = { ...outline.modules[1], sourceSectionIds: ['   '] };
    const added = applyTemplateOutlineEdits(removed, [{ type: 'add', module }], () => 'new');
    expect(added.flags.some((f) => f.type === 'missing' && f.severity === 'blocking' && f.location.moduleLocalId === 'new')).toBe(true);
  });
  it('requires a missing-frame flag to identify the specific required frame', () => {
    const outline = build();
    const missing = { ...outline, modules: outline.modules.filter((m) => m.frameKey !== 't1-core'), flags: [{ type: 'missing' as const, severity: 'blocking' as const, message: 'core is missing', questionForAdmin: 'Provide core', location: {}, evidence: [] }] };
    expect(validateTemplateOutline(missing, { templateKind: 'normal', responsibilities }).some((e) => e.code === 'REQUIRED_FRAME')).toBe(true);
    const marked = { ...missing, flags: [{ ...missing.flags[0], location: { frameKey: 't1-core' } }] };
    expect(validateTemplateOutline(marked, { templateKind: 'normal', responsibilities }).some((e) => e.code === 'REQUIRED_FRAME')).toBe(false);
  });
  it('puts an unrelated normal feature in the first summary group with its refs', () => {
    const unrelated = { ...inventory, systemSummary: { ...inventory.systemSummary, modules: ['Kế hoạch 30 ngày', 'Phân loại dữ liệu'], sourceRefs: [] }, features: [{ ...inventory.features[0], name: 'Banana', module: 'Orchard', purpose: 'Harvest fruit' }] };
    const outline = build('normal', unrelated);
    expect(outline.modules[0]).toMatchObject({ title: 'Kế hoạch 30 ngày', featureIds: ['f1'], sourceSectionIds: ['s2'], coverage: 'sufficient' });
    for (const module of outline.modules.slice(1)) {
      expect(module.sourceSectionIds).toEqual([]);
      expect(outline.flags.some((f) => f.type === 'missing' && f.severity === 'blocking' && f.location.moduleLocalId === module.moduleLocalId)).toBe(true);
    }
  });
  it('does not treat unrelated zero-score features as sources for advanced task frames', () => {
    const unrelated = { ...inventory, systemSummary: { ...inventory.systemSummary, sourceRefs: [] }, features: [{ ...inventory.features[0], name: 'Banana', module: 'Orchard', purpose: 'Harvest fruit' }] };
    const outline = build('advanced', unrelated);
    const module = outline.modules.find((m) => m.frameKey === 't2-task-1')!;
    expect(module.sourceSectionIds).toEqual([]);
    expect(outline.flags.some((f) => f.type === 'missing' && f.severity === 'blocking' && f.location.moduleLocalId === module.moduleLocalId)).toBe(true);
  });
  it('scores advanced Vietnamese features against responsibilities, not frame labels', () => {
    const tasks = ['Lập báo cáo tuần', 'Duyệt quyền'];
    const data: FeatureInventory = { ...inventory, systemSummary: { ...inventory.systemSummary, sourceRefs: [] }, features: [{ ...inventory.features[0], name: 'Báo cáo công việc', module: 'Công việc', purpose: 'Tổng hợp', sourceRefs: [{ sectionId: 'vn', quote: 'Báo cáo công việc' }] }] };
    const outline = buildTemplateOutline({ jobId: 'vn', templateKind: 'advanced', inventory: data, responsibilities: tasks });
    const slot = outline.modules.find((m) => m.responsibilityIndexes.includes(0))!;
    expect(slot).toMatchObject({ frameKey: 't2-task-1', title: 'Lập báo cáo tuần', featureIds: ['f1'], sourceSectionIds: ['vn'], coverage: 'sufficient' });
    expect(outline.modules.find((m) => m.frameKey === 't2-collab')).toMatchObject({ featureIds: [], coverage: 'insufficient' });
  });
});

describe('Vietnamese deterministic outline', () => {
  const handbookModules = ['Kế hoạch 30 ngày', 'Kênh giao tiếp nội bộ', 'Ngày làm việc đầu tiên — nhận thiết bị, tài khoản và gặp đội nhóm', 'Phân loại dữ liệu', 'Tiêu chí hoàn thành'];
  const handbook = (modules: readonly string[]): FeatureInventory => ({
    systemSummary: { purpose: 'Sổ tay hội nhập', modules, sourceRefs: [{ sectionId: 'sum', quote: 'Sổ tay hội nhập nhân viên' }] },
    glossary: [],
    features: modules.map((module, i) => ({ featureId: `f${i}`, name: `Nội dung ${i}`, module, purpose: `Hướng dẫn ${module}`, steps: [], audience: 'all', departments: [], roles: [], sourceRefs: [{ sectionId: `s${i}`, quote: `Đoạn ${module}` }] })),
    flags: [],
  });
  const vn = (modules: readonly string[], extra: Partial<FeatureInventory> = {}) =>
    buildTemplateOutline({ jobId: 'roxane', templateKind: 'normal', inventory: { ...handbook(modules), ...extra }, responsibilities: [] });

  it('groups features by the summary modules with their Vietnamese titles', () => {
    const outline = vn(handbookModules);
    expect(outline.modules).toHaveLength(5);
    expect(outline.modules.map((m) => m.title)).toEqual(handbookModules);
    expect(outline.modules.some((m) => /^t[12]-/.test(m.title))).toBe(false);
    expect(outline.modules.every((m) => m.coverage === 'sufficient')).toBe(true);
    expect(outline.modules.map((m) => m.frameKey)).toEqual(['t1-overview', 't1-access', 't1-navigation', 't1-core', 't1-core-2']);
    expect(outline.modules[0].sourceSectionIds).toEqual(['s0', 'sum']);
    expect(outline.modules[1].sourceSectionIds).toEqual(['s1']);
    expect(vn(handbookModules)).toEqual(outline);
    expect(validateTemplateOutline(outline, { templateKind: 'normal', responsibilities: [] })).toEqual([]);
  });
  it('pads a two-module normal outline with insufficient Vietnamese modules', () => {
    const outline = vn(handbookModules.slice(0, 2));
    expect(outline.modules).toHaveLength(4);
    const padded = outline.modules.slice(2);
    expect(padded.map((m) => m.coverage)).toEqual(['insufficient', 'insufficient']);
    expect(padded.map((m) => m.title)).toEqual(['Làm quen giao diện', 'Quy trình công việc chính']);
    expect(padded.every((m) => m.gapNote === 'Chưa tìm thấy nội dung tài liệu cho module này.' && m.sourceSectionIds.length === 0)).toBe(true);
    for (const module of padded) expect(outline.flags).toContainEqual(expect.objectContaining({ message: 'Module chưa có đoạn tài liệu nguồn.', questionForAdmin: 'Bổ sung tài liệu cho module này hoặc bỏ module.', location: { moduleLocalId: module.moduleLocalId } }));
    expect(validateTemplateOutline(outline, { templateKind: 'normal', responsibilities: [] })).toEqual([]);
  });
  it('sends unmatched features to the group with the most word overlap, otherwise the first group', () => {
    const data = handbook(handbookModules);
    const extra = [
      { ...data.features[0], featureId: 'x1', module: 'Khác', name: 'Phân loại', purpose: 'Dữ liệu mật', sourceRefs: [{ sectionId: 'x1', quote: 'Dữ liệu mật' }] },
      { ...data.features[0], featureId: 'x2', module: 'Orchard', name: 'Banana', purpose: 'Harvest', sourceRefs: [{ sectionId: 'x2', quote: 'Harvest fruit' }] },
    ];
    const outline = vn(handbookModules, { features: [...data.features, ...extra] });
    expect(outline.modules[3].featureIds).toContain('x1');
    expect(outline.modules[0].featureIds).toContain('x2');
  });
  it('merges groups above the maximum into the last module', () => {
    const many = Array.from({ length: 10 }, (_, i) => `Chủ đề ${i + 1}`);
    const outline = vn(many);
    expect(outline.modules).toHaveLength(8);
    expect(outline.modules[7].title).toBe('Chủ đề 8');
    expect(outline.modules[7].featureIds).toEqual(['f7', 'f8', 'f9']);
    expect(outline.modules[7].sourceSectionIds).toEqual(['s7', 's8', 's9']);
    expect(validateTemplateOutline(outline, { templateKind: 'normal', responsibilities: [] })).toEqual([]);
  });
  it('trims long summary module titles to 80 characters', () => {
    const long = `Quy trình ${'rất dài '.repeat(20)}`;
    expect(vn([long]).modules[0].title).toBe(long.trim().slice(0, 80).trim());
  });
  it('gives advanced modules Vietnamese titles and coverage while keeping task slots', () => {
    const outline = build('advanced');
    expect(outline.modules.some((m) => /^t[12]-/.test(m.title))).toBe(false);
    expect(outline.modules.every((m) => m.coverage === (m.sourceSectionIds.length ? 'sufficient' : 'insufficient'))).toBe(true);
    expect(validateTemplateOutline(outline, { templateKind: 'advanced', responsibilities })).toEqual([]);
  });
  it('accepts coverage edits and rejects malformed coverage metadata', () => {
    const outline = build();
    const id = outline.modules[1].moduleLocalId;
    const edited = applyTemplateOutlineEdits(outline, [{ type: 'update', moduleLocalId: id, patch: { coverageOverride: true, gapNote: 'Đã bổ sung.', coverage: 'sufficient' } }], () => 'new');
    expect(edited.modules.find((m) => m.moduleLocalId === id)).toMatchObject({ coverageOverride: true, gapNote: 'Đã bổ sung.', coverage: 'sufficient' });
    for (const patch of [{ coverage: 'maybe' }, { coverageOverride: 'yes' }, { gapNote: 5 }]) {
      const malformed = { ...outline, modules: [{ ...outline.modules[0], ...patch }, ...outline.modules.slice(1)] };
      expect(validateAdminOutline(malformed as never, { templateKind: 'normal', responsibilities })).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'METADATA' })]));
    }
  });
});

describe('normalizeOutlineModuleCount', () => {
  const base = buildTemplateOutline({ jobId: 'n', templateKind: 'normal', inventory, responsibilities: [] }).modules;
  it('pads to the minimum and reassigns order and positional frames', () => {
    const result = normalizeOutlineModuleCount([{ ...base[0], frameKey: 't1-support', order: 5 }], { jobId: 'n', templateKind: 'advanced' });
    expect(result).toHaveLength(5);
    expect(result.map((m) => m.frameKey)).toEqual(['t2-role', 't2-permissions', 't2-task-1', 't2-task-2', 't2-task-3']);
    expect(result.map((m) => m.order)).toEqual([0, 1, 2, 3, 4]);
    expect(result.slice(1).every((m) => m.coverage === 'insufficient' && !/^t[12]-/.test(m.title))).toBe(true);
    expect(new Set(result.map((m) => m.moduleLocalId)).size).toBe(5);
  });
  it('normalizes live modules only and keeps tombstones unchanged at the end', () => {
    const padId = base[1].moduleLocalId;
    const tombstone = { ...base[1], frameKey: 't1-access', order: 0, tombstoned: true };
    const result = normalizeOutlineModuleCount([tombstone, { ...base[0], order: 1 }], { jobId: 'n', templateKind: 'normal' });
    expect(result).toHaveLength(5);
    expect(result.slice(0, 4).every((m) => !m.tombstoned)).toBe(true);
    expect(result.slice(0, 4).map((m) => m.frameKey)).toEqual(['t1-overview', 't1-access', 't1-navigation', 't1-core']);
    expect(result.slice(0, 4).map((m) => m.order)).toEqual([0, 1, 2, 3]);
    expect(result[0].moduleLocalId).toBe(base[0].moduleLocalId);
    expect(result[4]).toEqual(tombstone);
    expect(result.slice(0, 4).map((m) => m.moduleLocalId)).not.toContain(padId);
    expect(new Set(result.map((m) => m.moduleLocalId)).size).toBe(5);
  });
});
