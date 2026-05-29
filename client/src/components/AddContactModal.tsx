import { useCallback, useEffect, useState } from "react";
import { searchUsers, type ApiUser } from "../lib/api";
import { IconX } from "./Icons";

const MIN_SEARCH_CHARS = 3;

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

  const performSearch = useCallback(async (searchQuery: string) => {
    if (searchQuery.trim().length < MIN_SEARCH_CHARS) {
      setResults([]);
      return;
    }

    setIsSearching(true);
    setError(null);

    try {
      const { users } = await searchUsers(sessionToken, searchQuery);
      setResults(users.filter((user) => user.id !== sessionUserId));
    } catch {
      setError("Suche fehlgeschlagen. Bitte erneut versuchen.");
      setResults([]);
    } finally {
      setIsSearching(false);
    }
  }, [sessionToken, sessionUserId]);

  useEffect(() => {
    if (searchTimeout) {
      clearTimeout(searchTimeout);
    }

    if (query.trim().length < MIN_SEARCH_CHARS) {
      setResults([]);
      return;
    }

    const timeout = setTimeout(() => {
      performSearch(query);
    }, 300);

    setSearchTimeout(timeout);

    return () => {
      clearTimeout(timeout);
    };
  }, [query, performSearch]);

  const handleSelectUser = (user: ApiUser) => {
    onContactSelected(user);
    onClose();
    setQuery("");
    setResults([]);
  };

  const handleClose = useCallback(() => {
    onClose();
    setQuery("");
    setResults([]);
    setError(null);
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, handleClose]);

  if (!isOpen) return null;

  const trimmedQuery = query.trim();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={handleClose}
    >
      <div
        className="app-surface w-full max-w-md rounded-2xl p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold" style={{ color: "var(--text)" }}>
              Kontakt hinzufügen
            </h2>
            <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
              Suche nur nach Username. Keine Telefonnummer nötig.
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-lg p-1 hover:bg-[var(--bg-hover)]"
            aria-label="Kontakt-Dialog schliessen"
            style={{ color: "var(--text-muted)" }}
          >
            <IconX size={18} />
          </button>
        </div>

        <div className="mb-4">
          <div className="relative">
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Username suchen..."
              className="app-input w-full pr-10"
              autoFocus
              aria-label="Kontakt nach Username suchen"
            />
            {isSearching && (
              <span
                className="absolute right-3 top-1/2 -translate-y-1/2"
                style={{ color: "var(--text-muted)" }}
              >
                ...
              </span>
            )}
          </div>
          <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
            Mindestens {MIN_SEARCH_CHARS} Zeichen für die Suche eingeben.
          </p>
        </div>

        {error && (
          <div
            className="mb-4 rounded-lg p-3 text-sm"
            style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
          >
            {error}
          </div>
        )}

        <div className="max-h-64 overflow-y-auto">
          {trimmedQuery.length < MIN_SEARCH_CHARS && (
            <div className="py-8 text-center" style={{ color: "var(--text-muted)" }}>
              <p className="text-sm">Tippe mindestens {MIN_SEARCH_CHARS} Zeichen, um zu suchen.</p>
              <p className="mt-1 text-xs">Registrierte Nutzer können direkt hinzugefügt werden.</p>
            </div>
          )}

          {trimmedQuery.length >= MIN_SEARCH_CHARS && !isSearching && results.length === 0 && (
            <div className="py-8 text-center" style={{ color: "var(--text-muted)" }}>
              <p className="text-sm">Keine Ergebnisse gefunden.</p>
              <p className="mt-1 text-xs">Eigene Accounts werden nicht als Kontakt angezeigt.</p>
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
                      Kontakt hinzufügen und Chat starten
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="mt-4 border-t pt-4" style={{ borderColor: "var(--border)" }}>
          <p className="text-center text-xs" style={{ color: "var(--text-muted)" }}>
            Kontakte werden lokal ausgewählt. Der Server sieht keine privaten Nachrichten.
          </p>
        </div>
      </div>
    </div>
  );
}
