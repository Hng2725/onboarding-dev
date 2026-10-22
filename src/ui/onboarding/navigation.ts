export type OnboardingAccess = 'admin' | 'learner';

export type AdminRoute = 'admin-overview' | 'employees' | 'templates' | 'essay-feedback' | 'evaluations';
export type LearnerRoute = 'my-overview' | 'my-learning' | 'results';
export type OnboardingRoute = AdminRoute | LearnerRoute;

export type NavigationIcon =
  | 'overview'
  | 'employees'
  | 'templates'
  | 'feedback'
  | 'evaluations'
  | 'learning'
  | 'results';

export interface NavigationItem {
  readonly id: OnboardingRoute;
  readonly label: string;
  readonly shortLabel: string;
  readonly icon: NavigationIcon;
}

const ADMIN_ROUTES: readonly NavigationItem[] = [
  { id: 'admin-overview', label: 'Tổng quan', shortLabel: 'Tổng quan', icon: 'overview' },
  { id: 'employees', label: 'Nhân sự', shortLabel: 'Nhân sự', icon: 'employees' },
  { id: 'templates', label: 'Template', shortLabel: 'Template', icon: 'templates' },
  { id: 'essay-feedback', label: 'Nhận xét tự luận', shortLabel: 'Tự luận', icon: 'feedback' },
  { id: 'evaluations', label: 'Đánh giá chung', shortLabel: 'Đánh giá', icon: 'evaluations' },
] as const;

const LEARNER_ROUTES: readonly NavigationItem[] = [
  { id: 'my-overview', label: 'Tổng quan của tôi', shortLabel: 'Tổng quan', icon: 'overview' },
  { id: 'my-learning', label: 'Nội dung học', shortLabel: 'Nội dung học', icon: 'learning' },
  { id: 'results', label: 'Kết quả', shortLabel: 'Kết quả', icon: 'results' },
] as const;

export function routesForAccess(access: OnboardingAccess): readonly NavigationItem[] {
  return access === 'admin' ? ADMIN_ROUTES : LEARNER_ROUTES;
}

export function defaultRouteForAccess(access: OnboardingAccess): OnboardingRoute {
  return routesForAccess(access)[0].id;
}
