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
  - [ ] 0.1a Durable Storage-Backend, das Render-Restart übersteht (Render Disk oder externer KV/DB) — Infra-/Kostenentscheidung
  - [x] 0.1b Verzeichnis at-rest verschlüsseln (AES-256-GCM unter `VAULTCHAT_STATE_KEY`) — persistierte Datei/Backups ohne Klartext-Identität/Metadaten. Deployed (19895c5, live, Build grün). **Aktiv sobald 0.1a + `VAULTCHAT_STATE_FILE`/`VAULTCHAT_STATE_KEY` gesetzt** — Service läuft aktuell ephemeral.
  - [ ] 0.1c Gruppen-Metadaten (Name/Beschreibung/Avatar) E2EE statt Server-Klartext
  - [ ] 0.1d Blinde Discovery via OPRF/PSI (Server lernt Username auch live nie)
- [ ] Verschlüsselte, serverseitige Offline-Mailbox als Option (Store-and-Forward), ohne dass der Server Absender/Inhalt sieht — Sealed-Sender bleibt intakt
- [ ] Account-Recovery-Konzept entwerfen und umsetzen (Verlust des Geräts), ohne Zero-Knowledge zu brechen
- [ ] Rate-Limit-/Abuse-Schutz serverseitig, der ohne Inhaltszugriff funktioniert — vom denker erweitert (HTTP-Limiter + WS-Per-Conn-Schutz existierten bereits):
  - [x] 0.4a Per-Account-Cap auf gleichzeitige WS-Sockets (Evict-Oldest, inhaltsblind, `VAULTCHAT_MAX_SOCKETS_PER_USER`=16) — deployed (2b03e65, live, Build grün)
  - [ ] 0.4b Per-IP-Cap auf Pre-Auth-WS-Verbindungen (braucht sorgfältiges X-Forwarded-For-Handling hinter Renders Proxy + Verifikation; daher zurückgestellt)
- [ ] Reproduzierbarer Build + veröffentlichter Bundle-Hash als Pipeline-Schritt

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

- [ ] THREAT_MODEL.md je Feature aktuell halten (jede Phase aktualisiert es mit)
- [ ] Externe Sicherheits-Review / Audit vorbereiten (Doku, Scope, Bedrohungsmodell)
- [ ] Privatsphäre-wahrendes Abuse-/Spam-Handling (Reporting ohne Inhalts-Deanonymisierung)
- [ ] Transparenz-Seite: was der Server sieht/nicht sieht, in klarer Sprache
- [ ] Datenschutz-/Rechtstexte und Lösch-/Export-Flows (DSGVO-konform, ohne Zero-Knowledge zu brechen)

## Phase 8 — Go-to-Market-Reife

- [ ] Statusseite/Monitoring, das keine Nutzer-Metadaten preisgibt
- [ ] Performance bei großen Chats/Communities (Historie + Medien flüssig)
- [ ] Last-/Skalierungstest des Relays unter realistischer Nutzung
- [ ] Beta-Programm + Feedback-Kanal (privatsphäre-freundlich)
