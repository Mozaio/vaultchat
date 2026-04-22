/**
 * VaultChat Double Ratchet (DR) — v4
 *
 *  - Identity-DH (X25519) erzeugt einen gemeinsamen Root.
 *  - Symmetrischer Ratchet pro Nachricht (BLAKE2b, domain-getrennt) → Forward Secrecy.
 *  - DH-Ratchet bei neuen Peer-Ratchet-Pubkeys → Post-Compromise Security.
 *  - AEAD mit XChaCha20-Poly1305 und AAD-Bindung auf den Header (Magic, Flags,
 *    Ratchet-Pub, Counter) — verhindert Header-Manipulation.
 *  - Bootstrap-Flag löst Asymmetrie bei erster Nachricht.
 *
 * Nicht implementiert: vollständiges X3DH / one-time prekeys. Siehe THREAT_MODEL.md.
 */
import { base64FromUint8, uint8FromBase64 } from "./b64";
import { publicKeyFromBase64 } from "./crypto";
import { getSodium, sodiumReady } from "./sodium";

const enc = new TextEncoder();

export type DRState = {
  v: 4;
  peerId: string;
  peerIdentityPk: string;
  root: string;
  myRatchet: { priv: string; pub: string } | null;
  peerRatchetPub: string;
  ckSend: string | null;
  ckRecv: string | null;
  nSend: number;
  nRecv: number;
};

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

async function kdfRoot(root: Uint8Array, input: Uint8Array): Promise<Uint8Array> {
  await sodiumReady();
  const sodium = getSodium();
  return sodium.crypto_generichash(
    32,
    concat(enc.encode("vaultchat-dr-v4-ck"), input),
    root
  );
}

async function advanceChain(ck: Uint8Array): Promise<[Uint8Array, Uint8Array]> {
  await sodiumReady();
  const sodium = getSodium();
  const next = sodium.crypto_generichash(
    32,
    concat(enc.encode("vaultchat-dr-v4-next"), new Uint8Array([0x02])),
    ck
  );
  const mk = sodium.crypto_generichash(
    32,
    concat(enc.encode("vaultchat-dr-v4-mk"), new Uint8Array([0x01])),
    ck
  );
  return [next, mk];
}

export async function drInit(
  myIdentitySk: Uint8Array,
  peerIdentityPkB64: string,
  peerId: string
): Promise<DRState> {
  await sodiumReady();
  const sodium = getSodium();
  const peerPk = publicKeyFromBase64(peerIdentityPkB64);
  const ss = sodium.crypto_scalarmult(myIdentitySk, peerPk);
  const root = sodium.crypto_generichash(32, enc.encode("vaultchat-dr-v4-root"), ss);
  return {
    v: 4,
    peerId,
    peerIdentityPk: peerIdentityPkB64,
    root: base64FromUint8(root),
    myRatchet: null,
    peerRatchetPub: peerIdentityPkB64,
    ckSend: null,
    ckRecv: null,
    nSend: 0,
    nRecv: 0,
  };
}

const MAGIC = new Uint8Array([0x56, 0x43, 0x44, 0x34]); // "VCD4"

export async function drEncrypt(
  state: DRState,
  plaintext: Uint8Array
): Promise<{ state: DRState; wire: Uint8Array }> {
  await sodiumReady();
  const sodium = getSodium();
  const s: DRState = { ...state };
  const isBootstrap = s.peerRatchetPub === s.peerIdentityPk;
  if (!s.myRatchet) {
    const kp = sodium.crypto_box_keypair();
    s.myRatchet = {
      priv: base64FromUint8(kp.privateKey),
      pub: base64FromUint8(kp.publicKey),
    };
    s.ckSend = null;
  }
  if (!s.ckSend) {
    const dhOut = sodium.crypto_scalarmult(
      uint8FromBase64(s.myRatchet.priv),
      uint8FromBase64(s.peerRatchetPub)
    );
    const ck = await kdfRoot(uint8FromBase64(s.root), dhOut);
    s.ckSend = base64FromUint8(ck);
    s.nSend = 0;
  }
  const [newCk, mk] = await advanceChain(uint8FromBase64(s.ckSend));
  const nonceLen = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  const nonce = sodium.randombytes_buf(nonceLen);
  const flags = isBootstrap ? 0x01 : 0x00;
  const nBuf = new Uint8Array(4);
  new DataView(nBuf.buffer).setUint32(0, s.nSend, false);
  const dhPub = uint8FromBase64(s.myRatchet.pub);
  const aad = new Uint8Array(MAGIC.length + 1 + 32 + 4);
  aad.set(MAGIC, 0);
  aad[MAGIC.length] = flags;
  aad.set(dhPub, MAGIC.length + 1);
  aad.set(nBuf, MAGIC.length + 1 + 32);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    aad,
    null,
    nonce,
    mk
  );
  const wire = new Uint8Array(aad.length + nonce.length + ct.length);
  let p = 0;
  wire.set(aad, p);
  p += aad.length;
  wire.set(nonce, p);
  p += nonce.length;
  wire.set(ct, p);
  s.ckSend = base64FromUint8(newCk);
  s.nSend += 1;
  return { state: s, wire };
}

