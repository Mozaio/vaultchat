/**
 * Whitelist guard for rendering PEER-SUPPLIED attachment bodies as an
 * <img>/<audio>/<video> `src` or a download `href`.
 *
 * Threat model: a malicious peer fully controls the decrypted body, mime
 * and fileName of a message (they are just fields inside the E2EE
 * payload). Rendering the body unchecked as a src/href is an XSS /
 * content-injection vector, e.g. a "javascript:..." body, a
 * "data:text/html,<script>..." body, or a "data:image/svg+xml,<svg
 * onload=...>" body. An "https://..." body in an auto-loaded <img> would
 * also leak the viewer's IP / act as a read-receipt tracking pixel.
 *
 * Legitimate attachments in this app are ALWAYS inline `data:` URLs
 * produced locally via FileReader.readAsDataURL (see sendDmFile /
 * sendDmVoice). So we allow only:
 *   - `data:` URLs whose media type is a known inert binary kind
 *     (raster images / audio / video / non-markup files)
 *   - `blob:` URLs (only ever created locally by this app)
 * and reject everything else (returns "" so nothing dangerous renders).
 * We deliberately do NOT allow `https:` for rendered media, to avoid the
 * IP-leak vector above.
 */

export type MediaKind = "image" | "audio" | "video" | "file";

// Raster images only — NOT image/svg+xml (SVG can carry scripts/markup).
const RASTER_IMAGE =
  /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif|x-icon|vnd\.microsoft\.icon)[;,]/i;
const AUDIO = /^data:audio\/[a-z0-9.+-]+[;,]/i;
const VIDEO = /^data:video\/[a-z0-9.+-]+[;,]/i;

// Data media types a browser may execute / render as markup. Blocked for
// the generic "file" download path (everything else, e.g. pdf/text-plain/
// office docs/zip, is fine to offer as a download).
const EXECUTABLE_DATA =
  /^data:(?:text\/html|application\/xhtml|image\/svg|application\/xml|text\/xml|application\/x-xpinstall)/i;

/**
 * Returns `body` if it is safe to use as the given media kind's src/href,
 * otherwise "". Always returns a string so callers can use it directly.
 */
export function safeMediaSrc(
  body: string | null | undefined,
  kind: MediaKind
): string {
  if (typeof body !== "string" || body.length === 0) return "";
  // trimStart() drops leading whitespace (incl. tabs/newlines) an attacker
  // might prepend to smuggle a scheme past a naive prefix check.
  const src = body.trimStart();
  const head = src.slice(0, 12).toLowerCase();

  // App-local blobs are safe; an attacker-supplied blob: URL simply won't
  // resolve in the victim's context and fails closed.
  if (head.startsWith("blob:")) return src;
  if (!head.startsWith("data:")) return "";

  switch (kind) {
    case "image":
      return RASTER_IMAGE.test(src) ? src : "";
    case "audio":
      return AUDIO.test(src) ? src : "";
    case "video":
      return VIDEO.test(src) ? src : "";
    case "file":
      return EXECUTABLE_DATA.test(src) ? "" : src;
    default:
      return "";
  }
}
