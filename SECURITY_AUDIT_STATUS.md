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

### Phase 1 — Foundation ✅ erledigt
- `@matrix-org/olm` ist als dependency drin.
- `lib/olmAdapter.ts` und `lib/megolmAdapter.ts` wrappen die Olm-API mit
  typsafem TS-Interface. Lazy-loaded, kein automatischer Code-Pfad
  benutzt sie heute schon.
- Test-Suite (`olmAdapter.test.ts`) prüft Roundtrip + Tamper-Reject mit Olm.
- CSP-Header (`render.yaml`, `server/src/index.ts`) erlauben
  `wasm-unsafe-eval` für Olm + libsodium WASM.

### Phase 2 — Coexistence ✅ Foundation erledigt
- **Wire-Format `VCO5`** definiert: `MAGIC(4)="VCO5" || type(1) || body`.
  encodeVco5/decodeVco5/isOlmCiphertext sind tested.
- **PreKey-Bundle** auf Server + Client um optionales `olm`-Feld
  erweitert (identityCurve25519, identityEd25519, oneTimeKeys[]).
  Backwards-kompatibel: alte Bundles ohne `olm` lassen den Sender auf
  DR-v4 zurückfallen.
- **olmSessionStore + olmSession** persistieren die Olm-Account- und
  -Session-Pickles in IDB, mit einem aus dem Local-Key abgeleiteten
  Pickle-Sub-Key (`deriveSubKey("vaultchat-olm-pickle-v1")`).
- **ensureOlmSession / olmEncryptJson / olmDecryptJson** sind eingebaut
  — der Send-/Receive-Pfad in ChatShell / incomingDm muss in einer
  Folge-Iteration auf den `VCO5`-Magic prüfen und entsprechend routen.

### Phase 3 — Megolm-Group ✅ Foundation erledigt
- **Wire-Format `VCG6`** definiert: `MAGIC(4)="VCG6" || sessionIdLen(1)
  || sessionId || senderUuid(16) || cipher-bytes`.
- **megolmSessionStore + megolmSession** mit
  ensureOutbound/loadInbound/saveInbound/rotateForMemberRemoval,
  buildSessionKeyDistribution für 1:1-Olm-basierten Key-Versand.
- Inbound-Sessions werden pro `{groupId, senderId, sessionId}` indexed
  — alte Sessions bleiben erhalten für Decryption alter Frames, neue
  Rotation kommt mit eigener ID dazu.
- Tests prüfen VCG6-Magic-Detection.

### Phase 4 — Aktivierung im Send-Pfad (separate Session)
- ChatShell-Send-Pfad: bevorzuge `olmEncryptJson` wenn das PreKey-Bundle
  des Empfängers `olm`-Felder hat, sonst fallback `drEncryptJson`.
- `incomingDm.ts`: prüfe `isOlmCiphertext` vor `isDrCiphertext` und
  route entsprechend.
- Group-Send: `megolmEncryptGroup` mit Key-Distribution via Olm 1:1.
- Migration-UI in Settings: "Krypto auf auditierte Olm-Schicht
  umstellen" — bestehende Sessions werden neu ausgehandelt.

### Phase 5 — Self-rolled Code löschen
- `doubleRatchet.ts`, `x3dh.ts`, `groupCrypto.ts` werden gelöscht,
  sobald keine v4-Session-Records mehr in lokalen DBs hängen (z.B.
  nach 90 Tagen ohne v4-Roundtrip).

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
