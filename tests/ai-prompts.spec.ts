import { describe, expect, it } from 'vitest';

import type { SourceRecord } from '../src/onboarding/contracts';
import {
  CONTEXT_LINE_CHARS,
  buildInventoryPrompt,
  buildModuleRepairPrompt,
  buildTemplateRepairBase,
  buildRepairPrompt,
  buildTemplateLessonsPrompt,
  buildTemplateQuestionsPrompt,
  buildVerificationPrompt,
} from '../src/onboarding/ai/prompts';

const longText = Array.from({ length: 600 }, (_value, index) => 'từ' + String(index)).join(' ');

function longestWrappableLine(text: string): number {
  return Math.max(...text.split('\n').filter((line) => /\s/.test(line.trim())).map((line) => line.length));
}

describe('AI prompt context layout', () => {
  it('keeps every system-context line short enough for agent file readers', () => {
    const source: SourceRecord = {
      id: 'row-1', roomId: 'room-a', sourceId: 'source-1', kind: 'document', fileName: 'guide.md',
      checksum: 'c', systemName: 'PrivOS', status: 'ready',
      sections: [{ id: 'source-1#s1', headingPath: ['Guide'], text: longText }],
      createdBy: 'admin-1', createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
    };
    const longInventory = { features: [{ localId: 'f1', name: longText, sourceRefs: [] }], flags: [] };
    const contexts = [
      buildInventoryPrompt({ sources: [source], batchIndex: 1, totalBatches: 1 }).systemContext,
      buildTemplateLessonsPrompt({ templateKind: 'normal', inventory: longInventory }).systemContext,
      buildTemplateQuestionsPrompt({
        templateKind: 'normal', inventory: longInventory, lessons: { modules: [{ localId: 'm1', title: longText }] },
      }).systemContext,
      buildVerificationPrompt([{ id: 'c1', claim: longText, quotes: [longText] }]).systemContext,
      buildRepairPrompt('{"title":"' + longText + '"}', ['root.title: FIELD_INVALID'], 'ctx').systemContext,
    ];

    for (const context of contexts) {
      expect(longestWrappableLine(context)).toBeLessThanOrEqual(CONTEXT_LINE_CHARS);
      expect(context.replace(/\s+/g, ' ')).toContain('từ598 từ599');
    }
  });

  it('places each source section on its own lines', () => {
    const source: SourceRecord = {
      id: 'row-1', roomId: 'room-a', sourceId: 'source-1', kind: 'document', fileName: 'guide.md',
      checksum: 'c', systemName: 'PrivOS', status: 'ready',
      sections: [
        { id: 'source-1#s1', headingPath: ['A'], text: 'Một.' },
        { id: 'source-1#s2', headingPath: ['B'], text: 'Hai.' },
      ],
      createdBy: 'admin-1', createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
    };
    const { systemContext } = buildInventoryPrompt({ sources: [source], batchIndex: 1, totalBatches: 1 });

    expect(systemContext).toMatch(/<section id="source-1#s1"[^>]*>\nMột\.\n<\/section>\n<section id="source-1#s2"/);
  });

  it('lists the allowed frame keys and module range for each template kind', () => {
    const normal = buildTemplateLessonsPrompt({ templateKind: 'normal', inventory: { features: [] } });
    const advanced = buildTemplateLessonsPrompt({
      templateKind: 'advanced',
      inventory: { features: [] },
      roleProfile: { department: 'sales', jobTitle: 'Sales', responsibilities: ['Báo giá', 'Chốt đơn'] },
    });

    expect(normal.prompt).toContain('t1-overview,t1-access,t1-navigation,t1-core,t1-core-2,t1-data,t1-security,t1-support');
    expect(normal.prompt).toContain('4–8 module');
    expect(advanced.prompt).toContain('t2-role,t2-permissions,t2-task-1');
    expect(advanced.prompt).toContain('5–8 module');
  });

  it('states the exact option shape for question calls and question repairs', () => {
    const questions = buildTemplateQuestionsPrompt({ templateKind: 'normal', inventory: { features: [] }, lessons: {} });

    expect(questions.prompt).toContain('options:[{id,label}]');
  });

  it('sends lessons to the question call as context data instead of instructions', () => {
    const questions = buildTemplateQuestionsPrompt({
      templateKind: 'normal',
      inventory: { features: [] },
      lessons: { modules: [{ localId: 'm1', blocks: [{ localId: 'LESSON_SENTINEL' }] }] },
    });

    expect(questions.prompt).not.toContain('LESSON_SENTINEL');
    expect(questions.systemContext).toContain('<lessons>');
    expect(questions.systemContext).toContain('LESSON_SENTINEL');
  });
});

const inventory = {
  features: [{ localId: 'f1', name: 'Orders', sourceRefs: [] }],
  flags: [],
};

describe('AI template prompts', () => {
  it('defines the generated local-id contract instead of public persisted ids', () => {
    const lessons = buildTemplateLessonsPrompt({ templateKind: 'normal', inventory });
    const questions = buildTemplateQuestionsPrompt({
      templateKind: 'normal',
      inventory,
      lessons: { modules: [{ localId: 'm1', blocks: [{ localId: 'm1-b1' }] }] },
    });

    expect(lessons.prompt).toContain('moduleLocalId');
    expect(lessons.prompt).toContain('blockLocalId');
    expect(questions.prompt).toContain('questionLocalId');
    expect(questions.prompt).toContain('modules:[{localId,questions');
  });

  it('keeps the original stage contract in repair prompts', () => {
    const questions = buildTemplateQuestionsPrompt({
      templateKind: 'normal',
      inventory,
      lessons: { modules: [{ localId: 'm1', blocks: [{ localId: 'm1-b1' }] }] },
    });
    const repair = buildRepairPrompt(
      '{"flags":[{"location":{"blockId":"m1-b1"}}]}',
      ['root.flags[0].location.blockId: UNKNOWN_FIELD'],
      questions.systemContext,
      questions.prompt,
    );

    expect(repair.prompt).toContain('moduleLocalId');
    expect(repair.prompt).toContain('blockLocalId');
    expect(repair.systemContext).toContain('<lessons>');
  });
});

describe('legacy role metadata in template prompts', () => {
  it('includes only responsibilities in lessons, questions, and repair prompts', () => {
    const input = {
      templateKind: 'advanced' as const,
      inventory: {},
      roleProfile: { department: 'other' as const, departmentLabel: 'DEPARTMENT_SENTINEL', jobTitle: 'TITLE_SENTINEL', responsibilities: ['TASK_ONE', 'TASK_TWO'] },
    };
    const questions = buildTemplateQuestionsPrompt({ ...input, lessons: {} });
    const requests = [
      buildTemplateLessonsPrompt(input),
      questions,
      buildTemplateRepairBase(input),
      buildModuleRepairPrompt({ ...input, stage: 'lessons', moduleLocalIds: ['m1'], previous: {}, errors: [] }),
      buildModuleRepairPrompt({ ...input, stage: 'questions', moduleLocalIds: ['m1'], previous: {}, lessons: {}, errors: [] }),
      buildRepairPrompt('{}', [], questions.systemContext, questions.prompt),
    ];
    for (const request of requests) {
      const text = request.prompt + request.systemContext;
      expect(text).toContain('TASK_ONE');
      expect(text).toContain('TASK_TWO');
      expect(text).not.toContain('DEPARTMENT_SENTINEL');
      expect(text).not.toContain('TITLE_SENTINEL');
      expect(text).not.toContain('department');
      expect(text).not.toContain('jobTitle');
    }
  });
});
