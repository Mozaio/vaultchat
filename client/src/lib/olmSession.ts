/**
 * High-level Olm-Session-Layer, analog zu drSession.ts.
 *
 * Zuständig für:
 *  - Wire-Format `VCO5` (encode/decode)
 *  - ensureOlmSession via Pre-Key-Bundle (Initial-Handshake)
 *  - encrypt / decrypt einer JSON-Nachricht
 *  - Session-Persistenz nach jeder Mutation
 *
 * Status: Phase 2 — eingebaut, aber noch nicht vom Send-Pfad (ChatShell)
 * verwendet. incomingDm.ts wird in einer Folge-Iteration auf das VCO5-
 * Magic prüfen und hierhin routen.
 */
import { base64FromUint8, uint8FromBase64 } from "./b64";
import * as api from "./api";
import {
  ensureOlmAccount,
  loadOlmSession,
  saveOlmAccount,
  saveOlmSession,
} from "./olmSessionStore";
import {
  olmInit,
  olmEncrypt,
  olmDecrypt,
} from "./olmAdapter";

type OlmModule = typeof import("@matrix-org/olm");
type OlmSession = InstanceType<OlmModule["Session"]>;

/**
 * Wire-Format:
 *   MAGIC(4) "VCO5" || type(1) || body-bytes
 * type ∈ {0, 1}: 0 = Pre-Key-Message (Init), 1 = normale Message.
 * body ist Olm-eigene base64-String, hier UTF-8-encoded geladen.
 *
 * Das Ganze wird vom Caller wieder base64 in den Sealed-Envelope-Slot
 * verpackt — die `envelope` field unserer DM-Frames bleibt also ein
 * base64-String.
 */
const VCO5_MAGIC = new Uint8Array([0x56, 0x43, 0x4f, 0x35]); // "VCO5"

export function encodeVco5(type: 0 | 1, body: string): Uint8Array {
  const bodyBytes = new TextEncoder().encode(body);
  const out = new Uint8Array(VCO5_MAGIC.length + 1 + bodyBytes.length);
  out.set(VCO5_MAGIC, 0);
  out[VCO5_MAGIC.length] = type;
  out.set(bodyBytes, VCO5_MAGIC.length + 1);
  return out;
}

export function decodeVco5(wire: Uint8Array): { type: 0 | 1; body: string } {
  if (wire.length <= VCO5_MAGIC.length + 1) {
    throw new Error("vco5_short");
  }
  for (let i = 0; i < VCO5_MAGIC.length; i++) {
    if (wire[i] !== VCO5_MAGIC[i]) throw new Error("vco5_bad_magic");
  }
  const type = wire[VCO5_MAGIC.length];
  if (type !== 0 && type !== 1) throw new Error("vco5_bad_type");
  const body = new TextDecoder().decode(wire.subarray(VCO5_MAGIC.length + 1));
  return { type: type as 0 | 1, body };
}

/**
 * Probe: erkennt VCO5-Wire am Magic-Prefix. Pendant zu isDrWire / isDrCiphertext.
 */
