import { base64FromUint8, uint8FromBase64 } from "./b64";
import { getSodium, sodiumReady } from "./sodium";

export type KeyPair = {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
};

export type WrappedSecret = {
  salt: string;
  nonce: string;
  cipher: string;
  /** KDF-Versionierung (#22): Parameter werden mitgespeichert, damit ein
   *  späteres Anheben der Argon2-Kosten alte Wraps weiter entschlüsselt.
   *  Fehlende Felder = Legacy-Wrap → INTERACTIVE-Konstanten. */
  kdf?: "argon2id";
  ops?: number;
  mem?: number;
};

/** Sanity-Clamp für gespeicherte KDF-Parameter: schützt vor manipulierten
 *  Werten (z. B. mem=4 GB als DoS oder ops=0 als Downgrade). Außerhalb des
 *  Korridors fallen wir auf die Default-Konstanten zurück — schlägt die
 *  MAC-Prüfung dann fehl, gibt es einen sauberen Fehler statt Browser-OOM. */
export function clampKdfParams(
  ops: unknown,
  mem: unknown,
  defaults: { ops: number; mem: number }
): { ops: number; mem: number } {
  const okOps =
    typeof ops === "number" && Number.isInteger(ops) && ops >= 1 && ops <= 16;
  const okMem =
    typeof mem === "number" &&
    Number.isInteger(mem) &&
    mem >= 8 * 1024 * 1024 &&
    mem <= 1024 * 1024 * 1024;
  return {
    ops: okOps ? (ops as number) : defaults.ops,
    mem: okMem ? (mem as number) : defaults.mem,
  };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function pwhashAlg(sodium: {
  crypto_pwhash_ALG_ARGON2ID?: number;
  crypto_pwhash_ALG_ARGON2ID13?: number;
  crypto_pwhash_ALG_DEFAULT?: number;
}): number {
  const alg =
    sodium.crypto_pwhash_ALG_ARGON2ID ??
    sodium.crypto_pwhash_ALG_ARGON2ID13 ??
    sodium.crypto_pwhash_ALG_DEFAULT;
  if (typeof alg !== "number") {
    throw new Error("argon2_algorithm_unavailable");
  }
  return alg;
}

export async function generateBoxKeypair(): Promise<KeyPair> {
  await sodiumReady();
  const sodium = getSodium();
  const kp = sodium.crypto_box_keypair();
  return { publicKey: kp.publicKey, secretKey: kp.privateKey };
}

export function publicKeyBase64(pk: Uint8Array): string {
  return base64FromUint8(pk);
}

export function publicKeyFromBase64(b64: string): Uint8Array {
  return uint8FromBase64(b64);
}

/** Argon2id + secretbox: wraps X25519 secret key for local persistence. */
export async function wrapSecretKey(
  secretKey: Uint8Array,
  password: string
): Promise<WrappedSecret> {
  await sodiumReady();
  const sodium = getSodium();
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  // #22: Parameter explizit festhalten statt implizit über die Konstanten —
  // der Unwrap nutzt die GESPEICHERTEN Werte, nicht die dann aktuellen.
  const ops = sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE;
  const mem = sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE;
  const key = sodium.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES,
    password,
    salt,
    ops,
    mem,
    pwhashAlg(sodium)
  );
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const cipher = sodium.crypto_secretbox_easy(secretKey, nonce, key);
  sodium.memzero(key);
  return {
    salt: base64FromUint8(salt),
    nonce: base64FromUint8(nonce),
    cipher: base64FromUint8(cipher),
    kdf: "argon2id",
    ops,
    mem,
  };
}

export async function unwrapSecretKey(
  w: WrappedSecret,
  password: string
): Promise<Uint8Array> {
  await sodiumReady();
  const sodium = getSodium();
  const salt = uint8FromBase64(w.salt);
  const nonce = uint8FromBase64(w.nonce);
  const cipher = uint8FromBase64(w.cipher);
  // Legacy-Wraps ohne Params → INTERACTIVE; gespeicherte Werte geclampt.
  const { ops, mem } = clampKdfParams(w.ops, w.mem, {
    ops: sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    mem: sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
  });
  const key = sodium.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES,
    password,
    salt,
    ops,
    mem,
    pwhashAlg(sodium)
  );
  const sk = sodium.crypto_secretbox_open_easy(cipher, nonce, key);
  sodium.memzero(key);
  return sk;
}

