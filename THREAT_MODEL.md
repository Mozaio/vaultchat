# VaultChat — Bedrohungsmodell

Dieses Projekt priorisiert **Ende-zu-Ende-Verschlüsselung (E2EE)**, **Forward Secrecy**, **Post-Compromise Security**, **Sealed-Sender-Metadata-Minimierung** und **Zero-Knowledge-Server**. Der Server hält **keine** Chat-Inhalte, Historie oder Absenderinformationen. Historie liegt nur **verschlüsselt im Browser (IndexedDB, at rest)**.

Es ist **kein** auditierter Ersatz für Signal/WhatsApp/Matrix. Das Projekt ist Open Source; unabhängige Audits werden empfohlen, sind aber nicht durchgeführt.

## Was wir absichern

### Transport- und Server-Schicht

- **TLS** in Produktion (`https` / `wss`); das Relay lehnt unauthentifizierte WS-Verbindungen ab. Tokens werden im ersten WebSocket-Auth-Frame gesendet, nicht in URLs.
- **RAM-only Verzeichnis**: Benutzer (Name, Argon2id-Hash, Identity-Public-Key), Gruppenmitgliedschaften — nur flüchtig im Arbeitsspeicher. Bei Neustart verschwindet der Verzeichniszustand.
- **Keine Nachrichten-Persistenz**: Der Server leitet Ciphertexts direkt weiter und speichert sie weder kurzzeitig noch dauerhaft.
- **Sealed-Sender DM-Protokoll**: Der Server sieht für DMs ausschließlich `toUserId` + einen opaken `envelope`. Er kennt den Absender einer DM nicht. Der Absender ist kryptografisch nur für den Empfänger sichtbar.
- **Sealed Group Sender**: Gruppenframes werden ohne `fromUserId` relayiert. Der Absender ist Teil der E2EE-Payload; nur Gruppenmitglieder können ihn entschlüsseln.
- **Keine Delivery-Receipts am Server**: Zustell-/Lesebestätigungen sind E2EE-Payloads, kein Server-Metadatum.
- **Strenge HTTP-Header**: `Content-Security-Policy` ohne Inline-Scripts oder externe Ressourcen, `X-Frame-Options: DENY`, `Permissions-Policy` für Kamera/Mikrofon nur auf `self`, `Referrer-Policy: no-referrer`, HSTS.
- **Rate-Limits**: getrennte Limits für Auth, Suche, Gruppen-Operationen und allgemeine API sowie pro WebSocket-Socket (Token-Bucket im Server).
- **Ciphertext-Cap**: WS akzeptiert nur begrenzte Frames für E2EE-Umschläge und verwirft zu große Socket-Messages.

### Kryptografie (Client)

- **Identität**: X25519-Keypair pro Account; Secret wird mit Argon2id + `crypto_secretbox` per Passwort eingeschlossen.
- **1:1-DM: Double Ratchet v4**:
  - Symmetrischer Kettenschlüssel via BLAKE2b-Ratchet mit Domain-Trennung (`vaultchat-dr-v4-ck/next/mk`) → **Forward Secrecy**; Message-Keys werden nach Nutzung überschrieben.
  - DH-Ratchet pro neu empfangenem Peer-Ratchet-Pub → **Post-Compromise Security**.
  - Asymmetrisches Bootstrap via `identity_sk` + Empfänger-Ratchet-Pub + Flag-Bit im Header, kompatibel mit konkurrierenden Erstnachrichten.
  - **AEAD mit AAD-Bindung**: `crypto_aead_xchacha20poly1305_ietf_encrypt` mit Header-Feldern (Magic, Flags, Ratchet-Pub, Counter) als Associated Data → ein Angreifer kann weder Header noch Counter manipulieren.
  - State wird pro Peer im verschlüsselten IndexedDB-Meta-Store abgelegt.
