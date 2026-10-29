import type { TemplateOutlineModule } from '../contracts';

/** Vietnamese display labels for the authoritative outline frames. Browser-safe. */
const FRAME_LABELS: Readonly<Record<string, string>> = {
  't1-overview': 'Tổng quan',
  't1-access': 'Tài khoản và quyền truy cập',
  't1-navigation': 'Làm quen giao diện',
  't1-core': 'Quy trình công việc chính',
  't1-core-2': 'Quy trình bổ sung',
  't1-data': 'Dữ liệu và báo cáo',
  't1-security': 'Bảo mật và an toàn',
  't1-support': 'Hỗ trợ và xử lý sự cố',
  't2-role': 'Vai trò và mục tiêu',
  't2-permissions': 'Quyền truy cập chuyên sâu',
  't2-task-1': 'Nhiệm vụ chuyên sâu 1',
  't2-task-2': 'Nhiệm vụ chuyên sâu 2',
  't2-task-3': 'Nhiệm vụ chuyên sâu 3',
  't2-task-4': 'Nhiệm vụ chuyên sâu 4',
  't2-task-5': 'Nhiệm vụ chuyên sâu 5',
  't2-task-6': 'Nhiệm vụ chuyên sâu 6',
  't2-collab': 'Phối hợp công việc',
  't2-reports': 'Báo cáo chuyên sâu',
  't2-control': 'Kiểm soát và tuân thủ',
};

export function outlineFrameLabel(frameKey: string): string {
  return FRAME_LABELS[frameKey] ?? frameKey;
}

export function outlineModuleDisplayTitle(module: Pick<TemplateOutlineModule, 'title' | 'frameKey'>): string {
  const title = module.title.trim();
  return !title || title === module.frameKey ? outlineFrameLabel(module.frameKey) : title;
}
