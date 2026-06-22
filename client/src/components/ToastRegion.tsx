import { useEffect, useState } from "react";
import { subscribeToasts, type ToastItem } from "../lib/toastBus";

export function ToastRegion() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => subscribeToasts(setItems), []);
  // Keep the aria-live container always mounted so screen readers register it
  // up front; only the toasts inside are conditional. A live region inserted
  // together with its first message is unreliably announced. When empty the
  // container has no visible toasts, so it stays invisible.
  return (
    <div className="toast-region" aria-live="polite">
      {items.map((t) => (
        <div
          key={t.id}
          className={`toast${t.kind === "default" ? "" : ` ${t.kind}`}`}
          role="status"
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
