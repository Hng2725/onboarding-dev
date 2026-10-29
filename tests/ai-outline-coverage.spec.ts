import { describe, expect, it } from 'vitest';
import type { SourceRecord, TemplateOutline, TemplateOutlineModule } from '../src/onboarding/contracts';
import { isModuleCovered, moduleHasUsableSources, outlineReadiness, usableSectionIds } from '../src/onboarding/ai/outline-coverage';

const source = (sections: { id: string; text: string }[], extra: Partial<SourceRecord> = {}): SourceRecord => ({
  id: 'r1', roomId: 'room', sourceId: 'src', kind: 'document', fileName: 'a.pdf', checksum: 'c', systemName: 'S', status: 'ready',
  sections: sections.map((s) => ({ ...s, headingPath: [] })), createdBy: 'u', createdAt: 't', updatedAt: 't', ...extra,
});
const module = (i: number, patch: Partial<TemplateOutlineModule> = {}): TemplateOutlineModule => ({
  moduleLocalId: `m${i}`, frameKey: `t1-${i}`, order: i, title: `Module ${i}`, description: '', estimatedMinutes: 10, objectives: [],
  featureIds: [], sourceSectionIds: [`s${i}`], responsibilityIndexes: [], coverage: 'sufficient', ...patch,
});
const outline = (modules: TemplateOutlineModule[]): TemplateOutline => ({ revision: 1, modules, flags: [], taskCoverage: [] });
const usable = new Set(['s0', 's1', 's2', 's3', 's4']);
const normal = { templateKind: 'normal' as const, responsibilities: [] };

describe('usableSectionIds', () => {
  it('keeps sections of ready, live sources with enough meaningful text', () => {
    const ids = usableSectionIds([
      source([{ id: 'ok', text: '  Nội dung đầy đủ  ' }, { id: 'short', text: ' ngắn ' }, { id: 'punct', text: '.........,,,,' }, { id: 'dup', text: 'Nội dung đầy đủ' }, { id: '   ', text: 'Nội dung đầy đủ' }]),
      source([{ id: 'failed', text: 'Nội dung đầy đủ' }], { status: 'failed' }),
      source([{ id: 'deleted', text: 'Nội dung đầy đủ' }], { deletedAt: 'x' }),
      source([{ id: 'dup', text: 'Nội dung trùng lặp' }]),
    ]);
    expect([...ids]).toEqual(['ok']);
  });
});

describe('module coverage', () => {
  it('requires at least one id and all ids usable', () => {
    expect(moduleHasUsableSources(module(0), usable)).toBe(true);
    expect(moduleHasUsableSources(module(0, { sourceSectionIds: [] }), usable)).toBe(false);
    expect(moduleHasUsableSources(module(0, { sourceSectionIds: ['s0', 'nope'] }), usable)).toBe(false);
  });
  it('treats insufficient modules as uncovered unless overridden, and missing coverage as covered', () => {
    expect(isModuleCovered(module(0, { coverage: 'insufficient' }), usable)).toBe(false);
    expect(isModuleCovered(module(0, { coverage: 'insufficient', coverageOverride: true }), usable)).toBe(true);
    expect(isModuleCovered(module(0, { coverage: undefined }), usable)).toBe(true);
    expect(isModuleCovered(module(0, { coverage: 'sufficient', sourceSectionIds: [] }), usable)).toBe(false);
  });
});

describe('outlineReadiness', () => {
  it('counts modules that still need sources', () => {
    const modules = [0, 1, 2].map((i) => module(i)).concat(module(3, { coverage: 'insufficient', sourceSectionIds: [] }));
    expect(outlineReadiness(outline(modules), usable, normal)).toEqual({ ready: false, reasons: ['Còn 1 module cần bổ sung hoặc bỏ'] });
  });
  it('is ready once the insufficient module has usable sections and an override', () => {
    const modules = [0, 1, 2].map((i) => module(i)).concat(module(3, { coverage: 'insufficient', coverageOverride: true }));
    expect(outlineReadiness(outline(modules), usable, normal)).toEqual({ ready: true, reasons: [] });
  });
  it('ignores tombstoned modules and checks the module count range', () => {
    const modules = [module(0), module(1), module(2, { tombstoned: true, coverage: 'insufficient', sourceSectionIds: [] })];
    expect(outlineReadiness(outline(modules), usable, normal).reasons).toEqual(['Cần từ 4 đến 8 module']);
    expect(outlineReadiness(outline([0, 1, 2, 3].map((i) => module(i))), usable, { templateKind: 'advanced', responsibilities: [] }).reasons).toEqual(['Cần từ 5 đến 8 module']);
  });
  it('reports advanced responsibilities without an active module', () => {
    const modules = [0, 1, 2, 3, 4].map((i) => module(i, { responsibilityIndexes: i === 2 ? [0] : [] }));
    expect(outlineReadiness(outline(modules), usable, { templateKind: 'advanced', responsibilities: ['A', 'B'] }).reasons).toEqual(['Còn nhiệm vụ chưa gắn module']);
    const tombstoned = [0, 1, 2, 3].map((i) => module(i)).concat(module(4, { responsibilityIndexes: [1] }), module(5, { tombstoned: true, responsibilityIndexes: [0] }));
    expect(outlineReadiness(outline(tombstoned), usable, { templateKind: 'advanced', responsibilities: ['A', 'B'] }).reasons).toEqual(['Còn nhiệm vụ chưa gắn module']);
    const covered = [...modules.slice(0, 4), module(4, { responsibilityIndexes: [1] })];
    expect(outlineReadiness(outline(covered), usable, { templateKind: 'advanced', responsibilities: ['A', 'B'] })).toEqual({ ready: true, reasons: [] });
  });
});