export async function drDecrypt(
  state: DRState,
  myIdentitySk: Uint8Array,
  wire: Uint8Array
): Promise<{ state: DRState; plaintext: Uint8Array }> {
  await sodiumReady();
  const sodium = getSodium();
  const nonceLen = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  const aadLen = MAGIC.length + 1 + 32 + 4;
  if (wire.length < aadLen + nonceLen + 16) {
    throw new Error("short_wire");
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (wire[i] !== MAGIC[i]) throw new Error("bad_magic");
  }
  let p = MAGIC.length;
  const flags = wire[p++];
  const isBootstrap = (flags & 0x01) === 0x01;
  const dhPub = wire.subarray(p, p + 32);
  p += 32;
  const n = new DataView(wire.buffer, wire.byteOffset + p, 4).getUint32(0, false);
  p += 4;
  const aad = wire.subarray(0, aadLen);
  const nonce = wire.subarray(p, p + nonceLen);
  p += nonceLen;
  const ct = wire.subarray(p);
  const dhPubB64 = base64FromUint8(dhPub);

  let s: DRState = { ...state };

  if (isBootstrap) {
    if (s.peerRatchetPub !== dhPubB64) {
      const dhOut = sodium.crypto_scalarmult(myIdentitySk, dhPub);
      s.ckRecv = base64FromUint8(await kdfRoot(uint8FromBase64(s.root), dhOut));
      s.nRecv = 0;
      s.peerRatchetPub = dhPubB64;
    }
  } else {
    if (s.peerRatchetPub !== dhPubB64) {
      if (!s.myRatchet) {
        throw new Error("no_ratchet_but_non_bootstrap");
      }
      const dh1 = sodium.crypto_scalarmult(uint8FromBase64(s.myRatchet.priv), dhPub);
      const newCkRecv = await kdfRoot(uint8FromBase64(s.root), dh1);
      const newKp = sodium.crypto_box_keypair();
      const dh2 = sodium.crypto_scalarmult(newKp.privateKey, dhPub);
      const newCkSend = await kdfRoot(uint8FromBase64(s.root), dh2);
      s = {
        ...s,
        myRatchet: {
          priv: base64FromUint8(newKp.privateKey),
          pub: base64FromUint8(newKp.publicKey),
        },
        ckRecv: base64FromUint8(newCkRecv),
        ckSend: base64FromUint8(newCkSend),
        nSend: 0,
        nRecv: 0,
        peerRatchetPub: dhPubB64,
      };
    }
  }

  if (!s.ckRecv) throw new Error("no_recv_chain");
  if (n < s.nRecv) throw new Error("replay_or_out_of_order");
  const skips = n - s.nRecv;
  if (skips > 64) throw new Error("too_many_skipped");
  let ck = uint8FromBase64(s.ckRecv);
  for (let i = 0; i < skips; i++) {
    const [nextCk] = await advanceChain(ck);
    ck = nextCk;
  }
  const [newCk, mk] = await advanceChain(ck);
  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ct,
    aad,
    nonce,
    mk
  );
  s.ckRecv = base64FromUint8(newCk);
  s.nRecv = n + 1;
  return { state: s, plaintext };
}

export function isDrWire(b64: string): boolean {
  try {
    const buf = uint8FromBase64(b64);
    if (buf.length < MAGIC.length) return false;
    for (let i = 0; i < MAGIC.length; i++) {
      if (buf[i] !== MAGIC[i]) return false;
    }
    return true;
  } catch {
    return false;
  }
}
