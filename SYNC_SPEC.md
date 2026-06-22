# Konsistente Historie über Geräte (Sealed Sync) — Design-Spec

**GOAL Phase 2, letzter Punkt.** Status: **Design only — keine Implementation.**
Dieser Punkt ist bewusst NICHT in dieser Runde gebaut worden: er hängt
architektonisch am Multi-Device-Vollausbau (`ROADMAP_MULTI_DEVICE.md`), der
zwei echte Geräte zur Verhaltens-Verifikation braucht und damit hier nicht
abschließbar ist. Dieses Dokument hält den privatsphäre-wahrenden Entwurf fest,
damit der nächste Multi-Device-Block ihn direkt umsetzen kann.

## Ziel

Wenn ein Nutzer mehrere Geräte hat (siehe sealed Device-Pairing,
`client/src/lib/deviceProvisioning.ts`), sollen **alle** Geräte denselben
Chatverlauf sehen — inkl. Nachrichten, die gesendet/empfangen wurden, während
ein Gerät offline war —, **ohne** dass der Server Inhalt, Absender/Empfänger
oder Zeitstruktur lernt. Zwei Teilprobleme:

1. **Initialer Sync** beim Koppeln (Gerät B übernimmt die bisherige Historie
   von Gerät A).
2. **Laufender Sync** (jede neue ausgehende/eingehende Nachricht erscheint auf
   allen eigenen Geräten).

## Nordstern / Privatsphäre-Grenze

Der Server bleibt **zero-knowledge**: Er darf nur opake Ciphertext-Blobs für
eine *opake* Empfänger-Geräte-Adresse routen/zwischenspeichern. Er darf NICHT
lernen:
- den Inhalt (selbstverständlich),
- die Klartext-Beziehung „diese Sync-Blobs gehören zu Account X" über das
  hinaus, was Routing zwingend erfordert,
- die Reihenfolge/den Inhalt der Historie.

Maßstab ist `THREAT_MODEL.md`. Im Zweifel: Feature zurückstellen, ZK behalten.

## Baustein 1 — Self-Channel (eigener Sealed-Kanal)

Jedes Gerät hat (im Multi-Device-Modell) ein **eigenes** Identity-Keypair
(`ROADMAP_MULTI_DEVICE.md`, `device.identityPublicKeyB64`). „Self-Sync" ist
dann nur ein Spezialfall des bestehenden Sealed-Sender-Versands: das sendende
Gerät verschlüsselt jede ausgehende Nachricht ZUSÄTZLICH einmal pro **eigenem
anderen Gerät** und legt sie in dessen Mailbox ab — exakt mit der vorhandenen
`sealedSender.ts` + `mailboxStore.ts`-Maschinerie, nur mit den eigenen
Geräte-PKs als Empfänger.

- **Wire:** wie heute `{ type:"dm", toUserId, toDeviceId, envelope }` (das
  `toDeviceId` kommt aus dem Multi-Device-Fan-out, `ROADMAP_MULTI_DEVICE.md`).
- **Was der Server sieht:** ein weiterer Sealed-Envelope an eine opake
  Geräte-Adresse desselben Accounts. Dass es „dasselbe Konto" ist, weiß der
  Server beim Self-Sync ohnehin (Mailbox ist pro Empfänger-Account/-Gerät) —
  das ist dieselbe Metadaten-Exposition wie beim normalen Mailbox-Routing,
  **kein** neuer Leak.
- **Frame-Typ:** ein neuer `PlainPayload.kind === "sync"` mit einem inneren
  `op` (siehe Baustein 3). Damit landen Self-Sync-Frames NICHT als sichtbare
  „Nachricht von mir an mich" in der UI, sondern werden vom Empfänger-Gerät
  in seine lokale IDB-Historie eingespielt.

## Baustein 2 — Initialer Sync via verschlüsseltem History-Pack

Beim Koppeln (Gerät B frisch verbunden) braucht B die **Alt-Historie** von A.
Wiederverwendung des bereits gebauten **History-Backups** (Item 1,
`client/src/lib/historyBackup.ts`):

1. A baut das History-Bündel (`buildHistoryBundle` aus `idbListAllDm` +
   `idbListAllGroupMsgs`).
2. Statt einer passphrase-abgeleiteten Argon2id-Schlüsselung wird das Pack mit
   einem **frischen Zufalls-Sync-Key** (`crypto_secretbox`) verschlüsselt; der
   Sync-Key wird **sealed an das ephemere/Geräte-Keypair von B** übertragen
   (`crypto_box_seal`, wie in `deviceProvisioning.ts`). So muss der (potenziell
   große) History-Blob nicht durch die langsame Argon2id-KDF, und der Sync-Key
   ist nur für B lesbar.
3. Transport: über die Mailbox (in Chunks, wegen Byte-Quota
   `VAULTCHAT_*`/`mailboxStore.ts`) ODER — für die manuelle Variante — als
   Datei/Copy-Paste (wie heute der manuelle Pairing-Flow). Der Server sieht
   nur Ciphertext.
4. B entschlüsselt, validiert das Shape (`parseHistoryBackup`-Logik) und
   spielt die Nachrichten via `idbPutDm`/`idbPutGroupMsg` at-rest unter dem
   eigenen Local Data Key ein (genau wie der Restore-Pfad aus Item 1).

