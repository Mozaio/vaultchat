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
  initMode?: "legacy" | "x3dh" | "pqxdh";
  lastPreKeyAt?: number;
};

function metaKey(peerId: string) {
  return `dr:${peerId}`;
}

const X3DH_FRAME = new Uint8Array([0x56, 0x58, 0x33, 0x31]); // "VX31"
const DM_BUNDLE_FRAME = new Uint8Array([0x56, 0x44, 0x42, 0x31]); // "VDB1"

type X3dhPreKeyFrame = {
  v: 1;
  type: "x3dh_prekey";
  sentAt?: number;
  ephemeralPublicKey: string;
  signedPreKeyId: number;
  oneTimePreKeyId: number | null;
  pqKemCiphertext?: string;
  wire: string;
};

type DmBundleFrame = {
  v: 1;
  type: "dm_bundle";
  primary: string;
  recovery: string;
};

export type DmEncryptResult = {
  innerB64: string;
  mode: "pqxdh" | "x3dh" | "ratchet" | "legacy";
};

export type DmEncryptOptions = {
  requireRecovery?: boolean;
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
    !(
      typeof frame.sentAt === "undefined" ||
      typeof frame.sentAt === "number"
    ) ||
    typeof frame.ephemeralPublicKey !== "string" ||
    typeof frame.signedPreKeyId !== "number" ||
    !(typeof frame.oneTimePreKeyId === "number" || frame.oneTimePreKeyId === null) ||
    !(
      typeof frame.pqKemCiphertext === "undefined" ||
      typeof frame.pqKemCiphertext === "string"
    ) ||
    typeof frame.wire !== "string"
  ) {
    throw new Error("invalid_x3dh_frame");
  }
  return frame;
}

function encodeDmBundleFrame(frame: DmBundleFrame): string {
  const body = enc.encode(JSON.stringify(frame));
  const out = new Uint8Array(DM_BUNDLE_FRAME.length + body.length);
  out.set(DM_BUNDLE_FRAME, 0);
  out.set(body, DM_BUNDLE_FRAME.length);
  return base64FromUint8(out);
}

