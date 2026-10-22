import {
  ArrowRightOutlined,
  AuditOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  FileDoneOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { PrivosAppProvider, usePrivosApp, usePrivosContext } from '@privos_ai/app-react';

import { ThemeProvider } from './theme-provider';
import { OnboardingApi, type AdminBootstrapSummary, type BootstrapResult } from './onboarding/api';
import { AppShell } from './onboarding/AppShell';
import { AdminDashboard } from './onboarding/admin-dashboard';
import { EmptyState, ErrorState, LoadingState } from './onboarding/components';
import { EmployeesPage } from './onboarding/employees';
import { LearnerDashboard } from './onboarding/learner-dashboard';
import { LearningWorkspace } from './onboarding/learning-workspace';
import { defaultRouteForAccess, routesForAccess, type OnboardingRoute } from './onboarding/navigation';
import { ResultsPage } from './onboarding/results';
import { EssayFeedbackPage, EvaluationsPage } from './onboarding/reviews';
import { TemplatesPage } from './onboarding/templates';

function StatCard({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: number; tone: string }) {
  return (
    <article className="stat-card">
      <div className={`stat-icon stat-${tone}`}>{icon}</div>
      <div><span>{label}</span><strong>{value}</strong></div>
    </article>
  );
}

function AdminFoundation({ summary, route }: { summary: AdminBootstrapSummary; route: OnboardingRoute }) {
  if (route !== 'admin-overview') {
    const copy: Record<string, [string, string]> = {
      employees: ['Quản lý nhân sự', 'Gán onboarding thủ công, phân loại nhân sự và theo dõi tiến độ trong room.'],
      templates: ['Thư viện template', 'Dùng template PrivOS có sẵn hoặc xây nội dung riêng từ tài liệu của room.'],
      'essay-feedback': ['Nhận xét tự luận', 'Đọc câu trả lời và phản hồi riêng cho từng câu tự luận đã nộp.'],
      evaluations: ['Đánh giá chung', 'Tổng hợp kết quả và công bố kết luận Đạt, Không đạt hoặc Làm lại.'],
    };
    const [title, description] = copy[route] ?? ['Onboarding', 'Không gian làm việc onboarding.'];
    return <EmptyState title={title} description={description} icon={<SafetyCertificateOutlined />} />;
  }
  return (
    <div className="page-stack">
      <section className="welcome-card">
        <div>
          <span className="welcome-kicker"><CheckCircleFilled /> Hệ thống đã sẵn sàng</span>
          <h2>Xây hành trình hội nhập rõ ràng cho từng nhân sự.</h2>
          <p>Quản lý tài liệu, bài tập và đánh giá trong một luồng thống nhất, được cô lập theo room PrivOS.</p>
        </div>
        <div className="welcome-orb"><SafetyCertificateOutlined /></div>
      </section>
      <section className="stats-grid" aria-label="Tổng quan onboarding">
        <StatCard icon={<TeamOutlined />} label="Lượt onboarding" value={summary.assignmentCount} tone="blue" />
        <StatCard icon={<FileDoneOutlined />} label="Template" value={summary.templateCount} tone="violet" />
        <StatCard icon={<ClockCircleOutlined />} label="Chờ nhận xét" value={summary.pendingEssayCount} tone="amber" />
        <StatCard icon={<AuditOutlined />} label="Chờ đánh giá" value={summary.pendingEvaluationCount} tone="green" />
      </section>
      <section className="content-card quick-start">
        <div><span className="section-kicker">BẮT ĐẦU NHANH</span><h2>Thiết lập lượt onboarding tiếp theo</h2><p>Chọn thành viên trong room, loại nhân sự và phiên bản template phù hợp.</p></div>
        <button className="button button-primary" type="button">Đi tới Nhân sự <ArrowRightOutlined /></button>
      </section>
    </div>
  );
}

function MountedRoute({ id, activeRoute, children }: { id: OnboardingRoute; activeRoute: OnboardingRoute; children: ReactNode }) {
  const active = id === activeRoute;
  return <section className="route-panel" data-onboarding-route={id} hidden={!active} aria-hidden={active ? undefined : true}>{children}</section>;
}

export function AdminWorkspace({ api, summary, route, onNavigate }: { api: OnboardingApi; summary: AdminBootstrapSummary; route: OnboardingRoute; onNavigate: (route: OnboardingRoute) => void }) {
  return <>
    <MountedRoute id="admin-overview" activeRoute={route}><AdminDashboard api={api} onOpenEmployees={() => onNavigate('employees')} /></MountedRoute>
    <MountedRoute id="employees" activeRoute={route}><EmployeesPage api={api} /></MountedRoute>
    <MountedRoute id="templates" activeRoute={route}><TemplatesPage api={api} onUseTemplate={() => onNavigate('employees')} /></MountedRoute>
    <MountedRoute id="essay-feedback" activeRoute={route}><EssayFeedbackPage api={api} /></MountedRoute>
    <MountedRoute id="evaluations" activeRoute={route}><EvaluationsPage api={api} /></MountedRoute>
    {!['admin-overview', 'employees', 'templates', 'essay-feedback', 'evaluations'].includes(route) && (
      <AdminFoundation summary={summary} route={route} />
    )}
  </>;
}

export function LearnerWorkspace({ api, route, onNavigate }: { api: OnboardingApi; route: OnboardingRoute; onNavigate: (route: OnboardingRoute) => void }) {
  const [selectedAssignmentId, setSelectedAssignmentId] = useState<string | null>(null);
  const openLearning = (assignmentId: string) => {
    setSelectedAssignmentId(assignmentId);
    onNavigate('my-learning');
  };
  return <>
    <MountedRoute id="my-overview" activeRoute={route}><LearnerDashboard api={api} onContinue={openLearning} onOpenResults={() => onNavigate('results')} /></MountedRoute>
    <MountedRoute id="my-learning" activeRoute={route}><LearningWorkspace api={api} assignmentId={selectedAssignmentId} onBack={() => onNavigate('my-overview')} onSubmitted={() => onNavigate('results')} /></MountedRoute>
    <MountedRoute id="results" activeRoute={route}><ResultsPage api={api} onRetry={openLearning} /></MountedRoute>
  </>;
}

function OnboardingRoot() {
  const app = usePrivosApp();
  const context = usePrivosContext();
  const api = useMemo(() => new OnboardingApi(app), [app]);
  const [bootstrap, setBootstrap] = useState<BootstrapResult | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [route, setRoute] = useState<OnboardingRoute | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await api.bootstrap();
      setBootstrap(result);
      setRoute((current) => current && routesForAccess(result.role).some((item) => item.id === current)
        ? current
        : defaultRouteForAccess(result.role));
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error('Không thể tải dữ liệu onboarding.'));
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { window.__privosUiBooted = true; }, []);

  return (
    <ThemeProvider hostTheme={context.theme}>
      {!bootstrap && !error && <div className="bootstrap-screen"><LoadingState /></div>}
      {!bootstrap && error && <div className="bootstrap-screen"><ErrorState error={error} onRetry={() => void load()} /></div>}
      {bootstrap && route && (
        <AppShell bootstrap={bootstrap} roomName={context.roomName} activeRoute={route} onNavigate={setRoute}>
          {bootstrap.role === 'admin'
            ? <AdminWorkspace api={api} summary={bootstrap.summary as AdminBootstrapSummary} route={route} onNavigate={setRoute} />
            : <LearnerWorkspace api={api} route={route} onNavigate={setRoute} />}
        </AppShell>
      )}
    </ThemeProvider>
  );
}

export default function App() {
  return <PrivosAppProvider name="PrivOS Onboarding" version="1"><OnboardingRoot /></PrivosAppProvider>;
}
