import { useEffect, useRef } from "react";
import { SHORTCUTS } from "../lib/shortcuts";
import { t, useLocale } from "../lib/i18n";
import { useFocusTrap } from "../lib/useFocusTrap";
import { IconX } from "./Icons";

export function ShortcutsHelpModal({ onClose }: { onClose: () => void }) {
  useLocale();
  const cardRef = useRef<HTMLDivElement>(null);
  useFocusTrap(cardRef);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="u-modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcuts-help-title"
    >
      <div
        ref={cardRef}
        className="app-surface u-modal-card w-full max-w-md rounded-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-2">
          <h2
            id="shortcuts-help-title"
            className="text-lg font-semibold"
            style={{ color: "var(--text)" }}
          >
            {t("shortcuts.title")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 hover:bg-[var(--bg-hover)]"
            style={{ color: "var(--text-muted)" }}
            aria-label={t("common.close")}
          >
            <IconX size={18} />
          </button>
        </div>
        <ul className="space-y-1.5">
          {SHORTCUTS.map((s) => (
            <li
              key={s.keys}
              className="flex items-center justify-between gap-3 rounded-lg px-3 py-2"
              style={{ background: "var(--bg-elevated)" }}
            >
              <span
                className="text-sm"
                style={{ color: "var(--text-secondary)" }}
              >
                {s.description}
              </span>
              <kbd className="shortcut-kbd">{s.keys}</kbd>
            </li>
          ))}
        </ul>
        <p
          className="mt-4 text-xs"
          style={{ color: "var(--text-muted)" }}
        >
          Tipp: <kbd className="shortcut-kbd">?</kbd> öffnet diese Liste
          jederzeit.
        </p>
      </div>
    </div>
  );
}
