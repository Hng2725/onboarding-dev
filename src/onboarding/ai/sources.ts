import { createHash } from 'node:crypto';

import type { OnboardingActor } from '../auth';
import type { SourceRecord, SourceSection } from '../contracts';
import type { OnboardingStore, StoreRecord } from '../store';
import {
  SourceExtractionError,
  extractSourceDocument,
  type ExtractSourceDocumentInput,
  type ExtractedSourceDocument,
  type SourceExtractionErrorCode,
} from './extract';
import { AI_GENERATION_LIMITS } from './limits';

export type SourceServiceErrorCode =
  | SourceExtractionErrorCode
  | 'ADMIN_REQUIRED'
  | 'SOURCE_LIMIT'
  | 'SOURCE_DUPLICATE'
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_FILE_MISMATCH';

export class SourceServiceError extends Error {
  readonly code: SourceServiceErrorCode;

  constructor(code: SourceServiceErrorCode, message: string) {
    super(message);
    this.name = 'SourceServiceError';
    this.code = code;
  }
}

export interface SourceSummary {
  readonly id: string;
  readonly roomId: string;
  readonly sourceId: string;
  readonly kind: 'document' | 'admin_note';
  readonly fileId?: string;
  readonly fileName: string;
  readonly mimeType?: string;
  readonly checksum: string;
  readonly systemName: string;
  readonly softwareVersion?: string;
  readonly effectiveDate?: string;
  readonly status: 'ready' | 'failed';
  readonly errorCode?: string;
  readonly textLength?: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt?: string;
}

export interface SourceFileMetadata {
  readonly fileId: string;
  readonly fileName: string;
  readonly mimeType?: string;
  readonly size: number;
}

export interface IngestSourceInput {
  readonly operationId: string;
  readonly fileName: string;
  readonly mimeType?: string;
  readonly base64: string;
  readonly fileId?: string;
  readonly systemName: string;
  readonly softwareVersion?: string;
  readonly effectiveDate?: string;
}

export interface AddAdminNoteInput {
  readonly operationId: string;
  readonly title: string;
  readonly text: string;
}

export interface SourceSectionResult {
  readonly fileName: string;
  readonly section: SourceSection;
}

export interface SourceService {
  listSources(actor: OnboardingActor): Promise<readonly SourceSummary[]>;
  ingestSource(actor: OnboardingActor, input: IngestSourceInput): Promise<SourceSummary>;
  addAdminNote(actor: OnboardingActor, input: AddAdminNoteInput): Promise<SourceSummary>;
  deleteSource(actor: OnboardingActor, sourceId: string): Promise<void>;
  getSourceSection(
    actor: OnboardingActor,
    sourceId: string,
    sectionId: string,
  ): Promise<SourceSectionResult>;
}

interface SourceDbData extends StoreRecord {
  readonly sourceId: string;
  readonly kind: 'document' | 'admin_note';
  readonly fileId?: string;
  readonly fileName: string;
  readonly mimeType?: string;
  readonly checksum: string;
  readonly systemName: string;
  readonly softwareVersion?: string;
  readonly effectiveDate?: string;
  readonly status: 'ready' | 'failed';
  readonly errorCode?: string;
  readonly sections?: readonly SourceSection[];
  readonly textLength?: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt?: string;
}

interface SourceDbRecord extends SourceDbData {
  readonly id: string;
}

export interface SourceServiceOptions {
  readonly now?: () => string;
  readonly readFileMetadata?: (
    roomId: string,
    fileId: string,
  ) => Promise<SourceFileMetadata | null>;
  readonly extract?: (
    input: ExtractSourceDocumentInput,
  ) => Promise<ExtractedSourceDocument>;
}

function requireAdmin(actor: OnboardingActor): void {
  if (actor.access !== 'admin') {
    throw new SourceServiceError('ADMIN_REQUIRED', 'Admin access is required.');
  }
}

