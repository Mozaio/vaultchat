import { useEffect, useRef, useState } from "react";
import { IconBarChart, IconLock, IconPlus } from "./Icons";
import { t, useLocale } from "../lib/i18n";

/**
 * "More" overflow menu for the message composer. Keeps the niche toggles
 * (view-once, poll) out of the always-visible tool row so the input stays
 * uncluttered on mobile — emoji + attach remain inline as the primary
 * actions. Shared by the DM and group composers.
 *
 * Outside-click / Escape handling mirrors EmojiPicker: a wrapper ref plus
 * window listeners that are only attached while the menu is open.
 */
export function ComposerToolsMenu({
  viewOnce,
  onToggleViewOnce,
  pollActive,
  onTogglePoll,
}: {
  viewOnce: boolean;
  onToggleViewOnce: () => void;
  pollActive: boolean;
  onTogglePoll: () => void;
}) {
  useLocale();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const anyActive = viewOnce || pollActive;

  return (
    <div className="composer-tools" ref={wrapRef}>
      <button
        type="button"
        className={`chat-tool-button${open || anyActive ? " active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title={t("chat.moreOptions")}
        aria-label={t("chat.moreOptions")}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <IconPlus size={18} />
      </button>
      {open && (
        <div className="composer-tools-menu" role="menu">
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={viewOnce}
            className={`composer-tools-item${viewOnce ? " active" : ""}`}
            onClick={() => {
              onToggleViewOnce();
              setOpen(false);
            }}
          >
            <IconLock size={16} />
            <span>{viewOnce ? t("msg.viewOnceOn") : t("msg.viewOnceShort")}</span>
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={pollActive}
            className={`composer-tools-item${pollActive ? " active" : ""}`}
            onClick={() => {
              onTogglePoll();
              setOpen(false);
            }}
          >
            <IconBarChart size={16} />
            <span>{pollActive ? t("poll.cancel") : t("poll.create")}</span>
          </button>
        </div>
      )}
    </div>
  );
}
