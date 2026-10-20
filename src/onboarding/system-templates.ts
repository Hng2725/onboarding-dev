import type {
  EmployeeType,
  OnboardingQuestion,
  TemplateModule,
  TemplateResource,
  TemplateSnapshot,
} from './contracts';

function resource(
  id: string,
  title: string,
  description: string,
  sourceUrl: string,
): TemplateResource {
  return { id, title, description, kind: 'link', required: true, sourceUrl };
}

function singleChoice(
  id: string,
  prompt: string,
  options: readonly [string, string][],
  correctOptionId: string,
  explanation: string,
): OnboardingQuestion {
  return {
    id,
    type: 'single_choice',
    prompt,
    required: true,
    options: options.map(([optionId, label]) => ({ id: optionId, label })),
    correctOptionIds: [correctOptionId],
    explanation,
  };
}

function module(
  templatePrefix: string,
  key: string,
  order: number,
  title: string,
  description: string,
  sourceUrl: string,
  question: OnboardingQuestion,
): TemplateModule {
  return {
    id: `${templatePrefix}-module-${key}`,
    key,
    order,
    title,
    description,
    resources: [resource(
      `${templatePrefix}-resource-${key}`,
      `Tài liệu: ${title}`,
      `Đọc hướng dẫn chính thức của PrivOS về ${title.toLocaleLowerCase('vi-VN')}.`,
      sourceUrl,
    )],
    questions: [question],
  };
}

