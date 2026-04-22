import { useCallback, useMemo, useRef, useState } from "react";
import { idbListAllDm, idbListAllGroupMsgs } from "../lib/idb";
import type { PlainPayload } from "../lib/crypto";

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
    const normalized = query.toLowerCase().trim();
    if (!normalized) {
      setResults([]);
      return;
    }

    setSearching(true);
    const hits: SearchHit[] = [];
    try {
      const dms = await idbListAllDm();
      for (const msg of dms) {
        let plain: PlainPayload;
        try {
          plain = JSON.parse(msg.plainJson) as PlainPayload;
        } catch {
          continue;
        }
        const body = (plain.body ?? "").toLowerCase();
        if (!body.includes(normalized)) continue;
        const peer = userById.get(msg.peerId);
        hits.push({
          key: `dm:${msg.id}`,
          type: "dm",
          peerId: msg.peerId,
          title: peer?.username ?? "Unbekannt",
          preview: (plain.body ?? "").slice(0, 140),
          timestamp: msg.at,
          cid: plain.cid ?? msg.id,
        });
      }

      const groupMsgs = await idbListAllGroupMsgs();
      for (const msg of groupMsgs) {
        let plain: PlainPayload;
        try {
          plain = JSON.parse(msg.plainJson) as PlainPayload;
        } catch {
          continue;
        }
        const body = (plain.body ?? "").toLowerCase();
        if (!body.includes(normalized)) continue;
        const group = groupById.get(msg.groupId);
        const sender = userById.get(msg.fromUserId);
        hits.push({
          key: `group:${msg.id}`,
          type: "group",
          groupId: msg.groupId,
          title: `${group?.name ?? "Gruppe"} — ${sender?.username ?? "Unbekannt"}`,
          preview: (plain.body ?? "").slice(0, 140),
          timestamp: msg.at,
          cid: plain.cid ?? msg.id,
        });
      }

      hits.sort((a, b) => b.timestamp - a.timestamp);
      setResults(hits.slice(0, 50));
    } finally {
      setSearching(false);
    }
  }, [query, userById, groupById]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") performSearch();
    if (e.key === "Escape") onClose();
  };

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
            onClick={performSearch}
            disabled={searching}
            className="theme-toggle"
            title="Suchen"
          >
            {searching ? "…" : "🔍"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="theme-toggle"
            title="Schließen"
          >
            ✕
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

