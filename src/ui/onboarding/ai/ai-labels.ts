const DIACRITICS = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;

export const BLOCK_KIND_LABELS: Readonly<Record<'concept' | 'steps' | 'scenario' | 'tip' | 'warning' | 'summary', string>> = {
  concept: 'Khái niệm',
  steps: 'Các bước',
  scenario: 'Tình huống',
  tip: 'Mẹo',
  warning: 'Lưu ý',
  summary: 'Tóm tắt',
};

export const QUESTION_LEVEL_LABELS: Readonly<Record<'recall' | 'procedure' | 'scenario', string>> = {
  recall: 'Ghi nhớ',
  procedure: 'Quy trình',
  scenario: 'Tình huống',
};

export const FLAG_TYPE_LABELS: Readonly<Record<string, string>> = {
  missing: 'Thiếu thông tin',
  conflict: 'Mâu thuẫn',
  ambiguous: 'Chưa rõ',
  outdated: 'Có thể lỗi thời',
  unsupported: 'Không có căn cứ',
  audience_unclear: 'Chưa rõ đối tượng',
  low_quality_source: 'Nguồn chất lượng thấp',
  generation_error: 'Lỗi tạo nội dung',
};

export function hasVietnameseText(text: string): boolean {
  return DIACRITICS.test(text);
}

export function actionableProviderFailure(message: string): string | null {
  if (/worker[_ ]failed|worker exited with code/i.test(message)) {
    const exitCode = /worker exited with code\s+(-?\d+)/i.exec(message)?.[1];
    const diagnostic = exitCode ? `worker_failed, exit code ${exitCode}` : 'worker_failed';
    return `Worker Sandbox của PrivOS đã dừng (${diagnostic}). Đây là lỗi hạ tầng `
      + 'Sandbox, không phải lỗi dữ liệu template. Admin workspace cần repair/restart Sandbox '
      + 'hoặc cấp quyền Native AI Chat, sau đó bấm Thử lại.';
  }
  if (/rejected (?:this agent's|the configured) credentials|model provider key/i.test(message)) {
    return 'PrivOS từ chối khóa nhà cung cấp model của agent AI. Admin workspace cần kiểm tra '
      + 'khóa nhà cung cấp model trong cài đặt agent, sau đó bấm Thử lại.';
  }
  if (/agent stopped unexpectedly/i.test(message)) {
    return 'Agent AI của PrivOS dừng đột ngột trước khi hoàn tất. Bấm Thử lại; nếu lặp lại, '
      + 'Admin workspace cần kiểm tra cấu hình agent.';
  }
  return null;
}

export function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as Record<string, unknown>;
  if (typeof record.code === 'string') return record.code;
  if (record.data && typeof record.data === 'object' && !Array.isArray(record.data)) {
    const code = (record.data as Record<string, unknown>).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  SOURCE_TOO_LARGE: 'Tài liệu vượt quá giới hạn 2 MB.',
  SOURCE_TYPE_UNSUPPORTED: 'Định dạng tài liệu chưa được hỗ trợ.',
  SOURCE_NO_TEXT: 'Không tìm thấy lớp chữ trong tài liệu; phiên bản này chưa hỗ trợ OCR.',
  SOURCE_DUPLICATE: 'Tài liệu này đã có trong danh sách nguồn.',
  ROLE_PROFILE_INVALID: 'Hồ sơ vai trò cần từ 2 đến 8 nhiệm vụ duy nhất.',
  AI_DISPATCH_UNKNOWN: 'Không xác định được trạng thái lần gọi AI. Hãy bấm Thử lại để tạo một lần gọi an toàn mới.',
  AI_TIMEOUT: 'AI xử lý quá thời gian. Hãy thử lại job.',
  AI_OUTPUT_INVALID: 'AI chưa tạo được cấu trúc hợp lệ sau các lần tự sửa.',
  TEMPLATE_FLAGS_BLOCKING: 'Cần xử lý hết cờ bắt buộc trước khi xuất bản.',
  REVIEW_CONFLICT: 'Template vừa được cập nhật ở nơi khác. Hãy tải lại bản mới nhất.',
  REVIEW_INVALID: 'Không thể áp dụng thao tác này cho bản nháp. Hãy chỉnh sửa trực tiếp module.',
  JOB_OWNER_REQUIRED: 'Job AI này do Admin khác tạo; chỉ người tạo mới tiếp tục hoặc hủy được.',
  OPERATION_CONFLICT: 'Dữ liệu vừa thay đổi. Hãy thử lại.',
  JOB_NOT_RUNNING: 'Tiến trình AI không còn chạy. Hãy mở lại hoặc tạo phiên mới.',
  SOURCE_NOT_FOUND: 'Không tìm thấy tài liệu nguồn đã chọn.',
  INVENTORY_REQUIRED: 'Cần phân tích tài liệu trước.',
  PROJECT_BUSY: 'AI của room đang bận. Hãy thử lại sau ít phút.',
  JOB_CALL_MISMATCH: 'Lượt gọi AI không còn khớp. Hãy thử lại.',
  COVERAGE_INCOMPLETE: 'Còn module chưa đủ tài liệu.',
};

/** Codes whose server message, when written in Vietnamese, says more than the generic text. */
const SPECIFIC_MESSAGE_CODES: ReadonlySet<string> = new Set(['OPERATION_CONFLICT', 'COVERAGE_INCOMPLETE']);

export function vietnameseErrorMessage(error: unknown): string {
  const providerMessage = error instanceof Error ? actionableProviderFailure(error.message) : null;
  if (providerMessage) return providerMessage;
  const code = errorCode(error);
  if (code && SPECIFIC_MESSAGE_CODES.has(code) && error instanceof Error && hasVietnameseText(error.message)) {
    return error.message.trim();
  }
  if (code && Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code)) return ERROR_MESSAGES[code];
  if (error instanceof Error && error.message && hasVietnameseText(error.message)) return error.message;
  return 'Không thể hoàn tất yêu cầu AI.' + (code ? ' (mã ' + code + ')' : '');
}
