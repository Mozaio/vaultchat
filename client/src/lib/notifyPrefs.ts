/**
 * Benachrichtigungs-Feinsteuerung pro Chat/Gruppe (GOAL Phase 3, Punkt 3).
 *
 * Discord/Slack-Pattern: drei Stufen statt nur an/aus.
 *   - "all"      → alle Nachrichten benachrichtigen
 *   - "mentions" → nur bei @Erwähnung (nur für Gruppen sinnvoll)
 *   - "none"     → komplett stumm
 *
 * Privatsphäre: rein LOKAL (localStorage). Der Server erfährt NICHTS über die
 * Präferenz — keine Benachrichtigungs-Server-Logik, keine Metadaten. Die
 * @Erwähnungs-Erkennung passiert auf dem ENTSCHLÜSSELTEN Inhalt im Client; der
 * Server sieht weder den Mention noch die Stufe.
 *
 * Back-Compat: die bestehenden Sets `vaultchat.muted.groups`/`.peers` bleiben
 * die "none"-Stufe (ein bereits stummgeschalteter Chat bleibt stumm). Die neue
 * "mentions"-Stufe lebt in einem separaten Set, damit alte Clients/State
 * unverändert funktionieren.
 */

export type NotifyLevel = "all" | "mentions" | "none";

export type NotifyState = {
  /** "none"-Stufe (entspricht dem alten Mute). */
  muted: Set<string>;
  /** "mentions"-Stufe (nur Gruppen). */
  mentionsOnly: Set<string>;
};

/** Aktuelle Stufe für eine ID ableiten. */
export function levelFor(state: NotifyState, id: string): NotifyLevel {
  if (state.muted.has(id)) return "none";
  if (state.mentionsOnly.has(id)) return "mentions";
  return "all";
}

/**
 * Entscheidet, ob für ein eingehendes Ereignis benachrichtigt werden soll.
 *  - "all"      → immer
 *  - "mentions" → nur wenn `mentioned`
 *  - "none"     → nur wenn `mentioned` (Discord: ein direkter @-Ping kommt auch
 *                 bei stummer Gruppe durch — bewusst beibehalten, damit das
 *                 bestehende Verhalten nicht strenger wird).
 *
 * Für DMs gibt es kein sinnvolles `mentioned`; dort ist die Stufe effektiv
 * "all" vs. "none" (mentionsOnly wird für Peers nicht gesetzt).
 */
export function shouldNotify(
  level: NotifyLevel,
  mentioned: boolean
): boolean {
  switch (level) {
    case "all":
      return true;
    case "mentions":
      return mentioned;
    case "none":
      return mentioned;
  }
}

/**
 * Setzt die Stufe für eine ID und liefert die neuen Sets zurück (immutabel).
 * Hält die beiden Sets konsistent: eine ID ist immer in höchstens einem Set.
 */
export function setLevel(
  state: NotifyState,
  id: string,
  level: NotifyLevel
): NotifyState {
  const muted = new Set(state.muted);
  const mentionsOnly = new Set(state.mentionsOnly);
  muted.delete(id);
  mentionsOnly.delete(id);
  if (level === "none") muted.add(id);
  else if (level === "mentions") mentionsOnly.add(id);
  return { muted, mentionsOnly };
}
