'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

type Theme = 'dark' | 'light';

const KEY = 'ombuds-theme';

/**
 * Light and dark. Dark is the default because the palette is built on #1b191f.
 *
 * The choice is kept in localStorage, which can throw in a private window, so every read
 * and write is wrapped. If storage is unavailable the toggle still works for the session.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>('dark');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(KEY);
    } catch {
      stored = null;
    }
    const current =
      stored === 'light' || stored === 'dark'
        ? (stored as Theme)
        : (document.documentElement.dataset.theme as Theme) || 'dark';
    setTheme(current);
    setReady(true);
  }, []);

  function flip() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      // A private window cannot remember the choice. That is survivable.
    }
  }

  return (
    <button
      type="button"
      onClick={flip}
      aria-label={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}
      title={theme === 'dark' ? 'Light' : 'Dark'}
      className={`grid h-9 w-9 place-items-center border border-line bg-surface text-text-2 transition-colors hover:border-line-strong hover:text-text ${className ?? ''}`}
      style={{ borderRadius: 'var(--radius-hair)' }}
    >
      {ready && theme === 'dark' ? <Sun size={15} aria-hidden="true" /> : <Moon size={15} aria-hidden="true" />}
    </button>
  );
}

export default ThemeToggle;