export function isOlmCiphertext(b64: string): boolean {
  try {
    const buf = uint8FromBase64(b64);
    if (buf.length < VCO5_MAGIC.length) return false;
    for (let i = 0; i < VCO5_MAGIC.length; i++) {
      if (buf[i] !== VCO5_MAGIC[i]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Stellt eine Olm-Session zum Peer her oder lädt eine bestehende aus der IDB.
 *
 * Wenn keine Session existiert: holt das PreKey-Bundle des Peers via API,
 * baut eine outbound Olm-Session. Die FIRST encrypt-call ergibt dann ein
 * Pre-Key-Message (type 0) — das initialisiert den Receiver, sobald der
 * empfangen hat.
 *
 * Achtung: der Empfänger muss in seinem PreKey-Bundle auf dem Server
 * `olmIdentityCurve25519` und mindestens einen One-Time-Key publiziert
 * haben. Bis das eingebaut ist, returns dieser Pfad mit `error: "no_olm_bundle"`.
 */
export async function ensureOlmSession(
  peerId: string,
  token: string
): Promise<OlmSession> {
  const existing = await loadOlmSession(peerId);
  if (existing) return existing;

  const olm = await olmInit();
  const account = await ensureOlmAccount();
  try {
    const bundle = await api.getPreKeyBundle(token, peerId);
    // PreKey-Bundle muss Olm-Schlüssel enthalten — sonst kein Olm-Pfad
    // möglich. Caller fällt dann auf DR v4 zurück (drSession.ts).
    const olmBundle = (bundle as unknown as {
      olm?: {
        identityCurve25519?: string;
        identityEd25519?: string;
        // Der Server liefert den One-Time-Key als Objekt {keyId, publicKey},
        // nicht als blanken String. create_outbound erwartet den base64-
        // String — sonst wirft Olm `OLM.INVALID_BASE64`.
        oneTimeKey?: { keyId: string; publicKey: string } | null;
      };
    }).olm;
    if (
      !olmBundle ||
      !olmBundle.identityCurve25519 ||
      !olmBundle.oneTimeKey ||
      !olmBundle.oneTimeKey.publicKey
    ) {
      throw new Error("no_olm_bundle");
    }
    const session = new olm.Session();
    session.create_outbound(
      account,
      olmBundle.identityCurve25519,
      olmBundle.oneTimeKey.publicKey
    );
    await saveOlmAccount(account);
    await saveOlmSession(peerId, session);
    return session;
  } finally {
    account.free();
  }
}

/**
 * Verschlüsselt einen JSON-String über Olm und gibt den fertigen
 * Sealed-fähigen base64-VCO5-Wire zurück.
 *
 * Session wird nach jeder Encrypt-Operation wieder gepicklet (Ratchet
 * bewegt sich vorwärts).
 */
export async function olmEncryptJson(
  peerId: string,
  token: string,
  plainJson: string
): Promise<string> {
  const session = await ensureOlmSession(peerId, token);
  try {
    const ct = olmEncrypt(session, plainJson);
    await saveOlmSession(peerId, session);
    const wire = encodeVco5(ct.type, ct.body);
    return base64FromUint8(wire);
  } finally {
    session.free();
  }
}

/**
 * Decrypt-Pfad. Wenn type === 0 (pre-key) und keine inbound Session
 * existiert, wird sie hier aus dem Pre-Key-Message gebaut.
 */
export async function olmDecryptJson(
  peerId: string,
  wireB64: string
): Promise<string> {
  const wire = uint8FromBase64(wireB64);
  const { type, body } = decodeVco5(wire);

  const olm = await olmInit();
  let session = await loadOlmSession(peerId);
  const account = await ensureOlmAccount();
  try {
    let needsFreshInbound = false;
    if (type === 0) {
      // Pre-Key-Message. Wir brauchen eine INBOUND-Session, die zu genau
      // dieser Nachricht passt. Wichtig bei "Glare": bauen beide Seiten
      // gleichzeitig eine Outbound-Session auf (passiert in Gruppen, wenn alle
      // Mitglieder zeitgleich ihren Megolm-Key verteilen), passt die
      // eingehende Pre-Key-Message NICHT zur eigenen Outbound-Session. Dann
      // (oder wenn gar keine Session existiert) eine frische Inbound-Session
      // aus der Pre-Key-Message bauen — sonst scheitert die Entschlüsselung
      // still und der Schlüssel geht verloren (Ursache der Gruppen-Bugs).
      if (!session) {
        needsFreshInbound = true;
      } else {
        let matches = false;
        try {
          matches = session.matches_inbound(body);
        } catch {
          matches = false;
        }
        if (!matches) {
          session.free();
          session = null;
          needsFreshInbound = true;
        }
      }
    } else if (!session) {
      throw new Error("no_olm_session_and_not_prekey");
    }
    if (needsFreshInbound) {
      session = new olm.Session();
      session.create_inbound(account, body);
      account.remove_one_time_keys(session);
      await saveOlmAccount(account);
    }
    const plain = olmDecrypt(session!, type, body);
    await saveOlmSession(peerId, session!);
    return plain;
  } finally {
    account.free();
    session?.free();
  }
}