function requiredText(value: string, label: string, maxLength = 250): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || normalized.includes('\u0000')) {
    throw new SourceServiceError('SOURCE_PARSE_FAILED', label + ' is invalid.');
  }
  return normalized;
}

function optionalText(value: string | undefined, maxLength = 250): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length > maxLength || normalized.includes('\u0000')) {
    throw new SourceServiceError('SOURCE_PARSE_FAILED', 'Source metadata is invalid.');
  }
  return normalized;
}

function decodeBase64(value: string): Uint8Array {
  const encoded = value.trim();
  const encodedLimit = Math.ceil(AI_GENERATION_LIMITS.maxSourceFileBytes / 3) * 4;
  if (encoded.length > encodedLimit + 4) {
    throw new SourceServiceError('SOURCE_TOO_LARGE', 'The source file exceeds the 2 MiB limit.');
  }
  if (
    !encoded
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw new SourceServiceError('SOURCE_PARSE_FAILED', 'The source payload is not valid base64.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) {
    throw new SourceServiceError('SOURCE_PARSE_FAILED', 'The source payload is not canonical base64.');
  }
  if (bytes.byteLength > AI_GENERATION_LIMITS.maxSourceFileBytes) {
    throw new SourceServiceError('SOURCE_TOO_LARGE', 'The source file exceeds the 2 MiB limit.');
  }
  return new Uint8Array(bytes);
}

function checksumOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sourceIdFor(roomId: string, operationId: string): string {
  const digest = createHash('sha256')
    .update(roomId)
    .update('\u0000')
    .update(operationId)
    .digest('hex');
  return 'source-' + digest.slice(0, 24);
}

function asSource(row: SourceDbRecord, roomId: string): SourceRecord {
  return {
    id: row.id,
    roomId,
    sourceId: row.sourceId,
    kind: row.kind,
    ...(row.fileId ? { fileId: row.fileId } : {}),
    fileName: row.fileName,
    ...(row.mimeType ? { mimeType: row.mimeType } : {}),
    checksum: row.checksum,
    systemName: row.systemName,
    ...(row.softwareVersion ? { softwareVersion: row.softwareVersion } : {}),
    ...(row.effectiveDate ? { effectiveDate: row.effectiveDate } : {}),
    status: row.status,
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    ...(row.sections ? { sections: row.sections } : {}),
    ...(row.textLength === undefined ? {} : { textLength: row.textLength }),
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.deletedAt ? { deletedAt: row.deletedAt } : {}),
  };
}

function asSummary(source: SourceRecord): SourceSummary {
  return {
    id: source.id,
    roomId: source.roomId,
    sourceId: source.sourceId,
    kind: source.kind,
    ...(source.fileId ? { fileId: source.fileId } : {}),
    fileName: source.fileName,
    ...(source.mimeType ? { mimeType: source.mimeType } : {}),
    checksum: source.checksum,
    systemName: source.systemName,
    ...(source.softwareVersion ? { softwareVersion: source.softwareVersion } : {}),
    ...(source.effectiveDate ? { effectiveDate: source.effectiveDate } : {}),
    status: source.status,
    ...(source.errorCode ? { errorCode: source.errorCode } : {}),
    ...(source.textLength === undefined ? {} : { textLength: source.textLength }),
    createdBy: source.createdBy,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    ...(source.deletedAt ? { deletedAt: source.deletedAt } : {}),
  };
}

function isDuplicateDatabaseError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  return record.code === 11000 || [record.message, record.error, String(error)]
    .some((value) => typeof value === 'string' && /E11000|duplicate key|unique index/i.test(value));
}

function sameMime(left?: string, right?: string): boolean {
  if (!left || !right) return true;
  return left.split(';')[0].trim().toLowerCase() === right.split(';')[0].trim().toLowerCase();
}

