import { describe, expect, it, vi } from 'vitest';

import {
  ONBOARDING_ROOMFILES,
  PublishedTemplateExportError,
  ensureOnboardingRoomfiles,
  ensureTemplateRoomfilesFolder,
  normalizeUploadedRoomFile,
  safeRoomfilesFolderName,
  publishTemplateWithRetryableExport,
  templateJsonArtifact,
} from '../src/ui/onboarding/roomfiles';

interface FolderRow {
  readonly _id: string;
  readonly name: string;
  readonly father?: string;
}

describe('Onboarding Roomfiles', () => {
  it('accepts the direct JSON response shape returned by the live host bridge', async () => {
    const rest = vi.fn(async (request: { query?: Record<string, unknown> }) => request.query?.fatherId
      ? {
          success: true,
          folders: [
            { _id: 'direct-documents', name: ONBOARDING_ROOMFILES.documents, father: 'direct-root' },
            { _id: 'direct-templates', name: ONBOARDING_ROOMFILES.templates, father: 'direct-root' },
          ],
          total: 2,
        }
      : {
          success: true,
          folders: [{ _id: 'direct-root', name: ONBOARDING_ROOMFILES.root, father: null }],
          total: 1,
        });

    await expect(ensureOnboardingRoomfiles({ rest } as never, 'room-direct')).resolves.toEqual({
      rootId: 'direct-root',
      documentsId: 'direct-documents',
      templatesId: 'direct-templates',
    });
  });

  it('reuses the exact existing English folder hierarchy without creating duplicates', async () => {
    const rest = vi.fn(async (request: { method: string; query?: Record<string, unknown> }) => {
      if (request.query?.fatherId === 'folder-root') {
        return {
          statusCode: 200,
          body: { folders: [
            { _id: 'folder-documents', name: ONBOARDING_ROOMFILES.documents, father: 'folder-root' },
            { _id: 'folder-templates', name: ONBOARDING_ROOMFILES.templates, father: 'folder-root' },
          ], total: 2 },
        };
      }
      return {
        statusCode: 200,
        body: { folders: [
          { _id: 'folder-other', name: 'Onboarding' },
          { _id: 'folder-root', name: ONBOARDING_ROOMFILES.root },
        ], total: 2 },
      };
    });

    await expect(ensureOnboardingRoomfiles({ rest }, 'room-1')).resolves.toEqual({
      rootId: 'folder-root',
      documentsId: 'folder-documents',
      templatesId: 'folder-templates',
    });
    expect(rest.mock.calls.every(([request]) => request.method === 'GET')).toBe(true);
  });

  it('creates only missing folders with the required parent ids', async () => {
    const folders: FolderRow[] = [];
    let nextId = 1;
    const rest = vi.fn(async (request: {
      method: string;
      query?: Record<string, unknown>;
      body?: Record<string, unknown>;
    }) => {
      if (request.method === 'GET') {
        const fatherId = request.query?.fatherId;
        const visible = fatherId
          ? folders.filter((folder) => folder.father === fatherId)
          : folders.filter((folder) => !folder.father);
        return { statusCode: 200, body: { folders: visible, total: visible.length } };
      }
      const folder: FolderRow = {
        _id: `folder-${nextId++}`,
        name: String(request.body?.name),
        ...(request.body?.fatherId ? { father: String(request.body.fatherId) } : {}),
      };
      folders.push(folder);
      return { statusCode: 200, body: { folder } };
    });

    const result = await ensureOnboardingRoomfiles({ rest }, 'room-create');

    expect(result).toEqual({
      rootId: 'folder-1',
      documentsId: 'folder-2',
      templatesId: 'folder-3',
    });
    expect(rest.mock.calls.filter(([request]) => request.method === 'POST').map(([request]) => request.body)).toEqual([
      { name: ONBOARDING_ROOMFILES.root, channelId: 'room-create' },
      { name: ONBOARDING_ROOMFILES.documents, channelId: 'room-create', fatherId: 'folder-1' },
      { name: ONBOARDING_ROOMFILES.templates, channelId: 'room-create', fatherId: 'folder-1' },
    ]);
  });

  it('recovers from a concurrent duplicate-folder creation by listing again', async () => {
    let rootVisible = false;
    const rest = vi.fn(async (request: {
      method: string;
      query?: Record<string, unknown>;
      body?: Record<string, unknown>;
    }) => {
      if (request.method === 'POST' && request.body?.name === ONBOARDING_ROOMFILES.root) {
        rootVisible = true;
        return { statusCode: 409, body: { error: 'Folder already exists' } };
      }
      if (request.method === 'POST') {
        const id = request.body?.name === ONBOARDING_ROOMFILES.documents ? 'documents-id' : 'templates-id';
        return { statusCode: 200, body: { folder: { _id: id, name: request.body?.name } } };
      }
      if (request.query?.fatherId === 'concurrent-root') {
        return { statusCode: 200, body: { folders: [], total: 0 } };
      }
      return {
        statusCode: 200,
        body: { folders: rootVisible ? [{ _id: 'concurrent-root', name: ONBOARDING_ROOMFILES.root }] : [], total: rootVisible ? 1 : 0 },
      };
    });

    await expect(ensureOnboardingRoomfiles({ rest }, 'room-race')).resolves.toEqual({
      rootId: 'concurrent-root',
      documentsId: 'documents-id',
      templatesId: 'templates-id',
    });
  });

  it('uses canonical Roomfiles metadata when keep_both renames an uploaded source', () => {
    expect(normalizeUploadedRoomFile({
      file: {
        _id: 'file-1',
        name: 'employee-guide (2).docx',
        file_size: 42,
        file_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    }, {
      fileName: 'employee-guide.docx',
      mimeType: 'application/octet-stream',
      size: 40,
    })).toEqual({
      fileId: 'file-1',
      fileName: 'employee-guide (2).docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 42,
    });
  });

  it('prefers a MIME-shaped type when file_type is only an extension', () => {
    expect(normalizeUploadedRoomFile({
      file: {
        _id: 'file-mime',
        name: 'guide.docx',
        file_size: 42,
        file_type: 'docx',
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    }, {
      fileName: 'guide.docx',
      mimeType: 'application/octet-stream',
      size: 42,
    }).mimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });

  it('builds a deterministic UTF-8 JSON artifact for a published template', () => {
    const artifact = templateJsonArtifact({
      id: 'ai-template/room:01',
      version: 3,
      title: 'Hội nhập Kỹ sư / Backend',
      status: 'draft',
      modules: [{ title: 'Giới thiệu' }],
    });

    expect(artifact.fileName).toBe('hoi-nhap-ky-su-backend-ai-template-room-01-v3.json');
    expect(artifact.mimeType).toBe('application/json');
    expect(JSON.parse(artifact.content)).toMatchObject({
      id: 'ai-template/room:01',
      version: 3,
      title: 'Hội nhập Kỹ sư / Backend',
      modules: [{ title: 'Giới thiệu' }],
    });
    expect(artifact.content.endsWith('\n')).toBe(true);
  });

  it('retries only the JSON export after publication has already succeeded', async () => {
    const template = { id: 'template-1', version: 1, title: 'Template 1' };
    const publish = vi.fn().mockResolvedValue(template);
    const exportTemplate = vi.fn()
      .mockRejectedValueOnce(new Error('Roomfiles unavailable'))
      .mockResolvedValueOnce(undefined);
    let pending: typeof template | undefined;

    try {
      await publishTemplateWithRetryableExport(pending, publish, exportTemplate);
    } catch (error) {
      expect(error).toBeInstanceOf(PublishedTemplateExportError);
      pending = (error as PublishedTemplateExportError<typeof template>).template;
    }

    await expect(publishTemplateWithRetryableExport(pending, publish, exportTemplate)).resolves.toEqual(template);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(exportTemplate).toHaveBeenCalledTimes(2);
  });
});

describe('per-template Roomfiles folders', () => {
  it('keeps readable Vietnamese names while removing unsafe path and control characters', () => {
    expect(safeRoomfilesFolderName('Payroll / Việt Nam')).toBe('Payroll - Việt Nam');
    expect(safeRoomfilesFolderName('  Quy\u0000 trình\t   nhân sự \\ nội bộ  '))
      .toBe('Quy trình nhân sự - nội bộ');
    expect(safeRoomfilesFolderName(' ... /// \\ !!! ')).toBe('template');
    expect([...safeRoomfilesFolderName('Đ'.repeat(120))]).toHaveLength(96);
  });

  it('finds an exact existing child below Created templates without creating it', async () => {
    const rest = vi.fn(async (request: { method: string; query?: Record<string, unknown> }) => {
      const fatherId = request.query?.fatherId;
      const folders = fatherId === 'root-id'
        ? [
            { _id: 'documents-id', name: ONBOARDING_ROOMFILES.documents, father: 'root-id' },
            { _id: 'templates-id', name: ONBOARDING_ROOMFILES.templates, father: 'root-id' },
          ]
        : fatherId === 'templates-id'
          ? [{ _id: 'template-folder-id', name: 'Payroll - Việt Nam', father: 'templates-id' }]
          : [{ _id: 'root-id', name: ONBOARDING_ROOMFILES.root }];
      return { statusCode: 200, body: { folders, total: folders.length } };
    });

    await expect(ensureTemplateRoomfilesFolder(
      { rest },
      'room-template-existing',
      'Payroll / Việt Nam',
    )).resolves.toEqual({
      rootId: 'root-id',
      documentsId: 'documents-id',
      templatesId: 'templates-id',
      templateFolderId: 'template-folder-id',
    });
    expect(rest.mock.calls.every(([request]) => request.method === 'GET')).toBe(true);
  });

  it('creates the template child with templatesId as father and reuses it on retry', async () => {
    const folders: FolderRow[] = [
      { _id: 'root-id', name: ONBOARDING_ROOMFILES.root },
      { _id: 'documents-id', name: ONBOARDING_ROOMFILES.documents, father: 'root-id' },
      { _id: 'templates-id', name: ONBOARDING_ROOMFILES.templates, father: 'root-id' },
    ];
    const rest = vi.fn(async (request: {
      method: string;
      query?: Record<string, unknown>;
      body?: Record<string, unknown>;
    }) => {
      if (request.method === 'GET') {
        const fatherId = request.query?.fatherId;
        const visible = fatherId
          ? folders.filter((folder) => folder.father === fatherId)
          : folders.filter((folder) => !folder.father);
        return { statusCode: 200, body: { folders: visible, total: visible.length } };
      }
      const folder = {
        _id: 'created-template-folder',
        name: String(request.body?.name),
        father: String(request.body?.fatherId),
      };
      folders.push(folder);
      return { statusCode: 200, body: { folder } };
    });
    const app = { rest };

    const first = await ensureTemplateRoomfilesFolder(app, 'room-template-create', 'Đào tạo / Sales');
    const second = await ensureTemplateRoomfilesFolder(app, 'room-template-create', 'Đào tạo / Sales');

    expect(first.templateFolderId).toBe('created-template-folder');
    expect(second.templateFolderId).toBe('created-template-folder');
    expect(rest.mock.calls.filter(([request]) => request.method === 'POST').map(([request]) => request.body)).toEqual([
      { name: 'Đào tạo - Sales', channelId: 'room-template-create', fatherId: 'templates-id' },
    ]);
    expect(first.documentsId).toBe('documents-id');
    expect(first.templatesId).toBe('templates-id');
    expect(ONBOARDING_ROOMFILES).toEqual({
      root: 'Onboarding-app',
      documents: 'Uploaded documents',
      templates: 'Created templates',
    });
  });

  it('recovers the template child when another request wins the create race', async () => {
    let childVisible = false;
    const rest = vi.fn(async (request: {
      method: string;
      query?: Record<string, unknown>;
      body?: Record<string, unknown>;
    }) => {
      if (request.method === 'POST') {
        childVisible = true;
        return { statusCode: 409, body: { error: 'Folder already exists' } };
      }
      const fatherId = request.query?.fatherId;
      const folders = fatherId === 'root-race'
        ? [
            { _id: 'documents-race', name: ONBOARDING_ROOMFILES.documents, father: 'root-race' },
            { _id: 'templates-race', name: ONBOARDING_ROOMFILES.templates, father: 'root-race' },
          ]
        : fatherId === 'templates-race'
          ? childVisible ? [{ _id: 'winner-id', name: 'Template race', father: 'templates-race' }] : []
          : [{ _id: 'root-race', name: ONBOARDING_ROOMFILES.root }];
      return { statusCode: 200, body: { folders, total: folders.length } };
    });

    await expect(ensureTemplateRoomfilesFolder(
      { rest },
      'room-template-race',
      'Template race',
    )).resolves.toMatchObject({ templateFolderId: 'winner-id' });
  });
});