→ Item 1 liefert die kryptografische Hälfte schon fertig; für den Sync wird
nur die Schlüsselableitung von „passphrase" auf „sealed Zufalls-Key"
umgestellt (ein kleines Adapter-Modul, kein neues Krypto-Design).

## Baustein 3 — Laufender Sync: Operationen statt Nachrichten

Damit Geräte konsistent bleiben, wird nicht nur „neue Nachricht" gesynct,
sondern die **idempotenten Frames**, die VaultChat ohnehin schon hat
(`PlainPayload.kind`): `text`/`file`/`voice`, aber auch `edit`, `delete`,
`reaction`, `receipt`. Der Self-Sync schickt diese Frames 1:1 an die eigenen
Geräte; jedes Gerät wendet sie auf seine lokale Historie an. Eigenschaften, die
die Konsistenz tragen:

- **Idempotenz:** jeder Frame trägt eine `cid`; das Wiederabspielen desselben
  Frames ist ein No-Op (vorhandene Dedup-Logik, `replayProtection.ts` +
  `idbPut*` mit fester `id`). Doppel-Zustellung (Mailbox-Replay nach Reconnect)
  ist damit unkritisch.
- **Commutative-genug:** `edit`/`delete`/`reaction` referenzieren per `refCid`
  eine Basis-Nachricht; Reihenfolge zwischen unabhängigen Frames ist egal,
  abhängige Frames konvergieren (Last-Writer-Wins per `at`-Timestamp, wie heute
  in `chatReducer.ts`). → Kein Vektor-Uhr-/CRDT-Schwergewicht nötig für den
  Anfang; der vorhandene Reducer ist bereits weitgehend ordnungsrobust.
- **Lückenfüllung:** beim Reconnect liefert die bestehende Offline-**Mailbox**
  (`mailboxStore.ts`, TTL 7 d) die verpassten Self-Sync-Frames nach — exakt
  derselbe Store-and-Forward-Pfad wie für normale DMs. Kein separater
  Sync-Server-State nötig.

## Was NEU gebaut werden muss (Decomposition)

1. **`device.identityPublicKeyB64` pro Gerät** + Server-Geräteverzeichnis
   (hängt an `ROADMAP_MULTI_DEVICE.md`, Server-Schema). **Voraussetzung** für
   alles Weitere.
2. **Fan-out beim Senden** auf `(Empfänger-Geräte) + (eigene anderen Geräte)`
   (Self-Sync). Reiner Client-Send-Pfad + Wire-Erweiterung `toDeviceId`.
3. **`kind:"sync"`-Frame** (oder Wiederverwendung der bestehenden Frames mit
   einem „self"-Flag) + Empfangs-Handler, der Frames in IDB einspielt statt in
   die sichtbare „Nachricht von mir"-Liste.
4. **Initialer History-Pack-Transfer** (Baustein 2): kleines Adapter-Modul über
   `historyBackup.ts` (Zufalls-Sync-Key statt Passphrase, sealed an Geräte-PK)
   + Chunking für die Mailbox-Byte-Quota. **Unit-testbar** (round-trip,
   wrong-key, tamper) — analog zu Item 1/3.
5. **Konfliktauflösung-Härtung**: Tests, dass `chatReducer` auch bei
   out-of-order/duplizierten Self-Sync-Frames konvergiert. **Unit-testbar.**
6. **Gruppen-Self-Sync**: Megolm-Session-Keys müssen auch an die eigenen
   Geräte verteilt werden (sonst kann Gerät B Gruppen-Historie nicht
   entschlüsseln). Hängt an der Megolm-Verteilung (`megolmAdapter.ts`) ×
   Geräte-Fan-out.

## Aufwandseinschätzung

Die kryptografischen Kernstücke (Baustein 2-Adapter, idempotenter
Frame-Replay) sind klein und unit-testbar und können in einer Cloud-Session
vorgebaut werden. Der **Verhaltenspfad** (Fan-out, Live-Mailbox-Replay über
zwei Geräte, Gruppen-Megolm über Geräte) braucht zwei echte Geräte und gehört
in denselben Block wie der Multi-Device-Vollausbau (`ROADMAP_MULTI_DEVICE.md`,
~6 Wochen + Audit). **Ohne** Multi-Device-Geräteverzeichnis ist Sealed Sync
nicht sinnvoll isoliert baubar.

## Risiken / offene Fragen

- **Metadaten beim Self-Sync:** Der Server sieht, dass Account X N Geräte hat
  und wie viel Sync-Traffic fließt. Das ist inhärent beim Multi-Device-Modell;
  Minderung wie bei Sealed Sender (opake Geräte-Adressen, kein Absender).
- **Storage-Wachstum** (mehr Ratchet-States, mehr Mailbox-Blobs) — siehe
  Risiken in `ROADMAP_MULTI_DEVICE.md`. IDB-Quota überwachen.
- **Konfliktauflösung jenseits LWW:** falls künftig kollaborative Features
  dazukommen (z.B. gemeinsame Notizen), reicht LWW nicht — dann CRDT
  evaluieren. Für reinen Chat-Verlauf ist LWW ausreichend.
