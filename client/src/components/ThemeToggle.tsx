import { useEffect, useState } from "react";
import { getTheme, setTheme, type Theme } from "../lib/themeStore";

export function ThemeToggle() {
  const [theme, setLocalTheme] = useState<Theme>(getTheme());

  useEffect(() => {
    setLocalTheme(getTheme());
  }, []);

  const cycle = () => {
    const next: Theme =
      theme === "light" ? "dark" : theme === "dark" ? "system" : "light";
    setTheme(next);
    setLocalTheme(next);
  };

  const icons: Record<Theme, string> = {
    light: "☀️",
    dark: "🌙",
    system: "💻",
  };

  return (
    <button
      type="button"
      onClick={cycle}
      title={`Theme: ${theme} (klicken zum wechseln)`}
      className="theme-toggle"
      aria-label={`Aktuelles Theme: ${theme}`}
    >
      {icons[theme]}
    </button>
  );
}

