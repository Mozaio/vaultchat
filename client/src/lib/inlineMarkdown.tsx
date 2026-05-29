import { useState, type ReactNode } from "react";

/**
 * Single-pass inline markdown renderer for chat messages.
 *
 * Supported, in this priority order:
 *   `code`         -> <code>
 *   **bold**       -> <strong>
 *   ~~strike~~     -> <s>
 *   ||spoiler||    -> click-to-reveal hidden text
 *   *italic*       -> <em>
 *   _italic_       -> <em>
 *   https://…      -> <a target="_blank" rel="noopener noreferrer nofollow">
 *   @mention       -> highlighted chip
 *
 * Block-level formatting (headings, lists, quotes) is intentionally
 * not supported — it's a chat composer, not a document editor.
 *
 * Whitespace in the input is preserved by the caller (the bubble keeps
 * `white-space: pre-wrap`), so newlines render as line breaks.
 */
const TOKEN = /(`[^`\n]+`|\*\*[^*\n]+\*\*|~~[^~\n]+~~|\|\|[^|\n]+\|\||\*[^*\n]+\*|_[^_\n]+_|https?:\/\/[^\s<>"']+|@[A-Za-z0-9_]{2,32})/g;

/** Discord-style spoiler: blacked-out until clicked/activated. */
function Spoiler({ children }: { children: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <span
      className={`md-spoiler${revealed ? " revealed" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={revealed ? undefined : "Spoiler"}
      onClick={(e) => {
        if (revealed) return;
        e.stopPropagation();
        setRevealed(true);
      }}
      onKeyDown={(e) => {
        if (!revealed && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          setRevealed(true);
        }
      }}
    >
      {children}
    </span>
  );
}

export function renderInlineMarkdown(text: string): ReactNode[] {
  if (!text) return [];
  const out: ReactNode[] = [];
  let lastIdx = 0;
  let key = 0;
  for (const m of text.matchAll(TOKEN)) {
    const idx = m.index ?? 0;
    if (idx > lastIdx) out.push(text.slice(lastIdx, idx));
    const tok = m[0];
    if (tok.startsWith("`")) {
      out.push(<code key={key++} className="md-code">{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("**")) {
      out.push(<strong key={key++}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("~~")) {
      out.push(<s key={key++}>{tok.slice(2, -2)}</s>);
    } else if (tok.startsWith("||")) {
      out.push(<Spoiler key={key++}>{tok.slice(2, -2)}</Spoiler>);
    } else if (tok.startsWith("*") || tok.startsWith("_")) {
      out.push(<em key={key++}>{tok.slice(1, -1)}</em>);
    } else if (tok.startsWith("@")) {
      // @mention — highlighted chip (group chats). Display-only; the actual
      // notify-on-mention check happens on the receiving side in ChatShell.
      out.push(
        <span key={key++} className="mention">
          {tok}
        </span>
      );
    } else {
      // URL — sanitize so only http(s) gets through; anything else falls
      // back to plain text (defense-in-depth, the regex already guards).
      const url = tok;
      if (/^https?:\/\//i.test(url)) {
        out.push(
          <a
            key={key++}
            href={url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="md-link"
          >
            {url}
          </a>
        );
      } else {
        out.push(url);
      }
    }
    lastIdx = idx + tok.length;
  }
  if (lastIdx < text.length) out.push(text.slice(lastIdx));
  return out;
}

/** Pull every distinct http(s) URL out of a piece of text. Used by the
 *  link-preview card under text bubbles. */
const URL_RE = /https?:\/\/[^\s<>"']+/gi;

export function extractLinks(text: string, max = 3): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?)\]]+$/, ""); // strip trailing punctuation
    if (!seen.has(url) && /^https?:\/\//i.test(url)) {
      seen.add(url);
      out.push(url);
      if (out.length >= max) break;
    }
  }
  return out;
}

/** Pretty-print a URL for the link card: domain + first path segment. */
export function shortenUrl(url: string): { host: string; path: string } {
  try {
    const u = new URL(url);
    const host = u.host.replace(/^www\./, "");
    const path = u.pathname === "/" ? "" : u.pathname;
    return { host, path: path.length > 40 ? path.slice(0, 39) + "…" : path };
  } catch {
    return { host: url, path: "" };
  }
}
