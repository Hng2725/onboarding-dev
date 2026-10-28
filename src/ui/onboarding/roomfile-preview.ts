import type { McpApp } from '@privos_ai/app-react';

import type { TemplateResource } from '../../onboarding/contracts';

export interface RoomFileMetadata {
  readonly _id: string;
  readonly name: string;
  readonly channel_id: string;
  readonly mimeType?: string;
}

export interface RoomfilePreview {
  readonly fileName: string;
  readonly mimeType: string;
  readonly blobUrl: string;
  readonly revoke: () => void;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonBlankString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
}

export function roomFileMetadata(
  response: unknown,
  expectedFileId: string,
  expectedRoomId: string,
): RoomFileMetadata {
  const envelope = objectValue(response);
  if (!envelope) throw new Error('PrivOS trả về metadata file không hợp lệ.');
  if (typeof envelope.statusCode === 'number' && envelope.statusCode >= 400) {
    throw new Error(`Không thể đọc file (${envelope.statusCode}).`);
  }

  const body = Object.prototype.hasOwnProperty.call(envelope, 'body')
    ? objectValue(envelope.body)
    : envelope;
  const payload = body && Object.prototype.hasOwnProperty.call(body, 'result')
    ? objectValue(body.result)
    : body;
  const file = payload && Object.prototype.hasOwnProperty.call(payload, 'file')
    ? objectValue(payload.file)
    : payload;

  if (!file || typeof file._id !== 'string' || file._id !== expectedFileId || typeof file.name !== 'string') {
    throw new Error('PrivOS trả về metadata file không hợp lệ.');
  }
  const channelId = nonBlankString(file.channel_id, file.channelId);
  if (channelId !== expectedRoomId) {
    throw new Error('File không thuộc room onboarding hiện tại.');
  }

  const mimeType = nonBlankString(file.mimeType, file.mimetype, file.contentType, file.file_type);
  return {
    _id: file._id,
    name: file.name,
    channel_id: channelId,
    ...(mimeType ? { mimeType } : {}),
  };
}

export function fileDownloadBlob(response: unknown): Blob {
  if (response instanceof Blob) return response;
  const envelope = objectValue(response);
  if (!envelope) throw new Error('PrivOS trả về dữ liệu file không hợp lệ.');
  if (typeof envelope.statusCode === 'number' && envelope.statusCode >= 400) {
    throw new Error(`Không thể tải file (${envelope.statusCode}).`);
  }
  if (envelope.body instanceof Blob) return envelope.body;

  const body = Object.prototype.hasOwnProperty.call(envelope, 'body')
    ? objectValue(envelope.body)
    : envelope;
  const payload = body && Object.prototype.hasOwnProperty.call(body, 'result')
    ? objectValue(body.result)
    : body;
  if (!payload || typeof payload.dataBase64 !== 'string') {
    throw new Error('PrivOS trả về dữ liệu file không hợp lệ.');
  }

  try {
    const binary = atob(payload.dataBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], {
      type: nonBlankString(payload.mimeType, payload.mimetype, payload.contentType) ?? 'application/octet-stream',
    });
  } catch {
    throw new Error('PrivOS trả về dữ liệu file không hợp lệ.');
  }
}

function isPdfFile(fileName: string, mimeType: string): boolean {
  const normalizedMime = mimeType.toLowerCase().split(';', 1)[0]?.trim() ?? '';
  if (normalizedMime === 'application/pdf') return true;
  if (normalizedMime && normalizedMime !== 'application/octet-stream') return false;
  return fileName.toLowerCase().endsWith('.pdf');
}

export function roomfilePreviewMode(
  resource: Pick<TemplateResource, 'kind'>,
  fileName: string,
  mimeType: string,
): 'embedded_pdf' | 'download' {
  return resource.kind === 'file' && isPdfFile(fileName, mimeType) ? 'embedded_pdf' : 'download';
}

function normalizeBlobType(blob: Blob, fallbackMimeType?: string): Blob {
  if (blob.type && blob.type !== 'application/octet-stream') return blob;
  const mimeType = fallbackMimeType ?? blob.type ?? 'application/octet-stream';
  return mimeType === blob.type ? blob : new Blob([blob], { type: mimeType });
}

export async function loadRoomfilePreview(
  app: Pick<McpApp, 'rest'>,
  roomId: string,
  resource: Pick<TemplateResource, 'fileId'>,
): Promise<RoomfilePreview> {
  if (!roomId.trim()) throw new Error('Không xác định được room hiện tại.');
  if (!resource.fileId?.trim()) throw new Error('Tài liệu chưa có file trong Roomfiles.');

  const fileId = resource.fileId.trim();
  const metadataResponse = await app.rest({
    method: 'GET',
    path: `file-management.files/${encodeURIComponent(fileId)}`,
  });
  const metadata = roomFileMetadata(metadataResponse, fileId, roomId);
  const downloadResponse = await app.rest({
    method: 'GET',
    path: `file-management.files/${encodeURIComponent(fileId)}/download`,
    responseType: 'blob',
  } as Parameters<McpApp['rest']>[0] & { responseType: 'blob' });
  const blob = normalizeBlobType(fileDownloadBlob(downloadResponse), metadata.mimeType);
  const blobUrl = URL.createObjectURL(blob);
  let revoked = false;

  return {
    fileName: metadata.name,
    mimeType: blob.type || metadata.mimeType || 'application/octet-stream',
    blobUrl,
    revoke() {
      if (revoked) return;
      revoked = true;
      URL.revokeObjectURL(blobUrl);
    },
  };
}
