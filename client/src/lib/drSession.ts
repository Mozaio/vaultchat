/**
 * Double-Ratchet Session-Wrapper.
 *
 * Persistiert den DR-State pro Peer in der verschlüsselten IndexedDB
 * (über metaGet/metaSet) und bietet encrypt/decrypt für DM-Payloads.
 * Verwendet Längen-Padding, damit Ciphertext-Größen nichts über die echte
 * Nachrichtenlänge verraten.
 *
 * Session-Initialisierung:
 *  - Neue Peers: X3DH-Prekey-Frame im ersten Sealed-Sender-Envelope.
 *  - Bestehende Peers: normaler Double-Ratchet-Wire.
 *  - Legacy-Fallback: direkter Identity-DH nur bei explizitem Opt-in.
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
import {
  consumeOneTimePreKey,
  loadKeyMaterial,
} from "./keyStore";
import { pad, unpad } from "./padding";
import { x3dhReceiver, x3dhSender } from "./x3dh";
import * as api from "./api";

type PersistedDRState = DRState & {
  initMode?: "legacy" | "x3dh";
};

function metaKey(peerId: string) {
  return `dr:${peerId}`;
}

const X3DH_FRAME = new Uint8Array([0x56, 0x58, 0x33, 0x31]); // "VX31"

type X3dhPreKeyFrame = {
  v: 1;
  type: "x3dh_prekey";
  ephemeralPublicKey: string;
  signedPreKeyId: number;
  oneTimePreKeyId: number | null;
  wire: string;
};

export type DmEncryptResult = {
  innerB64: string;
  mode: "x3dh" | "ratchet" | "legacy";
};

function x3dhEnabled(): boolean {
  return import.meta.env.VITE_VAULTCHAT_ENABLE_X3DH !== "0";
}

function legacyDhAllowed(): boolean {
  return import.meta.env.VITE_VAULTCHAT_ALLOW_LEGACY_DH === "1";
}

function encodeX3dhFrame(frame: X3dhPreKeyFrame): string {
  const body = enc.encode(JSON.stringify(frame));
  const out = new Uint8Array(X3DH_FRAME.length + body.length);
  out.set(X3DH_FRAME, 0);
  out.set(body, X3DH_FRAME.length);
  return base64FromUint8(out);
}

function decodeX3dhFrame(b64: string): X3dhPreKeyFrame {
  const data = uint8FromBase64(b64);
  if (data.length <= X3DH_FRAME.length) throw new Error("short_x3dh_frame");
  for (let i = 0; i < X3DH_FRAME.length; i++) {
    if (data[i] !== X3DH_FRAME[i]) throw new Error("bad_x3dh_frame");
  }
  const frame = JSON.parse(dec.decode(data.subarray(X3DH_FRAME.length))) as X3dhPreKeyFrame;
  if (
    frame.v !== 1 ||
    frame.type !== "x3dh_prekey" ||
    typeof frame.ephemeralPublicKey !== "string" ||
    typeof frame.signedPreKeyId !== "number" ||
    !(typeof frame.oneTimePreKeyId === "number" || frame.oneTimePreKeyId === null) ||
    typeof frame.wire !== "string"
  ) {
    throw new Error("invalid_x3dh_frame");
  }
  return frame;
}

export function isX3dhPreKeyFrame(b64: string): boolean {
  try {
    decodeX3dhFrame(b64);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDrSession(
  myIdentitySk: Uint8Array,
  peerId: string,
  peerPublicKeyB64: string
): Promise<DRState> {
  const existing = await metaGet(metaKey(peerId));
  if (existing) {
    try {
      const p = JSON.parse(existing) as PersistedDRState;
      if (p.v === 4 && p.peerIdentityPk === peerPublicKeyB64) return p;
    } catch {
      /* reinit */
    }
  }
  const fresh: PersistedDRState = {
    ...(await drInit(myIdentitySk, peerPublicKeyB64, peerId)),
    initMode: "legacy",
  };
  await metaSet(metaKey(peerId), JSON.stringify(fresh));
  return fresh;
}

/**
 * X3DH-basierte Session-Initialisierung.
 *
 * Versuche, ein Pre-Key-Bundle fuer den Peer zu laden und X3DH durchzufuehren.
 * Ohne PreKeys wird nur mit `VITE_VAULTCHAT_ALLOW_LEGACY_DH=1` auf direkten
 * DH zurueckgefallen. Der sichere Default ist Fail-Closed.
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
      const p = JSON.parse(existing) as PersistedDRState;
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
    const stateWithMeta: PersistedDRState = { ...fresh, initMode: "x3dh" };

    await metaSet(metaKey(peerId), JSON.stringify(stateWithMeta));
    return stateWithMeta;
  } catch {
    if (!legacyDhAllowed()) throw new Error("prekey_bundle_unavailable");
    const fresh: PersistedDRState = {
      ...(await drInit(myIdentitySk, peerPublicKeyB64, peerId)),
      initMode: "legacy",
    };
    await metaSet(metaKey(peerId), JSON.stringify(fresh));
    return fresh;
  }
}

async function saveState(st: DRState): Promise<void> {
  await metaSet(metaKey(st.peerId), JSON.stringify(st));
}

const enc = new TextEncoder();
const dec = new TextDecoder();

async function loadState(
  peerId: string,
  peerPublicKeyB64: string,
  options: { requireLegacy?: boolean } = {}
): Promise<DRState | null> {
  const existing = await metaGet(metaKey(peerId));
  if (!existing) return null;
  try {
    const p = JSON.parse(existing) as PersistedDRState;
    if (options.requireLegacy && p.initMode !== "legacy") return null;
    if (p.v === 4 && p.peerIdentityPk === peerPublicKeyB64) return p;
  } catch {
    /* ignore */
  }
  return null;
}

