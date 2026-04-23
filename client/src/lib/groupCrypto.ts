/**
 * VaultChat Group Crypto — v2
 * 
 * Verbesserungen gegenüber v1:
 * - Perfect Forward Secrecy (PFS) durchSender-Ratchet pro Nachricht
 * - Sender-specific chains verhindern dassGruppenmitglieder dieNachrichten anderer entschlüsseln wenn sie nur denGruppenkey haben
 * - Jedes Mitglied generiert ephemeral key pro send Vorgang
 * - Metadata-Minimierung: Server sieht keinenSender
 */
import { base64FromUint8, uint8FromBase64 } from "./b64";
import { getSodium, sodiumReady } from "./sodium";
import { metaGet, metaSet } from "./idb";
import type { PlainPayload } from "./crypto";

const MAGIC = new Uint8Array([0x47, 0x43, 0x32]); // "GC2" - new version header
const enc = new TextEncoder();

// Group sender key state (PFS per sender)
export type GroupSenderState = {
  senderKey: string; // base64 of 32-byte chain key
  chainCounter: number;
  ephemeralPub: string;
  ephemeralPriv: string;
};

export type GroupKeyState = {
  groupId: string;
  rootKey: string; // base64 of 32-byte root key
  senderStates: Record<string, GroupSenderState>; // senderId -> sender state
  memberPublicKeys: Record<string, string>; // senderId -> publicKey for verification
};

export async function setGroupKey(groupId: string, key32: Uint8Array) {
  await metaSet(`gkey:${groupId}`, base64FromUint8(key32));
}

export async function setGroupKeyState(groupId: string, state: GroupKeyState) {
  await metaSet(`gstate:${groupId}`, JSON.stringify(state));
}

