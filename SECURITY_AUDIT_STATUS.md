# VaultChat — Crypto Audit Status (ehrlich)

Letztes Update: 2026-05-10

Dieses Dokument listet jeden Kryptografie-Codepfad in VaultChat mit
einer ehrlichen Audit-Einschätzung. Kein Marketing — wenn etwas
nicht auditiert ist, steht das hier.

## ✅ Auditierte Libraries (zugrundeliegende Algorithmen + Implementations)

| Library | Was wir davon nutzen | Audit-Status |
|---|---|---|
| **libsodium** (via `libsodium-wrappers-sumo`) | XChaCha20-Poly1305, X25519, BLAKE2b, Argon2id, Ed25519, secretbox, box_seal | libsodium-Kern (C) mehrfach auditiert: NCC Group, Cure53 2017, kontinuierliche Reviews. Produktiv in Signal, Matrix, ProtonMail, WireGuard. Der JS-Wrapper ist Emscripten-Output ohne eigene Krypto-Logik. |
| **`@noble/post-quantum`** | ML-KEM-1024 (FIPS 203) für PQ-Hybrid in X3DH | noble-Familie auditiert von Cure53 2024. Pure-JS, kein WASM. ML-KEM selbst ist NIST-standardisiert (FIPS 203, Aug. 2024). |
| **`argon2`** (Node, server-side Password-Hash) | Argon2id für `/api/register`+`/api/login` | Wrapper um libargon2 (PHC-Gewinner, akademisch analysiert). |
| **`@matrix-org/olm`** *(neu hinzugefügt)* | Olm (1:1 Ratchet) + Megolm (Group Ratchet) | Auditiert: NCC Group 2016, NCC Group 2020, Quarkslab 2024. In Element/Matrix produktiv seit ~10 Jahren. WASM-Build mit Test-Vektoren. |

## 🟡 Standard-Patterns ohne formalen Audit, aber Industrie-Best-Practice

| Pfad | Was es ist | Risiko-Einordnung |
|---|---|---|
| `client/src/lib/sealedSender.ts` | `crypto_box_seal` + AAD-bound inner DR-Wire | Schlanker Wrapper; Sender-Auth kommt aus dem DR darin. Pattern entspricht Signal's Sealed Sender konzeptuell. |
| `server/src/replayStore.ts` | Sliding-Window Envelope-Hash-Set | Standardpattern, keine Krypto-Operation eigener Erfindung. |
| `client/src/lib/replayProtection.ts` | Client-seitiges Map-Set | Wie oben. |
| `server/src/auth.ts` | JWT mit `jsonwebtoken`, expliziter Issuer | jsonwebtoken hat HISTORY mit algorithm-confusion CVEs — wir nutzen `verify(token, secret, { issuer })`, der parsed `algorithm`-Header ist nicht beeinflussbar weil wir mit einer einzelnen HS256-Secret-Konstante arbeiten. |

## 🔴 Selbstgeschriebene Protokoll-Logik (NICHT auditiert)

Das ist der entscheidende Audit-Gap zu Signal/Element. Status pro Datei:

| Datei | Was | Aktueller Plan |
|---|---|---|
| `client/src/lib/doubleRatchet.ts` | Eigene DR v4 (XChaCha20-Poly1305 + BLAKE2b-KDF, AAD-bound Header) | **Migration zu Olm geplant** (siehe unten). Bis dahin: Memory-Hygiene (sec 6464885), Property-Tests gegen Bit-Flips/Replay/Roundtrip (96ab6a1). |
| `client/src/lib/x3dh.ts` | X3DH + ML-KEM-Hybrid für Initial-Handshake | **Migration zu Olm-PreKey-Bundles geplant**. Olm hat eigenen Handshake (`Account.outboundSession`, OneTimeKey-basiert) — austauschbares Wire-Format. |
| `client/src/lib/groupCrypto.ts` (v2) | Sender-Chains pro Member | **Self-Disclosed broken**: Ex-Mitglieder die den Root-Key kennen können zukünftige Chains rekonstruieren. Migration zu **Megolm** (Group-Ratchet, auditiert, semantisch ähnlich zu Signal Sender Keys) geplant. |
| `client/src/lib/groupCryptoV3.ts` | TreeKEM/MLS Skeleton | Wird vermutlich zugunsten von Megolm gestoppt — Megolm ist auditiert + produktiv erprobt, MLS-Browser-Implementations sind noch instabil. |

