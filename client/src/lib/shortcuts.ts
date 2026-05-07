/**
 * Globale Tastatur-Shortcuts für VaultChat.
 */
import { useEffect } from "react";

export type ShortcutHandler = {
  onSearch?: () => void;
  onEscape?: () => void;
  onSend?: () => boolean; // true wenn Nachricht gesendet wurde
  onLock?: () => void;
  onHelp?: () => void;
};

/** Authoritative list of shortcuts, used by the help modal so the docs
 *  never drift from the implementation. */
export const SHORTCUTS: { keys: string; description: string }[] = [
  { keys: "Ctrl/⌘ + K", description: "Suche öffnen" },
  { keys: "Ctrl/⌘ + L", description: "Sofort sperren" },
  { keys: "Ctrl/⌘ + Enter", description: "Nachricht senden (im Editor)" },
  { keys: "Enter", description: "Nachricht senden (im Composer)" },
  { keys: "Shift + Enter", description: "Neue Zeile" },
  { keys: "Esc", description: "Modal / Menü schließen" },
  { keys: "Doppelklick auf Bubble", description: "Mit 👍 reagieren" },
  { keys: "?", description: "Diese Übersicht öffnen" },
];

export function useShortcuts(handlers: ShortcutHandler) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName ?? "";
      const isInput = tag === "INPUT" || tag === "TEXTAREA";

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        handlers.onSearch?.();
        return;
      }

      if (e.key === "Escape") {
        handlers.onEscape?.();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") {
        e.preventDefault();
        handlers.onLock?.();
        return;
      }

      if (
        !isInput &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        e.key === "?"
      ) {
        e.preventDefault();
        handlers.onHelp?.();
        return;
      }

      if (isInput && (e.ctrlKey || e.metaKey) && e.key === "Enter") {
        const sent = handlers.onSend?.();
        if (sent) e.preventDefault();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handlers]);
}

