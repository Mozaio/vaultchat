/**
 * Olm-Session-Persistenz in IDB via meta-Tabelle.
 *
 * Olm hat keine clear "state I can JSON.stringify"-Form. Stattdessen
 * exportiert es einen mit pickleKey verschlüsselten String. Wir nutzen
 * unseren bestehenden Local Data Key (localKey.ts) als pickleKey —
 * derselbe Key der auch IDB-Records verschlüsselt, also kein neuer
 * Pickle-Key zu verwalten.
 *
 * Speicher-Schema:
 *   meta key                       value
 *   ───────────────────────────────────────────────────────────
 *   olmAccount                     Olm.Account.pickle
 *   olmSession:{peerId}            Olm.Session.pickle für 1:1 peer
 *
 * Der pickleKey wird live aus dem `localKey` abgeleitet — verlässt nie
 * das Modul.
 */
import { metaGet, metaSet } from "./idb";
import { hasLocalKey, deriveSubKey } from "./localKey";
import {
  olmInit,
  olmPickleAccount,
  olmPickleSession,
  olmUnpickleAccount,
  olmUnpickleSession,
  olmIdentityKeys,
  olmGenerateOneTimeKeys,
  olmMarkPublished,
} from "./olmAdapter";

type OlmModule = typeof import("@matrix-org/olm");
type OlmAccount = InstanceType<OlmModule["Account"]>;
type OlmSession = InstanceType<OlmModule["Session"]>;

/**
 * pickleKey für Olm. Cached pro Unlock-Session, damit wir nicht bei jeder
 * Operation neu deriven. Wird beim Lock implizit ungültig — `deriveSubKey`
 * würde dann throw'n.
 */
let _pickleKeyCache: string | null = null;
async function pickleKey(): Promise<string> {
  if (!hasLocalKey()) throw new Error("local_key_missing");
  if (_pickleKeyCache) return _pickleKeyCache;
  _pickleKeyCache = await deriveSubKey("vaultchat-olm-pickle-v1");
  return _pickleKeyCache;
}

export function clearOlmPickleCache(): void {
  _pickleKeyCache = null;
}

function accountMetaKey(): string {
  return "olmAccount";
}
function sessionMetaKey(peerId: string): string {
  return `olmSession:${peerId}`;
}

/**
 * Lädt den persistierten Olm-Account oder erzeugt einen neuen, wenn keiner
 * existiert. Idempotent: mehrfache Aufrufe geben denselben Account.
 *
 * Caller MUSS `account.free()` aufrufen wenn er fertig ist (WASM-Memory).
 */
export async function ensureOlmAccount(): Promise<OlmAccount> {
  const olm = await olmInit();
  const pk = await pickleKey();
  const raw = await metaGet(accountMetaKey());
  if (raw) {
    return olmUnpickleAccount(raw, pk);
  }
  const account = new olm.Account();
  account.create();
  await metaSet(accountMetaKey(), olmPickleAccount(account, pk));
  return account;
}

/**
 * Speichert den Account nach jeder mutierenden Operation
 * (one_time_keys generated, marked_published, etc).
 */
export async function saveOlmAccount(account: OlmAccount): Promise<void> {
  const pk = await pickleKey();
  await metaSet(accountMetaKey(), olmPickleAccount(account, pk));
}

/**
 * Wirft den persistierten Account weg. Wird beim full-reset gerufen
 * (`unregister` oder DELETE /api/me).
 */
export async function clearOlmAccount(): Promise<void> {
  await metaSet(accountMetaKey(), "");
}

/**
 * Olm-Session pro Peer. Wenn keine existiert, returns null — Caller
 * muss dann via `establishOlmPair` / Pre-Key-Bundle eine aufbauen.
 */
export async function loadOlmSession(peerId: string): Promise<OlmSession | null> {
  const raw = await metaGet(sessionMetaKey(peerId));
  if (!raw) return null;
  try {
    const pk = await pickleKey();
    return await olmUnpickleSession(raw, pk);
  } catch {
    // Pickle-Key passt nicht → Session ist mit anderem localKey
    // entstanden. Stale Eintrag, einfach verwerfen.
    return null;
  }
}

export async function saveOlmSession(
  peerId: string,
  session: OlmSession
): Promise<void> {
  const pk = await pickleKey();
  await metaSet(sessionMetaKey(peerId), olmPickleSession(session, pk));
}

export async function clearOlmSession(peerId: string): Promise<void> {
  await metaSet(sessionMetaKey(peerId), "");
}

/**
 * Komfort: produziert ein PreKey-Bundle aus dem persistierten Account,
 * das in /api/keys hochgeladen werden kann. Generiert nötige One-Time-
 * Keys nach (Standard 50) und speichert den Account wieder.
 */
export async function getOlmPublishBundle(
  oneTimeCount: number = 50
): Promise<{
  identityCurve25519: string;
  identityEd25519: string;
  oneTimeKeys: Record<string, string>;
}> {
  const account = await ensureOlmAccount();
  try {
    const ids = olmIdentityKeys(account);
    const otks = olmGenerateOneTimeKeys(account, oneTimeCount);
    olmMarkPublished(account);
    await saveOlmAccount(account);
    return {
      identityCurve25519: ids.curve25519,
      identityEd25519: ids.ed25519,
      oneTimeKeys: otks,
    };
  } finally {
    account.free();
  }
}
