/**
 * Gruppen-Rollen / Admin-Rechte — reine, zustandslose Autorisierungs-Policy
 * (GOAL Phase 3, Punkt 1).
 *
 * Designziele
 * ===========
 *  - **Genau eine Rollenstufe über "Mitglied": `admin`.** Das spiegelt die
 *    Realität von Signal-Gruppen ("Admins" vs. Mitglieder) und reicht für die
 *    Discord-Parität auf Gruppenebene. Communities/Spaces (mehr Rollen) sind
 *    ein separater, größerer Punkt (`COMMUNITIES_SPEC.md`).
 *  - **Der Ersteller (`createdByUserId`) ist immer Admin** und kann NICHT
 *    degradiert oder entfernt werden (sonst könnte eine Gruppe "verwaisen" oder
 *    der Ersteller per Kick-Race aus seiner eigenen Gruppe fliegen).
 *  - **Diese Datei trifft KEINE Krypto-Entscheidung.** Rollen sind eine reine
 *    Server-Autorisierungs-Schicht. Das Schlüsselmodell (GMK-/Megolm-Rotation
 *    bei jedem Mitgliedschaftswechsel) bleibt unverändert: Wer entfernt/gekickt
 *    wird, verliert durch die ohnehin stattfindende Rotation alle künftigen
 *    Schlüssel (Forward Secrecy). Rollen entscheiden nur, WER einen
 *    Mitgliedschaftswechsel auslösen darf — nicht, WIE er kryptografisch wirkt.
 *
 * Zero-Knowledge-Grenze
 * =====================
 *  Die Admin-Liste ist — wie die Mitgliederliste (`memberIds`) — ein bereits
 *  server-sichtbares Routing-Metadatum. Sie verrät NICHTS Neues über Inhalte
 *  oder Identitäten, das der Server nicht ohnehin über die Mitgliedschaft weiß.
 *  (Die größere Metadaten-Härtung — Mitgliederliste komplett vom Server
 *  fernhalten — ist die separate zkgroup-Arbeit, `ZKGROUP_SPEC.md`.)
 *
 * Reine Funktionen: kein I/O, keine globale State — voll unit-testbar.
 */

export type GroupRoleView = {
  createdByUserId: string;
  memberIds: readonly string[];
  /** Untermenge von memberIds. Der Ersteller gilt IMMER als Admin, auch wenn
   *  er (z.B. bei Legacy-Gruppen ohne Feld) nicht explizit gelistet ist. */
  adminIds?: readonly string[];
};

/** Effektive Admin-Menge: explizite adminIds ∪ {creator}, geschnitten mit
 *  den aktuellen Mitgliedern (ein Nicht-Mitglied ist nie Admin). */
export function effectiveAdminIds(g: GroupRoleView): Set<string> {
  const members = new Set(g.memberIds);
  const admins = new Set<string>();
  for (const id of g.adminIds ?? []) {
    if (members.has(id)) admins.add(id);
  }
  // Der Ersteller ist immer Admin, solange er Mitglied ist.
  if (members.has(g.createdByUserId)) admins.add(g.createdByUserId);
  return admins;
}

export function isMember(g: GroupRoleView, userId: string): boolean {
  return g.memberIds.includes(userId);
}

export function isAdmin(g: GroupRoleView, userId: string): boolean {
  return effectiveAdminIds(g).has(userId);
}

export function isCreator(g: GroupRoleView, userId: string): boolean {
  return g.createdByUserId === userId;
}

/** Darf `actor` ein Mitglied hinzufügen? Nur Admins. */
export function canAddMember(g: GroupRoleView, actorId: string): boolean {
  return isAdmin(g, actorId);
}

/**
 * Darf `actor` `target` aus der Gruppe entfernen/kicken?
 *  - Selbst-Entfernung (Verlassen) ist immer erlaubt.
 *  - Sonst: nur Admins dürfen kicken.
 *  - Der Ersteller kann von niemandem (außer sich selbst) gekickt werden.
 *  - Ein Admin kann einen anderen Admin nicht kicken; nur der Ersteller darf
 *    Admins entfernen (verhindert Admin-gegen-Admin-Kämpfe / Übernahme).
 */
export function canRemoveMember(
  g: GroupRoleView,
  actorId: string,
  targetId: string
): boolean {
  if (actorId === targetId) return true; // leave
  if (!isAdmin(g, actorId)) return false;
  if (isCreator(g, targetId)) return false; // creator unkickbar
  if (isAdmin(g, targetId) && !isCreator(g, actorId)) return false; // nur creator kickt admins
  return true;
}

/** Darf `actor` Profil (Name/Beschreibung/Avatar) ändern? Nur Admins. */
export function canUpdateProfile(g: GroupRoleView, actorId: string): boolean {
  return isAdmin(g, actorId);
}

/** Darf `actor` Einladungslinks erstellen/auflisten/widerrufen? Nur Admins. */
export function canManageInvites(g: GroupRoleView, actorId: string): boolean {
  return isAdmin(g, actorId);
}

/**
 * Darf `actor` `target` zum Admin befördern? Bestehende Admins dürfen
 * befördern (Mitglied → Admin). Voraussetzung: target ist Mitglied.
 */
export function canPromote(
  g: GroupRoleView,
  actorId: string,
  targetId: string
): boolean {
  if (!isAdmin(g, actorId)) return false;
  if (!isMember(g, targetId)) return false;
  return true;
}

/**
 * Darf `actor` `target` als Admin degradieren?
 *  - Nur der Ersteller darf Admins degradieren (verhindert, dass Admins sich
 *    gegenseitig entmachten).
 *  - Der Ersteller kann NICHT degradiert werden.
 */
export function canDemote(
  g: GroupRoleView,
  actorId: string,
  targetId: string
): boolean {
  if (!isCreator(g, actorId)) return false;
  if (isCreator(g, targetId)) return false;
  return isAdmin(g, targetId);
}
