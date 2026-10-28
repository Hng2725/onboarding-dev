import type { McpApp } from '@privos_ai/app-react';

export const ONBOARDING_ROOMFILES = {
  root: 'Onboarding-app',
  documents: 'Uploaded documents',
  templates: 'Created templates',
} as const;

export interface OnboardingRoomfileFolders {
  readonly rootId: string;
  readonly documentsId: string;
  readonly templatesId: string;
}

export interface UploadedRoomFile {
  readonly fileId: string;
  readonly fileName: string;
  readonly mimeType?: string;
  readonly size?: number;
}

export class PublishedTemplateExportError<T> extends Error {
  readonly cause: unknown;

  constructor(readonly template: T, cause: unknown) {
    super(cause instanceof Error && cause.message ? cause.message : 'Could not save the published template to Roomfiles.');
    this.name = 'PublishedTemplateExportError';
    this.cause = cause;
  }
}

interface UploadFallback {
  readonly fileName: string;
  readonly mimeType?: string;
  readonly size?: number;
}

type RoomfilesClient = Pick<McpApp, 'rest'>;
type JsonRecord = Record<string, unknown>;

const folderPromises = new WeakMap<object, Map<string, Promise<OnboardingRoomfileFolders>>>();

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function nonEmptyString(...values: readonly unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === 'string' && Boolean(value.trim()),
  )?.trim();
}