export function createSourceService(
  store: OnboardingStore,
  options: SourceServiceOptions = {},
): SourceService {
  const now = options.now ?? (() => new Date().toISOString());
  const extract = options.extract ?? extractSourceDocument;

  async function sourceRows(roomId: string): Promise<readonly SourceDbRecord[]> {
    const rows: SourceDbRecord[] = [];
    let cursor: string | undefined;
    do {
      const result = await store.query<SourceDbRecord>(roomId, 'onboarding_sources', {
        orderBy: [{ field: 'createdAt', direction: 'desc' }],
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      rows.push(...result.records);
      cursor = result.nextCursor;
    } while (cursor);
    return rows;
  }

  async function findBySourceId(roomId: string, sourceId: string): Promise<SourceDbRecord | undefined> {
    const result = await store.query<SourceDbRecord>(roomId, 'onboarding_sources', {
      filter: { sourceId },
      limit: 1,
    });
    return result.records[0];
  }

  async function findByChecksum(roomId: string, checksum: string): Promise<SourceDbRecord | undefined> {
    const result = await store.query<SourceDbRecord>(roomId, 'onboarding_sources', {
      filter: { checksum },
      limit: 1,
    });
    return result.records[0];
  }

  async function ensureCapacity(roomId: string): Promise<void> {
    if (await store.count(roomId, 'onboarding_sources') >= AI_GENERATION_LIMITS.maxSourcesPerRoom) {
      throw new SourceServiceError(
        'SOURCE_LIMIT',
        'This room already has the maximum number of active onboarding sources.',
      );
    }
  }

  async function persist(
    actor: OnboardingActor,
    operationId: string,
    data: SourceDbData,
  ): Promise<SourceSummary> {
    try {
      const row = await store.create<SourceDbRecord>(
        actor.roomId,
        'onboarding_sources',
        data,
        operationId,
      );
      return asSummary(asSource(row, actor.roomId));
    } catch (error) {
      if (!isDuplicateDatabaseError(error)) throw error;
      const replay = await findBySourceId(actor.roomId, data.sourceId);
      if (replay && replay.checksum === data.checksum && replay.kind === data.kind) {
        return asSummary(asSource(replay, actor.roomId));
      }
      throw new SourceServiceError('SOURCE_DUPLICATE', 'This source has already been added.');
    }
  }

  function mapExtractionError(error: unknown): never {
    if (error instanceof SourceExtractionError) {
      throw new SourceServiceError(error.code, error.message);
    }
    throw error;
  }

  return {
    async listSources(actor) {
      requireAdmin(actor);
      return (await sourceRows(actor.roomId)).map((row) => asSummary(asSource(row, actor.roomId)));
    },

    async ingestSource(actor, input) {
      requireAdmin(actor);
      const operationId = requiredText(input.operationId, 'Operation ID');
      const fileName = requiredText(input.fileName, 'File name');
      const mimeType = optionalText(input.mimeType);
      const systemName = requiredText(input.systemName, 'System name');
      const softwareVersion = optionalText(input.softwareVersion);
      const effectiveDate = optionalText(input.effectiveDate);
      const fileId = optionalText(input.fileId);
      const sourceId = sourceIdFor(actor.roomId, operationId);
      const bytes = decodeBase64(input.base64);
      const checksum = checksumOf(bytes);

      const replay = await findBySourceId(actor.roomId, sourceId);
      if (replay) {
        if (replay.checksum === checksum && replay.kind === 'document') {
          return asSummary(asSource(replay, actor.roomId));
        }
        throw new SourceServiceError(
          'SOURCE_DUPLICATE',
          'The operation ID is already bound to a different source.',
        );
      }

      if (fileId) {
        if (options.readFileMetadata) {
          const metadata = await options.readFileMetadata(actor.roomId, fileId);
          if (
            !metadata
            || metadata.fileId !== fileId
            || metadata.fileName !== fileName
            || metadata.size !== bytes.byteLength
            || !sameMime(metadata.mimeType, mimeType)
          ) {
            throw new SourceServiceError(
              'SOURCE_FILE_MISMATCH',
              'The uploaded room file metadata does not match the source payload.',
            );
          }
        }
      }

      if (await findByChecksum(actor.roomId, checksum)) {
        throw new SourceServiceError('SOURCE_DUPLICATE', 'This source has already been added.');
      }
      await ensureCapacity(actor.roomId);

      let extracted: ExtractedSourceDocument;
      try {
        extracted = await extract({ sourceId, fileName, mimeType, bytes });
      } catch (error) {
        return mapExtractionError(error);
      }
      const timestamp = now();
      return persist(actor, operationId, {
        sourceId,
        kind: 'document',
        ...(fileId ? { fileId } : {}),
        fileName,
        ...(mimeType ? { mimeType } : {}),
        checksum,
        systemName,
        ...(softwareVersion ? { softwareVersion } : {}),
        ...(effectiveDate ? { effectiveDate } : {}),
        status: 'ready',
        sections: extracted.sections,
        textLength: extracted.textLength,
        createdBy: actor.userId,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    },

    async addAdminNote(actor, input) {
      requireAdmin(actor);
      const operationId = requiredText(input.operationId, 'Operation ID');
      const title = requiredText(input.title, 'Note title');
      const text = requiredText(input.text, 'Note text', AI_GENERATION_LIMITS.maxNormalizedTextBytes);
      const bytes = new TextEncoder().encode(text);
      if (bytes.byteLength > AI_GENERATION_LIMITS.maxNormalizedTextBytes) {
        throw new SourceServiceError('SOURCE_TOO_LARGE', 'The admin note is too large.');
      }
      const checksum = checksumOf(bytes);
      const sourceId = sourceIdFor(actor.roomId, operationId);
      const replay = await findBySourceId(actor.roomId, sourceId);
      if (replay) {
        if (replay.checksum === checksum && replay.kind === 'admin_note') {
          return asSummary(asSource(replay, actor.roomId));
        }
        throw new SourceServiceError(
          'SOURCE_DUPLICATE',
          'The operation ID is already bound to a different source.',
        );
      }
      if (await findByChecksum(actor.roomId, checksum)) {
        throw new SourceServiceError('SOURCE_DUPLICATE', 'This source has already been added.');
      }
      await ensureCapacity(actor.roomId);

      let extracted: ExtractedSourceDocument;
      try {
        extracted = await extract({
          sourceId,
          fileName: title + '.md',
          mimeType: 'text/markdown',
          bytes,
        });
      } catch (error) {
        return mapExtractionError(error);
      }
      const timestamp = now();
      return persist(actor, operationId, {
        sourceId,
        kind: 'admin_note',
        fileName: title,
        mimeType: 'text/markdown',
        checksum,
        systemName: title,
        status: 'ready',
        sections: extracted.sections,
        textLength: extracted.textLength,
        createdBy: actor.userId,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    },

    async deleteSource(actor, rawSourceId) {
      requireAdmin(actor);
      const sourceId = requiredText(rawSourceId, 'Source ID');
      const row = await findBySourceId(actor.roomId, sourceId);
      if (!row) throw new SourceServiceError('SOURCE_NOT_FOUND', 'The source was not found.');
      await store.softDelete(actor.roomId, 'onboarding_sources', row.id);
    },

    async getSourceSection(actor, rawSourceId, rawSectionId) {
      requireAdmin(actor);
      const sourceId = requiredText(rawSourceId, 'Source ID');
      const sectionId = requiredText(rawSectionId, 'Section ID');
      const row = await findBySourceId(actor.roomId, sourceId);
      const section = row?.sections?.find((candidate) => candidate.id === sectionId);
      if (!row || !section) {
        throw new SourceServiceError('SOURCE_NOT_FOUND', 'The source section was not found.');
      }
      return { fileName: row.fileName, section };
    },
  };
}
