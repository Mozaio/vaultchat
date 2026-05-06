import { useEffect, useState } from "react";
import { subscribeToasts, type ToastItem } from "../lib/toastBus";

export function ToastRegion() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => subscribeToasts(setItems), []);
  if (items.length === 0) return null;
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
