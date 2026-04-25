# VaultChat

Sicherheitsorientierter **Browser-Chat** mit selbstentwickeltem **Double Ratchet v4 (AEAD + AAD)**, **Sealed Sender** für DMs und Gruppen, **Zero-Knowledge-Relay**, **TOFU-Pinning mit MITM-Erkennung**, **automatischer Gruppenschlüssel-Rotation**, **verschlüsselter lokaler Historie (at rest)**, **Offline-Outbox ohne Server-Mailbox**, **Auto-Lock**, **Längen-Padding**, **verschwindenden Nachrichten**, **Sprachnachrichten**, **WebRTC-Calls mit TURN- und Relay-Only-Modus** und einer **Sicherheitsnummer mit Emoji-Sequenz** für Out-of-Band-Verifikation.

- Der Server speichert **nichts** dauerhaft und kennt bei DMs weder Absender noch Inhalt (Sealed Sender).
- Die Chat-Historie liegt **nur im Browser** und ist dort mit einem aus dem Identity-Secret abgeleiteten Local Data Key verschlüsselt.
- Alle Inhalte, Reaktionen, Antworten, Bearbeitungen, Löschungen, Lesebestätigungen, Gruppen-Keys und Voice Notes sind **Ende-zu-Ende verschlüsselt** — der Server sieht sie nicht.

**Ehrlicher Anspruch:** kein auditierter Signal-Ersatz. Siehe [`THREAT_MODEL.md`](./THREAT_MODEL.md).

## Feature-Übersicht

| Bereich | Status |
|---|---|
| Registrierung / Login mit Argon2id (Server nur RAM) | ✔ |
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
| **Offline-Outbox** (client-seitig, verschlüsselt) mit Retry | ✔ |
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

Hinweis: Server-Nutzer und Gruppen leben nur im **RAM** — nach Neustart neu registrieren.

## Produktion

```bash
export VAULTCHAT_JWT_SECRET="$(openssl rand -base64 48)"
# Optional: erlaubte Client-/Connect-Origins, kommagetrennt
export VAULTCHAT_CORS_ORIGIN="https://chat.example.org"
export VAULTCHAT_CLIENT_ORIGINS="https://chat.example.org"
export VAULTCHAT_CONNECT_ORIGINS="https://chat.example.org"
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
- **Double Ratchet v4**: libsodium-basierte Eigen­implementierung. Symmetrische BLAKE2b-Kette (Forward Secrecy), DH-Ratchet pro neuem Peer-Public-Key (Post-Compromise Security), AEAD über `crypto_aead_xchacha20poly1305_ietf` mit Header-Binding via AAD (Magic, Flags, Ratchet-Pub, Counter). Domain-getrennte KDFs (`vaultchat-dr-v4-*`).
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
| `VAULTCHAT_CORS_ORIGIN` | CORS-Origin, kommagetrennt; in Produktion default geschlossen |
| `VAULTCHAT_CLIENT_ORIGINS` | Zusätzliche erlaubte CSP-Origins |
| `VAULTCHAT_CONNECT_ORIGINS` | Zusätzliche erlaubte `connect-src` Origins |
| `VAULTCHAT_SERVE_SPA` | `1` = statisches Frontend aus `/client/dist` ausliefern |
| `VAULTCHAT_STUN_URL` | Override des Default-STUN (Google) |
| `VAULTCHAT_TURN_URL` | TURN-URL (`turn:...` / `turns:...`) |
| `VAULTCHAT_TURN_USER` | TURN-Username |
| `VAULTCHAT_TURN_PASS` | TURN-Passwort |
| `VAULTCHAT_FORCE_RELAY` | `1` = Clients kriegen Hinweis, Relay-Only zu nutzen |

## Security Roadmap

Die installierbare/native Release-Strategie ist in [`SECURITY_ROADMAP.md`](./SECURITY_ROADMAP.md) dokumentiert. Bis dahin bleiben Sicherheitsclaims bewusst auf Web-App-Niveau begrenzt.

## Lizenz

MIT — siehe [`LICENSE`](./LICENSE).