function finiteNumber(...values: readonly unknown[]): number | undefined {
  return values.find(
    (value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0,
  );
}

function folderId(value: unknown): string | undefined {
  const folder = record(value);
  return nonEmptyString(folder._id, folder.id, folder.folderId);
}

function folderParentId(value: unknown): string | undefined {
  const folder = record(value);
  const father = record(folder.father);
  return nonEmptyString(folder.fatherId, typeof folder.father === 'string' ? folder.father : undefined, father._id, father.id);
}

function success(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300;
}

function normalizeRestResponse(response: unknown): { readonly statusCode: number; readonly body: unknown } {
  const envelope = record(response);
  return {
    statusCode: typeof envelope.statusCode === 'number'
      ? envelope.statusCode
      : envelope.success === false ? 400 : 200,
    body: Object.prototype.hasOwnProperty.call(envelope, 'body') ? envelope.body : response,
  };
}

function responseMessage(body: unknown): string {
  const value = record(body);
  return nonEmptyString(value.error, value.message) ?? 'Roomfiles request failed.';
}

async function listFolders(
  app: RoomfilesClient,
  roomId: string,
  parentId?: string,
): Promise<readonly JsonRecord[]> {
  const pageSize = 100;
  const folders: JsonRecord[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const response = normalizeRestResponse(await app.rest({
      method: 'GET',
      path: `file-management.folders.channel/${encodeURIComponent(roomId)}`,
      query: {
        ...(parentId ? { fatherId: parentId } : {}),
        count: pageSize,
        offset,
      },
    }));
    if (!success(response.statusCode)) {
      throw new Error(responseMessage(response.body));
    }
    const body = record(response.body);
    const page = Array.isArray(body.folders) ? body.folders.map(record) : [];
    folders.push(...page);
    const total = finiteNumber(body.total);
    if (page.length < pageSize || (total !== undefined && folders.length >= total)) break;
  }
  return folders;
}

function findExactFolder(
  folders: readonly JsonRecord[],
  name: string,
  parentId?: string,
): string | undefined {
  const match = folders.find((folder) => {
    if (folder.name !== name) return false;
    const actualParent = folderParentId(folder);
    return parentId ? actualParent === undefined || actualParent === parentId : actualParent === undefined;
  });
  return folderId(match);
}

async function ensureFolder(
  app: RoomfilesClient,
  roomId: string,
  name: string,
  parentId?: string,
): Promise<string> {
  const existing = findExactFolder(await listFolders(app, roomId, parentId), name, parentId);
  if (existing) return existing;

  const response = normalizeRestResponse(await app.rest({
    method: 'POST',
    path: 'file-management.folders.create',
    body: {
      name,
      channelId: roomId,
      ...(parentId ? { fatherId: parentId } : {}),
    },
  }));
  if (success(response.statusCode)) {
    const body = record(response.body);
    const createdId = folderId(body.folder) ?? folderId(body);
    if (createdId) return createdId;
  }

  // Another mounted app may have created the same folder between our list and create calls.
  const concurrent = findExactFolder(await listFolders(app, roomId, parentId), name, parentId);
  if (concurrent) return concurrent;
  throw new Error(responseMessage(response.body));
}

async function ensureOnboardingRoomfilesUncached(
  app: RoomfilesClient,
  roomId: string,
): Promise<OnboardingRoomfileFolders> {
  const rootId = await ensureFolder(app, roomId, ONBOARDING_ROOMFILES.root);
  const documentsId = await ensureFolder(app, roomId, ONBOARDING_ROOMFILES.documents, rootId);
  const templatesId = await ensureFolder(app, roomId, ONBOARDING_ROOMFILES.templates, rootId);
  return { rootId, documentsId, templatesId };
}

export function ensureOnboardingRoomfiles(
  app: RoomfilesClient,
  roomId: string,
): Promise<OnboardingRoomfileFolders> {
  const normalizedRoomId = roomId.trim();
  if (!normalizedRoomId) return Promise.reject(new Error('Room id is required to prepare Roomfiles.'));

  let rooms = folderPromises.get(app);
  if (!rooms) {
    rooms = new Map();
    folderPromises.set(app, rooms);
  }
  const existing = rooms.get(normalizedRoomId);
  if (existing) return existing;

  const pending = ensureOnboardingRoomfilesUncached(app, normalizedRoomId).catch((error) => {
    rooms?.delete(normalizedRoomId);
    throw error;
  });
  rooms.set(normalizedRoomId, pending);
  return pending;
}

export function safeRoomfilesFolderName(title: string): string {
  const readable = title
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ')
    .replace(/[\\/]+/gu, ' - ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!/[\p{L}\p{N}]/u.test(readable)) return 'template';
  const capped = [...readable].slice(0, 96).join('').trim();
  return /[\p{L}\p{N}]/u.test(capped) ? capped : 'template';
}

export async function ensureTemplateRoomfilesFolder(
  app: RoomfilesClient,
  roomId: string,
  templateTitle: string,
): Promise<OnboardingRoomfileFolders & { readonly templateFolderId: string }> {
  const folders = await ensureOnboardingRoomfiles(app, roomId);
  const templateFolderId = await ensureFolder(
    app,
    roomId.trim(),
    safeRoomfilesFolderName(templateTitle),
    folders.templatesId,
  );
  return { ...folders, templateFolderId };
}

export function normalizeUploadedRoomFile(
  value: unknown,
  fallback: UploadFallback,
): UploadedRoomFile {
  const envelope = record(value);
  const file = Object.keys(record(envelope.file)).length > 0 ? record(envelope.file) : envelope;
  const fileId = nonEmptyString(file.fileId, file._id, file.id);
  if (!fileId) throw new Error('Roomfiles did not return an uploaded file id.');
  const mimeType = [file.mimeType, file.mimetype, file.type, file.file_type, fallback.mimeType]
    .find((candidate): candidate is string => typeof candidate === 'string' && candidate.includes('/'))
    ?.trim();
  const size = finiteNumber(file.size, file.fileSize, file.file_size, file.bytes, fallback.size);
  return {
    fileId,
    fileName: nonEmptyString(file.fileName, file.name, file.title) ?? fallback.fileName,
    ...(mimeType ? { mimeType } : {}),
    ...(size === undefined ? {} : { size }),
  };
}

export async function publishTemplateWithRetryableExport<T>(
  publishedTemplate: T | undefined,
  publish: () => Promise<T>,
  exportTemplate: (template: T) => Promise<void>,
): Promise<T> {
  const template = publishedTemplate ?? await publish();
  try {
    await exportTemplate(template);
  } catch (error) {
    throw new PublishedTemplateExportError(template, error);
  }
  return template;
}

function slug(value: string, fallback: string, maxLength: number): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return normalized || fallback;
}

export function templateJsonArtifact<T extends { readonly id: string; readonly version: number; readonly title: string }>(
  template: T,
): { readonly fileName: string; readonly mimeType: 'application/json'; readonly content: string } {
  const title = slug(template.title, 'template', 80);
  const id = slug(template.id, 'id', 48);
  const internal = new Set(['publication', 'moduleApproval', 'lessonProvenance', 'approvedLessonVersion',
    'approvedQuestionVersion', 'questionLessonVersion', 'moduleLocalId', 'featureIds', 'sourceSectionIds',
    'responsibilityIndexes', 'jobId', 'operationId', 'promptVersion', 'generationNotes', 'flags']);
  return {
    fileName: `${title}-${id}-v${template.version}.json`,
    mimeType: 'application/json',
    content: `${JSON.stringify(template, (key, value: unknown) => internal.has(key) ? undefined : value, 2)}\n`,
  };
}
