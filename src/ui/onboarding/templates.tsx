import {
  CheckOutlined,
  CloseOutlined,
  FileAddOutlined,
  PlusOutlined,
  RobotOutlined,
  RocketOutlined,
  SearchOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePrivosApp, usePrivosContext } from '@privos_ai/app-react';

import type { EmployeeType, ResourceKind } from '../../onboarding/contracts';
import type {
  AdminTemplateDetail,
  TemplateDraftInput,
  TemplateModuleInput,
  TemplateQuestionInput,
  TemplateResourceInput,
} from '../../onboarding/templates';
import type { OnboardingApi } from './api';
import {
  ConfirmDialog,
  ErrorState,
  InlineNotice,
  LoadingState,
  type InlineNoticeMessage,
} from './components';
import {
  QuestionEditor,
  TemplateCard,
  TemplateDetailPanel,
  TemplateLibraryToolbar,
  TemplateModalLayer,
  filterTemplates,
  insertQuestionAfter,
  newQuestion,
  preloadTemplateDetails,
  templateDetailCacheKey,
  templateEditorTransition,
  type TemplateDetailCacheEntry,
  type TemplateCatalogView,
  type TemplateDetailAction,
  type TemplateEditorUiState,
  type TemplateStatusFilter,
} from './template-editor-ui';
import { usePolling, type PollReason } from './polling';
import { AiGeneratorPage } from './ai/ai-generator';
import { ensureOnboardingRoomfiles } from './roomfiles';

export {
  QuestionEditor,
  TemplateCard,
  TemplateDetailPanel,
  TemplateLibraryToolbar,
  TemplateModalLayer,
  filterTemplates,
  filterTemplatesByName,
  insertQuestionAfter,
  newQuestion,
  preloadTemplateDetails,
  templateDetailCacheKey,
  templateDetailActions,
  templateDetailActions as templateActions,
  templateEditorTransition,
  updateCorrectOptionIds,
} from './template-editor-ui';

export type TemplateValidationLevel = 'error' | 'suggestion';

export interface TemplateValidationIssue {
  readonly field: string;
  readonly message: string;
  readonly level: TemplateValidationLevel;
}

function moduleValidationMessage(module: TemplateModuleInput, moduleIndex: number, message: string): string {
  const moduleName = module.title.trim() || `Module ${moduleIndex + 1}`;
  return `Module “${moduleName}”: ${message}`;
}

function questionValidationMessage(module: TemplateModuleInput, moduleIndex: number, questionIndex: number, message: string): string {
  const moduleName = module.title.trim() || `Module ${moduleIndex + 1}`;
  return `Module “${moduleName}” · Câu ${questionIndex + 1}: ${message}`;
}

export function validateTemplateDraft(draft: TemplateDraftInput): readonly TemplateValidationIssue[] {
  const issues: TemplateValidationIssue[] = [];
  if (!draft.title.trim()) issues.push({ field: 'title', message: 'Nhập tên template.', level: 'error' });
  if (!Number.isInteger(draft.maxAttempts) || (draft.maxAttempts ?? 0) < 1) {
    issues.push({ field: 'maxAttempts', message: 'Số lượt làm phải từ 1 trở lên.', level: 'error' });
  }
  if (!draft.modules.length) issues.push({ field: 'modules', message: 'Thêm ít nhất một module.', level: 'error' });
  draft.modules.forEach((module, moduleIndex) => {
    if (!module.key.trim()) issues.push({ field: `modules.${moduleIndex}.key`, message: moduleValidationMessage(module, moduleIndex, 'Module cần mã định danh.'), level: 'error' });
    if (!module.title.trim()) issues.push({ field: `modules.${moduleIndex}.title`, message: moduleValidationMessage(module, moduleIndex, 'Module cần tiêu đề.'), level: 'error' });
    if (!module.resources.length) issues.push({ field: `modules.${moduleIndex}.resources`, message: moduleValidationMessage(module, moduleIndex, 'Thêm ít nhất một tài liệu.'), level: 'error' });
    if (!module.questions.length) issues.push({ field: `modules.${moduleIndex}.questions`, message: moduleValidationMessage(module, moduleIndex, 'Nên thêm ít nhất một câu hỏi.'), level: 'suggestion' });
    module.resources.forEach((resource, resourceIndex) => {
      if (!resource.title.trim() || (!resource.fileId && !resource.sourceUrl)) {
        issues.push({ field: `modules.${moduleIndex}.resources.${resourceIndex}`, message: moduleValidationMessage(module, moduleIndex, 'Tài liệu cần tên và file hoặc URL.'), level: 'error' });
      }
    });
    module.questions.forEach((question, questionIndex) => {
      const field = `modules.${moduleIndex}.questions.${questionIndex}`;
      if (!question.prompt.trim()) issues.push({ field, message: questionValidationMessage(module, moduleIndex, questionIndex, 'Nhập nội dung câu hỏi.'), level: 'error' });
      if (question.type === 'essay') return;

      const options = question.options ?? [];
      const optionIds = new Set(options.map((option) => option.id));
      const correctOptionIds = question.correctOptionIds ?? [];
      if (options.length < 2 || options.some((option) => !option.id.trim() || !option.label.trim()) || optionIds.size !== options.length) {
        issues.push({ field: `${field}.options`, message: questionValidationMessage(module, moduleIndex, questionIndex, 'Câu trắc nghiệm cần ít nhất hai đáp án đầy đủ và không trùng mã.'), level: 'error' });
      }
      const correctSelectionInvalid = correctOptionIds.some((id) => !optionIds.has(id))
        || (question.type === 'single_choice' ? correctOptionIds.length !== 1 : correctOptionIds.length < 1);
      if (correctSelectionInvalid) {
        issues.push({ field: `${field}.correctOptionIds`, message: questionValidationMessage(module, moduleIndex, questionIndex, question.type === 'single_choice' ? 'Chọn đúng một đáp án đúng.' : 'Chọn ít nhất một đáp án đúng.'), level: 'error' });
      }
    });
  });
  return issues;
}

