/**
 * Globale Tastatur-Shortcuts für VaultChat.
 */
import { useEffect } from "react";

export type ShortcutHandler = {
  onSearch?: () => void;
  onEscape?: () => void;
  onSend?: () => boolean; // true wenn Nachricht gesendet wurde
  onLock?: () => void;
};

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

      if (isInput && (e.ctrlKey || e.metaKey) && e.key === "Enter") {
        const sent = handlers.onSend?.();
        if (sent) e.preventDefault();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handlers]);
}

