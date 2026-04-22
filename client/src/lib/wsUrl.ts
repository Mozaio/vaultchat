/** WebSocket URL for realtime; in production use same host + wss. */
export function getWsUrl(token: string): string {
  const raw = (
    import.meta.env.VITE_WS_URL ??
    import.meta.env.VITE_API_BASE ??
    ""
  )
    .trim()
    .replace(/\/$/, "");
  if (raw) {
    const ws = raw
      .replace(/^https:\/\//i, "wss://")
      .replace(/^http:\/\//i, "ws://");
    return `${ws}/ws?token=${encodeURIComponent(token)}`;
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`;
}
