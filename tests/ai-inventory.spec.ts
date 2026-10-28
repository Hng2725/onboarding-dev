import { describe, expect, it } from 'vitest';

import {
  flagsForAdvancedRole,
  mergeInventoryChunks,
  validateInventoryChunk,
  validateRoleProfile,
  type InventoryChunk,
} from '../src/onboarding/ai/inventory';

const refA = { sectionId: 'source-a#s1', quote: 'Bấm nút Gửi duyệt để chuyển đơn.' };
const refB = { sectionId: 'source-b#s1', quote: 'Bấm nút Trình duyệt để chuyển đơn.' };

function chunk(source: 'a' | 'b'): InventoryChunk {
  return {
    systemSummary: {
      purpose: 'Quản lý đơn hàng',
      modules: ['Bán hàng'],
      sourceRefs: [source === 'a' ? refA : refB],
    },
    glossary: [],
    features: [{
      localId: 'f1',
      name: 'Duyệt đơn hàng',
      module: 'Bán hàng',
      purpose: 'Chuyển đơn sang bước duyệt',
      steps: [{
        order: 1,
        action: source === 'a' ? 'Bấm Gửi duyệt' : 'Bấm Trình duyệt',
        sourceRefs: [source === 'a' ? refA : refB],
      }],
      audience: 'role_specific',
      departments: ['sales'],
      roles: ['Chuyên viên'],
      sourceRefs: [source === 'a' ? refA : refB],
    }],
    flags: [],
  };
}

describe('feature inventory', () => {
  it('validates raw inventory fields and rejects duplicate IDs or injected fields', () => {
    expect(validateInventoryChunk(chunk('a'))).toMatchObject({ ok: true });
    const injected = {
      ...chunk('a'),
      secrets: ['TOKEN'],
      features: [...chunk('a').features, { ...chunk('a').features[0] }],
    };
    expect(validateInventoryChunk(injected)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ code: 'UNKNOWN_FIELD' }),
        expect.objectContaining({ code: 'DUPLICATE_FEATURE_ID' }),
      ]),
    });
  });

  it('merges deterministically and creates one stable blocking conflict flag', () => {
    const first = mergeInventoryChunks([chunk('a'), chunk('b')]);
    const reversed = mergeInventoryChunks([chunk('b'), chunk('a')]);

    expect(first).toEqual(reversed);
    expect(first.features).toHaveLength(1);
    expect(first.flags).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^flag-/),
        type: 'conflict',
        severity: 'blocking',
        evidence: expect.arrayContaining([refA, refB]),
      }),
    ]);
  });

  it('validates required advanced-role details and department-other labels', () => {
    expect(validateRoleProfile({
      department: 'other',
      jobTitle: '',
      responsibilities: ['Một nhiệm vụ'],
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ROLE_DEPARTMENT_LABEL_REQUIRED' }),
      expect.objectContaining({ code: 'ROLE_JOB_TITLE_REQUIRED' }),
      expect.objectContaining({ code: 'ROLE_RESPONSIBILITY_COUNT' }),
    ]));
  });

  it('creates stable missing flags when role permissions and responsibilities lack sourced features', () => {
    const inventory = mergeInventoryChunks([chunk('a')]);
    const flags = flagsForAdvancedRole(inventory, {
      department: 'finance',
      jobTitle: 'Kế toán',
      responsibilities: ['Đối soát ngân hàng', 'Lập báo cáo thuế'],
    });

    expect(flags.map((flag) => flag.type)).toEqual(['missing', 'missing', 'missing']);
    expect(flags.every((flag) => flag.severity === 'blocking')).toBe(true);
    expect(flagsForAdvancedRole(inventory, {
      department: 'finance',
      jobTitle: 'Kế toán',
      responsibilities: ['Đối soát ngân hàng', 'Lập báo cáo thuế'],
    })).toEqual(flags);
  });
});
