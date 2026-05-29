import { LOCALES, setLocale, t, useLocale, type Locale } from "../lib/i18n";

/**
 * Compact language picker. Subscribes to locale changes via useLocale so it
 * (and its label) stay in sync, and persists the choice + flips document
 * direction (RTL) through setLocale.
 */
export function LanguageSwitcher({ className }: { className?: string }) {
  const locale = useLocale();
  return (
    <select
      className={className ?? "lang-switcher"}
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      aria-label={t("lang.label")}
      title={t("lang.label")}
    >
      {LOCALES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.label}
        </option>
      ))}
    </select>
  );
}
