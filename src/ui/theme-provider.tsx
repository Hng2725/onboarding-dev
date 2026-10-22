import { MoonOutlined, SunOutlined } from '@ant-design/icons';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePrivosApp } from '@privos_ai/app-react';

export type ThemeMode = 'auto' | 'light' | 'dark';
type ResolvedTheme = 'light' | 'dark';

interface ThemeContextValue {
  readonly mode: ThemeMode;
  readonly resolved: ResolvedTheme;
  readonly setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: 'auto',
  resolved: 'light',
  setMode: () => undefined,
});

const STORAGE_KEY = 'onboarding:theme-mode';

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

export function ThemeProvider({ children, hostTheme }: { children: ReactNode; hostTheme: string }) {
  const app = usePrivosApp();
  const [mode, setModeState] = useState<ThemeMode>('auto');

  useEffect(() => {
    let active = true;
    void app.storage.get(STORAGE_KEY).then((stored) => {
      if (active && (stored === 'auto' || stored === 'light' || stored === 'dark')) setModeState(stored);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [app]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    void app.storage.set(STORAGE_KEY, next).catch(() => undefined);
  }, [app]);

  const hostIsDark = hostTheme === 'dark' || hostTheme === 'high-contrast';
  const resolved: ResolvedTheme = mode === 'auto' ? (hostIsDark ? 'dark' : 'light') : mode;

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  const value = useMemo(() => ({ mode, resolved, setMode }), [mode, resolved, setMode]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function ThemeToggle() {
  const { mode, resolved, setMode } = useTheme();
  const next: ThemeMode = mode === 'auto' ? (resolved === 'dark' ? 'light' : 'dark') : mode === 'dark' ? 'light' : 'dark';
  const label = next === 'dark' ? 'Chuyển sang giao diện tối' : 'Chuyển sang giao diện sáng';
  return (
    <button className="icon-button" type="button" aria-label={label} title={label} onClick={() => setMode(next)}>
      {resolved === 'dark' ? <SunOutlined /> : <MoonOutlined />}
    </button>
  );
}
