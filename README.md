# VaultChat

Sicherheitsorientierter **Browser-Chat** mit selbstentwickeltem **Double Ratchet v4 (AEAD + AAD)**, **Sealed Sender** für DMs und Gruppen, **Zero-Knowledge-Relay**, **TOFU-Pinning mit MITM-Erkennung**, **automatischer Gruppenschlüssel-Rotation**, **verschlüsselter lokaler Historie (at rest)**, **Client-Outbox plus verschluesselter Offline-Mailbox mit TTL**, **Auto-Lock**, **Längen-Padding**, **verschwindenden Nachrichten**, **Sprachnachrichten**, **WebRTC-Calls mit TURN- und Relay-Only-Modus** und einer **Sicherheitsnummer mit Emoji-Sequenz** für Out-of-Band-Verifikation.

- Der Server speichert keine Nachrichten dauerhaft. Optional persistiert er nur Account-Verzeichnis, Gruppenmitgliedschaften und PreKey-Bundles (`VAULTCHAT_STATE_FILE`), damit Identitaeten und sichere neue Sessions Restart-stabil bleiben. DM-Absender und Inhalte bleiben fuer den Relay-Server verborgen (Sealed Sender).
- Die Chat-Historie liegt **nur im Browser** und ist dort mit einem aus dem Identity-Secret abgeleiteten Local Data Key verschlüsselt.
- Alle Inhalte, Reaktionen, Antworten, Bearbeitungen, Löschungen, Lesebestätigungen, Gruppen-Keys und Voice Notes sind **Ende-zu-Ende verschlüsselt** — der Server sieht sie nicht.

**Ehrlicher Anspruch:** kein auditierter Signal-Ersatz. Siehe [`THREAT_MODEL.md`](./THREAT_MODEL.md).
Produktions-Gates und der Weg aus dem Demo-/Preview-Modus sind in [`PRODUCT_READINESS.md`](./PRODUCT_READINESS.md) dokumentiert.

**Audit-Status der Krypto** ist in [`SECURITY_AUDIT_STATUS.md`](./SECURITY_AUDIT_STATUS.md) detailliert aufgeschlüsselt:
- ✅ Primitiven (libsodium, ML-KEM via noble, Argon2) — formal auditiert.
- ⚠️ Selbstgeschriebene DR/X3DH/Group-Logik — nicht extern auditiert.
- 🛣 **Olm/Megolm-Foundation eingebaut** (`@matrix-org/olm`, NCC Group 2016/2020 + Quarkslab 2024 auditiert) — Migration in Phasen geplant, siehe Status-Dokument.

## Feature-Übersicht

| Bereich | Status |
|---|---|
| Registrierung / Login mit Argon2id (optional persistentes Directory) | ✔ |
| 1:1-DM mit **Double Ratchet v4** (XChaCha20-Poly1305 + AAD-Header-Binding) | ✔ |
| **Sealed Sender** DM-Envelope — Server kennt Absender nicht | ✔ |
| **Sealed Group Sender** — `fromUserId` nie auf der Leitung | ✔ |
| **TOFU-Pinning** mit automatischer MITM-Erkennung + UI-Warnung | ✔ |
| Längen-Padding (Bucketing) für Metadaten-Minimierung | ✔ |
| Gruppen mit **automatischer Key-Rotation** bei Add/Remove/Leave | ✔ |
| Reaktionen, Antworten, Bearbeiten, Löschen für alle | ✔ |
| Lesebestätigungen + Zustellbestätigungen (E2EE) | ✔ |
| Verschwindende Nachrichten (pro Chat, 30 s – 7 Tage) | ✔ |
| Sprachnachrichten (Opus via MediaRecorder) | ✔ |
| Datei-Versand (Data-URL, verschlüsselt) | ✔ |
| **Offline-Outbox** client-seitig + serverseitige sealed DM-Mailbox mit TTL/Limit | ✔ |
| **Auto-Lock** nach Inaktivität (10 min) + manueller Lock | ✔ |
| **Code-Hash-Pinning** (SHA-384) + UI-Warnung bei Drift | ✔ |
| WebRTC-Anrufe mit **TURN-Konfiguration** + **Relay-Only-Modus** | ✔ |
| Sicherheitsnummer + Emoji-Sequenz (Signal-Style) | ✔ |
| Verschlüsselte IndexedDB (at rest, Secretbox) | ✔ |
| WebSocket-Relay mit Token-Bucket-Rate-Limit | ✔ |
| Strenge CSP, HSTS, kein Inline-JS | ✔ |
| Subresource Integrity für Bundle | ✔ |
| Typing-Indikator, Fingerprint, verschlüsseltes JSON-Backup | ✔ |

