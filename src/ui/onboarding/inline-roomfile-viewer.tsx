import { DownloadOutlined, FilePdfOutlined, ReloadOutlined } from '@ant-design/icons';
import { useEffect, useRef, useState } from 'react';
import { usePrivosApp } from '@privos_ai/app-react';

import type { TemplateResource } from '../../onboarding/contracts';
import {
  loadRoomfilePreview,
  roomfilePreviewMode,
  type RoomfilePreview,
} from './roomfile-preview';

export function InlineRoomfileContent({
  preview,
  resource,
}: {
  preview: RoomfilePreview;
  resource: Pick<TemplateResource, 'title' | 'kind'>;
}) {
  if (roomfilePreviewMode(resource, preview.fileName, preview.mimeType) === 'embedded_pdf') {
    return (
      <div className="inline-roomfile-pdf">
        <div className="inline-roomfile-heading"><FilePdfOutlined /><strong>{preview.fileName}</strong></div>
        <iframe src={preview.blobUrl} title={`Xem PDF ${resource.title}`} />
      </div>
    );
  }

  return (
    <div className="inline-roomfile-download">
      <DownloadOutlined />
      <h3>{preview.fileName}</h3>
      <p>Định dạng này chưa hỗ trợ xem trực tiếp trong app.</p>
      <a className="button button-primary" href={preview.blobUrl} download={preview.fileName}>Tải xuống</a>
    </div>
  );
}

export function InlineRoomfileViewer({
  resource,
  roomId,
  onOpened,
}: {
  resource: TemplateResource;
  roomId: string;
  onOpened?: () => void;
}) {
  const app = usePrivosApp();
  const [preview, setPreview] = useState<RoomfilePreview | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const onOpenedRef = useRef(onOpened);

  useEffect(() => {
    onOpenedRef.current = onOpened;
  }, [onOpened]);

  useEffect(() => {
    let cancelled = false;
    let loaded: RoomfilePreview | null = null;
    setPreview(null);
    setError(null);

    void loadRoomfilePreview(app, roomId, resource)
      .then((next) => {
        loaded = next;
        if (cancelled) {
          next.revoke();
          return;
        }
        setPreview(next);
        onOpenedRef.current?.();
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught : new Error('Không thể mở tài liệu.'));
        }
      });

    return () => {
      cancelled = true;
      loaded?.revoke();
    };
  }, [app, resource.fileId, resource.id, roomId, retryKey]);

  if (error) {
    return (
      <div className="viewer-error inline-roomfile-state">
        <ReloadOutlined />
        <p>{error.message}</p>
        <button className="button button-secondary" type="button" onClick={() => setRetryKey((value) => value + 1)}>Thử lại</button>
      </div>
    );
  }
  if (!preview) return <div className="inline-roomfile-state">Đang tải tài liệu từ Roomfiles…</div>;
  return <InlineRoomfileContent preview={preview} resource={resource} />;
}
