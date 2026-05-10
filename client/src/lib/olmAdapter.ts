/**
 * Olm Adapter — typsafer Wrapper um @matrix-org/olm.
 *
 * Hintergrund: Olm ist Matrix.orgs Double-Ratchet-Implementation, mehrfach
 * auditiert (NCC Group 2016, NCC Group 2020, Quarkslab 2024) und in
 * Element/Matrix seit ~10 Jahren produktiv. Wir wechseln den DR-Pfad
 * schrittweise dorthin, weil unsere eigene doubleRatchet.ts kein
 * externes Audit hat.
 *
 * Status: FOUNDATION. Wird heute noch nicht von ChatShell/incomingDm
 * aufgerufen. Wire-Format-Migration (`VCO5`-Magic + Coexistence mit
 * dem alten `VCD4`-Pfad) ist Phase 2 — siehe SECURITY_AUDIT_STATUS.md.
 *
 * Lazy-Import: `@matrix-org/olm` ist ~120 KB WASM, deshalb erst beim
 * ersten Aufruf von `olmInit()` geladen. So bleibt das Initial-Bundle
 * für reine Lese-User klein.
 */

type OlmModule = typeof import("@matrix-org/olm");
type OlmAccount = InstanceType<OlmModule["Account"]>;
type OlmSession = InstanceType<OlmModule["Session"]>;

let _olm: OlmModule | null = null;
let _initPromise: Promise<OlmModule> | null = null;

/**
 * Lädt @matrix-org/olm dynamisch + wartet auf Olm.init() (WASM-Bootstrap).
 * Idempotent.
 *
 * `locateFile` tells the olm-WASM-Bootstrapper, wo er die `olm.wasm`-Datei
 * findet. Vite emittiert die JS-Loader-Datei nach `/assets/olm-HASH.js`,
 * aber die wasm-Datei wird über unseren `vaultchat-copy-olm-wasm`-Plugin
 * separat nach `/olm.wasm` kopiert. Ohne den expliziten Override würde
 * Olm relativ zum loader-Pfad nach `/assets/olm.wasm` suchen — die Datei
 * existiert dort nicht, der SPA-Fallback liefert `<!doctype html>`
 * zurück und WebAssembly.instantiate failed mit "expected magic word
 * 00 61 73 6d, found 3c 21 64 6f".
 */
export async function olmInit(): Promise<OlmModule> {
  if (_olm) return _olm;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const mod = (await import("@matrix-org/olm")) as unknown as OlmModule & {
      default?: OlmModule;
    };
    const olm = mod.default ?? mod;
    if (typeof olm.init !== "function") {
      throw new Error("olm_module_missing_init");
    }
    await (olm.init as (opts?: { locateFile?: (f: string) => string }) => Promise<void>)({
      locateFile: () => "/olm.wasm",
    });
    _olm = olm;
    return olm;
  })();
  return _initPromise;
}

/**
 * Erzeugt einen neuen Olm-Account. Olm.Account hat Identity-Keys (Ed25519
 * + Curve25519) und kann One-Time-Keys generieren, die für Initial-
 * Sessions verwendet werden.
 *
 * Caller ist verantwortlich für `acct.free()` wenn der Account nicht mehr
 * gebraucht wird (manuelle Memory-Verwaltung, weil WASM).
 */
export async function createOlmAccount(): Promise<OlmAccount> {
  const olm = await olmInit();
  const a = new olm.Account();
  a.create();
  return a;
}

/**
 * Roundtrip-Helper: outbound + inbound Session aufbauen aus zwei Accounts.
 * Nutzt One-Time-Key des Empfängers.
 *
 * Pattern entspricht Matrix' Standard-Flow (siehe Olm-Docs).
 */