function decodeDmBundleFrame(b64: string): DmBundleFrame {
  const data = uint8FromBase64(b64);
  if (data.length <= DM_BUNDLE_FRAME.length) throw new Error("short_dm_bundle_frame");
  for (let i = 0; i < DM_BUNDLE_FRAME.length; i++) {
    if (data[i] !== DM_BUNDLE_FRAME[i]) throw new Error("bad_dm_bundle_frame");
  }
  const frame = JSON.parse(dec.decode(data.subarray(DM_BUNDLE_FRAME.length))) as DmBundleFrame;
  if (
    frame.v !== 1 ||
    frame.type !== "dm_bundle" ||
    typeof frame.primary !== "string" ||
    typeof frame.recovery !== "string"
  ) {
    throw new Error("invalid_dm_bundle_frame");
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

export function isDmBundleFrame(b64: string): boolean {
  try {
    decodeDmBundleFrame(b64);
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
      bundle.oneTimePreKey?.publicKey ?? null,
      bundle.pqKem?.publicKey ?? null
    );

    // DR-Session mit X3DH initiieren (anderes KDF-Label → kein Kollisionsrisiko)
    const fresh = await drInitFromX3DH(
      x3dhResult.sharedSecret,
      peerId,
      peerPublicKeyB64
    );

    // Merken dass dies eine X3DH-Session ist (Metadata)
    const stateWithMeta: PersistedDRState = {
      ...fresh,
      initMode: x3dhResult.pqKemCiphertext ? "pqxdh" : "x3dh",
    };

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

async function saveState(st: PersistedDRState): Promise<void> {
  await metaSet(metaKey(st.peerId), JSON.stringify(st));
}

const enc = new TextEncoder();
const dec = new TextDecoder();
let lastPreKeyStamp = 0;

function nextPreKeyStamp() {
  const now = Date.now();
  lastPreKeyStamp = Math.max(now, lastPreKeyStamp + 1);
  return lastPreKeyStamp;
}

async function loadState(
  peerId: string,
  peerPublicKeyB64: string,
  options: { requireLegacy?: boolean } = {}
): Promise<PersistedDRState | null> {
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

async function createX3dhPreKeyEnvelopeFromBundle(
  myIdentitySk: Uint8Array,
  peerId: string,
  peerPublicKeyB64: string,
  plainJson: string,
  bundle: api.PreKeyBundle,
  options: { forceSignedPreKeyOnly?: boolean; forceClassicalOnly?: boolean } = {}
): Promise<{ innerB64: string; state: PersistedDRState; mode: "pqxdh" | "x3dh" }> {
  if (bundle.identityKey !== peerPublicKeyB64) {
    throw new Error("identity_bundle_mismatch");
  }
  const sentAt = nextPreKeyStamp();
  const oneTimePreKey = options.forceSignedPreKeyOnly
    ? null
    : bundle.oneTimePreKey;
  const x3dh = await x3dhSender(
    myIdentitySk,
    bundle.identityKey,
    bundle.signedPreKey.publicKey,
    oneTimePreKey?.publicKey ?? null,
    options.forceClassicalOnly ? null : bundle.pqKem?.publicKey ?? null
  );
  const st: PersistedDRState = {
    ...(await drInitFromX3DH(x3dh.sharedSecret, peerId, peerPublicKeyB64)),
    initMode: x3dh.pqKemCiphertext ? "pqxdh" : "x3dh",
  };
  const padded = pad(enc.encode(plainJson));
  const { state, wire } = await drEncrypt(st, padded);
  return {
    innerB64: encodeX3dhFrame({
      v: 1,
      type: "x3dh_prekey",
      sentAt,
      ephemeralPublicKey: x3dh.ephemeralPublicKey,
      signedPreKeyId: bundle.signedPreKey.keyId,
      oneTimePreKeyId: oneTimePreKey?.keyId ?? null,
      ...(x3dh.pqKemCiphertext
        ? { pqKemCiphertext: x3dh.pqKemCiphertext }
        : {}),
      wire: base64FromUint8(wire),
    }),
    state: {
      ...state,
      initMode: x3dh.pqKemCiphertext ? "pqxdh" : "x3dh",
      lastPreKeyAt: sentAt,
    },
    mode: x3dh.pqKemCiphertext ? "pqxdh" : "x3dh",
  };
}

async function decryptInnerFrameJson(
  myIdentitySk: Uint8Array,
  peerId: string,
  peerPublicKeyB64: string,
  innerB64: string,
  receivedAt?: number
): Promise<string> {
  if (isDrCiphertext(innerB64)) {
    return drDecryptJson(myIdentitySk, peerId, peerPublicKeyB64, innerB64);
  }
  if (isX3dhPreKeyFrame(innerB64)) {
    return drDecryptX3dhPreKeyJson(
      myIdentitySk,
      peerId,
      peerPublicKeyB64,
      innerB64,
      receivedAt
    );
  }
  throw new Error("unsupported_dm_inner_frame");
}

export async function drEncryptJsonForDm(
  myIdentitySk: Uint8Array,
  peerId: string,
  peerPublicKeyB64: string,
  plainJson: string,
  token: string,
  options: DmEncryptOptions = {}
): Promise<DmEncryptResult> {
  const useX3dh = x3dhEnabled();
  if (useX3dh && options.requireRecovery) {
    const bundle = await api.getPreKeyBundle(token, peerId);
    const fresh = await createX3dhPreKeyEnvelopeFromBundle(
      myIdentitySk,
      peerId,
      peerPublicKeyB64,
      plainJson,
      bundle,
      { forceSignedPreKeyOnly: true, forceClassicalOnly: true }
    );
    await saveState(fresh.state);
    return { innerB64: fresh.innerB64, mode: fresh.mode };
  }
  const existing = await loadState(peerId, peerPublicKeyB64, {
    requireLegacy: !useX3dh,
  });
  if (existing) {
    const padded = pad(enc.encode(plainJson));
    const { state, wire } = await drEncrypt(existing, padded);
    await saveState(state);
    if (options.requireRecovery) throw new Error("prekey_recovery_unavailable");
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
    const x3dh = await createX3dhPreKeyEnvelopeFromBundle(
      myIdentitySk,
      peerId,
      peerPublicKeyB64,
      plainJson,
      bundle
    );
    await saveState(x3dh.state);
    if (bundle.oneTimePreKey || bundle.pqKem) {
      try {
        const recovery = await createX3dhPreKeyEnvelopeFromBundle(
          myIdentitySk,
          peerId,
          peerPublicKeyB64,
          plainJson,
          bundle,
          { forceSignedPreKeyOnly: true, forceClassicalOnly: true }
        );
        return {
          innerB64: encodeDmBundleFrame({
            v: 1,
            type: "dm_bundle",
            primary: x3dh.innerB64,
            recovery: recovery.innerB64,
          }),
          mode: x3dh.mode,
        };
      } catch {
        /* The primary X3DH frame is still valid when signed-prekey recovery cannot be built. */
      }
    }
    return { innerB64: x3dh.innerB64, mode: x3dh.mode };
  } catch (e) {
    if (e instanceof Error && e.message === "identity_bundle_mismatch") throw e;
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
  frameB64: string,
  receivedAt = Date.now()
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
    frame.ephemeralPublicKey,
    km.pqKem?.sk ?? null,
    frame.pqKemCiphertext ?? null
  );
  const st = await drInitFromX3DH(sharedSecret, peerId, peerPublicKeyB64);
  const wire = uint8FromBase64(frame.wire);
  const { state, plaintext } = await drDecrypt(st, myIdentitySk, wire);
  const result = dec.decode(unpad(plaintext));
  const preKeyAt = frame.sentAt ?? receivedAt;
  const existing = await loadState(peerId, peerPublicKeyB64);
  const existingPreKeyAt = existing?.lastPreKeyAt ?? 0;
  if (preKeyAt >= existingPreKeyAt) {
    // Multiple initial X3DH frames can arrive out of order before the peer's
    // first response. Never let an older pre-key frame roll back the live ratchet.
    await saveState({
      ...state,
      initMode: frame.pqKemCiphertext ? "pqxdh" : "x3dh",
      lastPreKeyAt: preKeyAt,
    });
  }
  if (frame.oneTimePreKeyId !== null) {
    await consumeOneTimePreKey(km, frame.oneTimePreKeyId);
  }
  return result;
}

export async function drDecryptDmBundleJson(
  myIdentitySk: Uint8Array,
  peerId: string,
  peerPublicKeyB64: string,
  frameB64: string,
  receivedAt?: number
): Promise<string> {
  const frame = decodeDmBundleFrame(frameB64);
  try {
    return await decryptInnerFrameJson(
      myIdentitySk,
      peerId,
      peerPublicKeyB64,
      frame.primary,
      receivedAt
    );
  } catch {
    return decryptInnerFrameJson(
      myIdentitySk,
      peerId,
      peerPublicKeyB64,
      frame.recovery,
      receivedAt
    );
  }
}

export function isDrCiphertext(b64: string): boolean {
  return isDrWire(b64);
}
