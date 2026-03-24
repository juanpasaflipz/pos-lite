import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';

type ThemeMode = 'dark' | 'light' | 'system';

interface ThemeContextType {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  isDark: boolean;
}

const ThemeContext = createContext<ThemeContextType>({
  mode: 'dark',
  setMode: () => {},
  isDark: true,
});

const STORAGE_KEY = 'dk-theme';

function resolveIsDark(mode: ThemeMode): boolean {
  if (mode === 'system') {
    return !window.matchMedia('(prefers-color-scheme: light)').matches;
  }
  return mode === 'dark';
}

export const ThemeProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'system') return stored;
    return 'dark';
  });
  const [isDark, setIsDark] = useState(() => resolveIsDark(mode));

  const applyTheme = useCallback((dark: boolean) => {
    setIsDark(dark);
    if (dark) {
      document.documentElement.classList.remove('light');
    } else {
      document.documentElement.classList.add('light');
    }
  }, []);

  const setMode = useCallback((newMode: ThemeMode) => {
    setModeState(newMode);
    if (newMode === 'dark') {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, newMode);
    }
    applyTheme(resolveIsDark(newMode));
  }, [applyTheme]);

  // Apply on mount and listen for system preference changes
  useEffect(() => {
    applyTheme(resolveIsDark(mode));

    if (mode === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: light)');
      const handler = (e: MediaQueryListEvent) => applyTheme(!e.matches);
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
  }, [mode, applyTheme]);

  return (
    <ThemeContext.Provider value={{ mode, setMode, isDark }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => useContext(ThemeContext);