- **Sealed-Sender-Envelope**: Jede DM wird vor dem Verlassen des Clients in einen `crypto_box_seal(recipient_identity_pk, HEADER || sender_uuid || len || inner_ciphertext)` gewrappt. Der Relay-Server kennt den Absender nicht. Der Empfänger entpackt den Envelope und prüft den inneren DR-Wire gegen seinen Ratchet-State für `sender_uuid`; ein gefälschtes `sender_uuid` führt zu Decrypt-Fail.
- **Gruppen**: Symmetrischer Gruppenschlüssel (32 Byte, `crypto_secretbox`); verteilt per DR-DM (und damit selbst sealed-sender). **Automatische Schlüsselrotation** bei Add/Remove/Leave eines Members; der rotierte Key wird neu verteilt, sodass ehemalige Member zukünftige Nachrichten nicht mehr lesen können.
- **Längen-Padding**: Payloads werden vor der Verschlüsselung auf Bucket-Größen (64, 256, 1 KiB, 4 KiB, 16 KiB, 64 KiB, 256 KiB, 1 MiB) aufgepolstert.
- **Zero-Knowledge-Frames**: Reaktionen, Antworten, Bearbeitungen, Löschungen, Lese-/Zustellbestätigungen, Sprachnachrichten, Gruppen-Key-Verteilung sind E2EE-Payloads.
- **Verschwindende Nachrichten**: Sender setzt `ttlMs`; Empfänger berechnet `expiresAt` und purged automatisch aus IDB.
- **Safety Number + TOFU-Pinning**:
  - 60-Zeichen-Nummer + 8-Emoji-Sequenz aus BLAKE2b über die sortierten Identity-PKs.
  - Client pinnt beim ersten Kontakt den Public-Key (**Trust-on-First-Use**).
  - Beim Wechsel des Keys markiert der Client den Peer automatisch als `mismatch`; das Versenden von DMs wird blockiert, bis der Nutzer die Sicherheitsnummer neu verifiziert oder den Wechsel explizit akzeptiert.
  - UI-Badges (`✓ Verifiziert`, `⚠ Schlüssel geändert`) pro Kontakt.

### Offline-Zustellung (Zero-Knowledge Mailbox)

- Der Server liefert bei DMs ein `dm_ack` mit `delivered: n` Flag (Anzahl Sockets des Empfängers).
- Ist der Empfänger offline (`delivered=0`), verbleibt der **bereits sealed** Envelope in der lokalen, LDK-verschlüsselten **Outbox** des Senders.
- Periodischer Retry alle 15 s und automatischer Flush bei WebSocket-Reconnect. Erst wenn der Empfänger online erscheint und der Server `delivered>0` meldet, entfernt der Sender den Eintrag.
- Der Server sieht weiterhin nichts davon: Er bekommt den Envelope erst bei tatsächlicher Zustellung.

### At-Rest-Schutz im Browser

- **Local Data Key (LDK)**: Nach dem Entsperren aus dem entpackten Secret-Key abgeleitet (`BLAKE2b(32, "vaultchat-local-idb-v1", sk)`).
- **Jede IDB-Payload** (DM-Frame, Gruppen-Frame, Ratchet-State, Gruppenschlüssel, TTL-Einstellungen, Outbox-Einträge, TOFU-Pins) wird mit `crypto_secretbox` unter dem LDK verschlüsselt.
- **Auto-Lock**: Nach 10 min Inaktivität (Maus/Tastatur/Visibility) werden `secretKey` und LDK automatisch aus dem Speicher gelöscht (`memzero`). Der Nutzer muss das Passwort neu eingeben, bevor er weiter chatten kann.
- **Manueller Sperren-Knopf**: Sofortiges LDK-Löschen.
- **Logout**: Löscht zusätzlich Token und wrapped-Identity (benötigt Backup-Import beim nächsten Login).

### WebRTC (Audio/Video)

- Peer-to-peer über WebRTC; nur SDP + ICE-Candidates werden vom Server durchgereicht. Medien sind SRTP zwischen den Peers.
- **Konfigurierbare TURN-Relays** via `VAULTCHAT_TURN_URL`, `VAULTCHAT_TURN_USER`, `VAULTCHAT_TURN_PASS`.
- **Relay-Only-Modus**: Im Client per Checkbox aktivierbar (sowie server-forciert via `VAULTCHAT_FORCE_RELAY=1`). Setzt `iceTransportPolicy: "relay"`, entfernt STUN-Fallbacks bei server-forciertem Relay und filtert Host-/srflx-Kandidaten vor dem Signaling — verhindert IP-Exposure an den Peer, wenn TURN korrekt konfiguriert ist.

### Asset-Integrität

- Vite-Build injiziert `integrity="sha384-…"` in alle gebündelten JS/CSS-Dateien (`vite-plugin-sri`).
- Zusätzlich **clientseitiger SHA-384-Fingerprint des Hauptbundles**: beim ersten Vertrauen lokal gepinnt und nach Unlock verschlüsselt gespeichert. Bei Abweichung blockiert die App das Entsperren, bis der Nutzer den neuen Build bewusst out-of-band verifiziert und neu pinnt. Ersetzt keine Reproducible Builds, mindert aber Drift-Angriffe nach dem ersten Vertrauen.

## Bedrohungen und Grenzen (Stand jetzt)

