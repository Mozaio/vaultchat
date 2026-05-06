export type ToastKind = "default" | "success" | "warning" | "danger";

export type ToastItem = {
  id: string;
  message: string;
  kind: ToastKind;
};

type Listener = (toasts: ToastItem[]) => void;

const listeners = new Set<Listener>();
let toasts: ToastItem[] = [];

function notify() {
  const snap = [...toasts];
  for (const l of listeners) l(snap);
}

export function pushToast(
  message: string,
  kind: ToastKind = "default",
  durationMs = 3800
): void {
  const id =
    (globalThis.crypto?.randomUUID?.() as string | undefined) ??
    `${Date.now()}-${Math.random()}`;
  toasts = [...toasts, { id, message, kind }];
  notify();
  window.setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    notify();
  }, durationMs);
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