/**
 * Vereinheitlichte E2EE-Payload (v2).
 *
 * Jede Nachricht ist ein "Frame" im Chat. Reaktionen, Antworten, Bearbeitungen
 * und Löschungen sind eigenständige Frames, die sich auf eine ID beziehen.
 * Lesebestätigungen und Zustellbestätigungen laufen ebenfalls als Frames
 * (Ende-zu-Ende verschlüsselt, nicht server-sichtbar).
 */
export type PlainPayload = {
  v: 2;
  /** Client-generierte Nachrichten-ID (clientId). Für Reply/Reaktion/Edit/Delete als Referenz. */
  cid: string;
  kind:
    | "text"
    | "file"
    | "voice"
    | "group_key"
    | "megolm_session_key"
    | "megolm_key_request"
    | "reaction"
    | "edit"
    | "delete"
    | "receipt"
    | "system"
    | "poll"
    | "poll-vote"
    | "voice_announce"
    | "profile_key";
  /** Text-Body bzw. Data-URL für Datei/Voice. Leer für Meta-Frames. */
  body?: string;
  fileName?: string;
  mime?: string;
  /** Originale Dateigröße in Bytes (für Anzeige in der Bubble). */
  fileSize?: number;
  /**
   * Kleines, verschlüsseltes Vorschaubild (data-URL, ~256px JPEG) für Bild-
   * Attachments. Reist innerhalb der bereits sealed PlainPayload — also
   * automatisch E2EE, kein separater Schlüssel/Server-Fetch. Der Empfänger
   * kann es sofort rendern, während das (ggf. große) Vollbild aus `body`
   * lazy geladen wird. Optional/rückwärtskompatibel: ältere Clients lassen
   * das Feld weg, der Empfänger fällt dann auf `body` zurück. */
  thumb?: string;
  /** Originalmaße des Bildes in Pixeln (für stabiles Layout / Seitenverhältnis,
   *  ohne das Vollbild zu dekodieren). */
  width?: number;
  height?: number;
  /** Laufzeit in Millisekunden für Sprachnachrichten. */
  durationMs?: number;
  /** Empfänger-IDs einer Weiterleitung (Vorschau/Markierung). */
  forwardedFromUserId?: string;
  /** Bezug auf frühere cid für Antworten. */
  replyToCid?: string;
  /** Kurzvorschau der zitierten Nachricht (wird vom Sender erzeugt, damit Empfänger rendern kann). */
  replyPreview?: string;
  /**
   * Wenn gesetzt, gehört diese Nachricht zu einem Thread, dessen
   * Wurzel die angegebene Cid ist. Threads werden in der Hauptansicht
   * unterdrückt und in einem separaten Thread-Panel angezeigt.
   */
  threadParentCid?: string;
  /** Bezug für Reaktion / Edit / Delete / Receipt. */
  refCid?: string;
  /** Emoji der Reaktion; leer = Reaktion entfernt. */
  emoji?: string;
  /** Empfangs-/Lesebestätigung. */
  receiptKind?: "delivered" | "read";
  /** Time-to-live nach Zustellung in ms (verschwindende Nachrichten). */
  ttlMs?: number;
  /** Wenn true: Nachricht wird beim ersten Anschauen lokal gelöscht
   *  (Snapchat/Signal-Style View-Once). Best-effort — kein Schutz vor Screenshot. */
  viewOnce?: boolean;
  /** Nur bei kind === "poll". */
  pollQuestion?: string;
  pollOptions?: string[];
  /** Nur bei kind === "poll-vote". refCid zeigt auf die poll. */
  pollVoteIndex?: number;
  /** Nur bei kind === "group_key" */
  groupId?: string;
  keyB64?: string;
  /** Sender ephemeral public key für Gruppen-PFS */
  senderEphemeral?: string;
  /** Nur bei kind === "megolm_session_key": Megolm-Sitzungs-ID + Session-Key
   *  des Senders. Empfänger ruft `ingestSessionKey` auf, um eine
   *  InboundGroupSession aufzubauen. */
  megolmSessionId?: string;
  megolmSessionKey?: string;
  /** Optional auf dem megolm_session_key-Frame mitgeschickt: das geteilte
   *  Gruppen-Geheimnis (Group Master Key) zum E2EE-Verschlüsseln von
   *  Gruppen-Metadaten (Name/Avatar). epoch versioniert Rotationen. */
  groupSecretKey?: string;
  groupSecretEpoch?: number;
  /** Nur bei kind === "voice_announce": ephemerale Voice-Room-Koordination
   *  (Beitreten/Verlassen/Anwesend). Wird NICHT gespeichert oder gerendert,
   *  sondern an den GroupCallController weitergereicht. */
  voiceKind?: "voice_join" | "voice_leave" | "voice_present";
  /** Profile-Key des Absenders (base64) zum E2EE-Entschlüsseln seines
   *  Profil-Blobs (Anzeigename/Avatar). Wird auf einem dedizierten
   *  `profile_key`-Frame ODER huckepack auf Distributions-Frames über Olm
   *  geteilt — NIE an den Server. `profileKeyEpoch` versioniert Rotationen
   *  (höhere Epoche gewinnt). Empfänger ruft `adoptContactProfileKey`. */
  profileKey?: string;
  profileKeyEpoch?: number;
  /**
   * Für Gruppen-Sealed-Sender: der Absender ist in der E2EE-Payload enthalten,
   * nicht im server-sichtbaren Group-Frame. Für DMs wird der Absender per
   * Sealed-Envelope am Transport transportiert; das Feld hier dient dann als
   * Redundanz/Plausibilisierung.
   */
  senderUserId?: string;
};