## Entwicklung

Node 20+ erforderlich.

```bash
cd vaultchat
npm install
npm run dev
```

- API/WS: `http://127.0.0.1:8787`
- Web: `http://127.0.0.1:5173`

Hinweis: Ohne `VAULTCHAT_STATE_FILE` leben Server-Nutzer, Gruppen und PreKeys nur im **RAM**. Fuer produktive Deployments sollte diese Datei auf einem persistenten Volume liegen.

## Produktion

```bash
export VAULTCHAT_JWT_SECRET="$(openssl rand -base64 48)"
# Optional: erlaubte Client-/Connect-Origins, kommagetrennt
export VAULTCHAT_CORS_ORIGIN="https://chat.example.org"
export VAULTCHAT_CLIENT_ORIGINS="https://chat.example.org"
export VAULTCHAT_CONNECT_ORIGINS="https://chat.example.org"
# Optional, aber fuer produktive Signal-aehnliche Nutzung empfohlen:
# persistiert nur Directory/Gruppen/PreKeys, keine Nachrichteninhalte.
export VAULTCHAT_STATE_FILE="/var/lib/vaultchat/server-state.json"
# Optional: TURN-Server für WebRTC-Calls hinter NAT
export VAULTCHAT_TURN_URL="turn:turn.example.org:3478"
export VAULTCHAT_TURN_USER="…"
export VAULTCHAT_TURN_PASS="…"
# Optional: Server-forciertes Relay-Only für zusätzliche IP-Privatsphäre
export VAULTCHAT_FORCE_RELAY=1
npm run build
VAULTCHAT_SERVE_SPA=1 npm run start -w server
```

Es werden keine Datenverzeichnisse gebraucht.

### Docker

```bash
docker compose up --build
```

## Sicherheitsprimitive

- **Identität**: X25519-Keypair, Secret mit Argon2id-abgeleitetem Key + `crypto_secretbox` gewickelt.
- **Olm + Megolm (Foundation, Migration in Phasen)**: `@matrix-org/olm` ist als Dependency drin. Olm ist Matrix.orgs DR-Implementation, auditiert von NCC Group 2016 + 2020 und Quarkslab 2024. Die Adapter (`lib/olmAdapter.ts`, `lib/megolmAdapter.ts`) sind eingebaut und tested, aber der ChatShell-Send-Pfad nutzt sie noch nicht (siehe [`SECURITY_AUDIT_STATUS.md`](./SECURITY_AUDIT_STATUS.md)).
- **Double Ratchet v4** *(aktueller Pfad, eigene Implementation, Migration zu Olm geplant)*: libsodium-basiert. Symmetrische BLAKE2b-Kette (Forward Secrecy), DH-Ratchet pro neuem Peer-Public-Key (Post-Compromise Security), AEAD über `crypto_aead_xchacha20poly1305_ietf` mit Header-Binding via AAD (Magic, Flags, Ratchet-Pub, Counter). Domain-getrennte KDFs (`vaultchat-dr-v4-*`).
- **PQXDH-v1 Hybrid-Handshake**: Neue Sessions verwenden, wenn beide Clients es unterstuetzen, X3DH plus ML-KEM-1024 aus `@noble/post-quantum`. Das hybride Secret initialisiert weiterhin den bestehenden Double Ratchet. Alte Bundles ohne PQ-Key fallen automatisch auf X3DH zurueck.
- **Sealed Sender**: Jede DM wird vor dem Versand in `crypto_box_seal(recipient_pk, HEADER||sender_uuid||len||inner)` gewrappt. Der Relay-Server sieht nur `toUserId` + Envelope.
- **Sealed Group Sender**: Gruppenframes haben kein `fromUserId` im Transport. Der Absender liegt verschlüsselt in der Payload (`senderUserId`).
- **TOFU-Pinning**: Client pinnt beim ersten Kontakt den Public-Key. Bei Änderung: Automatisch `mismatch`-Status und Sperre des Send-Flows bis zur Verifizierung.
- **Gruppen**: `crypto_secretbox` mit 32-Byte-Key; Verteilung via sealed-sender-DM. Automatische Rotation bei jeder Mitgliedsänderung.
- **At rest**: Lokaler Datenkey aus `BLAKE2b(secretKey, "vaultchat-local-idb-v1")`; jeder IDB-Record ist Secretbox-Ciphertext.
- **Auto-Lock**: Zähler auf Maus/Tastatur/Visibility; nach 10 min wird `secretKey`/LDK per `memzero` gelöscht.
- **Padding**: Nachrichten werden vor der Verschlüsselung auf Bucket-Größen aufgepolstert.
- **Sicherheitsnummer**: BLAKE2b über sortierte Identity-Pubkeys → 60-Zeichen-Nummer + 8-Emoji-Sequenz. UI erlaubt verifizieren und Re-Pinning nach Key-Wechsel.
- **Code-Integrität**: Client berechnet SHA-384 des Haupt-Bundles und pinnt es verschlüsselt. Bei Drift wird Entsperren blockiert, bis der Nutzer bewusst neu pinnt.
- **WebRTC**: Konfigurierbarer TURN über ENV (`VAULTCHAT_TURN_URL/USER/PASS`). Relay-Only-Modus (`iceTransportPolicy: relay`) filtert lokale Host-/srflx-Kandidaten; server-forciertes Relay entfernt STUN-Fallbacks.
- **Backups**: Identitäts-Backups werden als passwortgeschützte Argon2id/Secretbox-Bundles exportiert. Klartext-Identity-JSON bleibt nur als Legacy-Import kompatibel.
- **Server-Header**: strikte CSP ohne Inline-Skripte, `X-Frame-Options: DENY`, HSTS, Referrer-Policy `no-referrer`, Permissions-Policy restriktiv.

