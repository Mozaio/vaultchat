# Roadmap: Multi-Device / Linked Devices

Status: **Plan only — keine Implementation.** Komplettierung ~3-4 Wochen Engineering + 2 Wochen Audit.

## Problem

Aktuell ist VaultChat **single-device**: ein Account = ein Browser-Session = ein Identity-Keypair. Login auf Gerät B sperrt Gerät A nicht aus, aber B sieht keine Historie und keine neuen Nachrichten in Echtzeit (außer per Mailbox-Replay nach Re-Login).

## Ziel

Wie Signal: ein Account ist ein Verzeichnis von **Geräten** (jedes mit eigenem Keypair). Sender verschlüsselt jede DM einmal pro Empfänger-Gerät. Sync zwischen eigenen Geräten passiert über einen "Self-Channel".

## Architektur

### Server-Schema

```
account
  id (uuid)
  username, email, plan, …

device
  id (uuid)
  account_id (fk)
  name (e.g. "iPhone 15", "Firefox auf Laptop")
  identityPublicKeyB64
  signedPreKeyBundle (gleiches Schema wie heute, aber pro Device)
  pqKemPublicKeyB64
  createdAt
  lastSeen
  state: "active" | "revoked"

device_revocation
  device_id (fk)
  revoked_by_device_id (fk)
  signature (Ed25519 vom Primary-Device über die Revocation)
  revoked_at
```

### Pairing-Flow (Primary → Secondary)

1. Primary erzeugt einen **Provisioning-Token** (32 Byte random) und zeigt ihn als QR-Code (oder 6-Wort-Phrase).
2. Secondary scannt den QR-Code → `POST /api/devices/pair { provisioningToken, deviceName, identityPubKey, … }`.
3. Server verknüpft das neue Device mit dem Account, returns `{ deviceId, jwt }`.
4. Primary pollt `GET /api/devices?since=<timestamp>` und sieht das neue Device.
5. Primary fragt User: "Neues Gerät 'iPhone 15' verbinden?". Bei Ja: signiert eine **Device-Authorization** (Ed25519 über `deviceId || identityPk || timestamp`) und published sie via `POST /api/devices/:id/authorize { signature }`.
6. Secondary pollt `GET /api/devices/me` und sieht die Authorization → wechselt von `pending` auf `active`.

### DM-Versand (n Empfänger-Geräte)

Bisher: 1 Sealed-Sender-Envelope pro DM.
Multi-Device: für jeden aktiven Empfänger-Gerät einen eigenen Envelope:

```
POST /api/dm/send {
  envelopes: [
    { toDeviceId: "...", envelope: "<base64>" },
    { toDeviceId: "...", envelope: "<base64>" },
    ...
  ]
}
```

Plus: Sender muss **eigene anderen Geräte** auch beliefern (Self-Sync), damit sie die ausgehende Nachricht in der Historie sehen. Das verdoppelt den Send-Workload bei n Empfängern auf `(n + own_devices)`.

### Group-Distribution

Aktuelle GroupKey-Distribution (sealed-sender DMs an alle Mitglieder) wird zu (alle Mitglieder × alle deren Geräte). Bei großen Gruppen O(n × d) — hier wird ein **Sender-Key-Caching** (ähnlich Signal) sinnvoll, damit wir nicht n × d Envelopes schreiben.

### Cross-Device Sync

Jedes Device hält eine separate IDB-Historie (eigene Keys, eigene Ratchet-States). Initialer Sync nach Pairing: Primary kann optional verschlüsselte Historie via "Recovery Pack" exportieren (wie heute Backup), Secondary importiert. Live-Updates: Primary schickt jede ausgehende DM zusätzlich an alle eigenen Geräte (siehe "Self-Sync" oben).

### Revocation

Wenn User Device verliert:
1. Primary signiert `Revocation { deviceId, revokedAt, revokedBy: primaryDeviceId, signature }`.
2. Server published Revocation in `GET /api/account/revocations`.
3. Andere Devices fetchen die Liste regelmäßig und löschen den Public-Key des revoked Device aus ihrer Senderliste — neue DMs werden nicht mehr an dieses Device geschickt.
4. Server akzeptiert keine Logins mehr für das Device (JWT wird invalidiert).

## Migration

- **Alle bestehenden Accounts werden zu Single-Device-Accounts mit dem aktuellen Browser als Primary.** Migration-Script läuft beim ersten Login nach Update.
- Wire-Format `to: userId` wird zu `to: { userId, deviceId? }` — fehlendes deviceId fällt zurück auf "alle Geräte des Users" (Server fan-out).

## Aufwand-Schätzung

| Bereich | LOC neu | LOC modifiziert | Aufwand |
|---|---|---|---|
| Server: device-Tabelle + Auth | 600 | 200 | 1 Woche |
| Server: DM-Fanout + Revocation | 400 | 300 | 0.5 Woche |
| Client: Device-Pairing-UI + QR | 800 | - | 1 Woche |
| Client: Self-Sync-Logik | 500 | 600 | 1 Woche |
| Client: Settings UI | 300 | - | 2 Tage |
| Tests + E2E | 800 | - | 3 Tage |
| Audit | - | - | 2 Wochen |
| **Total** | ~3400 | ~1100 | **~6 Wochen** |

## Risiken

- **Race-Condition bei Pairing**: User scannt QR auf Gerät B, während Gerät A offline ist. Authorization-Signatur kommt nie. Fallback: Primary muss online sein für Pairing.
- **Storage-Wachstum**: jeder Sender hält pro Empfänger × pro Empfänger-Device einen DR-State. Bei 100 Kontakten × 3 Geräten = 300 Ratchets. ~50 KB/Ratchet → 15 MB nur für Ratchet-State. IDB-Quota muss überwacht werden.
- **Revocation-Race**: User revoked Device, dieses Device empfängt aber noch DMs in der Sekunde davor. Mitigation: Revocations sind sofort auf Server, anderes Device cached aber bis zum nächsten Fetch. Akzeptabel.

## Abhängigkeiten

- Erwartet **Group Crypto v3 (TreeKEM)** als parallele Roadmap, weil die Group-Sender-Key-Rotation ohne TreeKEM bei vielen Mitgliedern × Geräten linear teuer wird.