## Migrations-Plan auf auditierte Protocols

### Phase 1 — Foundation (jetzt eingebaut, koexistierend)
- `@matrix-org/olm` ist als dependency drin.
- `lib/olmAdapter.ts` und `lib/megolmAdapter.ts` wrappen die Olm-API mit
  typsafem TS-Interface. Lazy-loaded, kein automatischer Code-Pfad
  benutzt sie heute schon.
- Test-Suite (`olmAdapter.test.ts`) prüft Roundtrip + Tamper-Reject mit Olm.

### Phase 2 — Coexistence (separate Session)
- Wire-Format-Version-Byte: `VCD4` (heutige DR) vs. `VCO5` (Olm).
- Empfänger erkennt am Magic-Prefix welche Decryption-Pfad.
- Neue Sessions → Olm (sofern beide Peers V5 supporten — Capability-Bit
  in PreKey-Bundle).
- Bestehende Sessions → bleiben auf v4 DR.
- Migrationspfad: User klickt in Security-Settings "Krypto upgraden",
  alle Sessions werden neu ausgehandelt.

### Phase 3 — Group via Megolm (separate Session)
- Group-Sender-Keys analog Signal/Matrix.
- Ex-Member-Removal triggert Megolm-Group-Rotation (auditierter Pfad).
- groupCryptoV3-Skeleton wird zu Megolm-Wrapper umgeschrieben.

### Phase 4 — Self-rolled Code löschen (separate Session)
- `doubleRatchet.ts`, `x3dh.ts`, `groupCrypto.ts` werden gelöscht, sobald
  keine v4-Session-Records mehr in lokalen DBs hängen (z.B. nach 90 Tagen
  ohne v4-Roundtrip).

## Was bleibt auch nach allen Phasen selbst geschrieben

- Wire-Format-Encoder/Decoder (Magic-Bytes, Length-Prefixe). Trivial,
  schwer falsch zu machen, Property-Tests da.
- Sealed-Sender-Wrapper. Wenn man so will: ein 20-Zeilen
  `crypto_box_seal`-Wrapper, der die inner-frame-bytes vom Server fern hält.
- Backup-Format (`backup.ts`): Argon2id + secretbox_easy auf serialisierte
  Identity. Standardpattern, Tests da (`backup.test.ts`).
- Frontend/UI. Keine Krypto.

## Reproducible Builds + Audit der App selbst

Auch nach Phase 4 bleibt die größte Lücke der **Browser-Trust-Model**:
jeder Page-Load lädt JavaScript vom Server. Subresource-Integrity
(`vite-plugin-sri.ts`, sha384) und Code-Integrity-Pinning
(`lib/codeIntegrity.ts`) helfen — aber der allererste Besuch ist
blindes Vertrauen.

Reproducible Builds + signierte Native-Releases bleiben der einzige
saubere Pfad (siehe `SECURITY_ROADMAP.md`). Olm/Megolm-Migration
schließt nur den Algorithmus-Gap, nicht den Delivery-Gap.

## Wenn du als externer Reviewer einsteigen willst

Schau dir in dieser Reihenfolge an:
1. `lib/olmAdapter.ts` + `lib/megolmAdapter.ts` (wenn ja-Pfad eingehängt)
2. `lib/doubleRatchet.ts` (heutiger Pfad bis Migration)
3. `lib/x3dh.ts` (heutiger Handshake)
4. `lib/sealedSender.ts` (kleiner aber zentral)
5. `lib/backup.ts` (Storage-at-rest)
6. `server/src/index.ts` Block "WebSocket message handling" (zod-Schemas, replay-store, rate-limit)
7. `THREAT_MODEL.md` (Modell-Annahmen)

Issues mit reproduzierbarem Repro-Pfad → GitHub Issues im Repo.