export interface UploadedResourceMetadata {
  readonly fileId: string;
  readonly title: string;
  readonly mimeType?: string;
  readonly size?: number;
}

export function normalizeUploadedResource(result: unknown): UploadedResourceMetadata {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('PrivOS không trả về metadata file hợp lệ.');
  const envelope = result as Record<string, unknown>;
  const file = envelope.file && typeof envelope.file === 'object' && !Array.isArray(envelope.file)
    ? envelope.file as Record<string, unknown>
    : envelope;
  const fileId = [file.fileId, file._id, file.id].find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
  const title = [file.name, file.fileName, file.title].find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
  if (!fileId || !title) throw new Error('PrivOS không trả về ID hoặc tên file ổn định.');
  const mimeType = [file.mimeType, file.type].find((value): value is string => typeof value === 'string');
  const size = typeof file.size === 'number' && Number.isFinite(file.size) ? file.size : undefined;
  return { fileId, title, mimeType, size };
}

const steps = ['Thông tin', 'Module', 'Tài liệu', 'Câu hỏi', 'Xác nhận'] as const;
const CLOSED_EDITOR: TemplateEditorUiState = { open: false, dirty: false, confirmDiscard: false };

function newModule(index: number): TemplateModuleInput {
  return { key: `module-${index + 1}`, title: '', description: '', resources: [], questions: [] };
}

function emptyDraft(): TemplateDraftInput {
  return { title: '', description: '', employeeType: 'normal', passingScore: 80, maxAttempts: 1, modules: [newModule(0)] };
}

function detailToDraft(detail: AdminTemplateDetail): TemplateDraftInput {
  return {
    title: detail.title,
    description: detail.description,
    employeeType: detail.employeeType,
    passingScore: detail.passingScore ?? 80,
    maxAttempts: detail.maxAttempts,
    modules: detail.modules.map((module) => ({
      id: module.id,
      key: module.key,
      title: module.title,
      description: module.description,
      resources: module.resources.map((resource) => ({ ...resource })),
      questions: module.questions.map((question) => ({ ...question })),
    })),
  };
}

function patchModule(draft: TemplateDraftInput, index: number, patch: Partial<TemplateModuleInput>): TemplateDraftInput {
  return { ...draft, modules: draft.modules.map((module, current) => current === index ? { ...module, ...patch } : module) };
}

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Không thể đọc file.'));
    reader.readAsDataURL(file);
  });
}

export function templateOperationError(
  caught: unknown,
  fallback = 'Không thể cập nhật template.',
): InlineNoticeMessage {
  return {
    message: caught instanceof Error && caught.message ? caught.message : fallback,
    tone: 'error',
  };
}

