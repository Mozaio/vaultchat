import { useEffect, useState, type ReactNode } from "react";
import { getTheme, setTheme, type Theme } from "../lib/themeStore";
import { IconMoon, IconSettings, IconSun } from "./Icons";

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

  const icons: Record<Theme, ReactNode> = {
    light: <IconSun size={17} />,
    dark: <IconMoon size={17} />,
    system: <IconSettings size={17} />,
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

