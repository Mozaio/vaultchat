/**
 * useFocusTrap — Tastatur-Fokus-Falle für modale Dialoge (WCAG 2.4.3 / 2.1.2).
 *
 * Warum
 * =====
 * Alle Modals der App setzen bereits `role="dialog"` + `aria-modal="true"` und
 * schließen per Escape. Aber der Fokus wurde bisher nie in den Dialog bewegt,
 * nicht eingefangen und beim Schließen nicht zurückgegeben. Für Tastatur- und
 * Screenreader-Nutzer heißt das: nach dem Öffnen liegt der Fokus weiter im
 * Hintergrund, Tab kann aus dem `aria-modal`-Dialog herauslaufen (verbotenes
 * Verhalten), und nach dem Schließen landet der Fokus auf `<body>`.
 *
 * Dieser Hook behebt das rein additiv (keine Verhaltensänderung für die Maus):
 *  1. beim Mounten den Fokus in den Dialog setzen (erstes fokussierbares
 *     Element, sonst der Container selbst),
 *  2. Tab / Shift+Tab am Rand des Dialogs umbrechen (Fokus bleibt drin),
 *  3. beim Unmounten den Fokus auf das zuvor fokussierte Element zurückgeben.
 *
 * Die DOM-freie Kernlogik (Selektor, Filterung, Wrap-Around-Index) ist als
 * reine Funktionen ausgelagert und unit-getestet (`useFocusTrap.test.ts`).
 */
import { useEffect, type RefObject } from "react";

/**
 * CSS-Selektor für potenziell fokussierbare Elemente. Bewusst breit; die
 * tatsächliche Sichtbarkeits-/Disabled-Prüfung passiert in `isFocusable`.
 */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]",
  "audio[controls]",
  "video[controls]",
  "[contenteditable]:not([contenteditable='false'])",
].join(",");

/**
 * Reine Entscheidung, ob ein gefundenes Element wirklich fokussierbar ist:
 * nicht disabled, kein negativer tabindex, nicht (über `display:none` /
 * `visibility:hidden` / `hidden`-Attribut) unsichtbar. `inert` schließt ganze
 * Teilbäume aus.
 *
 * Ausgelagert + injizierbare `getStyle`/`hidden`-Werte, damit die Logik ohne
 * echtes DOM testbar bleibt.
 */
export function isFocusableCandidate(opts: {
  disabled?: boolean;
  tabIndex?: number | null;
  /** `display`-Wert (computed). */
  display?: string;
  /** `visibility`-Wert (computed). */
  visibility?: string;
  /** `hidden`-Attribut / Property. */
  hidden?: boolean;
  /** liegt das Element in einem `inert`-Teilbaum? */
  inInert?: boolean;
}): boolean {
  if (opts.disabled) return false;
  if (opts.hidden) return false;
  if (opts.inInert) return false;
  if (opts.tabIndex != null && opts.tabIndex < 0) return false;
  if (opts.display === "none") return false;
  if (opts.visibility === "hidden" || opts.visibility === "collapse") return false;
  return true;
}

/**
 * Berechnet den Zielindex nach Tab / Shift+Tab mit Wrap-Around.
 *
 * @param current  aktueller Index (oder -1, wenn der Fokus außerhalb liegt)
 * @param count    Anzahl fokussierbarer Elemente (>= 1)
 * @param backward true bei Shift+Tab
 * @returns Index des Elements, das fokussiert werden soll
 */
export function nextFocusIndex(
  current: number,
  count: number,
  backward: boolean
): number {
  if (count <= 0) return -1;
  if (count === 1) return 0;
  if (current < 0) {
    // Fokus außerhalb der Falle: Tab → erstes, Shift+Tab → letztes Element.
    return backward ? count - 1 : 0;
  }
  if (backward) {
    return current === 0 ? count - 1 : current - 1;
  }
  return current === count - 1 ? 0 : current + 1;
}

function inInertSubtree(el: Element | null): boolean {
  let node: Element | null = el;
  while (node) {
    if ((node as HTMLElement).inert || node.getAttribute("inert") !== null) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

/** Sammelt die aktuell wirklich fokussierbaren Elemente innerhalb von `root`. */
export function collectFocusable(root: HTMLElement): HTMLElement[] {
  const nodes = Array.from(
    root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  );
  return nodes.filter((el) => {
    let style: CSSStyleDeclaration | null = null;
    try {
      style = window.getComputedStyle(el);
    } catch {
      style = null;
    }
    const tabIndexAttr = el.getAttribute("tabindex");
    return isFocusableCandidate({
      disabled: (el as HTMLButtonElement).disabled,
      tabIndex: tabIndexAttr == null ? null : Number(tabIndexAttr),
      display: style?.display,
      visibility: style?.visibility,
      hidden: el.hidden,
      inInert: inInertSubtree(el),
    });
  });
}

/**
 * Fängt den Tastatur-Fokus innerhalb des referenzierten Elements ein, solange
 * `active` wahr ist.
 *
 * @param ref    Ref auf den Dialog-Container.
 * @param active Ob die Falle aktiv ist (i.d.R. „Modal offen").
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active = true
): void {
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root || typeof document === "undefined") return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    // Fokus in den Dialog bewegen: erstes fokussierbares Element, sonst den
    // Container selbst (der dafür fokussierbar gemacht wird).
    const focusFirst = () => {
      const focusable = collectFocusable(root);
      if (focusable.length > 0) {
        focusable[0].focus();
      } else {
        if (!root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");
        root.focus();
      }
    };
    // Nach dem Paint fokussieren, damit `autoFocus`-Elemente Vorrang behalten
    // und das DOM vollständig ist.
    const raf =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(() => {
            // Nicht stehlen, wenn der Fokus dank `autoFocus` schon im Dialog ist.
            if (!root.contains(document.activeElement)) focusFirst();
          })
        : (focusFirst(), 0);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusable = collectFocusable(root);
      if (focusable.length === 0) {
        // Nichts fokussierbar: Fokus auf dem Container halten.
        e.preventDefault();
        root.focus();
        return;
      }
      const currentIndex = focusable.indexOf(
        document.activeElement as HTMLElement
      );
      const target = nextFocusIndex(currentIndex, focusable.length, e.shiftKey);
      // Nur eingreifen, wenn wir am Rand umbrechen oder der Fokus außerhalb ist;
      // sonst lässt die native Tab-Reihenfolge sich normal bewegen.
      const atEdge =
        currentIndex < 0 ||
        (e.shiftKey && currentIndex === 0) ||
        (!e.shiftKey && currentIndex === focusable.length - 1);
      if (atEdge) {
        e.preventDefault();
        focusable[target].focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
      // Fokus zurückgeben, falls das vorige Element noch im DOM/sichtbar ist.
      if (
        previouslyFocused &&
        document.contains(previouslyFocused) &&
        typeof previouslyFocused.focus === "function"
      ) {
        try {
          previouslyFocused.focus();
        } catch {
          /* ignore */
        }
      }
    };
  }, [ref, active]);
}