export function TemplatesPage({
  api,
  onUseTemplate,
  canGenerateWithAi = true,
}: {
  api: OnboardingApi;
  onUseTemplate: () => void;
  canGenerateWithAi?: boolean;
}) {
  const [items, setItems] = useState<readonly TemplateCatalogView[]>([]);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<TemplateStatusFilter>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [notice, setNotice] = useState<InlineNoticeMessage | null>(null);
  const [detailItem, setDetailItem] = useState<TemplateCatalogView | null>(null);
  const detailCacheRef = useRef<ReadonlyMap<string, TemplateDetailCacheEntry>>(new Map());
  const [detailCache, setDetailCache] = useState<ReadonlyMap<string, TemplateDetailCacheEntry>>(detailCacheRef.current);
  const [detailActionError, setDetailActionError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TemplateCatalogView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [reviewTarget, setReviewTarget] = useState<{ id: string; version: number } | undefined>();

  const load = useCallback(async (reason: PollReason) => {
    const initial = reason === 'initial';
    if (initial) { setLoading(true); setError(null); }
    try {
      const nextItems = (await api.adminTemplates<{ templates: readonly TemplateCatalogView[] }>('list')).templates;
      setItems(nextItems);
      setDetailItem((current) => current
        ? nextItems.find((item) => item.id === current.id && item.version === current.version) ?? null
        : null);
      const nextCache = await preloadTemplateDetails(nextItems, detailCacheRef.current, async (item) => (
        await api.adminTemplates<{ template: AdminTemplateDetail }>('get', {
          templateId: item.id,
          version: item.version,
        })
      ).template);
      detailCacheRef.current = nextCache;
      setDetailCache(nextCache);
      setError(null);
    } catch (caught) {
      if (initial) setError(caught instanceof Error ? caught : new Error('Không thể tải thư viện template.'));
    } finally {
      if (initial) setLoading(false);
    }
  }, [api]);

  const refresh = usePolling(load);
  const filteredItems = useMemo(() => filterTemplates(items, query, statusFilter), [items, query, statusFilter]);
  const detailEntry = detailItem ? detailCache.get(templateDetailCacheKey(detailItem)) : undefined;
  const detail = detailEntry?.detail ?? null;
  const detailLoading = Boolean(detailItem && !detailEntry);
  const detailError = detailActionError ?? detailEntry?.error ?? null;

  async function retryDetail(item: TemplateCatalogView) {
    const key = templateDetailCacheKey(item);
    const next = new Map(detailCacheRef.current);
    next.delete(key);
    detailCacheRef.current = next;
    setDetailCache(next);
    try {
      const result = await api.adminTemplates<{ template: AdminTemplateDetail }>('get', {
        templateId: item.id,
        version: item.version,
      });
      const loaded = new Map(detailCacheRef.current);
      loaded.set(key, { detail: result.template, error: null });
      detailCacheRef.current = loaded;
      setDetailCache(loaded);
    } catch (caught) {
      setDetailActionError(caught instanceof Error ? caught.message : 'Không thể tải chi tiết template.');
    }
  }

  async function runDetailAction(action: TemplateDetailAction) {
    if (!detailItem || !detail) return;
    setNotice(null);
    try {
      if (action === 'use') {
        setDetailItem(null);
        onUseTemplate();
        return;
      }
      if (action === 'edit') {
        setReviewTarget({ id: detail.id, version: detail.version });
        setDetailItem(null);
        setAiOpen(true);
        return;
      }
      if (action === 'archive') {
        await api.adminTemplates('archive', { templateId: detail.id, version: detail.version });
        setNotice({ message: 'Đã lưu trữ phiên bản template.', tone: 'success' });
      }
      if (action === 'delete') {
        setPendingDelete(detailItem);
        setDetailItem(null);
        return;
      }
      setDetailItem(null);
      await refresh();
    } catch (caught) {
      setNotice(templateOperationError(caught));
    }
  }

  async function confirmDelete() {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    try {
      await api.adminTemplates('delete', {
        templateId: pendingDelete.id,
        version: pendingDelete.version,
      });
      setPendingDelete(null);
      setNotice({ message: 'Đã xóa template.', tone: 'success' });
      await refresh();
    } catch (caught) {
      setNotice(templateOperationError(caught, 'Không thể xóa template.'));
    } finally {
      setDeleting(false);
    }
  }

  if (loading) return <LoadingState label="Đang tải thư viện template…" />;
  if (error) return <ErrorState error={error} onRetry={() => void refresh()} />;

  return <div className="page-stack">
    <section className="page-heading">
      <div><span className="section-kicker">THƯ VIỆN NỘI DUNG</span><h2>Template onboarding</h2><p>AI tạo lộ trình từ tài liệu của room; Admin rà soát, chỉnh sửa rồi mới xuất bản.</p></div>
      <button
        className="button button-primary"
        type="button"
        disabled={!canGenerateWithAi}
        title={canGenerateWithAi ? undefined : 'Cần cấp quyền Sandbox hoặc Native AI Chat cho app.'}
        onClick={() => { setReviewTarget(undefined); setAiOpen(true); }}
      ><RobotOutlined /> Tạo bằng AI</button>
    </section>
    <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
    <TemplateLibraryToolbar query={query} status={statusFilter} count={filteredItems.length} total={items.length} onQueryChange={setQuery} onStatusChange={setStatusFilter} />
    {filteredItems.length > 0
      ? <section className="template-grid">{filteredItems.map((item) => <TemplateCard item={item} key={item.id + '@' + item.version} onOpen={() => { setDetailActionError(null); setDetailItem(item); }} />)}</section>
      : <section className="template-search-empty"><SearchOutlined /><strong>Không tìm thấy template</strong><p>Thử tìm bằng một tên khác.</p></section>}
    {detailItem && <TemplateModalLayer><div className="dialog-backdrop template-detail-backdrop" role="presentation" onMouseDown={() => setDetailItem(null)}><TemplateDetailPanel detail={detail} loading={detailLoading} error={detailError} onClose={() => setDetailItem(null)} onRetry={() => void retryDetail(detailItem)} onAction={(action) => void runDetailAction(action)} /></div></TemplateModalLayer>}
    {/* AiGeneratorPage owns its backdrop: ×, Esc and a backdrop click all go through its close confirmation. */}
    {aiOpen && <TemplateModalLayer><AiGeneratorPage api={api} canGenerateWithAi={canGenerateWithAi} initialTemplate={reviewTarget} onClose={() => setAiOpen(false)} onComplete={() => { setAiOpen(false); setNotice({ message: 'Đã xuất bản template AI.', tone: 'success' }); void refresh(); }} /></TemplateModalLayer>}
    {pendingDelete && <TemplateModalLayer><ConfirmDialog open title="Xóa template?" description="Chỉ có thể xóa template chưa được gán cho nhân sự." confirmLabel="Xóa template" busy={deleting} busyLabel="Đang xóa…" onCancel={() => { if (!deleting) setPendingDelete(null); }} onConfirm={() => void confirmDelete()} /></TemplateModalLayer>}
  </div>;
}

export function LegacyTemplatesPage({ api, onUseTemplate }: { api: OnboardingApi; onUseTemplate: () => void }) {
  const app = usePrivosApp();
  const { roomId } = usePrivosContext();
  const [items, setItems] = useState<readonly TemplateCatalogView[]>([]);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<TemplateStatusFilter>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [notice, setNotice] = useState<InlineNoticeMessage | null>(null);
  const [editorMessage, setEditorMessage] = useState<InlineNoticeMessage | null>(null);
  const [editorUi, setEditorUi] = useState<TemplateEditorUiState>(CLOSED_EDITOR);
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<TemplateDraftInput>(() => emptyDraft());
  const [editing, setEditing] = useState<{ id: string; version: number; updatedAt: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [detailItem, setDetailItem] = useState<TemplateCatalogView | null>(null);
  const detailCacheRef = useRef<ReadonlyMap<string, TemplateDetailCacheEntry>>(new Map());
  const [detailCache, setDetailCache] = useState<ReadonlyMap<string, TemplateDetailCacheEntry>>(detailCacheRef.current);
  const [detailActionError, setDetailActionError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TemplateCatalogView | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async (reason: PollReason) => {
    const initial = reason === 'initial';
    if (initial) { setLoading(true); setError(null); }
    try {
      const nextItems = (await api.adminTemplates<{ templates: readonly TemplateCatalogView[] }>('list')).templates;
      setItems(nextItems);
      setDetailItem((current) => current
        ? nextItems.find((item) => item.id === current.id && item.version === current.version) ?? null
        : null);
      const nextCache = await preloadTemplateDetails(nextItems, detailCacheRef.current, async (item) => (
        await api.adminTemplates<{ template: AdminTemplateDetail }>('get', {
          templateId: item.id,
          version: item.version,
        })
      ).template);
      detailCacheRef.current = nextCache;
      setDetailCache(nextCache);
      setError(null);
    } catch (caught) {
      if (initial) setError(caught instanceof Error ? caught : new Error('Không thể tải thư viện template.'));
    } finally {
      if (initial) setLoading(false);
    }
  }, [api]);

  const refresh = usePolling(load);
  const issues = useMemo(() => validateTemplateDraft(draft), [draft]);
  const blockingIssues = useMemo(() => issues.filter((issue) => issue.level === 'error'), [issues]);
  const suggestions = useMemo(() => issues.filter((issue) => issue.level === 'suggestion'), [issues]);
  const filteredItems = useMemo(() => filterTemplates(items, query, statusFilter), [items, query, statusFilter]);
  const detailEntry = detailItem ? detailCache.get(templateDetailCacheKey(detailItem)) : undefined;
  const detail = detailEntry?.detail ?? null;
  const detailLoading = Boolean(detailItem && !detailEntry);
  const detailError = detailActionError ?? detailEntry?.error ?? null;

  useEffect(() => {
    if (!editorUi.open && !detailItem) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (editorUi.confirmDiscard) {
        setEditorUi((current) => templateEditorTransition(current, 'cancel_discard'));
      } else if (editorUi.open && !saving && !uploading) {
        setEditorUi((current) => templateEditorTransition(current, 'request_close'));
      } else if (detailItem) {
        setDetailItem(null);
        setDetailActionError(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [detailItem, editorUi.confirmDiscard, editorUi.open, saving, uploading]);

  function updateDraft(next: TemplateDraftInput) {
    setDraft(next);
    setEditorUi((current) => ({ ...current, dirty: true }));
  }

  function openNew() {
    setDraft(emptyDraft());
    setEditing(null);
    setStep(0);
    setEditorMessage(null);
    setEditorUi({ open: true, dirty: false, confirmDiscard: false });
  }

  function openEditor(template: AdminTemplateDetail) {
    if (template.source === 'system') return;
    setDraft(detailToDraft(template));
    setEditing({ id: template.id, version: template.version, updatedAt: template.updatedAt });
    setStep(0);
    setEditorMessage(null);
    setDetailItem(null);
    setDetailActionError(null);
    setEditorUi({ open: true, dirty: false, confirmDiscard: false });
  }

  function requestEditorClose() {
    if (saving || uploading) return;
    setEditorUi((current) => templateEditorTransition(current, 'request_close'));
  }

  const retryDetail = useCallback(async (item: TemplateCatalogView) => {
    const key = templateDetailCacheKey(item);
    const pending = new Map(detailCacheRef.current);
    pending.delete(key);
    detailCacheRef.current = pending;
    setDetailCache(pending);
    setDetailActionError(null);
    try {
      const result = await api.adminTemplates<{ template: AdminTemplateDetail }>('get', { templateId: item.id, version: item.version });
      const next = new Map(detailCacheRef.current);
      next.set(key, { detail: result.template, error: null });
      detailCacheRef.current = next;
      setDetailCache(next);
    } catch (caught) {
      const next = new Map(detailCacheRef.current);
      next.set(key, { detail: null, error: caught instanceof Error ? caught.message : 'Không thể tải chi tiết template.' });
      detailCacheRef.current = next;
      setDetailCache(next);
    }
  }, [api]);

  async function runDetailAction(action: TemplateDetailAction) {
    if (!detailItem || !detail) return;
    setNotice(null);
    try {
      if (action === 'use') {
        setDetailItem(null);
        setDetailActionError(null);
        onUseTemplate();
        return;
      }
      if (action === 'edit') {
        openEditor(detail);
        return;
      }
      if (action === 'clone') {
        await api.adminTemplates('clone_system', { templateId: detailItem.id, version: detailItem.version });
        setNotice({ message: 'Đã tạo bản nháp tùy chỉnh từ template hệ thống.', tone: 'success' });
      }
      if (action === 'archive') {
        await api.adminTemplates('archive', { templateId: detailItem.id, version: detailItem.version });
        setNotice({ message: 'Đã lưu trữ phiên bản template.', tone: 'success' });
      }
      if (action === 'delete') {
        setPendingDelete(detailItem);
        setDetailItem(null);
        setDetailActionError(null);
        return;
      }
      setDetailItem(null);
      setDetailActionError(null);
      await refresh();
    } catch (caught) {
      setNotice(templateOperationError(caught));
    }
  }

  async function confirmDelete() {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    try {
      await api.adminTemplates('delete', { templateId: pendingDelete.id, version: pendingDelete.version });
      setPendingDelete(null);
      setNotice({ message: 'Đã xóa template.', tone: 'success' });
      await refresh();
    } catch (caught) {
      setNotice(templateOperationError(caught, 'Không thể xóa template.'));
    }
    finally { setDeleting(false); }
  }

  async function upload(file: File, moduleIndex: number) {
    if (!roomId) { setEditorMessage({ message: 'Không xác định được room để tải file.', tone: 'error' }); return; }
    setUploading(true);
    setEditorMessage(null);
    try {
      const folders = await ensureOnboardingRoomfiles(app, roomId);
      // `files:write` is used only when an admin explicitly uploads template material to this room.
      const result = await app.uploadFile({
        channelId: roomId,
        folderId: folders.documentsId,
        fileName: file.name,
        base64Data: await fileBase64(file),
        mimeType: file.type || undefined,
        duplicateAction: 'keep_both',
      });
      const uploaded = normalizeUploadedResource(result);
      const resource: TemplateResourceInput = { title: uploaded.title, kind: 'file', required: true, fileId: uploaded.fileId };
      const module = draft.modules[moduleIndex];
      updateDraft(patchModule(draft, moduleIndex, { resources: [...module.resources, resource] }));
      setEditorMessage({ message: `Đã tải ${uploaded.title} lên room.`, tone: 'success' });
    } catch (caught) {
      setEditorMessage({ message: caught instanceof Error ? caught.message : 'Không thể tải file.', tone: 'error' });
    }
    finally { setUploading(false); }
  }

  async function save(publish: boolean) {
    if (publish && blockingIssues.length) {
      setEditorMessage({ message: `Còn ${blockingIssues.length} mục cần hoàn thiện trước khi xuất bản.`, tone: 'error' });
      return;
    }
    setSaving(true);
    setEditorMessage(null);
    try {
      const saved = editing
        ? await api.adminTemplates<{ template: AdminTemplateDetail }>('update', { templateId: editing.id, version: editing.version, expectedUpdatedAt: editing.updatedAt, draft })
        : await api.adminTemplates<{ template: AdminTemplateDetail }>('create', { draft });

      setEditing({ id: saved.template.id, version: saved.template.version, updatedAt: saved.template.updatedAt });
      setDraft(detailToDraft(saved.template));
      setEditorUi((current) => ({ ...current, dirty: false }));

      if (publish) {
        try {
          await api.adminTemplates('publish', { templateId: saved.template.id, version: saved.template.version, expectedUpdatedAt: saved.template.updatedAt });
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : 'Không thể xuất bản template.';
          setEditorMessage({ message: `Bản nháp đã được lưu nhưng chưa thể xuất bản: ${message}`, tone: 'error' });
          return;
        }
      }

      setNotice({
        message: publish ? 'Đã xuất bản phiên bản template.' : 'Đã lưu bản nháp.',
        tone: 'success',
      });
      setEditorUi((current) => templateEditorTransition(current, 'save_succeeded'));
      await refresh();
    } catch (caught) {
      setEditorMessage({ message: caught instanceof Error ? caught.message : 'Không thể lưu template.', tone: 'error' });
    }
    finally { setSaving(false); }
  }

  if (loading) return <LoadingState label="Đang tải thư viện template…" />;
  if (error) return <ErrorState error={error} onRetry={() => void refresh()} />;

  return <div className="page-stack">
    <section className="page-heading"><div><span className="section-kicker">THƯ VIỆN NỘI DUNG</span><h2>Template onboarding</h2><p>Chọn một template để xem đầy đủ tài liệu, câu hỏi và các thao tác phù hợp.</p></div><button className="button button-primary" type="button" onClick={openNew}><PlusOutlined /> Tạo template</button></section>
    <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
    <TemplateLibraryToolbar
      query={query}
      status={statusFilter}
      count={filteredItems.length}
      total={items.length}
      onQueryChange={setQuery}
      onStatusChange={setStatusFilter}
    />
    {filteredItems.length > 0
      ? <section className="template-grid">{filteredItems.map((item) => <TemplateCard item={item} key={`${item.id}@${item.version}`} onOpen={() => { setDetailActionError(null); setDetailItem(item); }} />)}</section>
      : <section className="template-search-empty"><SearchOutlined /><strong>Không tìm thấy template</strong><p>Thử tìm bằng một tên khác.</p></section>}

    {detailItem && <TemplateModalLayer><div className="dialog-backdrop template-detail-backdrop" role="presentation" onMouseDown={() => { setDetailItem(null); setDetailActionError(null); }}><TemplateDetailPanel detail={detail} loading={detailLoading} error={detailError} onClose={() => { setDetailItem(null); setDetailActionError(null); }} onRetry={() => void retryDetail(detailItem)} onAction={(action) => void runDetailAction(action)} /></div></TemplateModalLayer>}

    {editorUi.open && <TemplateModalLayer><div className="dialog-backdrop builder-backdrop" role="presentation" onMouseDown={requestEditorClose}><section className="builder-panel" role="dialog" aria-modal="true" aria-labelledby="builder-title" onMouseDown={(event) => event.stopPropagation()}>
      <header className="builder-header"><div><span className="section-kicker">WIZARD 5 BƯỚC</span><h2 id="builder-title">{editing ? 'Chỉnh sửa template' : 'Template onboarding mới'}</h2></div><button className="icon-button" type="button" aria-label="Đóng" onClick={requestEditorClose}><CloseOutlined /></button></header>
      <ol className="wizard-steps">{steps.map((label, index) => <li key={label} className={index === step ? 'active' : index < step ? 'done' : ''}><span>{index < step ? <CheckOutlined /> : index + 1}</span><small>{label}</small></li>)}</ol>
      <div className="builder-body">
        <InlineNotice notice={editorMessage} className="editor-notice" onDismiss={() => setEditorMessage(null)} />
        {step === 0 && <div className="form-stack two-column-form"><label className="form-field form-wide"><span>Tên template</span><input value={draft.title} onChange={(event) => updateDraft({ ...draft, title: event.target.value })} placeholder="Ví dụ: Hội nhập đội Kinh doanh" /></label><label className="form-field form-wide"><span>Mô tả</span><textarea rows={3} value={draft.description} onChange={(event) => updateDraft({ ...draft, description: event.target.value })} /></label><label className="form-field"><span>Loại nhân sự</span><select value={draft.employeeType} onChange={(event) => updateDraft({ ...draft, employeeType: event.target.value as EmployeeType })}><option value="normal">Thông thường</option><option value="advanced">Chuyên sâu</option></select></label><label className="form-field"><span>Số lượt làm tối đa</span><input type="number" min={1} value={draft.maxAttempts ?? 1} onChange={(event) => updateDraft({ ...draft, maxAttempts: Number(event.target.value) })} /></label></div>}
        {step === 1 && <div className="module-editor"><div className="section-header"><div><h3>Cấu trúc module</h3><p>Mỗi module là một chặng học có tài liệu và câu hỏi riêng.</p></div><button className="button button-secondary" type="button" onClick={() => updateDraft({ ...draft, modules: [...draft.modules, newModule(draft.modules.length)] })}><PlusOutlined /> Thêm module</button></div>{draft.modules.map((module, index) => <div className="module-block" key={module.id ?? index}><strong>Module {index + 1}</strong><div className="form-grid"><label className="form-field"><span>Mã</span><input value={module.key} onChange={(event) => updateDraft(patchModule(draft, index, { key: event.target.value }))} /></label><label className="form-field"><span>Tiêu đề</span><input value={module.title} onChange={(event) => updateDraft(patchModule(draft, index, { title: event.target.value }))} /></label><label className="form-field form-wide"><span>Mô tả</span><textarea rows={2} value={module.description} onChange={(event) => updateDraft(patchModule(draft, index, { description: event.target.value }))} /></label></div></div>)}</div>}
        {step === 2 && <div className="module-editor"><div className="section-header"><div><h3>Tài liệu bắt buộc</h3><p>Nhân sự phải mở và xác nhận hoàn thành trước khi làm bài.</p></div></div>{draft.modules.map((module, index) => <div className="module-block" key={module.id ?? index}><strong>{module.title || `Module ${index + 1}`}</strong><label className="upload-zone"><UploadOutlined /><span>{uploading ? 'Đang tải lên PrivOS…' : 'Tải tài liệu lên room'}</span><input type="file" disabled={uploading} onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file, index); event.target.value = ''; }} /></label><div className="resource-list">{module.resources.map((resource, resourceIndex) => <span key={`${resource.fileId ?? resource.sourceUrl}-${resourceIndex}`}><FileAddOutlined /> {resource.title}</span>)}</div><button className="text-button" type="button" onClick={() => { const sourceUrl = window.prompt('Nhập URL tài liệu'); if (sourceUrl) updateDraft(patchModule(draft, index, { resources: [...module.resources, { title: sourceUrl, kind: 'link' as ResourceKind, required: true, sourceUrl }] })); }}>+ Thêm liên kết</button></div>)}</div>}
        {step === 3 && <div className="module-editor">
          <div className="section-header"><div><h3>Câu hỏi</h3><p>Trắc nghiệm được chấm tự động; tự luận chỉ cần nộp và chờ Admin nhận xét.</p></div></div>
          {draft.modules.map((module, moduleIndex) => <div className="module-block question-module" key={module.id ?? moduleIndex}>
            <div className="question-module-heading"><strong>{module.title || `Module ${moduleIndex + 1}`}</strong></div>
            {module.questions.length === 0 && <><p className="question-empty">Chưa có câu hỏi nào trong module này.</p><button className="button button-secondary question-insert-action" type="button" onClick={() => updateDraft(patchModule(draft, moduleIndex, { questions: [newQuestion()] }))}><PlusOutlined /> Thêm câu hỏi</button></>}
            {module.questions.map((question, questionIndex) => <div className="question-editor-stack" key={question.id ?? `${moduleIndex}-${questionIndex}`}>
              <QuestionEditor question={question} questionKey={`${moduleIndex}-${questionIndex}`} questionNumber={questionIndex + 1} onChange={(next: TemplateQuestionInput) => updateDraft(patchModule(draft, moduleIndex, { questions: module.questions.map((item, current) => current === questionIndex ? next : item) }))} onRemove={() => updateDraft(patchModule(draft, moduleIndex, { questions: module.questions.filter((_, current) => current !== questionIndex) }))} />
              <button className="button button-secondary question-insert-action" type="button" onClick={() => updateDraft(patchModule(draft, moduleIndex, { questions: insertQuestionAfter(module.questions, questionIndex, newQuestion()) }))}><PlusOutlined /> Thêm câu hỏi bên dưới</button>
            </div>)}
          </div>)}
        </div>}
        {step === 4 && <div className="review-panel"><div className="review-messages"><div className={blockingIssues.length ? 'review-warning' : 'review-success'}>{blockingIssues.length ? <><strong>Còn {blockingIssues.length} mục cần hoàn thiện</strong><ul>{blockingIssues.slice(0, 8).map((issue) => <li key={`${issue.field}-${issue.message}`}>{issue.message}</li>)}</ul></> : <><CheckOutlined /><strong>Template đã sẵn sàng để xuất bản</strong></>}</div>{suggestions.length > 0 && <div className="review-suggestion"><strong>Gợi ý</strong><ul>{suggestions.slice(0, 8).map((issue) => <li key={`${issue.field}-${issue.message}`}>{issue.message}</li>)}</ul></div>}</div><dl><div><dt>Tên</dt><dd>{draft.title || 'Chưa đặt tên'}</dd></div><div><dt>Phân loại</dt><dd>{draft.employeeType === 'advanced' ? 'Chuyên sâu' : 'Thông thường'}</dd></div><div><dt>Module</dt><dd>{draft.modules.length}</dd></div><div><dt>Tài liệu</dt><dd>{draft.modules.reduce((sum, module) => sum + module.resources.length, 0)}</dd></div><div><dt>Câu hỏi</dt><dd>{draft.modules.reduce((sum, module) => sum + module.questions.length, 0)}</dd></div></dl></div>}
      </div>
      <footer className="builder-footer"><button className="button button-secondary" type="button" disabled={step === 0 || saving} onClick={() => setStep((current) => current - 1)}>Quay lại</button><div>{step === 4 && <button className="button button-secondary" type="button" disabled={saving} onClick={() => void save(false)}>{saving ? 'Đang lưu…' : 'Lưu bản nháp'}</button>}<button className="button button-primary" type="button" disabled={saving} onClick={() => step === 4 ? void save(true) : setStep((current) => current + 1)}>{step === 4 ? <><RocketOutlined /> {saving ? 'Đang xuất bản…' : 'Xuất bản'}</> : 'Tiếp tục'}</button></div></footer>
    </section></div></TemplateModalLayer>}

    {editorUi.confirmDiscard && <TemplateModalLayer><ConfirmDialog open title="Đóng khi chưa lưu?" description="Các thay đổi trong template chưa được lưu và sẽ bị mất." confirmLabel="Đóng không lưu" onCancel={() => setEditorUi((current) => templateEditorTransition(current, 'cancel_discard'))} onConfirm={() => setEditorUi((current) => templateEditorTransition(current, 'confirm_discard'))} /></TemplateModalLayer>}
    {pendingDelete && <TemplateModalLayer><ConfirmDialog open title="Xóa template?" description="Chỉ có thể xóa template tùy chỉnh chưa được gán cho nhân sự." confirmLabel="Xóa template" busy={deleting} busyLabel="Đang xóa…" onCancel={() => { if (!deleting) setPendingDelete(null); }} onConfirm={() => void confirmDelete()} /></TemplateModalLayer>}
  </div>;
}
