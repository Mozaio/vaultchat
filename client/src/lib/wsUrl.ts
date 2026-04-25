/** WebSocket URL for realtime; auth is sent as the first frame, not in URL logs. */
export function getWsUrl(): string {
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
    return `${ws}/ws`;
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}
