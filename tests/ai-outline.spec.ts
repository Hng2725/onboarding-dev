import { describe, expect, it } from 'vitest';
import { applyTemplateOutlineEdits, buildTemplateOutline, validateTemplateOutline } from '../src/onboarding/ai/outline';
import type { FeatureInventory } from '../src/onboarding/ai/inventory';

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
