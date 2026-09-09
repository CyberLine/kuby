import { createEffect, createMemo, createRoot, createSignal, onCleanup } from "solid-js";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "kuby.theme";

function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark" || value === "system") {
      return value;
    }
  } catch {
    /* ignore */
  }
  return "system";
}

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyDocumentTheme(resolved: ResolvedTheme) {
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute("content", resolved === "dark" ? "#0b0f14" : "#f3f6f9");
  }
}

async function applyWindowTheme(preference: ThemePreference, resolved: ResolvedTheme) {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTheme(preference === "system" ? null : resolved);
  } catch {
    /* browser preview or missing window permission */
  }
}

function createThemeStore() {
  const [preference, setPreferenceState] = createSignal<ThemePreference>(readPreference());
  const [systemIsDark, setSystemIsDark] = createSignal(systemPrefersDark());

  const resolved = createMemo<ResolvedTheme>(() => {
    const pref = preference();
    if (pref === "system") return systemIsDark() ? "dark" : "light";
    return pref;
  });

  createEffect(() => {
    const pref = preference();
    const appearance = resolved();
    applyDocumentTheme(appearance);
    void applyWindowTheme(pref, appearance);
  });

  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onSchemeChange = (event: MediaQueryListEvent) => {
    setSystemIsDark(event.matches);
  };
  media.addEventListener("change", onSchemeChange);
  onCleanup(() => media.removeEventListener("change", onSchemeChange));

  function setPreference(next: ThemePreference) {
    setPreferenceState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }

  return { preference, resolved, setPreference };
}

export const themeStore = createRoot(createThemeStore);