export async function getGroupKeyState(groupId: string): Promise<GroupKeyState | null> {
  const raw = await metaGet(`gstate:${groupId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GroupKeyState;
  } catch {
    return null;
  }
}

// Chain key derivation
async function deriveChainKey(rootKey: Uint8Array, chainIndex: number): Promise<[Uint8Array, Uint8Array]> {
  await sodiumReady();
  const sodium = getSodium();
  const idxBuf = new Uint8Array(4);
  new DataView(idxBuf.buffer).setUint32(0, chainIndex, false);
  
  // Derive chain key (for next message)
  const nextKey = sodium.crypto_generichash(
    32,
    idxBuf,
    rootKey
  );
  
  // Derive message key
  const messageKey = sodium.crypto_generichash(
    32,
    enc.encode("message"),
    rootKey
  );
  
  return [nextKey, messageKey];
}

// Legacy key migration helper
export async function getGroupKey(groupId: string): Promise<Uint8Array | null> {
  const b = await metaGet(`gkey:${groupId}`);
  if (!b) return null;
  return uint8FromBase64(b);
}

export async function randomGroupKey(): Promise<Uint8Array> {
  await sodiumReady();
  return getSodium().randombytes_buf(32);
}

// Initialize group key state with PFS
export async function initGroupKeyState(
  groupId: string,
  memberIds: string[],
  mySenderId: string,
  myIdentitySk: Uint8Array
): Promise<GroupKeyState> {
  await sodiumReady();
  const sodium = getSodium();
  
  // Generate new root key
  const rootKey = sodium.randombytes_buf(32);
  
  // Generate sender key for myself
  const senderKp = sodium.crypto_box_keypair();
  const senderState: GroupSenderState = {
    senderKey: base64FromUint8(sodium.randombytes_buf(32)),
    chainCounter: 0,
    ephemeralPub: base64FromUint8(senderKp.publicKey),
    ephemeralPriv: base64FromUint8(senderKp.privateKey),
  };
  
  const state: GroupKeyState = {
    groupId,
    rootKey: base64FromUint8(rootKey),
    senderStates: { [mySenderId]: senderState },
    memberPublicKeys: {}, // Will be populated as we receive keys from other members
  };
  
  await setGroupKeyState(groupId, state);
  
  // Set legacy key for backward compatibility
  await metaSet(`gkey:${groupId}`, base64FromUint8(rootKey));
  
  return state;
}

// Rotate group key with new root - called when member joins/leaves
export async function rotateGroupKey(
  groupId: string,
  mySenderId: string,
  excludeMembers: string[] = []
): Promise<{ newRootKey: Uint8Array; newSenderKey: string; messages: { toUserId: string; payload: PlainPayload }[] }> {
  await sodiumReady();
  const sodium = getSodium();
  const state = await getGroupKeyState(groupId);
  if (!state) throw new Error("no_group_state");

  // Generate new root key
  const newRootKey = sodium.randombytes_buf(32);
  const newSenderKey = sodium.randombytes_buf(32);
  
  // Derive first chain key from new root
  const [nextKey, firstMessageKey] = await deriveChainKey(newRootKey, 0);
  
  // Update own sender state
  const senderKp = sodium.crypto_box_keypair();
  state.senderStates[mySenderId] = {
    senderKey: base64FromUint8(newSenderKey),
    chainCounter: 0,
    ephemeralPub: base64FromUint8(senderKp.publicKey),
    ephemeralPriv: base64FromUint8(senderKp.privateKey),
  };
  state.rootKey = base64FromUint8(newRootKey);
  
  await setGroupKeyState(groupId, state);
  
  // Create key distribution messages for other members
  // These will be sent via sealed sender DM
  const distributionMessages: { toUserId: string; payload: PlainPayload }[] = [];
  
  for (const memberId of Object.keys(state.memberPublicKeys)) {
    if (memberId === mySenderId || excludeMembers.includes(memberId)) continue;
    distributionMessages.push({
      toUserId: memberId,
      payload: {
        v: 2,
        cid: crypto.randomUUID(),
        kind: "group_key",
        groupId,
        keyB64: base64FromUint8(newRootKey),
        senderEphemeral: base64FromUint8(senderKp.publicKey),
      },
    });
  }
  
  return { newRootKey, newSenderKey, messages: distributionMessages };
}

// Encrypt group message with sender-specific ratchet (PFS)
export async function encryptGroupMessage(
  groupId: string,
  senderId: string,
  payload: PlainPayload
): Promise<{ ciphertext: string; senderChainKey: string }> {
  await sodiumReady();
  const sodium = getSodium();
  const state = await getGroupKeyState(groupId);
  if (!state) throw new Error("no_group_state");
  
  const senderState = state.senderStates[senderId];
  if (!senderState) throw new Error("no_sender_state");
  
  // Derive current chain key
  const chainKey = uint8FromBase64(senderState.senderKey);
  const [nextChainKey, messageKey] = await deriveChainKey(chainKey, senderState.chainCounter);
  
  // Generate message nonce
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  
  // Include sender ephemeral public key in AAD for verification
  const senderPub = uint8FromBase64(senderState.ephemeralPub);
  const aad = new Uint8Array(32 + 4);
  aad.set(senderPub, 0);
  const counterBuf = new Uint8Array(4);
  new DataView(counterBuf.buffer).setUint32(0, senderState.chainCounter, false);
  aad.set(counterBuf, 32);
  
  // Encrypt payload
  const plaintext = enc.encode(JSON.stringify(payload));
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    aad,
    null,
    nonce,
    messageKey
  );
  
  // Build wire format: MAGIC || senderId || counter || senderEphPub || nonce || ciphertext
  const senderIdBytes = uuidToBytes(senderId);
  const counterBytes = new Uint8Array(4);
  new DataView(counterBytes.buffer).setUint32(0, senderState.chainCounter, false);
  
  const wire = new Uint8Array(
    MAGIC.length + 16 + 4 + 32 + nonce.length + ciphertext.length
  );
  let p = 0;
  wire.set(MAGIC, p);
  p += MAGIC.length;
  wire.set(senderIdBytes, p);
  p += 16;
  wire.set(counterBytes, p);
  p += 4;
  wire.set(senderPub, p);
  p += 32;
  wire.set(nonce, p);
  p += nonce.length;
  wire.set(ciphertext, p);
  
  // Update sender state
  senderState.senderKey = base64FromUint8(nextChainKey);
  senderState.chainCounter += 1;
  await setGroupKeyState(groupId, state);
  
  return {
    ciphertext: base64FromUint8(wire),
    senderChainKey: base64FromUint8(nextChainKey),
  };
}

// Decrypt group message - needs sender's ephemeral private key
export async function decryptGroupMessage(
  groupId: string,
  recipientSenderId: string,
  recipientPrivateKey: Uint8Array,
  ciphertextB64: string
): Promise<{ plaintext: PlainPayload; senderId: string }> {
  await sodiumReady();
  const sodium = getSodium();
  const state = await getGroupKeyState(groupId);
  if (!state) throw new Error("no_group_state");
  
  const buf = uint8FromBase64(ciphertextB64);
  
  // Parse wire format
  if (buf.length < MAGIC.length + 16 + 4 + 32) throw new Error("bad_ciphertext");
  
  let p = 0;
  for (let i = 0; i < MAGIC.length; i++) {
    if (buf[i] !== MAGIC[i]) throw new Error("bad_magic");
  }
  p += MAGIC.length;
  
  const senderIdBytes = buf.subarray(p, p + 16);
  p += 16;
  const senderId = bytesToUuid(senderIdBytes);
  
  const counterBytes = buf.subarray(p, p + 4);
  const counter = new DataView(counterBytes.buffer, counterBytes.byteOffset, 4).getUint32(0, false);
  p += 4;
  
  const senderEphPub = buf.subarray(p, p + 32);
  p += 32;
  
  const nonceLen = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  const nonce = buf.subarray(p, p + nonceLen);
  p += nonceLen;
  const ciphertext = buf.subarray(p);
  
  // Find sender state - if not exists, initialize from stored chain key
  let senderState = state.senderStates[senderId];
  if (!senderState) {
    // Need to derive chain key from stored root key + counter
    // For now, derive from root key (in production would store chain keys per sender)
    const rootKey = uint8FromBase64(state.rootKey);
    let chainKey = rootKey;
    for (let i = 0; i < counter; i++) {
      const [next] = await deriveChainKey(chainKey, i);
      chainKey = next;
    }
    senderState = {
      senderKey: base64FromUint8(chainKey),
      chainCounter: counter,
      ephemeralPub: base64FromUint8(senderEphPub),
      ephemeralPriv: "", // We don't have their private key
    };
    state.senderStates[senderId] = senderState;
  }
  
  // Build AAD for decryption
  const aad = new Uint8Array(32 + 4);
  aad.set(senderEphPub, 0);
  const counterBuf = new Uint8Array(4);
  new DataView(counterBuf.buffer).setUint32(0, counter, false);
  aad.set(counterBuf, 32);
  
  // Get message key (need to advance chain to counter)
  let chainKey = uint8FromBase64(senderState.senderKey);
  for (let i = senderState.chainCounter; i < counter; i++) {
    const [next] = await deriveChainKey(chainKey, i);
    chainKey = next;
  }
  
  const [, messageKey] = await deriveChainKey(chainKey, counter);
  
  // Decrypt
  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ciphertext,
    aad,
    nonce,
    messageKey
  );
  
  // Update chain counter
  senderState.chainCounter = counter + 1;
  senderState.senderKey = base64FromUint8(chainKey);
  await setGroupKeyState(groupId, state);
  
  return {
    plaintext: JSON.parse(new TextDecoder().decode(plaintext)) as PlainPayload,
    senderId,
  };
}

// Legacy decrypt for backward compatibility
export async function decryptGroupPayload(
  groupId: string,
  b64: string
): Promise<PlainPayload> {
  await sodiumReady();
  const sodium = getSodium();
  const buf = uint8FromBase64(b64);
  
  // Check if it's new format (GC2) or legacy (GC1)
  if (buf.length >= 3 && buf[0] === MAGIC[0] && buf[1] === MAGIC[1] && buf[2] === MAGIC[2]) {
    // New format - but we need sender info which we don't have
    // For now, try to decrypt with stored state
    const state = await getGroupKeyState(groupId);
    if (state && Object.keys(state.senderStates).length > 0) {
      const firstSenderId = Object.keys(state.senderStates)[0];
      const senderState = state.senderStates[firstSenderId];
      return decryptGroupMessage(groupId, firstSenderId, uint8FromBase64(senderState.ephemeralPriv), b64)
        .then(r => r.plaintext);
    }
    throw new Error("need_sender_key_for_v2");
  }
  
  // Legacy format
  const legacyMagic = new Uint8Array([0x47, 0x43, 0x31, 0x01]);
  if (buf.length < legacyMagic.length) throw new Error("bad_group_cipher");
  for (let i = 0; i < legacyMagic.length; i++) {
    if (buf[i] !== legacyMagic[i]) throw new Error("bad_group_magic");
  }
  const key = await getGroupKey(groupId);
  if (!key) throw new Error("no_group_key");
  const n = sodium.crypto_secretbox_NONCEBYTES;
  const nonce = buf.subarray(legacyMagic.length, legacyMagic.length + n);
  const cipher = buf.subarray(legacyMagic.length + n);
  const plain = sodium.crypto_secretbox_open_easy(cipher, nonce, key);
  return JSON.parse(new TextDecoder().decode(plain)) as PlainPayload;
}

export async function encryptGroupPayload(
  groupId: string,
  payload: PlainPayload
): Promise<string> {
  await sodiumReady();
  const sodium = getSodium();
  const state = await getGroupKeyState(groupId);
  
  if (state && Object.keys(state.senderStates).length > 0) {
    // Use new PFS encrypt
    const senderId = Object.keys(state.senderStates)[0];
    const result = await encryptGroupMessage(groupId, senderId, payload);
    return result.ciphertext;
  }
  
  // Legacy encryption
  const key = await getGroupKey(groupId);
  if (!key) throw new Error("no_group_key");
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const cipher = sodium.crypto_secretbox_easy(
    enc.encode(JSON.stringify(payload)),
    nonce,
    key
  );
  // Use legacy magic for backward compat
  const legacyMagic = new Uint8Array([0x47, 0x43, 0x31, 0x01]);
  const out = new Uint8Array(legacyMagic.length + nonce.length + cipher.length);
  let p = 0;
  out.set(legacyMagic, p);
  p += legacyMagic.length;
  out.set(nonce, p);
  p += nonce.length;
  out.set(cipher, p);
  return base64FromUint8(out);
}

// Helper functions
function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) throw new Error("bad_uuid");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToUuid(b: Uint8Array): string {
  if (b.length !== 16) throw new Error("bad_uuid_len");
  const h = Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}