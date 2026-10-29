import { describe, expect, it } from 'vitest';
import type { FeatureInventory } from '../src/onboarding/ai/inventory';
import { AI_GENERATION_LIMITS } from '../src/onboarding/ai/limits';
import { buildTemplateOutline, validateTemplateOutline } from '../src/onboarding/ai/outline';
import { buildOutlinePlanPrompt, validateOutlinePlanOutput } from '../src/onboarding/ai/outline-plan';

const inventory: FeatureInventory = {
  systemSummary: { purpose: 'Quản lý đơn hàng', modules: ['Bán hàng'], sourceRefs: [{ sectionId: 's1', quote: 'Tổng quan hệ thống bán hàng' }] },
  glossary: [],
  features: [
    { featureId: 'f1', name: 'Tạo đơn', module: 'Bán hàng', purpose: 'Tạo đơn mới', steps: [], audience: 'all', departments: [], roles: [], sourceRefs: [{ sectionId: 's2', quote: 'Bấm Tạo đơn để bắt đầu' }] },
    { featureId: 'f2', name: 'Duyệt đơn', module: 'Bán hàng', purpose: 'Duyệt đơn', steps: [], audience: 'all', departments: [], roles: [], sourceRefs: [{ sectionId: 's3', quote: 'Bấm Gửi duyệt để chuyển đơn' }] },
  ],
  flags: [],
};
const usable = new Set(['s1', 's2', 's3']);
const featureIds = new Set(['f1', 'f2']);
const responsibilities = ['Tạo đơn hàng', 'Duyệt đơn hàng'];

const planModule = (index: number, patch: Record<string, unknown> = {}) => ({
  title: `Bài ${index + 1}: Làm quen hệ thống`, description: 'Giới thiệu các thao tác chính.', estimatedMinutes: 15,
  objectives: ['Hiểu mục đích hệ thống'], featureIds: ['f1'], sourceSectionIds: ['s1'], responsibilityIndexes: [],
  coverage: 'sufficient', gapNote: '', ...patch,
});

function input(templateKind: 'normal' | 'advanced' = 'normal') {
  const previous = buildTemplateOutline({ jobId: 'job-1', templateKind, inventory, responsibilities: templateKind === 'advanced' ? responsibilities : [] });
  return { jobId: 'job-1', templateKind, previous, usable, featureIds, responsibilities: templateKind === 'advanced' ? responsibilities : [] } as const;
}

