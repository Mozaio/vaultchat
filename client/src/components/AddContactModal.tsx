/**
 * Verbessertes AddContactModal mit Telegram-Style Live-Suche
 * 
 * Features:
 * - Live-Suche während der Eingabe (ab 2 Zeichen)
 * - Keine Liste aller Nutzer mehr
 * - Klare Fehlermeldungen
 * - Schnelle Auswahl aus Suchergebnissen
 */
import { useState, useEffect, useCallback } from "react";
import { searchUsers, type ApiUser } from "../lib/api";

interface AddContactModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessionToken: string;
  sessionUserId: string;
  onContactSelected: (user: ApiUser) => void;
}

export function AddContactModal({
  isOpen,
  onClose,
  sessionToken,
  sessionUserId,
  onContactSelected,
}: AddContactModalProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ApiUser[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTimeout, setSearchTimeout] = useState<ReturnType<typeof setTimeout> | null>(null);

  // Live-Suche mit Debounce
  const performSearch = useCallback(async (searchQuery: string) => {
    if (searchQuery.trim().length < 2) {
      setResults([]);
      return;
    }

    setIsSearching(true);
    setError(null);

    try {
      const { users } = await searchUsers(sessionToken, searchQuery);
      setResults(users);
    } catch (err) {
      setError("Suche fehlgeschlagen. Bitte erneut versuchen.");
      setResults([]);
    } finally {
      setIsSearching(false);
    }
  }, [sessionToken]);

  // Debounced Search
  useEffect(() => {
    if (searchTimeout) {
      clearTimeout(searchTimeout);
    }

    if (query.trim().length < 2) {
      setResults([]);
      return;
    }

    const timeout = setTimeout(() => {
      performSearch(query);
    }, 300); // 300ms Debounce

    setSearchTimeout(timeout);

    return () => {
      if (timeout) clearTimeout(timeout);
    };
  }, [query, performSearch]);

  const handleSelectUser = (user: ApiUser) => {
    onContactSelected(user);
    onClose();
    setQuery("");
    setResults([]);
  };

  const handleClose = () => {
    onClose();
    setQuery("");
    setResults([]);
    setError(null);
  };

  if (!isOpen) return null;

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={handleClose}
    >
      <div 
        className="app-surface w-full max-w-md rounded-2xl p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold" style={{ color: "var(--text)" }}>
            Kontakt hinzufügen
          </h2>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-lg p-1 hover:bg-[var(--bg-hover)]"
          >
            ✕
          </button>
        </div>

        {/* Search Input */}
        <div className="mb-4">
          <div className="relative">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Username suchen..."
              className="app-input w-full pr-10"
              autoFocus
            />
            {isSearching && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400">
                ...
              </span>
            )}
          </div>
          <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
            Mindestens 2 Zeichen für die Suche eingeben
          </p>
        </div>

        {/* Error Message */}
        {error && (
          <div className="mb-4 rounded-lg bg-red-900/30 p-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {/* Search Results */}
        <div className="max-h-64 overflow-y-auto">
          {query.trim().length < 2 && (
            <div className="py-8 text-center" style={{ color: "var(--text-muted)" }}>
              <p className="text-sm">🔍 Tippe mindestens 2 Zeichen um zu suchen</p>
            </div>
          )}

          {query.trim().length >= 2 && !isSearching && results.length === 0 && (
            <div className="py-8 text-center" style={{ color: "var(--text-muted)" }}>
              <p className="text-sm">Keine Ergebnisse gefunden</p>
              <p className="mt-1 text-xs">Versuche einen anderen Username</p>
            </div>
          )}

          {results.length > 0 && (
            <div className="space-y-1">
              {results.map((user) => (
                <button
                  key={user.id}
                  type="button"
                  onClick={() => handleSelectUser(user)}
                  className="flex w-full items-center gap-3 rounded-lg p-3 text-left transition hover:bg-[var(--bg-hover)]"
                >
                  <div 
                    className="flex h-10 w-10 items-center justify-center rounded-full text-sm font-medium"
                    style={{ background: "var(--accent)", color: "white" }}
                  >
                    {user.username.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium" style={{ color: "var(--text)" }}>
                      {user.username}
                    </p>
                    <p className="truncate text-xs" style={{ color: "var(--text-muted)" }}>
                      Klicken um Chat zu starten
                    </p>
                  </div>
                  <span className="text-lg" style={{ color: "var(--accent)" }}>
                    →
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer Hint */}
        <div className="mt-4 pt-4 border-t" style={{ borderColor: "var(--border)" }}>
          <p className="text-center text-xs" style={{ color: "var(--text-muted)" }}>
            💡 Der Benutzer muss bereits registriert sein
          </p>
        </div>
      </div>
    </div>
  );
}
