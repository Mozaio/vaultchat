# Communities / Spaces (Discord-Parität) — Design-Spec

**GOAL Phase 3:** „Spaces/Server mit mehreren Kanälen unter einer Community".
Status: **Design only — bewusst NICHT in einem Schuss gebaut.**

Dies ist der **große architektonische** Punkt der Phase 3. Eine Community ist
ein Discord-artiger „Server": ein Container mit **mehreren Kanälen**, einer
**gemeinsamen Mitgliedschaft** und einem **Rollenmodell**, wobei **jeder Kanal
einzeln Ende-zu-Ende-verschlüsselt** ist. Diese Spec hält den
privatsphäre-wahrenden Entwurf + eine sicher inkrementell baubare Zerlegung
fest, damit der nächste Block ihn gegen klare Akzeptanzkriterien umsetzt — statt
eine große E2EE-Kanal-Architektur zu überstürzen (Risiko fürs Schlüsselmodell).

## Nordstern / Privatsphäre-Grenze

Der Server bleibt **zero-knowledge** und lernt durch Communities **nichts
Neues** über Inhalte:

- Der Server kennt nur **opake Routing-Metadaten**: Community-ID (UUID),
  Kanal-IDs (UUIDs), Mitglieds-IDs (`memberIds`), Admin-IDs (`adminIds`) — exakt
  die Art Metadaten, die er für Gruppen heute schon hält (`StoredGroup`).
