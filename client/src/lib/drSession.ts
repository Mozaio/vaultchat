/**
 * Double-Ratchet Session-Wrapper.
 *
 * Persistiert den DR-State pro Peer in der verschlüsselten IndexedDB
 * (über metaGet/metaSet) und bietet encrypt/decrypt für DM-Payloads.
 * Verwendet Längen-Padding, damit Ciphertext-Größen nichts über die echte
 * Nachrichtenlänge verraten.
 *
 * Session-Initialisierung:
 *  - Normalfall: `ensureDrSession` → direkter Identity-DH (`drInit`)
 *  - X3DH-Modus (neu): `ensureDrSessionWithX3dh` → Pre-Key-Bundle + X3DH +
 *    `drInitFromX3DH` (anderes KDF-Label → kein Root-Kollisionsrisiko).
 *    Fallback auf `drInit` wenn keine OneTime-PreKeys verfügbar.
 */
import { base64FromUint8, uint8FromBase64 } from "./b64";
import {
  drDecrypt,
  drEncrypt,
  drInit,
  drInitFromX3DH,
  isDrWire,
  type DRState,
} from "./doubleRatchet";
import { metaGet, metaSet } from "./idb";
import { pad, unpad } from "./padding";
import { x3dhSender } from "./x3dh";
import * as api from "./api";

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

/**
 * X3DH-basierte Session-Initialisierung (mit Fallback).
 *
 * Versuche, ein Pre-Key-Bundle für den Peer zu laden und X3DH durchzuführen.
 * Wenn keine Pre-Keys verfügbar sind (z.B. alter Client ohne Upload), falle
 * auf den traditionellen `ensureDrSession` (direkter DH) zurück.
 *
 * Der daraus resultierende Root-Key ist anders als bei `ensureDrSession`,
 * weil `drInitFromX3DH` ein separates KDF-Label verwendet → kein Kollisionsrisiko.
 *
 * Token wird für API-Calls benötigt.
 */
export async function ensureDrSessionWithX3dh(
  myIdentitySk: Uint8Array,
  peerId: string,
  peerPublicKeyB64: string,
  token: string
): Promise<DRState> {
  // Prüfe ob bereits eine Session existiert
  const existing = await metaGet(metaKey(peerId));
  if (existing) {
    try {
      const p = JSON.parse(existing) as DRState;
      if (p.v === 4 && p.peerIdentityPk === peerPublicKeyB64) return p;
    } catch {
      /* reinit */
    }
  }

  try {
    // Versuche Pre-Key-Bundle vom Server zu holen
    const bundle = await api.getPreKeyBundle(token, peerId);

    // X3DH shared secret berechnen
    const x3dhResult = await x3dhSender(
      myIdentitySk,
      bundle.identityKey,
      bundle.signedPreKey.publicKey,
      bundle.oneTimePreKey?.publicKey ?? null
    );

    // DR-Session mit X3DH initiieren (anderes KDF-Label → kein Kollisionsrisiko)
    const fresh = await drInitFromX3DH(
      x3dhResult.sharedSecret,
      peerId,
      peerPublicKeyB64
    );

    // Merken dass dies eine X3DH-Session ist (Metadata)
    const stateWithMeta = { ...fresh };

    await metaSet(metaKey(peerId), JSON.stringify(stateWithMeta));
    return stateWithMeta;
  } catch {
    // Fallback: direkter DH (wie bisher)
    const fresh = await drInit(myIdentitySk, peerPublicKeyB64, peerId);
    await metaSet(metaKey(peerId), JSON.stringify(fresh));
    return fresh;
  }
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
