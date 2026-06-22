import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  getOrBuildIndex,
  search as searchIndex,
} from "../lib/searchIndex";
import { IconSearch, IconX } from "./Icons";
import { t, useLocale } from "../lib/i18n";
import { useFocusTrap } from "../lib/useFocusTrap";

/**
 * Wrap each occurrence of a query term in <mark> so matches stand out in
 * the result list. Terms shorter than 2 chars are ignored to avoid
 * highlighting nearly every character. Purely presentational — operates on
 * the already-decrypted local preview text.
 */
function highlightMatches(text: string, query: string): ReactNode {
  const terms = query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  if (terms.length === 0) return text;
  const lowerTerms = terms.map((t) => t.toLowerCase());
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(${escaped.join("|")})`, "gi");
  return text.split(re).map((part, i) =>
    lowerTerms.includes(part.toLowerCase()) ? (
      <mark key={i} className="search-highlight">
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

type SearchHit = {
  key: string;
  type: "dm" | "group";
  peerId?: string;
  groupId?: string;
  title: string;
  preview: string;
  timestamp: number;
  cid: string;
};

export function SearchPanel({
  users,
  groups,
  onSelect,
  onClose,
}: {
  users: { id: string; username: string }[];
  groups: { id: string; name: string }[];
  onSelect: (type: "dm" | "group", id: string, cid?: string) => void;
  onClose: () => void;
}) {
  useLocale();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef);

  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const groupById = useMemo(
    () => new Map(groups.map((g) => [g.id, g])),
    [groups]
  );

  const performSearch = useCallback(async () => {
    const normalized = query.trim();
    if (!normalized) {
      setResults([]);
      return;
    }

    setSearching(true);
    try {
      // Index lazy bauen (idempotent, einmal pro Session aus IDB rehydriert).
      await getOrBuildIndex();
      const hitDocs = searchIndex(normalized, { limit: 50 });
      const hits: SearchHit[] = hitDocs.map((doc) => {
        if (doc.scope === "dm") {
          const peer = userById.get(doc.scopeId);
          return {
            key: `dm:${doc.id}`,
            type: "dm",
            peerId: doc.scopeId,
            title: peer?.username ?? t("search.unknown"),
            preview: doc.body.slice(0, 140),
            timestamp: doc.at,
            cid: doc.cid,
          };
        }
        const group = groupById.get(doc.scopeId);
        const sender = doc.fromUserId
          ? userById.get(doc.fromUserId)
          : undefined;
        return {
          key: `group:${doc.id}`,
          type: "group",
          groupId: doc.scopeId,
          title: `${group?.name ?? t("chat.groupFallback")} — ${sender?.username ?? t("search.unknown")}`,
          preview: doc.body.slice(0, 140),
          timestamp: doc.at,
          cid: doc.cid,
        };
      });
      setResults(hits);
    } finally {
      setSearching(false);
    }
  }, [query, userById, groupById]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") void performSearch();
    if (e.key === "Escape") onClose();
  };

  // Live search with 250ms debounce — local IDB lookup, fast enough.
  useEffect(() => {
    const t = setTimeout(() => {
      void performSearch();
    }, 250);
    return () => clearTimeout(t);
  }, [query, performSearch]);

  // Escape schließt auch, wenn der Fokus auf einem Ergebnis-Button liegt
  // (der Input-onKeyDown greift nur, solange das Eingabefeld fokussiert ist).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="search-panel-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t("search.title")}
    >
      <div ref={panelRef} className="search-panel" onClick={(e) => e.stopPropagation()}>
        <div className="search-header">
          <input
            ref={inputRef}
            autoFocus
            type="text"
            placeholder={t("search.messages")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="search-input"
          />
          <button
            type="button"
            onClick={() => void performSearch()}
            disabled={searching}
            className="theme-toggle"
            title={t("search.search")}
            aria-label={t("search.search")}
          >
            {searching ? <span aria-hidden>…</span> : <IconSearch size={18} />}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="theme-toggle"
            title={t("common.close")}
            aria-label={t("search.close")}
          >
            <IconX size={18} />
          </button>
        </div>

        <div className="search-results">
          {!query.trim() && (
            <div className="search-empty">
              <IconSearch size={26} aria-hidden />
              <p className="search-empty-title">{t("search.title")}</p>
              <p className="search-empty-hint">
                {t("search.localHint")}
              </p>
            </div>
          )}
          {results.length === 0 && query.trim() && !searching && (
            <div className="search-empty">{t("search.noResults")}</div>
          )}
          {results.map((hit) => (
            <button
              key={hit.key}
              className="search-hit"
              onClick={() => {
                const id = hit.type === "dm" ? hit.peerId : hit.groupId;
                if (!id) return;
                onSelect(hit.type, id, hit.cid);
              }}
            >
              <div className="search-hit-title">
                {highlightMatches(hit.title, query)}
              </div>
              <div className="search-hit-preview">
                {highlightMatches(hit.preview, query)}
              </div>
              <div className="search-hit-time">
                {new Date(hit.timestamp).toLocaleString("de-DE")}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