- **Community-Name/-Beschreibung/-Avatar UND Kanal-Namen** sind **E2EE**, genau
  wie Gruppen-Metadaten heute (`GMETA1:`-Ciphertext via Group Master Key,
  `groupSecret.ts`, #25). Der Server speichert nur Platzhalter + Ciphertext und
  sieht den echten Namen nie.
- Kanal-Nachrichten laufen über den **bestehenden Sealed-Group-Pfad** (#26):
  ohne `fromUserId`, nur opaker Ciphertext, Fan-out an die Kanal-Mitglieder.
- **Keine** serverseitige Kanal-Verzeichnis-Suche, **kein** Public Discovery von
  Communities (das stünde im Konflikt mit Metadaten-Minimierung — siehe
  GOAL-Privatsphäre-Regel). Beitritt nur per **Einladungslink** (vorhandene,
  nicht-enumerierbare Token, `inviteStore.ts`).

Die ehrliche Grenze ist dieselbe wie bei Gruppen heute: die **Mitglieder-/
Admin-Liste pro Kanal** ist server-sichtbares Routing-Metadatum. Die
vollständige Härtung (Mitgliedschaft komplett vor dem Server verbergen) ist die
separate **zkgroup**-Arbeit (`ZKGROUP_SPEC.md`) und kein Blocker für diese Spec.

## Datenmodell

Eine Community ist eine dünne Klammer um **N Kanäle**, wobei jeder Kanal
kryptografisch im Wesentlichen die **heutige Gruppe** ist (eigener GMK + Megolm-
Session + Rotation). Das ist der Schlüssel-Hebel: **wir erfinden keine neue
Krypto**, sondern setzen die auditierte Gruppen-Schicht pro Kanal wieder ein.

```
Community
  id            : UUID (server-opak)
  metaCipher    : GMETA1: (Name/Beschreibung/Avatar, E2EE über Community-GMK)
  memberIds[]   : UUIDs            (Routing, server-sichtbar)
  adminIds[]    : UUIDs            (Rollen, wie groupRoles.ts; Ersteller immer Admin)
  createdByUserId
  createdAt
  channels[]    : ChannelRef[]

ChannelRef
  id            : UUID (server-opak)   — ist zugleich eine groupId im Bestand
  communityId   : UUID
  nameCipher    : GMETA1: (Kanal-Name, E2EE)
  kind          : "text"  (später "voice")
  position      : number (Sortierung; Klartext-Ordnungszahl, kein Geheimnis)
  memberMode    : "all" | "subset"   — siehe „Kanal-Sichtbarkeit"
```

### Schlüsselmodell (kein Eigenbau)

- **Pro Kanal** gibt es einen eigenen **GMK** (`groupSecret.ts`) und damit eine
  eigene Megolm-Session + eigene Rotation. Ein Kanal = eine Gruppe im heutigen
  Sinn. **Forward Secrecy bleibt pro Kanal erhalten**: wer aus einem Kanal
  entfernt wird, verliert über die vorhandene Rotation dessen künftige
  Schlüssel.
- **Community-GMK** (separat, eigene Epoche) verschlüsselt **nur** die
  Community-Metadaten (Name/Avatar) und die **Kanal-Namen** — nicht den
  Nachrichteninhalt. So kann ein Mitglied die Kanal-Liste lesbar darstellen,
  ohne automatisch jeden Kanal entschlüsseln zu können (bei `subset`-Kanälen).
- **Verteilung**: GMKs werden — wie heute — über den **Olm-1:1-Kanal** an die
  Mitglieder verteilt (huckepack/dedizierter Frame), gedrosselt pro
  Empfänger/Epoche. Beitritt/Verlassen rotiert den/die betroffenen GMK(s).

### Kanal-Sichtbarkeit

- `memberMode: "all"` (Default, MVP): Kanal-Mitglieder = Community-Mitglieder.
  Beitritt zur Community = Zugang zu allen `all`-Kanälen. Einfachster, sicherer
  Pfad.
- `memberMode: "subset"` (später): private Kanäle mit eigener Teilmenge +
  eigenem GMK, der nur an die Teilmenge verteilt wird. Erfordert sorgfältige
  Rotation und ist **nicht** Teil des Fundaments.

## Rollenmodell

Wiederverwendung der in Phase-3-Punkt-1 gebauten, reinen Policy `groupRoles.ts`
(Server) / `groupRoles.ts` (Client-UI-Spiegel):

- **Community-Ebene:** Ersteller ist immer Admin; Admins können Kanäle anlegen/
  umbenennen/löschen, Mitglieder hinzufügen/kicken, Einladungen verwalten,
  Rollen vergeben. Nur der Ersteller degradiert Admins.
- **Kanal-Ebene (MVP):** erbt die Community-Rollen (kein separates Per-Kanal-
  Rollenmodell im Fundament). Per-Kanal-Overrides sind eine spätere Erweiterung.

Die Autorisierung wird **server-seitig** erzwungen (wie bei Gruppen), die
Client-Rollenhelfer sind nur fürs UI-Gating.

## Wire / Endpoints (Entwurf)

Additiv, bricht die bestehenden Gruppen-Endpoints nicht:

- `POST /api/communities` — Community anlegen (Platzhalter-Meta + nachgereichter
  `GMETA1:`-Ciphertext, analog `createGroup`).
- `GET /api/communities` — Communities des Nutzers (opake Routing-Daten +
  Meta-Ciphertext + Kanal-Liste).
- `PATCH /api/communities/:id` — Meta (Name/Avatar-Ciphertext) ändern (admin).
- `POST /api/communities/:id/channels` — Kanal anlegen (admin). Server legt eine
  Gruppe (= Kanal) an und verknüpft sie via `communityId`.
- `PATCH /api/communities/:id/channels/:chId` — Kanal-Name (Ciphertext)/Position.
- `DELETE /api/communities/:id/channels/:chId` — Kanal löschen (admin).
- Mitgliedschaft/Rollen/Invites: **wiederverwenden** der vorhandenen Gruppen-/
  Invite-Endpoints auf Community-Ebene (Beitritt fügt zu allen `all`-Kanälen
  hinzu) — kein neuer Krypto-Pfad.
- Nachrichten: **unverändert** der Sealed-Group-Pfad pro Kanal-ID.

## Zerlegung (sicher inkrementell, jeweils mit Verifikation)

Jedes Teilstück ist einzeln tsc-clean + unit-getestet baubar; die
kryptografischen Kernstücke sind vor jeder UI testbar.

- **C1 — Community-Krypto-Fundament (dormant).** Community-GMK über die
  vorhandene `groupSecret.ts`-Primitive (eigener Scope `community:<id>`), plus
  Wire-Helfer für Kanal-Namen-Verschlüsselung (`GMETA1:` wiederverwendet).
  Unit-Tests: GMK-Roundtrip, Epoch-Adopt, Kanal-Name-Encrypt/Decrypt. **Kein
  Server, kein UI — tree-shaken, kein Live-Effekt.**
- **C2 — Server-Datenmodell + Endpoints.** `StoredCommunity` + `channels`
  (Kanal = Gruppe mit `communityId`), CRUD-Endpoints (admin-gated über
  `groupRoles`), persistiert wie Gruppen. Server-Tests: Auth/Rollen, Kanal-
  Anlegen/Löschen, Mitglieds-Fan-out. **Server-opak: nur Platzhalter +
  Ciphertext.**
- **C3 — Client-Datenschicht.** `communities.ts` (laden/entschlüsseln der
  Community-/Kanal-Namen mit Platzhalter-Fallback), GMK-Verteilung über Olm
  (Spiegel der heutigen Gruppen-Verteilung).
- **C4 — UI: Community-Sidebar + Kanal-Liste.** Discord-artige zweispaltige
  Navigation (Communities | Kanäle), eingebettet in `ChatShell`. Strings in 10
  Sprachen. Kanal-Auswahl rendert den bestehenden Gruppen-Chat für die Kanal-ID.
- **C5 — Rollen-/Moderations-UI auf Community-Ebene.** Wiederverwendung der
  Rollen-Badges/Promote/Demote/Kick aus Punkt 1; Kanal-Verwaltung (anlegen/
  umbenennen/löschen) für Admins.
- **C6 (später) — private Kanäle (`subset`).** Eigener Per-Kanal-GMK an eine
  Teilmenge, sorgfältige Rotation. **Nicht** Teil des Fundaments.

## Akzeptanz / Verifikation

Vor jedem Commit: `npm run typecheck` (client, 0 Fehler) → `npm test`
(client + server, nur die zwei dokumentierten pre-existing Fails) →
`npm run build` (client). Neue Krypto-/Rollen-Logik bekommt Unit-Tests.
Behaviorale Verifikation (mehrere Kanäle, Beitritt, Kick → kein künftiger
Zugriff) braucht **mehrere echte Accounts** und einen Render-Deploy — daher
USER-gebunden, nicht im Loop abschließbar.

## Warum hier gestoppt wird

Das ist ein E2EE-Architektur-Punkt mit echtem Risiko fürs Schlüsselmodell.
Ein überstürzter Komplettbau in einer Runde würde gegen die CLAUDE.md-Regel
„kleinschrittig, Krypto nie erfinden, Sicherheit > Feature" verstoßen. Das
Fundament (C1) ist gefahrlos vorbaubar; alles ab C2 sollte als eigene,
einzeln verifizierte Runde gegen dieses Spec laufen. In GOAL.md ist der Punkt
daher `- [-]` (dekomponiert, USER-/Multi-Account-gebunden), nicht erfragt.