export async function establishOlmPair(
  myAccount: OlmAccount,
  theirAccount: OlmAccount
): Promise<{ outbound: OlmSession; inbound: OlmSession }> {
  const olm = await olmInit();
  // Their account muss einen OneTime-Key bereitstellen (wie X3DH).
  theirAccount.generate_one_time_keys(1);
  const theirOneTimeKeys = JSON.parse(theirAccount.one_time_keys()) as {
    curve25519: Record<string, string>;
  };
  const otkValues = Object.values(theirOneTimeKeys.curve25519);
  const firstOtk = otkValues[0];
  if (!firstOtk) throw new Error("no_one_time_key");
  theirAccount.mark_keys_as_published();
  const theirIdentityKeys = JSON.parse(theirAccount.identity_keys()) as {
    curve25519: string;
    ed25519: string;
  };

  const outbound = new olm.Session();
  outbound.create_outbound(
    myAccount,
    theirIdentityKeys.curve25519,
    firstOtk
  );

  // Empfängerseitig: outbound erstellt ein erstes Pre-Key-Message — damit
  // baut der Receiver eine inbound Session.
  const firstMsg = outbound.encrypt("__olm_handshake__");
  const inbound = new olm.Session();
  inbound.create_inbound(theirAccount, firstMsg.body);
  inbound.decrypt(firstMsg.type, firstMsg.body);
  return { outbound, inbound };
}

/**
 * Verschlüsselt eine Nachricht über eine bereits etablierte Olm-Session.
 * Return: { type, body } — type ist 0 (pre-key) oder 1 (normal).
 */
export function olmEncrypt(
  session: OlmSession,
  plaintext: string
): { type: 0 | 1; body: string } {
  const enc = session.encrypt(plaintext);
  return { type: enc.type as 0 | 1, body: enc.body };
}

/**
 * Entschlüsselt eine Nachricht. Caller muss `type` und `body` aus dem
 * Wire-Frame korrekt durchreichen.
 */
export function olmDecrypt(
  session: OlmSession,
  type: 0 | 1,
  body: string
): string {
  return session.decrypt(type, body);
}

/**
 * Identity-Keys eines Accounts auslesen (Curve25519 + Ed25519).
 * Werden in das Pre-Key-Bundle gepublished und vom Empfänger zum
 * Session-Setup benutzt.
 */
export function olmIdentityKeys(account: OlmAccount): {
  curve25519: string;
  ed25519: string;
} {
  return JSON.parse(account.identity_keys()) as {
    curve25519: string;
    ed25519: string;
  };
}

/**
 * One-Time-Keys generieren (mit n=Anzahl) und als Map zurückgeben.
 * mark_keys_as_published() sollte vom Caller aufgerufen werden, NACHDEM
 * die Keys ans Server-Pre-Key-Bundle ausgeliefert wurden.
 */
export function olmGenerateOneTimeKeys(
  account: OlmAccount,
  n: number
): Record<string, string> {
  account.generate_one_time_keys(n);
  const keys = JSON.parse(account.one_time_keys()) as {
    curve25519: Record<string, string>;
  };
  return keys.curve25519;
}

export function olmMarkPublished(account: OlmAccount): void {
  account.mark_keys_as_published();
}

/**
 * Serialisiert Account/Session in einen verschlüsselten String (Olm Pickle).
 * Der `pickleKey` muss vom Caller verwaltet werden (z.B. unser
 * localKey).
 */
export function olmPickleAccount(account: OlmAccount, pickleKey: string): string {
  return account.pickle(pickleKey);
}

export function olmPickleSession(session: OlmSession, pickleKey: string): string {
  return session.pickle(pickleKey);
}

export async function olmUnpickleAccount(
  pickled: string,
  pickleKey: string
): Promise<OlmAccount> {
  const olm = await olmInit();
  const a = new olm.Account();
  a.unpickle(pickleKey, pickled);
  return a;
}

export async function olmUnpickleSession(
  pickled: string,
  pickleKey: string
): Promise<OlmSession> {
  const olm = await olmInit();
  const s = new olm.Session();
  s.unpickle(pickleKey, pickled);
  return s;
}
