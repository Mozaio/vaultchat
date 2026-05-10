import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getOrBuildIndex,
  search as searchIndex,
} from "../lib/searchIndex";
import { IconSearch, IconX } from "./Icons";

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
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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
            title: peer?.username ?? "Unbekannt",
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
          title: `${group?.name ?? "Gruppe"} — ${sender?.username ?? "Unbekannt"}`,
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

  return (
    <div className="search-panel-overlay" onClick={onClose}>
      <div className="search-panel" onClick={(e) => e.stopPropagation()}>
        <div className="search-header">
          <input
            ref={inputRef}
            autoFocus
            type="text"
            placeholder="Nachrichten durchsuchen…"
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
            title="Suchen"
            aria-label="Suchen"
          >
            {searching ? <span aria-hidden>…</span> : <IconSearch size={18} />}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="theme-toggle"
            title="Schließen"
            aria-label="Suche schließen"
          >
            <IconX size={18} />
          </button>
        </div>

        <div className="search-results">
          {results.length === 0 && query && !searching && (
            <div className="search-empty">Keine Ergebnisse</div>
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
              <div className="search-hit-title">{hit.title}</div>
              <div className="search-hit-preview">{hit.preview}</div>
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