export async function sealPayload(
  payload: PlainPayload,
  recipientPkB64: string
): Promise<string> {
  await sodiumReady();
  const sodium = getSodium();
  const pk = publicKeyFromBase64(recipientPkB64);
  const bytes = enc.encode(JSON.stringify(payload));
  const sealed = sodium.crypto_box_seal(bytes, pk);
  return base64FromUint8(sealed);
}

export async function openPayload(
  ciphertextB64: string,
  recipientPkB64: string,
  recipientSk: Uint8Array
): Promise<PlainPayload> {
  await sodiumReady();
  const sodium = getSodium();
  const pk = publicKeyFromBase64(recipientPkB64);
  const sealed = uint8FromBase64(ciphertextB64);
  const opened = sodium.crypto_box_seal_open(sealed, pk, recipientSk);
  const json = dec.decode(opened);
  return JSON.parse(json) as PlainPayload;
}

export async function fingerprintFromPublicKeyB64(
  publicKeyB64: string
): Promise<string> {
  await sodiumReady();
  const sodium = getSodium();
  const pk = publicKeyFromBase64(publicKeyB64);
  const h = sodium.crypto_generichash(32, pk);
  const hex = Array.from(h)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 4)} ${hex.slice(4, 8)} ${hex.slice(8, 12)} ${hex.slice(12, 16)}`;
}

/**
 * Zwei-seitige Safety Number: deterministischer Hash der beiden Identity-PKs
 * plus Anwendungs-Domain. Dient für Out-of-Band Verifikation (Signal-Style).
 */
export async function safetyNumber(
  myPkB64: string,
  peerPkB64: string
): Promise<{ groups: string[]; emojiSeq: string[] }> {
  await sodiumReady();
  const sodium = getSodium();
  const a = publicKeyFromBase64(myPkB64);
  const b = publicKeyFromBase64(peerPkB64);
  const cmp = compareBytes(a, b);
  const [lo, hi] = cmp < 0 ? [a, b] : [b, a];
  const input = new Uint8Array(lo.length + hi.length);
  input.set(lo, 0);
  input.set(hi, lo.length);
  const h = sodium.crypto_generichash(
    32,
    input,
    enc.encode("vaultchat-safety-v1")
  );
  const digits: string[] = [];
  for (let i = 0; i < h.length; i += 4) {
    const v = (h[i]! << 24) | (h[i + 1]! << 16) | (h[i + 2]! << 8) | h[i + 3]!;
    digits.push((v >>> 0).toString(10).slice(0, 5).padStart(5, "0"));
  }
  const groups: string[] = [];
  const flat = digits.join("");
  for (let i = 0; i < 60; i += 5) groups.push(flat.slice(i, i + 5));
  const EMOJIS = [
    "🦊", "🐼", "🦉", "🐝", "🐙", "🦄", "🐢", "🐧",
    "🌵", "🌲", "🍀", "🌙", "⭐", "🔥", "❄️", "⚡",
    "🎲", "🎹", "🎯", "🚀", "🛰️", "🔑", "🛡️", "🔒",
    "🧩", "🪞", "📦", "📯", "🧭", "🧬", "🪐", "🧿",
  ];
  const emojiSeq: string[] = [];
  for (let i = 0; i < 8; i++) emojiSeq.push(EMOJIS[h[i]! % EMOJIS.length]!);
  return { groups, emojiSeq };
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return a.length - b.length;
}