export async function drEncryptJsonForDm(
  myIdentitySk: Uint8Array,
  peerId: string,
  peerPublicKeyB64: string,
  plainJson: string,
  token: string
): Promise<DmEncryptResult> {
  const useX3dh = x3dhEnabled();
  const existing = await loadState(peerId, peerPublicKeyB64, {
    requireLegacy: !useX3dh,
  });
  if (existing) {
    const padded = pad(enc.encode(plainJson));
    const { state, wire } = await drEncrypt(existing, padded);
    await saveState(state);
    return { innerB64: base64FromUint8(wire), mode: "ratchet" };
  }

  if (!useX3dh) {
    if (!legacyDhAllowed()) throw new Error("x3dh_required");
    const st = await ensureDrSession(myIdentitySk, peerId, peerPublicKeyB64);
    const padded = pad(enc.encode(plainJson));
    const { state, wire } = await drEncrypt(st, padded);
    await saveState(state);
    return { innerB64: base64FromUint8(wire), mode: "legacy" };
  }

  try {
    const bundle = await api.getPreKeyBundle(token, peerId);
    const x3dh = await x3dhSender(
      myIdentitySk,
      bundle.identityKey,
      bundle.signedPreKey.publicKey,
      bundle.oneTimePreKey?.publicKey ?? null
    );
    const st: PersistedDRState = {
      ...(await drInitFromX3DH(x3dh.sharedSecret, peerId, peerPublicKeyB64)),
      initMode: "x3dh",
    };
    const padded = pad(enc.encode(plainJson));
    const { state, wire } = await drEncrypt(st, padded);
    await saveState(state);
    return {
      innerB64: encodeX3dhFrame({
        v: 1,
        type: "x3dh_prekey",
        ephemeralPublicKey: x3dh.ephemeralPublicKey,
        signedPreKeyId: bundle.signedPreKey.keyId,
        oneTimePreKeyId: bundle.oneTimePreKey?.keyId ?? null,
        wire: base64FromUint8(wire),
      }),
      mode: "x3dh",
    };
  } catch {
    if (!legacyDhAllowed()) throw new Error("prekey_bundle_unavailable");
    const st = await ensureDrSession(myIdentitySk, peerId, peerPublicKeyB64);
    const padded = pad(enc.encode(plainJson));
    const { state, wire } = await drEncrypt(st, padded);
    await saveState(state);
    return { innerB64: base64FromUint8(wire), mode: "legacy" };
  }
}

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
  const useX3dh = x3dhEnabled();
  const st =
    (await loadState(peerId, peerPublicKeyB64, { requireLegacy: !useX3dh })) ??
    (legacyDhAllowed()
      ? await ensureDrSession(myIdentitySk, peerId, peerPublicKeyB64)
      : null);
  if (!st) throw new Error("missing_ratchet_session");
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

export async function drDecryptX3dhPreKeyJson(
  myIdentitySk: Uint8Array,
  peerId: string,
  peerPublicKeyB64: string,
  frameB64: string
): Promise<string> {
  const frame = decodeX3dhFrame(frameB64);
  const km = await loadKeyMaterial();
  if (!km) throw new Error("key_material_missing");
  if (km.signedPreKey.keyId !== frame.signedPreKeyId) {
    throw new Error("signed_prekey_not_found");
  }
  const otpSk =
    frame.oneTimePreKeyId === null
      ? null
      : km.oneTimePreKeys.find((k) => k.keyId === frame.oneTimePreKeyId)?.sk ?? null;
  if (frame.oneTimePreKeyId !== null && !otpSk) {
    throw new Error("one_time_prekey_not_found");
  }
  const sharedSecret = await x3dhReceiver(
    myIdentitySk,
    peerPublicKeyB64,
    km.signedPreKey.sk,
    otpSk,
    frame.ephemeralPublicKey
  );
  const st = await drInitFromX3DH(sharedSecret, peerId, peerPublicKeyB64);
  const wire = uint8FromBase64(frame.wire);
  const { state, plaintext } = await drDecrypt(st, myIdentitySk, wire);
  const result = dec.decode(unpad(plaintext));
  // A peer may legitimately restart its local ratchet state after a browser
  // reset or device restore. Accepting a fresh X3DH pre-key message here keeps
  // delivery working while still requiring a valid signed pre-key handshake.
  await saveState(state);
  if (frame.oneTimePreKeyId !== null) {
    await consumeOneTimePreKey(km, frame.oneTimePreKeyId);
  }
  return result;
}

export function isDrCiphertext(b64: string): boolean {
  return isDrWire(b64);
}
