import {
  AuditOutlined,
  BellOutlined,
  BookOutlined,
  CloseOutlined,
  CommentOutlined,
  DashboardOutlined,
  FileTextOutlined,
  MenuOutlined,
  ReadOutlined,
  TeamOutlined,
  TrophyOutlined,
} from '@ant-design/icons';
import { useEffect, useState, type ComponentType, type ReactNode } from 'react';

import type { BootstrapResult } from './api';
import {
  routesForAccess,
  type NavigationIcon,
  type OnboardingRoute,
} from './navigation';
import { ThemeToggle } from '../theme-provider';

const ICONS: Readonly<Record<NavigationIcon, ComponentType<{ className?: string }>>> = {
  overview: DashboardOutlined,
  employees: TeamOutlined,
  templates: FileTextOutlined,
  feedback: CommentOutlined,
  evaluations: AuditOutlined,
  learning: ReadOutlined,
  results: TrophyOutlined,
};

function initials(value: string): string {
  return value.split(/[._\s-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'U';
}

export function AppShell({
  bootstrap,
  roomName,
  activeRoute,
  onNavigate,
  children,
}: {
  bootstrap: BootstrapResult;
  roomName?: string;
  activeRoute: OnboardingRoute;
  onNavigate: (route: OnboardingRoute) => void;
  children: ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const routes = routesForAccess(bootstrap.role);
  const current = routes.find((item) => item.id === activeRoute) ?? routes[0];

  useEffect(() => setDrawerOpen(false), [activeRoute]);

  const navigation = (
    <nav className="primary-nav" aria-label="Điều hướng Onboarding">
      {routes.map((item) => {
        const Icon = ICONS[item.icon];
        const active = item.id === activeRoute;
        return (
          <button
            key={item.id}
            type="button"
            className={`nav-item${active ? ' nav-item-active' : ''}`}
            aria-current={active ? 'page' : undefined}
            onClick={() => onNavigate(item.id)}
          >
            <Icon className="nav-icon" />
            <span>{item.label}</span>
            {active && <span className="nav-active-mark" />}
          </button>
        );
      })}
    </nav>
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><BookOutlined /></div>
          <div><strong>Onboarding</strong><span>for PrivOS</span></div>
        </div>
        <div className="workspace-chip">
          <span className="workspace-dot" />
          <div><small>ROOM HIỆN TẠI</small><strong>{roomName || 'PrivOS Workspace'}</strong></div>
        </div>
        {navigation}
        <div className="sidebar-foot">
          <span className={`role-pill role-${bootstrap.role}`}>{bootstrap.role === 'admin' ? 'Quản trị viên' : 'Nhân sự'}</span>
          <small>Dữ liệu được bảo vệ theo room</small>
        </div>
      </aside>

      <div className="app-column">
        <header className="topbar">
          <div className="topbar-heading">
            <button className="icon-button menu-button" type="button" aria-label="Mở menu" onClick={() => setDrawerOpen(true)}>
              <MenuOutlined />
            </button>
            <div><span className="eyebrow">PrivOS Onboarding</span><h1>{current.label}</h1></div>
          </div>
          <div className="topbar-actions">
            <ThemeToggle />
            <button className="icon-button" type="button" aria-label="Thông báo" title="Thông báo"><BellOutlined /></button>
            <div className="profile-block">
              <div className="avatar">{initials(bootstrap.identity.username)}</div>
              <div><strong>{bootstrap.identity.username}</strong><span>{bootstrap.role === 'admin' ? 'Admin của room' : 'Thành viên'}</span></div>
            </div>
          </div>
        </header>

        <main className="app-content">{children}</main>
      </div>

      {drawerOpen && (
        <div className="drawer-backdrop" role="presentation" onMouseDown={() => setDrawerOpen(false)}>
          <aside className="mobile-drawer" aria-label="Menu Onboarding" onMouseDown={(event) => event.stopPropagation()}>
            <div className="brand drawer-brand">
              <div className="brand-mark"><BookOutlined /></div>
              <div><strong>Onboarding</strong><span>for PrivOS</span></div>
              <button className="icon-button drawer-close" type="button" aria-label="Đóng menu" onClick={() => setDrawerOpen(false)}><CloseOutlined /></button>
            </div>
            {navigation}
          </aside>
        </div>
      )}
    </div>
  );
}
