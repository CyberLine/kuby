import { For } from "solid-js";
import { type ThemePreference, themeStore } from "../stores/theme";

const OPTIONS: {
  id: ThemePreference;
  title: string;
  label: string;
}[] = [
  { id: "system", title: "System default", label: "System" },
  { id: "light", title: "Light mode", label: "Light" },
  { id: "dark", title: "Dark mode", label: "Dark" },
];

function ThemeIcon(props: { id: ThemePreference }) {
  if (props.id === "light") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="2.6" fill="none" stroke="currentColor" stroke-width="1.4" />
        <g stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
          <path d="M8 1.6v1.5M8 12.9v1.5M1.6 8h1.5M12.9 8h1.5M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M3.2 12.8l1.1-1.1M11.7 4.3l1.1-1.1" />
        </g>
      </svg>
    );
  }
  if (props.id === "dark") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M7.1 2.4a5.7 5.7 0 1 0 6.5 7.4A4.9 4.9 0 0 1 7.1 2.4z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect
        x="2"
        y="2.5"
        width="12"
        height="8.2"
        rx="1.4"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
      />
      <path d="M5.5 13.2h5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    </svg>
  );
}

export function ThemeToggle() {
  const { preference, setPreference } = themeStore;

  return (
    <div class="theme-toggle" role="radiogroup" aria-label="Appearance">
      <For each={OPTIONS}>
        {(opt) => (
          <button
            type="button"
            role="radio"
            class={`theme-toggle-btn ${preference() === opt.id ? "active" : ""}`}
            aria-checked={preference() === opt.id}
            title={opt.title}
            onClick={() => setPreference(opt.id)}
          >
            <ThemeIcon id={opt.id} />
            <span class="theme-toggle-label">{opt.label}</span>
          </button>
        )}
      </For>
    </div>
  );
}
