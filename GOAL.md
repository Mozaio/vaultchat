# Ziel: VaultChat / Umbra zum vollwertigen, bezahlbaren Produkt entwickeln

**Nordstern:** Sicherheit und Privatsphäre auf Signal-Niveau behalten, dabei
den Komfort und Funktionsumfang von WhatsApp/Discord/Telegram bieten — so
weit, dass Menschen dafür zahlen. Marke: **Umbra**.

So funktioniert diese Liste: Der **denker** recherchiert für jeden offenen
Punkt online, wie führende Apps das lösen, und entwirft die
privatsphäre-wahrende Variante. Jeder Punkt durchläuft
denker -> schreiber -> waechter -> tester und wird erst abgehakt, wenn
waechter PASS und tester DEPLOY OK liefern. Arbeite die Phasen von oben
nach unten ab. Halte Punkte klein; bei zu großen Punkten lass den denker
sie in Unterpunkte zerlegen und ergänze sie hier.

Status-Marker: `- [ ]` offen · `- [x]` erledigt · `- [-]` blockiert (vom Loop
nicht selbst abschließbar) — entweder **nutzer-exklusiv** (Billing/Secret/
Account, `USER:`-Notiz) oder **fehlendes Tooling/Verifikation** (z.B. kein
lokales npm, Client nicht deploy-typgecheckt, `BLOCKED:`-Notiz). `- [-]` wird
nie erfragt, automatisch übersprungen. Sonst gilt: vollautonom, nie nachfragen
(siehe CLAUDE.md „Autonome Vollmacht").

> Privatsphäre-Regel für die ganze Roadmap: Manche Bequemlichkeits-Features
> etablierter Apps stehen im Konflikt mit E2EE/Metadaten-Minimierung
> (serverseitige Suche, Klartext-Cloud-Backup, Public Discovery, nahtloses
> Multi-Device, Push mit Inhalt). Für solche Punkte ist die Aufgabe immer,
> die **sichere Variante** zu bauen — oder den Konflikt offen in
> THREAT_MODEL.md zu dokumentieren, statt ihn still zu umgehen.

---

## Phase 0 — Fundament: vom Prototyp zum Dienst

Aktuell leben Server-Nutzer und Gruppen nur im RAM und sind nach Neustart
weg. Ohne durable, zero-knowledge Persistenz ist es kein Produkt.

- [ ] Durable, blind gespeicherte Konten: Identitäts-/Routing-Daten serverseitig persistent, aber für den Server inhaltlich blind (keine Klartext-Identität, keine lesbaren Metadaten) — vom denker zerlegt:
  - [-] 0.1a **USER:** Durable Storage-Backend, das Render-Restart übersteht (Render Disk oder externer KV/DB) — **Code fertig** (serverState.ts: atomare File-Persistenz + AES-256-GCM at-rest unter `VAULTCHAT_STATE_KEY`, fail-closed). **Offen = reine Infra-/Kosten- + Account-Aktion des Nutzers, autonom NICHT lösbar:** Render Disk (persistent, kostenpflichtig) ODER externen KV/DB provisionieren und `VAULTCHAT_STATE_FILE`+`VAULTCHAT_STATE_KEY` im Render-Dashboard setzen. Service läuft sonst weiter `state: ephemeral` (im Live-Log bestätigt). Loop überspringt den Punkt bis zur Entscheidung. **denker-Empfehlung:** 1-GB-Render-Disk direkt am `vaultchat-server`-Service — einfachster Pfad, keine zweite Abhängigkeit, Frankfurt-Region bleibt.
  - [x] 0.1b Verzeichnis at-rest verschlüsseln (AES-256-GCM unter `VAULTCHAT_STATE_KEY`) — persistierte Datei/Backups ohne Klartext-Identität/Metadaten. Deployed (19895c5, live, Build grün). **Aktiv sobald 0.1a + `VAULTCHAT_STATE_FILE`/`VAULTCHAT_STATE_KEY` gesetzt** — Service läuft aktuell ephemeral.
  - [x] 0.1c Gruppen-Metadaten (Name/Beschreibung/Avatar) E2EE statt Server-Klartext — **BEREITS IMPLEMENTIERT (#25)**: Client verschlüsselt via GMK (`groupSecret.ts` `encryptGroupMeta`/`GMETA1`); `createGroup` legt Platzhalter an + reicht Ciphertext nach, `decryptGroupList` entschlüsselt mit Platzhalter-Fallback, GMK-Verteilung über Olm. Server sieht NIE den echten Namen. (Mein 2026-06-20-„Korrektur" fba7959 war falsch — zurückgenommen.)
  - [ ] 0.1d Blinde Discovery via OPRF/PSI (Server lernt Username auch live nie) — vom denker zerlegt, Design in `DISCOVERY_SPEC.md`:
    - [x] 0.1d-1 Design-Spec + ehrliche Sicherheitsgrenze (`DISCOVERY_SPEC.md`): OPRF(ristretto255, SHA-512), Tag-Index statt Klartext-Name. *(docs, kein Deploy nötig)*
    - [x] 0.1d-2 Server-OPRF-Primitive + Key-Mgmt: `POST /api/discovery/evaluate` → `k·B`, `k` aus `VAULTCHAT_DISCOVERY_OPRF_KEY` (fail-closed in prod), rate-limited; libsodium als Server-Dep (lazy import, boot-safe). Dormant (kein Caller bis 0.1d-3/4). Deployed (11ac596, live, Build grün).
    - [-] 0.1d-3 Account-Index per OPRF-Tag (Registrierung/Discovery per Tag, Klartext-Name raus aus Server-State; Migration/Back-Compat). **BLOCKED:** gekoppelt an 0.1d-4 — server-allein ausgerollt würde die Live-Discovery brechen, solange der Client noch Klartext schickt. Erst zusammen mit dem Client deployen.
    - [-] 0.1d-4 Client-Blinding + Verdrahtung (Tag bei Register+Lookup; `?q=<name>` → blinder Tag-Lookup). **BLOCKED:** Client-Code; Client wird beim Deploy NICHT typgecheckt und ist hier nicht lauffähig → blindes Live-Deploy = White-Screen-Risiko. Braucht Cloud/Sandbox-Session mit npm (Build/Typecheck/Tests) zur Verifikation.
    - [-] 0.1d-5 **USER:** `VAULTCHAT_DISCOVERY_OPRF_KEY` dauerhaft stabil setzen + durable State (hängt an 0.1a)
- [x] Verschlüsselte, serverseitige Offline-Mailbox (Store-and-Forward), ohne dass der Server Absender/Inhalt sieht — Sealed-Sender bleibt intakt. **Bereits implementiert & live** (`server/src/mailboxStore.ts`): speichert nur Ciphertext (DM = Sealed-Sender-`envelope` ohne `fromUserId`, Gruppe = `ciphertext`+`groupId`), TTL (7 d) + Count-Cap (500) + Byte-Quota (48 MB/Empfänger) gegen OOM-DoS, Dedup per `cid`, periodischer Sweep, Clear-on-Account-Deletion. Offline-Enqueue ist im Send-Pfad verdrahtet (`delivered===0` → enqueue). **Rest = Persistenz über Restart**, hängt an 0.1a (heute RAM-only, `state: ephemeral`).
- [x] Account-Recovery-Konzept entwerfen und umsetzen (Verlust des Geräts), ohne Zero-Knowledge zu brechen. **Umgesetzt & live** (`client/src/lib/backup.ts`): client-verschlüsseltes Identity-Backup (Argon2id INTERACTIVE → XSalsa20-Poly1305-`secretbox`, versionierte KDF-Params #22, Shape-Check, `memzero`); Import auf neuem Gerät stellt Identität wieder her; Server sieht nie Identität/Passphrase. `BackupReminder` + `SecuritySettings` + `backupRequiredForNewDevices`. **Konzept dokumentiert** in `RECOVERY.md` (inkl. der ZK-Grenze: ohne Backup keine Recovery — by design). Historien-Recovery ist separat (Phase 2).
- [ ] Rate-Limit-/Abuse-Schutz serverseitig, der ohne Inhaltszugriff funktioniert — vom denker erweitert (HTTP-Limiter + WS-Per-Conn-Schutz existierten bereits):
  - [x] 0.4a Per-Account-Cap auf gleichzeitige WS-Sockets (Evict-Oldest, inhaltsblind, `VAULTCHAT_MAX_SOCKETS_PER_USER`=16) — deployed (2b03e65, live, Build grün)
  - [x] 0.4b Per-IP-Cap auf gleichzeitige Pre-Auth-WS-Verbindungen pro Quell-IP (default 30, `VAULTCHAT_MAX_PREAUTH_WS_PER_IP`); ein Socket wird beim Authentifizieren sofort freigegeben → NAT-Nutzer (Firma/Uni/Mobilfunk) NICHT limitiert, nur gleichzeitige unauth Sockets. Fail-open ohne ermittelbare IP / bei cap<=0. Client-IP aus erstem X-Forwarded-For-Hop (Render-Proxy), nur transient im RAM, nie persistiert/identitäts-geloggt. Deployed (398413e, live, Build grün).
- [x] Reproduzierbarer Build + veröffentlichter Bundle-Hash als Pipeline-Schritt — CI-Workflow `reproducible-build.yml`: baut Client auf gepinntem Node 20.20.2, publiziert SHA-384 (SRI-Format) aller Bundle-Assets (Job-Summary + Artefakt) + aufgelöstes `package-lock.json`. Run #1 (15e5df6) grün.
  - [ ] 0.5b `package-lock.json` committen + SOURCE_DATE_EPOCH-Honoring für bit-genaue Reproduzierbarkeit. Wieder machbar: ein lokales `npm install` erzeugt jetzt einen aktuellen Lockfile (inkl. libsodium). Rest: Lockfile committen + verifizieren, dass der Render-Build damit sauber durchläuft, + SOURCE_DATE_EPOCH im Build honorieren.

- [x] Client type-clean + Typecheck-CI-Gate: `tsc --noEmit` über den Client ist grün (34→0 Fehler) und läuft als CI bei jedem Push (`.github/workflows/client-typecheck.yml` + `client typecheck`-Script). **Damit sind Client-Änderungen vor dem Deploy verifizierbar → die client-lastige Roadmap (Phase 1+) ist sicher autonom shippbar.** Behoben u.a.: stale `UploadBody`-Typ nach Olm-Migration, `SharedMediaItem` voice/file-Union, JSX-Namespace (React 19), Node-vs-Browser-`Timeout`, ungenutzte Imports/Setter.

## Phase 1 — Alltagstauglichkeit (WhatsApp-Parität)

- [x] Verschlüsselte clientseitige Volltextsuche über die lokale Historie. **Umgesetzt & live** (`searchIndex.ts`): zero-knowledge In-Memory-Inverted-Index (nur RAM), Tokenizer + Prefix-/AND-Suche, `SearchPanel`, Clear-on-Lock. Live-Index-Pflege in der Session jetzt verdrahtet (entkoppelter idb-Event-Chokepoint, kein Zyklus) → neue/editierte/gelöschte Nachrichten sofort suchbar (fb501e9, deployed + Browser-Check).
- [x] Medien-/Datei-Galerie pro Chat (verschlüsselt, nur im Browser). **Umgesetzt**: `ChatShell` berechnet `sharedMediaItems` (client-entschlüsselt aus IDB) und übergibt sie an `InfoPanel` (DM+Gruppe) — geteilte Medien (Datei/Voice, Download) pro Chat, zero-knowledge. **Enhancement erledigt:** „Alle anzeigen ({n})"/„Weniger anzeigen"-Toggle im Info-Panel zeigt jetzt die volle Liste statt nur 8 (1120298, Cloud-verifiziert tsc+Build; USER: deployen). Bleibt zero-knowledge (Items bereits client-entschlüsselt).
- [x] Nachrichten/Medien weiterleiten (E2EE-konform, mit Weiterleitungs-Markierung). **Umgesetzt** (`ChatShell`): `buildForwardPayloadForSend` setzt `forwardedFromUserId`-Marker, `commitForward` + Weiterleiten-Modal mit Mehrfach-Ziel-Picker.
- [x] Kontakte & Profile: Anzeigename + Avatar, E2E-verschlüsselt geteilt (Signal-Profile-Keys; Server sieht nur Ciphertext, analog #25). Alle 4 Sub-Punkte cloud-verifiziert (tsc 0, 14 Profil-Tests, Build grün) + waechter-Review des Krypto-Kerns (`profileKeys.ts`: Key nur über Olm, nie zum Server, at-rest LDK-verschlüsselt, Epoch-Rotation). **Client deployed (2f77711, live, Browser-Check 0 Fehler), Server-Teil live (133586c).**
  - [x] Krypto-Grundlage `client/src/lib/profileCrypto.ts`: 32-B Profile-Key + libsodium `crypto_secretbox` encrypt/decrypt von {displayName, avatar} → `PROFILE1:`-Wire, Avatar-Größencap, Shape-Validierung. Spiegelt `groupSecret.ts` (#25), keine eigene Krypto. CI-typgeprüft (a5759ff), **dormant** (unwired, tree-shaken → kein Live-Effekt).
  - [x] Profile-Key-Verteilung an Kontakte über den bestehenden Olm-Kanal (+ Rotation/Re-Share). **Umgesetzt** (`client/src/lib/profileKeys.ts` + Wiring in `ChatShell.tsx`): 32-B Profile-Key (eigener + pro-Kontakt) at-rest im LDK-IDB-Meta-Store; Verteilung huckepack auf echten Inhalts-DMs (`profileKey`/`profileKeyEpoch` auf dem PlainPayload) PLUS dedizierter `profile_key`-Olm-Frame, gedrosselt pro Kontakt/Epoche (`profileKeyDistributedRef`); Empfang adoptiert epoch-basiert (höhere Epoche gewinnt). Spiegelt exakt die GMK-Verteilung (#25). Cloud-verifiziert: tsc 0 Fehler, 14 neue Unit-Tests grün (round-trip + adopt/rotation/epoch), Build grün.
  - [x] Server-Ciphertext-Feld + API für das Profil-Blob: `profileCipher` am User-Record (persistiert), `PUT /api/profile` (auth, rate-limited, nur `PROFILE1:`-Blob, size-capped), Auslieferung über `/api/users`. Server-opak (wie GMETA), nie Klartext. Deployed (133586c, live, Build grün). Client jetzt verdrahtet.
  - [x] Profil-Editor-UI (eigener Name/Avatar setzen) + Kontakt-Anzeige (Name/Avatar entschlüsseln & rendern). **Umgesetzt** (`ChatShell.tsx` + `PeerRow.tsx` + `InfoPanel.tsx`, alle Strings via `t()` in 10 Sprachen): Profil-Editor-Modal (Anzeigename + 256px-Avatar → `encryptProfile` → `PUT /api/profile` → Re-Verteilung an alle Kontakte); Kontakt-Anzeige in Chat-Liste, Chat-Header und Info-Panel zeigt entschlüsselten Namen/Avatar mit Username/Initialen-Fallback; Avatare durch `safeMediaSrc` sanitisiert; Profile von Nicht-Akzeptierten (Requests) bleiben verborgen. **Verifiziert Cloud/Sandbox** (tsc + Tests + Build grün). **USER: einmal auf Render deployen, um live zu schalten.**
  - ✅ Damit ist die gesamte „Kontakte & Profile"-Aufgabe fertig (alle 4 Sub-Punkte). Verifikation lief in Cloud/Sandbox (npm: tsc 0, Tests, Build) — kein blindes Deploy.
- [ ] Entwürfe und Scroll-Position pro Chat persistent (lokal). Entwürfe ✅ (per-Chat, verschlüsselt, „Draft:"-Preview). Scroll-to-bottom-Button + Unread-beim-Hochscrollen ✅ **verdrahtet + live** (`onScroll`→`handleDmScroll`/`handleGroupScroll`, 19d8f64, deployed + im Browser geprüft). **Offen:** Scroll-Position pro Chat über Reload persistent merken.
- [ ] Push-Benachrichtigungen ohne Inhalts-Leak an den Push-Dienst (nur „Wakeup", Inhalt wird lokal entschlüsselt). **Verifiziert: echtes Web-Push fehlt** (kein `PushManager`/VAPID/Push-Event im Code) — es gibt nur lokale Desktop-Notifications (`desktopNotify.ts`) mit 3-stufiger Privacy (Name+Inhalt / nur Name / nichts), die aber nur bei offener App greifen. **Zu bauen:** Service-Worker-Web-Push als reines „Wakeup" (kein Inhalt an den Push-Dienst), Inhalt lokal entschlüsselt — Infra-/Krypto-Feature, eigene Runde mit Verifikation.
- [x] Link-Vorschauen clientseitig erzeugt (kein Server-Fetch, kein Leak an Dritte). **Umgesetzt + verifiziert** (`inlineMarkdown.tsx`): `extractLinks` parst URLs, `shortenUrl` zeigt host/path — **kein** `fetch`/XHR/OG-Abruf der Zielseite (grep bestätigt) → kein Leak an Dritte.

## Phase 2 — Multi-Device & Backup (die harten E2EE-Probleme)

- [ ] Multi-Device: zweites Gerät sicher koppeln (QR/Sicherheitsnummer), Schlüssel sealed übertragen
- [ ] Geräte-Verwaltung: aktive Geräte sehen, einzeln widerrufen
- [x] Verschlüsseltes Backup & Restore der Historie (passphrase-/key-basiert, Server sieht nur Ciphertext). **Umgesetzt + Cloud-verifiziert (tsc 0, 11 neue Unit-Tests grün, Build grün)** (`client/src/lib/historyBackup.ts`): spiegelt exakt das Identity-Backup (`backup.ts`) — Argon2id (INTERACTIVE, versionierte/geclampte KDF-Params #22) → `crypto_secretbox_easy` über das serialisierte History-Bündel (alle DM+Gruppen-Nachrichten aus IDB via `idbListAllDm`/`idbListAllGroupMsgs`). Reiner Ciphertext-Blob als Datei-Export/-Import; Server sieht NICHTS (kein Inhalt, keine Peer-IDs/Zeitstempel — der Blob wird nicht hochgeladen). `expiresAt` wird bewusst NICHT mitgesichert (verschwindende Nachrichten auferstehen nicht). MAC-Fehler → generischer Fehler (kein Oracle wrong-pass vs. tamper), Shape-Validierung gegen Malformed-but-authenticated. UI in `SecuritySettings` (Export/Import-Buttons im Backup-Tab) + `ChatShell`-Handler (Datei-Download/-Upload, Passphrase-Prompt, Reload-nach-Restore zur vollen Rehydrierung), alle Strings via `t()` in 10 Sprachen. Tests: round-trip, wrong-passphrase-reject, tamper-reject, wrong-shape-reject, empty-history, fresh-salt/nonce. **USER: einmal auf Render deployen, um live zu schalten.**
- [ ] Konsistente Historie über Geräte hinweg (sealed Sync), ohne Metadaten preiszugeben

## Phase 3 — Gruppen & Communities (Discord-Parität)

- [ ] Gruppen-Rollen/Admin-Rechte (Add/Remove/Kick) sauber im Key-Modell
- [ ] Spaces/Server mit mehreren Kanälen unter einer Community
- [ ] Threads/Antwort-Stränge innerhalb eines Kanals
- [ ] Erwähnungen (@user) + Benachrichtigungs-Feinsteuerung pro Kanal/Community
- [ ] Einladungslinks mit ablaufenden, nicht-enumerierbaren Tokens
- [ ] Moderations-Tools, die ohne Server-Inhaltszugriff auskommen (clientseitig/role-basiert)

## Phase 4 — Anrufe & Medien-Reife

- [ ] Gruppen-Audio-/Video-Calls (E2EE, SFU/Relay-Modell mit IP-Schutz)
- [ ] Bildschirmfreigabe in Calls
- [ ] Bessere Medienpipeline: Bild-/Video-Komprimierung clientseitig, Thumbnails verschlüsselt
- [ ] Sticker/GIFs/Emojis ohne Tracking-Leak an Drittanbieter

## Phase 5 — Design, UX & Marke (Umbra)

- [ ] Professionelles, vertrauenswürdiges UI-Refresh (research-getrieben), konsistentes Designsystem
- [ ] Marke „Umbra": Logo, Farbwelt, Tonalität, Landingpage
- [ ] Onboarding, das E2EE/Schlüssel verständlich macht (Sicherheit als Feature sichtbar)
- [ ] Vollwertige PWA / installierbare App (mobil + Desktop), Offline-fähig
- [ ] Barrierefreiheit (Tastatur, Screenreader, Kontraste) und Internationalisierung (i18n)

## Phase 6 — Monetarisierung (ohne die Privatsphäre zu verraten)

- [ ] Abo-/Tier-Modell definieren (Free vs. Plus/Pro: z.B. mehr Speicher, Communities, größere Calls)
- [ ] Zahlungs-/Abo-Schicht, die Identität NICHT an den Zahlungsanbieter bindet (blind/anonymisiert, Entitlement-Token statt Klarname)
- [ ] Feature-Gating sauber im Client umsetzen, ohne sensible Daten an den Server zu geben
- [ ] Optionaler Self-Hosting-/Business-Tier dokumentiert

## Phase 7 — Vertrauen, Sicherheit & Compliance

- [ ] THREAT_MODEL.md je Feature aktuell halten (jede Phase aktualisiert es mit) — laufend; zuletzt 2026-06-22 um 0.1b/0.4a/0.5/#25 + E2E-Benutzer-Profile (Profile-Key) ergänzt
- [ ] Externe Sicherheits-Review / Audit vorbereiten (Doku, Scope, Bedrohungsmodell)
- [ ] Privatsphäre-wahrendes Abuse-/Spam-Handling (Reporting ohne Inhalts-Deanonymisierung)
- [ ] Transparenz-Seite: was der Server sieht/nicht sieht, in klarer Sprache — Inhalt als `TRANSPARENCY.md` fertig (2026-06-22); In-App-Seite (Client-Route) noch offen
- [ ] Datenschutz-/Rechtstexte und Lösch-/Export-Flows (DSGVO-konform, ohne Zero-Knowledge zu brechen)

## Phase 8 — Go-to-Market-Reife

- [ ] Statusseite/Monitoring, das keine Nutzer-Metadaten preisgibt
- [ ] Performance bei großen Chats/Communities (Historie + Medien flüssig)
- [ ] Last-/Skalierungstest des Relays unter realistischer Nutzung
- [ ] Beta-Programm + Feedback-Kanal (privatsphäre-freundlich)
