/** Light/dark theme, persisted per browser. Default: light (the ivory look). */

export type Theme = 'light' | 'dark';

export function getTheme(): Theme {
  try {
    return localStorage.getItem('theme') === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem('theme', theme);
  } catch {
    // fine — theme just won't persist
  }
  document.documentElement.classList.toggle('dark', theme === 'dark');
}