function template(
  id: string,
  employeeType: EmployeeType,
  title: string,
  description: string,
  modules: readonly TemplateModule[],
): TemplateSnapshot {
  return {
    id,
    version: 1,
    source: 'system',
    status: 'published',
    employeeType,
    title,
    description,
    passingScore: 70,
    modules,
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const foundations = template(
  'privos-foundations',
  'normal',
  'Nền tảng sử dụng PrivOS',
  'Lộ trình nhập môn dành cho mọi nhân sự: tài khoản, phòng làm việc, tệp, danh sách, thông báo và ứng dụng.',
  [
    module(
      'foundations', 'welcome', 1, 'Làm quen với PrivOS',
      'Hiểu PrivOS là không gian cộng tác thống nhất cho đội ngũ và AI.',
      'https://docs.privos.ai/',
      singleChoice(
        'foundations-question-welcome',
        'Dữ liệu trao đổi và quy trình trong PrivOS được tổ chức chủ yếu theo đâu?',
        [['rooms', 'Theo từng room'], ['browser', 'Theo từng trình duyệt']],
        'rooms',
        'Room là ngữ cảnh làm việc giúp hội thoại, tệp và quy trình luôn gắn với đúng nhóm.',
      ),
    ),
    module(
      'foundations', 'account', 2, 'Tài khoản và bảo mật',
      'Thiết lập hồ sơ, mật khẩu, tùy chọn cá nhân và thói quen bảo mật cơ bản.',
      'https://docs.privos.ai/guide/account-settings.html',
      singleChoice(
        'foundations-question-account',
        'Bạn nên dùng loại mật khẩu nào cho tài khoản PrivOS?',
        [['unique', 'Mật khẩu mạnh và riêng biệt'], ['shared', 'Mật khẩu dùng chung với đồng nghiệp']],
        'unique',
        'Mật khẩu mạnh, riêng biệt và được lưu bằng trình quản lý mật khẩu giúp giảm rủi ro lộ tài khoản.',
      ),
    ),
    module(
      'foundations', 'rooms', 3, 'Room và giao tiếp nhóm',
      'Sử dụng tin nhắn, luồng thảo luận và tệp đính kèm đúng ngữ cảnh room.',
      'https://docs.privos.ai/guide/team-communication.html',
      singleChoice(
        'foundations-question-rooms',
        'Vì sao nên trao đổi công việc trong đúng room?',
        [['context', 'Để lịch sử, tệp và quyết định giữ đúng ngữ cảnh'], ['speed', 'Để tăng tốc độ Internet']],
        'context',
        'Mô hình room-scoped giữ toàn bộ hội thoại và tài liệu liên quan trong cùng một không gian.',
      ),
    ),
    module(
      'foundations', 'files', 4, 'Quản lý tệp',
      'Tải lên, sắp xếp, tìm kiếm và sử dụng lịch sử phiên bản của tệp.',
      'https://docs.privos.ai/guide/file-management.html',
      singleChoice(
        'foundations-question-files',
        'Tệp trong PrivOS nên được lưu ở đâu để đồng đội tìm lại đúng ngữ cảnh?',
        [['room', 'Trong room liên quan'], ['personal', 'Chỉ trên máy cá nhân']],
        'room',
        'Tệp đặt trong room liên quan có thể được tìm kiếm và giữ cùng lịch sử công việc.',
      ),
    ),
    module(
      'foundations', 'lists', 5, 'Lists và dữ liệu có cấu trúc',
      'Làm quen với bảng, kanban, trường dữ liệu và luồng trạng thái.',
      'https://docs.privos.ai/guide/lists.html',
      singleChoice(
        'foundations-question-lists',
        'Lists phù hợp nhất với nhu cầu nào?',
        [['structured', 'Theo dõi dữ liệu có cấu trúc và trạng thái'], ['passwords', 'Chia sẻ mật khẩu']],
        'structured',
        'Lists là các vùng chứa dữ liệu linh hoạt cho tác vụ, quy trình, danh mục và nhiều nghiệp vụ khác.',
      ),
    ),
    module(
      'foundations', 'notifications-and-apps', 6, 'Thông báo và MCP Apps',
      'Điều chỉnh thông báo và nhận biết cách ứng dụng mở rộng hoạt động trong PrivOS.',
      'https://docs.privos.ai/guide/mcp-apps.html',
      singleChoice(
        'foundations-question-notifications-apps',
        'MCP App truy cập tính năng PrivOS theo nguyên tắc nào?',
        [['scopes', 'Theo quyền và scope được cấp'], ['all', 'Luôn có toàn quyền']],
        'scopes',
        'MCP App chạy trong môi trường giới hạn và chỉ dùng những quyền đã được cấp.',
      ),
    ),
  ],
);

const advanced = template(
  'privos-advanced',
  'advanced',
  'Vận hành PrivOS chuyên sâu',
  'Lộ trình dành cho nhân sự chuyên sâu về Sandbox, Bot, AI workflow, quyền ứng dụng và cô lập room.',
  [
    module(
      'advanced', 'sandbox', 1, 'Sandbox và AI Assistant',
      'Hiểu cách phiên AI được cô lập và sử dụng đúng dữ liệu trong phạm vi được phép.',
      'https://docs.privos.ai/guide/ai-assistant.html',
      singleChoice(
        'advanced-question-sandbox',
        'Mục tiêu chính của sandbox là gì?',
        [['isolation', 'Cô lập thực thi và dữ liệu theo phạm vi'], ['sharing', 'Mở toàn bộ dữ liệu giữa các room']],
        'isolation',
        'Sandbox tạo ranh giới an toàn cho tác vụ AI và giảm nguy cơ truy cập chéo.',
      ),
    ),
    module(
      'advanced', 'bots', 2, 'Phát triển và vận hành Bot',
      'Nắm vòng đời Bot, sự kiện kích hoạt và nguyên tắc cấp quyền tối thiểu.',
      'https://docs.privos.ai/guide/developer/bot-development.html',
      singleChoice(
        'advanced-question-bots',
        'Bot nên được cấp quyền theo cách nào?',
        [['least', 'Chỉ cấp quyền tối thiểu cần thiết'], ['owner', 'Luôn cấp quyền Owner']],
        'least',
        'Quyền tối thiểu cần thiết giới hạn tác động khi cấu hình hoặc thông tin xác thực gặp sự cố.',
      ),
    ),
    module(
      'advanced', 'ai-workflows', 3, 'AI workflows và phê duyệt',
      'Thiết kế luồng sự kiện, quyết định AI, hành động và điểm kiểm soát của con người.',
      'https://docs.privos.ai/guide/admin/sandbox-bot.html',
      singleChoice(
        'advanced-question-ai-workflows',
        'Khi workflow thực hiện hành động nhạy cảm, nên bổ sung gì?',
        [['approval', 'Điểm phê duyệt của con người'], ['silence', 'Tắt toàn bộ nhật ký']],
        'approval',
        'Điểm phê duyệt giúp duy trì giám sát con người trước hành động có ảnh hưởng lớn.',
      ),
    ),
    module(
      'advanced', 'app-permissions', 4, 'Quyền của MCP App',
      'Đọc scope, kiểm tra quyền và áp dụng nguyên tắc deny-by-default.',
      'https://docs.privos.ai/guide/admin/mcp-platform.html',
      singleChoice(
        'advanced-question-app-permissions',
        'Khi app chưa được cấp một scope, hành vi an toàn mặc định là gì?',
        [['deny', 'Từ chối truy cập'], ['allow', 'Cho phép tạm thời']],
        'deny',
        'Nền tảng MCP áp dụng ranh giới quyền rõ ràng và từ chối quyền chưa được cấp.',
      ),
    ),
    module(
      'advanced', 'room-isolation', 5, 'Cô lập dữ liệu theo room',
      'Bảo vệ dữ liệu bằng cách truyền và kiểm tra room hiện hành trên mọi thao tác.',
      'https://docs.privos.ai/guide/team-communication.html',
      singleChoice(
        'advanced-question-room-isolation',
        'Một dịch vụ xử lý dữ liệu room cần kiểm tra điều gì trước tiên?',
        [['actor-room', 'Danh tính người gọi và room hiện hành'], ['theme', 'Giao diện sáng hay tối']],
        'actor-room',
        'Ràng buộc người gọi với room hiện hành ngăn truy cập chéo không được phép.',
      ),
    ),
  ],
);

export const SYSTEM_TEMPLATES: readonly TemplateSnapshot[] = deepFreeze([foundations, advanced]);

export function getSystemTemplate(id: string, version: number): TemplateSnapshot | undefined {
  return SYSTEM_TEMPLATES.find((item) => item.id === id && item.version === version);
}
