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

Status-Marker: `- [ ]` offen · `- [x]` erledigt · `- [-]` blockiert durch eine
**nutzer-exklusive Aktion** (Billing/Secret/Account) — nie erfragen, automatisch
überspringen, eine `USER:`-Notiz sagt, was der Nutzer tun muss. Sonst gilt:
vollautonom, nie nachfragen (siehe CLAUDE.md „Autonome Vollmacht").

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
  - [ ] 0.1d Blinde Discovery via OPRF/PSI (Server lernt Username auch live nie)
- [ ] Verschlüsselte, serverseitige Offline-Mailbox als Option (Store-and-Forward), ohne dass der Server Absender/Inhalt sieht — Sealed-Sender bleibt intakt
- [ ] Account-Recovery-Konzept entwerfen und umsetzen (Verlust des Geräts), ohne Zero-Knowledge zu brechen
- [ ] Rate-Limit-/Abuse-Schutz serverseitig, der ohne Inhaltszugriff funktioniert — vom denker erweitert (HTTP-Limiter + WS-Per-Conn-Schutz existierten bereits):
  - [x] 0.4a Per-Account-Cap auf gleichzeitige WS-Sockets (Evict-Oldest, inhaltsblind, `VAULTCHAT_MAX_SOCKETS_PER_USER`=16) — deployed (2b03e65, live, Build grün)
  - [x] 0.4b Per-IP-Cap auf gleichzeitige Pre-Auth-WS-Verbindungen pro Quell-IP (default 30, `VAULTCHAT_MAX_PREAUTH_WS_PER_IP`); ein Socket wird beim Authentifizieren sofort freigegeben → NAT-Nutzer (Firma/Uni/Mobilfunk) NICHT limitiert, nur gleichzeitige unauth Sockets. Fail-open ohne ermittelbare IP / bei cap<=0. Client-IP aus erstem X-Forwarded-For-Hop (Render-Proxy), nur transient im RAM, nie persistiert/identitäts-geloggt. Deployed (398413e, live, Build grün).
- [x] Reproduzierbarer Build + veröffentlichter Bundle-Hash als Pipeline-Schritt — CI-Workflow `reproducible-build.yml`: baut Client auf gepinntem Node 20.20.2, publiziert SHA-384 (SRI-Format) aller Bundle-Assets (Job-Summary + Artefakt) + aufgelöstes `package-lock.json`. Run #1 (15e5df6) grün.
  - [ ] 0.5b `package-lock.json` committen + SOURCE_DATE_EPOCH-Honoring für bit-genaue Reproduzierbarkeit (lockfile liegt bereits als CI-Artefakt vor)

## Phase 1 — Alltagstauglichkeit (WhatsApp-Parität)

- [ ] Verschlüsselte clientseitige Volltextsuche über die lokale Historie
- [ ] Medien-/Datei-Galerie pro Chat (verschlüsselt, nur im Browser)
- [ ] Nachrichten/Medien weiterleiten (E2EE-konform, mit Weiterleitungs-Markierung)
- [ ] Kontakte & Profile: Anzeigename + Avatar, E2E-verschlüsselt geteilt
- [ ] Entwürfe und Scroll-Position pro Chat persistent (lokal)
- [ ] Push-Benachrichtigungen ohne Inhalts-Leak an den Push-Dienst (nur „Wakeup", Inhalt wird lokal entschlüsselt)
- [ ] Link-Vorschauen clientseitig erzeugt (kein Server-Fetch, kein Leak an Dritte)

## Phase 2 — Multi-Device & Backup (die harten E2EE-Probleme)

- [ ] Multi-Device: zweites Gerät sicher koppeln (QR/Sicherheitsnummer), Schlüssel sealed übertragen
- [ ] Geräte-Verwaltung: aktive Geräte sehen, einzeln widerrufen
- [ ] Verschlüsseltes Backup & Restore der Historie (passphrase-/key-basiert, Server sieht nur Ciphertext)
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

- [ ] THREAT_MODEL.md je Feature aktuell halten (jede Phase aktualisiert es mit) — laufend; zuletzt 2026-06-22 um 0.1b/0.4a/0.5/#25 ergänzt
- [ ] Externe Sicherheits-Review / Audit vorbereiten (Doku, Scope, Bedrohungsmodell)
- [ ] Privatsphäre-wahrendes Abuse-/Spam-Handling (Reporting ohne Inhalts-Deanonymisierung)
- [ ] Transparenz-Seite: was der Server sieht/nicht sieht, in klarer Sprache — Inhalt als `TRANSPARENCY.md` fertig (2026-06-22); In-App-Seite (Client-Route) noch offen
- [ ] Datenschutz-/Rechtstexte und Lösch-/Export-Flows (DSGVO-konform, ohne Zero-Knowledge zu brechen)

## Phase 8 — Go-to-Market-Reife

- [ ] Statusseite/Monitoring, das keine Nutzer-Metadaten preisgibt
- [ ] Performance bei großen Chats/Communities (Historie + Medien flüssig)
- [ ] Last-/Skalierungstest des Relays unter realistischer Nutzung
- [ ] Beta-Programm + Feedback-Kanal (privatsphäre-freundlich)