1. **Kompromittierter Web-Host** *(residual)*: Der Host kann pro Aufruf neuen JS-Code liefern. SRI schützt nur vor Tampering zwischen Build und Auslieferung. Unser **Code-Hash-Pinning** mindert den Angriff (TOFU-Policy auf Bundle-Ebene), schützt aber nicht vor gezieltem Angriff auf den ersten Aufruf. Vollständige Minderung braucht reproducible builds + unabhängig veröffentlichte Hashes + idealerweise native Clients oder signierte Web Bundles.

   **Verbesserung (v2)**: Code-Integrity-Pinning mit **passwortgeschütztem Hash** (`codeIntegrityEnhanced.ts`). Der Hash wird mit einem aus dem `secretKey` abgeleiteten Schlüssel verschlüsselt gespeichert und ein Mismatch blockiert Unlock/Session-Start. Einfaches Auslesen von localStorage reicht nicht aus — der Angreifer müsste den Browser-Prozess kontrollieren.

2. **Kein auditiertes libsignal** *(residual)*: Unser Double Ratchet v4 ist konzeptionell korrekt, nutzt libsodium-Primitive (XChaCha20-Poly1305, X25519, BLAKE2b) und bindet Header per AAD. Er ist dennoch **kein** Drop-in-Ersatz für `libsignal-protocol`. Es gibt kein X3DH mit One-Time-Prekeys, keine Deniable Signatures, kein formales Audit.

3. **Metadaten-Leak am Relay** *(stark reduziert)*: Der Server kennt für DMs nur `toUserId`, nicht den Absender. Dadurch kann er nicht mehr trivial die Kommunikationsgraphen rekonstruieren. Residuell bleiben: Zeitkorrelation (Sende-/Empfangszeitpunkte) sowie Gruppenmitgliedschaften (weil der Server Mitglieder routen muss).

4. **MITM bei Erstkontakt** *(stark reduziert)*: TOFU-Pinning detektiert Key-Wechsel automatisch und blockiert weitere DMs, bis der Nutzer verifiziert. Safety-Number-Vergleich bleibt der Goldstandard.

5. **Offline/Neues Gerät** *(teilweise gelöst)*: Sender-Outbox übernimmt Store-and-Forward-Funktion, ohne dass der Server speichert. Ein neues Gerät benötigt weiterhin den Backup-Import für die Identität; neue Backups sind passwortgeschützte Argon2id/Secretbox-Bundles, Legacy-Klartext-JSON wird nur noch für Import-Kompatibilität akzeptiert.

6. **Browser-Forensik** *(reduziert)*: Auto-Lock + `memzero` entfernen LDK und SK nach 10 min Inaktivität bzw. manuellem Lock. Root-Zugriff auf ein laufendes, aktives Gerät bleibt außerhalb des Modells.

   **Verbesserung (v2)**: **Anti-Exfiltration Protection** (`exfilProtection.ts`):
   - Periodisches Memory-Wiping mit randomisierten Intervallen (30-120s)
   - Sofortiges Wiping bei Tab-Wechsel (visibilitychange)
   - Zusätzlicher Schutz mit Zufallsdaten-Ersetzung
   - Registrierung des LDK für automatisiertes Wiping

7. **Nachrichten-Replay-Angriffe** *(neu, adressiert)*: Angreifer könnte gültige, bereits zugestellte Nachrichten erneut senden.

   **Lösung (v2)**: **Client-seitiger Replay-Schutz** (`replayProtection.ts`):
   - Message-ID basierte Duplicate-Detection
   - 5-Minuten-Zeitfenster mit automatischem Cleanup
   - Gruppenspezifische Sets für isolierte Prüfung
   - Automatisches Reset bei Lock

8. **Gruppenschlüssel-Rotation** *(gelöst)*: Beim Hinzufügen/Entfernen/Verlassen rotiert der aktor-Client automatisch den Gruppenschlüssel und verteilt ihn sealed-sender-DM-basiert.

9. **WebRTC ohne TURN** *(optional lösbar)*: TURN wird über ENV konfiguriert. Relay-Only-Modus verhindert IP-Leak an den Peer.

## Reproduzierbare Builds (Empfehlung)

- `package-lock.json` committen, Docker-Build mit festen Node-Images nutzen (`node:20-alpine`), `npm ci` für Determinismus.
- Bit-genaue Reproduzierbarkeit benötigt zusätzlich `SOURCE_DATE_EPOCH` und eine fixierte Toolchain.
- Den resultierenden Bundle-SHA-384-Hash unabhängig publizieren, damit Nutzer beim ersten Aufruf den im Banner angezeigten Hash verifizieren können.
