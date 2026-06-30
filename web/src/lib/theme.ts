// Semi 深色模式：body[theme-mode='dark']；持久化复用历史 key。
const THEME_KEY = "chatgpt2api-theme";

export type ThemeMode = "light" | "dark";

export function getTheme(): ThemeMode {
  return document.body.getAttribute("theme-mode") === "dark" ? "dark" : "light";
}

export function setTheme(mode: ThemeMode) {
  if (mode === "dark") {
    document.body.setAttribute("theme-mode", "dark");
  } else {
    document.body.removeAttribute("theme-mode");
  }
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* ignore */
  }
}

export function toggleTheme(): ThemeMode {
  const next: ThemeMode = getTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}