describe('outline plan', () => {
  it('turns a valid plan into a Vietnamese outline with positional frame keys and a new revision', () => {
    const raw = { modules: [
      planModule(0, { title: 'Tổng quan hệ thống bán hàng' }),
      planModule(1, { title: 'Tạo đơn hàng mới', featureIds: ['f1'], sourceSectionIds: ['s2'] }),
      planModule(2, { title: 'Gửi duyệt đơn hàng', featureIds: ['f2'], sourceSectionIds: ['s3'] }),
      planModule(3, { title: 'Theo dõi trạng thái đơn', featureIds: ['f2'], sourceSectionIds: ['s3', 's2'] }),
      planModule(4, { title: 'Xử lý sự cố thường gặp', featureIds: [], sourceSectionIds: [], coverage: 'insufficient', gapNote: 'Tài liệu chưa nói về sự cố.' }),
    ] };
    const result = validateOutlinePlanOutput(raw, input());
    if (!result.ok) throw new Error(result.errors.join('; '));
    const outline = result.value;
    expect(outline.revision).toBe(2);
    expect(outline.modules.map((m) => m.title)).toEqual(['Tổng quan hệ thống bán hàng', 'Tạo đơn hàng mới', 'Gửi duyệt đơn hàng', 'Theo dõi trạng thái đơn', 'Xử lý sự cố thường gặp']);
    expect(outline.modules.map((m) => m.frameKey)).toEqual(['t1-overview', 't1-access', 't1-navigation', 't1-core', 't1-core-2']);
    expect(outline.modules.map((m) => m.order)).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(outline.modules.map((m) => m.moduleLocalId)).size).toBe(5);
    expect(outline.modules.every((m) => /^outline-[0-9a-f]{64}$/.test(m.moduleLocalId))).toBe(true);
    expect(outline.modules[4]).toMatchObject({ coverage: 'insufficient', gapNote: 'Tài liệu chưa nói về sự cố.' });
    expect(outline.modules[0].coverage).toBe('sufficient');
    expect(outline.modules[0].gapNote).toBeUndefined();
    expect(validateTemplateOutline(outline, { templateKind: 'normal', responsibilities: [] })).toEqual([]);
    // Deterministic by job ID and position.
    expect(validateOutlinePlanOutput(raw, input())).toEqual(result);
  });

  it('drops bogus source and feature ids and downgrades a sufficient module without usable sources', () => {
    const raw = { modules: [planModule(0), planModule(1), planModule(2), planModule(3, { sourceSectionIds: ['bogus#1', 'nope'], featureIds: ['f9', 'f2'], coverage: 'sufficient' })] };
    const result = validateOutlinePlanOutput(raw, input());
    if (!result.ok) throw new Error(result.errors.join('; '));
    const module = result.value.modules[3];
    expect(module.sourceSectionIds).toEqual([]);
    expect(module.featureIds).toEqual(['f2']);
    expect(module.coverage).toBe('insufficient');
    expect(module.gapNote).toBeTruthy();
    expect(result.value.flags.some((f) => f.type === 'missing' && f.severity === 'blocking' && f.location.moduleLocalId === module.moduleLocalId)).toBe(true);
  });

  it('truncates modules beyond the maximum and pads below the minimum', () => {
    const ten = validateOutlinePlanOutput({ modules: Array.from({ length: 10 }, (_, i) => planModule(i)) }, input());
    if (!ten.ok) throw new Error(ten.errors.join('; '));
    expect(ten.value.modules).toHaveLength(8);
    expect(ten.value.modules.map((m) => m.title)).toEqual(Array.from({ length: 8 }, (_, i) => `Bài ${i + 1}: Làm quen hệ thống`));
    const two = validateOutlinePlanOutput({ modules: [planModule(0), planModule(1)] }, input());
    if (!two.ok) throw new Error(two.errors.join('; '));
    expect(two.value.modules).toHaveLength(AI_GENERATION_LIMITS.normalModuleRange.min);
    expect(two.value.modules.slice(2).every((m) => m.coverage === 'insufficient')).toBe(true);
  });

  it('rejects only structurally unusable output', () => {
    expect(validateOutlinePlanOutput('nope', input()).ok).toBe(false);
    expect(validateOutlinePlanOutput({ modules: 'x' }, input()).ok).toBe(false);
    expect(validateOutlinePlanOutput({ modules: [{ title: '' }, 3, null] }, input()).ok).toBe(false);
  });

  it('builds the advanced task coverage from responsibility indexes so the outline validates', () => {
    const raw = { modules: [
      planModule(0, { title: 'Vai trò của bạn' }),
      planModule(1, { title: 'Quyền truy cập' }),
      planModule(2, { title: 'Tạo đơn hàng', responsibilityIndexes: [0], sourceSectionIds: ['s2'] }),
      planModule(3, { title: 'Duyệt đơn hàng', responsibilityIndexes: [1, 0, 7], sourceSectionIds: ['s3'] }),
      planModule(4, { title: 'Phối hợp nhóm' }),
    ], taskCoverage: [{ task: 'bịa', moduleLocalId: 'x' }] };
    const result = validateOutlinePlanOutput(raw, input('advanced'));
    if (!result.ok) throw new Error(result.errors.join('; '));
    expect(result.value.modules.map((m) => m.frameKey)).toEqual(['t2-role', 't2-permissions', 't2-task-1', 't2-task-2', 't2-task-3']);
    expect(result.value.modules[3].responsibilityIndexes).toEqual([1]);
    expect(result.value.taskCoverage.map((c) => c.task)).toEqual(responsibilities);
    expect(validateTemplateOutline(result.value, { templateKind: 'advanced', responsibilities })).toEqual([]);
  });

  it('lists section metadata only and stays within prompt limits for 200 sections', () => {
    const sections = Array.from({ length: 200 }, (_, i) => ({ id: `source-${i % 10}#s${i}`, sourceId: `source-${i % 10}`, fileName: `tai-lieu-${i % 10}.pdf`, headingPath: ['Chương ' + String(i), 'Mục con dài ' + 'x'.repeat(40)], chars: 3_000 }));
    const request = buildOutlinePlanPrompt({ templateKind: 'advanced', inventory, sections, responsibilities, range: AI_GENERATION_LIMITS.advancedModuleRange });
    expect(Buffer.byteLength(request.prompt, 'utf8')).toBeLessThan(AI_GENERATION_LIMITS.maxPromptChars);
    expect(Buffer.byteLength(request.systemContext, 'utf8')).toBeLessThan(AI_GENERATION_LIMITS.maxSystemContextChars);
    expect(request.systemContext).toContain('source-9#s199');
    expect(request.systemContext).toContain('Duyệt đơn');
    expect(request.prompt).toContain('sourceSectionIds');
    expect(request.prompt).toContain('responsibilityIndexes');
    expect(request.prompt).toContain('tiếng Việt');
    expect(request.prompt).toMatch(/5.*8/);
  });
});
