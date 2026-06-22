# Account-Recovery-Konzept (Geräteverlust) — ohne Zero-Knowledge zu brechen

**Status:** Mechanismus implementiert & live (`client/src/lib/backup.ts`,
`SecuritySettings.tsx`, `BackupReminder.tsx`). Dieses Dokument hält das Konzept
fest (GOAL Phase 0 „Account-Recovery entwerfen und umsetzen").

## Grundsatz

Umbra ist Zero-Knowledge: der Server kennt weder den privaten Schlüssel noch
die Passphrase. Daraus folgt zwingend — **es gibt keine serverseitige
„Passwort vergessen"-Wiederherstellung**. Wer nie ein Backup gemacht hat, kann
seine Identität nach Geräteverlust nicht zurückholen. Das ist kein Bug, sondern
die Konsequenz von E2EE; jede „bequeme" serverseitige Recovery würde die
Garantie brechen und ist daher ausgeschlossen.

## Mechanismus: client-verschlüsseltes Identity-Backup

`encryptIdentityBackup(identity, passphrase)`:
- KDF: **Argon2id** (libsodium `crypto_pwhash`, INTERACTIVE-Limits), Salt
  zufällig pro Backup. KDF-Parameter (`ops`/`mem`) sind versioniert (#22) und
  werden ins Backup geschrieben → vorwärts-/rückwärtskompatibel, geclampt.
- AEAD: `crypto_secretbox_easy` (XSalsa20-Poly1305) über das serialisierte
  `LocalIdentity` (enthält `userId`, `username`, `publicKey` und den
  passwort-`wrapped` privaten Schlüssel). Schlüssel nach Gebrauch `memzero`.
- Ergebnis: `EncryptedIdentityBackup` v2 (`salt`/`nonce`/`cipher` base64). Reiner
  Ciphertext — selbst wenn er über den Server transportiert/abgelegt würde, sähe
  der Server nichts Lesbares.

`parseIdentityBackup(raw, passphraseProvider)`:
- Entschlüsselt mit der Passphrase; MAC-Fehler → generischer Fehler („falsche
  Passphrase ODER manipuliert", nicht unterscheidbar). Danach Shape-Validierung
  gegen `LocalIdentity` → vorhersehbarer Fehler statt späterem NPE.

## Recovery-Ablauf (Geräteverlust)

1. **Vorsorge:** Nutzer erstellt in den Sicherheitseinstellungen ein
   verschlüsseltes Backup (Passphrase wählen). `BackupReminder` stupst aktiv an;
   `backupRequiredForNewDevices` macht das Backup zur Voraussetzung für die
   Anmeldung neuer Geräte.
2. **Verlust:** Gerät weg → der private Schlüssel auf dem Gerät ist verloren.
3. **Wiederherstellung:** Auf dem neuen Gerät Backup-Datei importieren +
   Passphrase eingeben → `parseIdentityBackup` stellt `LocalIdentity` wieder her,
   die Identität (und damit die Adressierbarkeit) ist zurück.

## Grenzen / bewusst getrennt

- **Nachrichtenhistorie** wird hier NICHT abgedeckt — das ist der separate
  Phase-2-Punkt „Verschlüsseltes Backup & Restore der Historie". Dieses Konzept
  stellt die **Identität** wieder her, nicht den Chatverlauf.
- **Passphrase-Verlust = Totalverlust** (per Design, s.o.). Empfehlung an den
  Nutzer: Passphrase getrennt vom Gerät sichern (Passwortmanager/Papier).
- Optionaler `recoveryEmailHash` (server-seitig nur als HMAC gespeichert) dient
  NICHT der Schlüssel-Wiederherstellung, sondern als optionaler Account-Kontakt/
  Anti-Enumeration — er bricht ZK nicht.
