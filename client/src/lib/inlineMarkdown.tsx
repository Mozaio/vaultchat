import type { ReactNode } from "react";

/**
 * Single-pass inline markdown renderer for chat messages.
 *
 * Supported, in this priority order:
 *   `code`         -> <code>
 *   **bold**       -> <strong>
 *   ~~strike~~     -> <s>
 *   *italic*       -> <em>
 *   _italic_       -> <em>
 *   https://…      -> <a target="_blank" rel="noopener noreferrer nofollow">
 *
 * Block-level formatting (headings, lists, quotes) is intentionally
 * not supported — it's a chat composer, not a document editor.
 *
 * Whitespace in the input is preserved by the caller (the bubble keeps
 * `white-space: pre-wrap`), so newlines render as line breaks.
 */
const TOKEN = /(`[^`\n]+`|\*\*[^*\n]+\*\*|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_|https?:\/\/[^\s<>"']+)/g;

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
    } else if (tok.startsWith("*") || tok.startsWith("_")) {
      out.push(<em key={key++}>{tok.slice(1, -1)}</em>);
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
