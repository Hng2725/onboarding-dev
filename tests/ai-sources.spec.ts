import { describe, expect, it, vi } from 'vitest';

import type { OnboardingActor } from '../src/onboarding/auth';
import type { SourceSection } from '../src/onboarding/contracts';
import {
  createSourceService,
  type SourceFileMetadata,
} from '../src/onboarding/ai/sources';
import { AI_GENERATION_LIMITS } from '../src/onboarding/ai/limits';
import { MemoryOnboardingStore } from './helpers/onboarding-memory-store';

const adminA: OnboardingActor = { userId: 'admin-a', roomId: 'room-a', access: 'admin' };
const adminB: OnboardingActor = { userId: 'admin-b', roomId: 'room-b', access: 'admin' };
const learner: OnboardingActor = { userId: 'member-a', roomId: 'room-a', access: 'learner' };
const bytes = Buffer.from('# Tổng quan\n\nNội dung', 'utf8');

function setup(
  store = new MemoryOnboardingStore(),
  metadata: SourceFileMetadata = {
    fileId: 'file-1', fileName: 'guide.md', mimeType: 'text/markdown', size: bytes.length,
  },
) {
  const readFileMetadata = vi.fn().mockResolvedValue(metadata);
  const extract = vi.fn().mockImplementation(async ({ sourceId }: { sourceId: string }) => ({
    sections: [{
      id: sourceId + '#s1', headingPath: ['Tổng quan'], text: 'Nội dung',
    }] satisfies SourceSection[],
    textLength: 8,
  }));
  const service = createSourceService(store, {
    now: () => '2026-10-23T08:00:00.000Z',
    readFileMetadata,
    extract,
  });
  return { extract, readFileMetadata, service, store };
}

function documentInput(operationId = 'operation-1') {
  return {
    operationId,
    fileName: 'guide.md',
    mimeType: 'text/markdown',
    base64: bytes.toString('base64'),
    fileId: 'file-1',
    systemName: 'PrivOS',
    softwareVersion: '2.0',
    effectiveDate: '2026-10-01',
  };
}

describe('AI source service', () => {
  it('is admin-only, room-scoped, and omits sections from source summaries', async () => {
    const { service } = setup();

    await expect(service.ingestSource(learner, documentInput())).rejects.toMatchObject({
      code: 'ADMIN_REQUIRED',
    });
    const source = await service.ingestSource(adminA, documentInput());

    expect(source).toMatchObject({
      kind: 'document', fileId: 'file-1', fileName: 'guide.md', status: 'ready',
      systemName: 'PrivOS', createdBy: 'admin-a',
    });
    expect(source).not.toHaveProperty('sections');
    await expect(service.listSources(adminA)).resolves.toEqual([source]);
    await expect(service.listSources(adminB)).resolves.toEqual([]);
  });

  it('verifies persisted room-file metadata before extracting client-supplied bytes', async () => {
    const { extract, readFileMetadata, service } = setup(undefined, {
      fileId: 'file-1', fileName: 'different.md', mimeType: 'text/markdown', size: bytes.length,
    });

    await expect(service.ingestSource(adminA, documentInput())).rejects.toMatchObject({
      code: 'SOURCE_FILE_MISMATCH',
    });
    expect(readFileMetadata).toHaveBeenCalledWith('room-a', 'file-1');
    expect(extract).not.toHaveBeenCalled();
  });

  it('replays one operation idempotently but rejects a different operation with the same checksum', async () => {
    const { extract, service, store } = setup();

    const first = await service.ingestSource(adminA, documentInput('same-operation'));
    const replay = await service.ingestSource(adminA, documentInput('same-operation'));

    expect(replay).toEqual(first);
    expect(extract).toHaveBeenCalledTimes(1);
    await expect(store.count('room-a', 'onboarding_sources')).resolves.toBe(1);
    await expect(service.ingestSource(adminA, documentInput('different-operation')))
      .rejects.toMatchObject({ code: 'SOURCE_DUPLICATE' });
  });

  it('adds admin notes, retrieves one exact section, and soft-deletes the source', async () => {
    const { service } = setup();

    const note = await service.addAdminNote(adminA, {
      operationId: 'note-operation', title: 'Quy ước nội bộ',
      text: '# Phê duyệt\n\nBấm nút Gửi duyệt.',
    });
    expect(note).toMatchObject({
      kind: 'admin_note', fileName: 'Quy ước nội bộ', systemName: 'Quy ước nội bộ',
    });
    const detail = await service.getSourceSection(adminA, note.sourceId, note.sourceId + '#s1');
    expect(detail).toMatchObject({
      fileName: 'Quy ước nội bộ',
      section: { headingPath: ['Tổng quan'], text: 'Nội dung' },
    });

    await service.deleteSource(adminA, note.sourceId);
    await expect(service.listSources(adminA)).resolves.toEqual([]);
    await expect(service.getSourceSection(adminA, note.sourceId, note.sourceId + '#s1'))
      .rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
  });

  it('enforces the active-source count before creating another source', async () => {
    const { service, store } = setup();
    for (let index = 0; index < AI_GENERATION_LIMITS.maxSourcesPerRoom; index += 1) {
      await store.create('room-a', 'onboarding_sources', {
        sourceId: 'existing-' + String(index),
        kind: 'admin_note',
        fileName: 'Note ' + String(index),
        checksum: 'checksum-' + String(index),
        systemName: 'Note',
        status: 'ready',
        sections: [],
        textLength: 1,
        createdBy: 'admin-a',
        createdAt: '2026-10-23T08:00:00.000Z',
        updatedAt: '2026-10-23T08:00:00.000Z',
      });
    }

    await expect(service.addAdminNote(adminA, {
      operationId: 'one-too-many', title: 'Quá giới hạn', text: 'Nội dung mới',
    })).rejects.toMatchObject({ code: 'SOURCE_LIMIT' });
  });
});
