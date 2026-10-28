import type { SourceRecord } from '../../src/onboarding/contracts';
import type { GeneratedTemplate } from '../../src/onboarding/ai/validate';

const quote = 'Open the Orders menu and select Create order to begin a new order.';

export const aiSource: SourceRecord = {
  id: 'source-row-1',
  roomId: 'room-a',
  sourceId: 'source-1',
  kind: 'document',
  fileName: 'orders.md',
  mimeType: 'text/markdown',
  checksum: 'fixture-checksum',
  systemName: 'Order System',
  status: 'ready',
  sections: [{ id: 'source-1#s1', headingPath: ['Orders'], text: quote }],
  textLength: quote.length,
  createdBy: 'admin-1',
  createdAt: '2026-10-23T08:00:00.000Z',
  updatedAt: '2026-10-23T08:00:00.000Z',
};

const frames = ['t1-overview', 't1-access', 't1-navigation', 't1-core'] as const;

export const generatedTemplate: GeneratedTemplate = {
  title: 'Order System onboarding',
  description: 'Learn the supported order workflow.',
  generationNotes: [],
  modules: frames.map((frameKey, moduleIndex) => {
    const moduleLocalId = `m${moduleIndex + 1}`;
    const blockLocalId = `${moduleLocalId}-b1`;
    return {
      localId: moduleLocalId,
      frameKey,
      title: `Module ${moduleIndex + 1}`,
      description: `Description ${moduleIndex + 1}`,
      estimatedMinutes: 8,
      objectives: ['Understand the workflow', 'Apply the workflow'],
      featureIds: ['feat-1'],
      blocks: [{
        localId: blockLocalId,
        kind: 'concept' as const,
        title: 'Order workflow',
        body: 'Use **Orders** to start the documented workflow.',
        sourceRefs: [{ sectionId: 'source-1#s1', quote }],
      }, {
        localId: `${moduleLocalId}-summary`,
        kind: 'summary' as const,
        body: 'Review the order workflow.',
        sourceRefs: [],
      }],
      questions: [0, 1, 2].map((questionIndex) => ({
        localId: `${moduleLocalId}-q${questionIndex + 1}`,
        level: questionIndex === 0 ? 'recall' as const : 'procedure' as const,
        prompt: `What should you do in case ${questionIndex + 1}?`,
        options: [
          { id: 'a', label: 'Open Orders' },
          { id: 'b', label: 'Open Reports' },
          { id: 'c', label: 'Open Settings' },
          { id: 'd', label: 'Sign out' },
        ],
        correctOptionId: 'a',
        explanation: 'The source says to open Orders before creating the order.',
        blockIds: [blockLocalId],
        sourceRefs: [{ sectionId: 'source-1#s1', quote }],
      })),
    };
  }),
  flags: [{
    type: 'ambiguous',
    severity: 'warning',
    message: 'The workflow audience is not explicit.',
    questionForAdmin: 'Should every employee use this workflow?',
    location: { moduleLocalId: 'm1', blockLocalId: 'm1-b1' },
    evidence: [{ sectionId: 'source-1#s1', quote }],
  }],
};

export async function seedAiSource(store: {
  create<T>(roomId: string, collection: 'onboarding_sources', data: Record<string, unknown>): Promise<T>;
}): Promise<void> {
  const { id: _id, roomId: _roomId, ...data } = aiSource;
  await store.create('room-a', 'onboarding_sources', data);
}
