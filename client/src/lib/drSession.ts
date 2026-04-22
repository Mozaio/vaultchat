/**
 * Double-Ratchet Session-Wrapper.
 *
 * Persistiert den DR-State pro Peer in der verschlüsselten IndexedDB
 * (über metaGet/metaSet) und bietet encrypt/decrypt für DM-Payloads.
 * Verwendet Längen-Padding, damit Ciphertext-Größen nichts über die echte
 * Nachrichtenlänge verraten.
 *
 * Hintergrund: `x3dh.ts` + `POST /api/keys` (keyStore) bereiten vollwertigen
 * X3DH vor; Sitzungsstart in Produktion nutzt derzeit `drInit`/`ensureDrSession`
 * (kompatibel mit Empfängern, bis X3DH Ende-zu-Ende ausgerollt ist).
 */
import { base64FromUint8, uint8FromBase64 } from "./b64";
import {
  drDecrypt,
  drEncrypt,
  drInit,
  isDrWire,
  type DRState,
} from "./doubleRatchet";
import { metaGet, metaSet } from "./idb";
import { pad, unpad } from "./padding";

function metaKey(peerId: string) {
  return `dr:${peerId}`;
}

export async function ensureDrSession(
  myIdentitySk: Uint8Array,
  peerId: string,
  peerPublicKeyB64: string
): Promise<DRState> {
  const existing = await metaGet(metaKey(peerId));
  if (existing) {
    try {
      const p = JSON.parse(existing) as DRState;
      if (p.v === 4 && p.peerIdentityPk === peerPublicKeyB64) return p;
    } catch {
      /* reinit */
    }
  }
  const fresh = await drInit(myIdentitySk, peerPublicKeyB64, peerId);
  await metaSet(metaKey(peerId), JSON.stringify(fresh));
  return fresh;
}

async function saveState(st: DRState): Promise<void> {
  await metaSet(metaKey(st.peerId), JSON.stringify(st));
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function drEncryptJson(
  myIdentitySk: Uint8Array,
  peerId: string,
  peerPublicKeyB64: string,
  plainJson: string
): Promise<string> {
  const st = await ensureDrSession(myIdentitySk, peerId, peerPublicKeyB64);
  const padded = pad(enc.encode(plainJson));
  const { state, wire } = await drEncrypt(st, padded);
  await saveState(state);
  return base64FromUint8(wire);
}

export async function drDecryptJson(
  myIdentitySk: Uint8Array,
  peerId: string,
  peerPublicKeyB64: string,
  wireB64: string
): Promise<string> {
  const st = await ensureDrSession(myIdentitySk, peerId, peerPublicKeyB64);
  const wire = uint8FromBase64(wireB64);
  const { state, plaintext } = await drDecrypt(st, myIdentitySk, wire);
  // IMPORTANT: save state only after successful decode+unpad,
  // otherwise we risk ratchet desync on malformed padding/encoding.
  try {
    const result = dec.decode(unpad(plaintext));
    await saveState(state);
    return result;
  } catch (e) {
    throw e;
  }
}

export function isDrCiphertext(b64: string): boolean {
  return isDrWire(b64);
}