## Environment-Variablen (Server)

| Variable | Zweck |
|---|---|
| `VAULTCHAT_JWT_SECRET` | Pflicht in Prod — signiert JWTs |
| `VAULTCHAT_EMAIL_HASH_SECRET` | Separater Pepper fuer optionale Recovery-E-Mail-HMACs; nicht mit `VAULTCHAT_JWT_SECRET` wiederverwenden |
| `VAULTCHAT_DEPLOYMENT_PROFILE` | `development`, `preview` oder `production`; Production aktiviert Fail-Fast-Konfigurationschecks |
| `VAULTCHAT_ALLOW_EPHEMERAL_STATE` | `1` erlaubt bewusst RAM-only State trotz Production Profile |
| `VAULTCHAT_REGISTRATION_MODE` | `open`, `invite` oder `closed`; Production sollte `invite` oder `closed` nutzen |
| `VAULTCHAT_INVITE_CODES` | Kommagetrennte Einladungscodes fuer `invite` Mode; mit `VAULTCHAT_STATE_FILE` werden genutzte Codes als SHA-256-Hashes gesperrt |
| `VAULTCHAT_INVITE_CODE_HASHES` | Kommagetrennte SHA-256-Hex-Hashes von Einladungscodes |
| `VAULTCHAT_ALLOW_OPEN_REGISTRATION` | `1` erlaubt offene Registrierung trotz Production Profile |
| `VAULTCHAT_CORS_ORIGIN` | CORS-Origin, kommagetrennt; in Produktion default geschlossen |
| `VAULTCHAT_CLIENT_ORIGINS` | Zusätzliche erlaubte CSP-Origins |
| `VAULTCHAT_CONNECT_ORIGINS` | Zusätzliche erlaubte `connect-src` Origins |
| `VAULTCHAT_STATE_FILE` | Optionaler JSON-State fuer Nutzer, Gruppen und PreKey-Bundles; keine Nachrichten-Persistenz |
| `VAULTCHAT_SERVE_SPA` | `1` = statisches Frontend aus `/client/dist` ausliefern |
| `VAULTCHAT_MAILBOX_TTL_MS` | TTL fuer temporaer gespeicherte sealed DM-Envelopes |
| `VAULTCHAT_MAILBOX_MAX_PER_USER` | Obergrenze temporaerer sealed DM-Envelopes pro Empfaenger |
| `VAULTCHAT_STUN_URL` | Override des Default-STUN (Google) |
| `VAULTCHAT_TURN_URL` | TURN-URL (`turn:...` / `turns:...`) |
| `VAULTCHAT_TURN_USER` | TURN-Username |
| `VAULTCHAT_TURN_PASS` | TURN-Passwort |
| `VAULTCHAT_FORCE_RELAY` | `1` = Clients kriegen Hinweis, Relay-Only zu nutzen |
| `VAULTCHAT_MAX_B64_CIPHERTEXT_BYTES` | Maximaler WS-Ciphertext/Envelope-Rahmen; Default ca. 320 MiB für Dateien bis 128 MiB |
| `VAULTCHAT_JSON_LIMIT` | Limit für JSON-API-Requests; Default `12mb` |

## Security Roadmap

Die installierbare/native Release-Strategie ist in [`SECURITY_ROADMAP.md`](./SECURITY_ROADMAP.md) dokumentiert. Bis dahin bleiben Sicherheitsclaims bewusst auf Web-App-Niveau begrenzt.

## Lizenz

MIT — siehe [`LICENSE`](./LICENSE).
