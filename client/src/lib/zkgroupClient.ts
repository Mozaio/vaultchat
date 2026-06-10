/**
 * Lazy, flag-gated Loader für das vendorte zkgroup-WASM (Weg A, Phase A3).
 *
 * Das WASM ist Signals AUDITIERTE zkgroup-Crate (libsignal v0.95.0), in CI
 * gebaut und unter client/public/zkgroup/ eingecheckt. Es wird NUR hinter
 * dem experimentellen Flag und nie auf dem heißen Pfad geladen. Da Vite
 * /public nicht bundlet, hat es null Einfluss auf den Haupt-Bundle —
 * der dynamische Import zieht es erst bei Bedarf.
 *
 * Sicherheits-Hinweis: Diese Datei trägt (noch) KEINE Subresource-Integrity
 * und ist keine aktive Security-Boundary. zkgroup bleibt experimentell bis
 * zum externen Review (siehe ZKGROUP_SPEC.md). Vor jedem Enforcement muss
 * das WASM ins Code-Integrity-Pinning aufgenommen werden.
 */

const FLAG_KEY = "vaultchat.zkgroup.experimental";
const WASM_MODULE_URL = "/zkgroup/zkgroup_wasm.js";

type ZkgroupWasm = {
  version(): string;
  self_test(): boolean;
  /** Voller Mitgliedschafts-Proof (Issue→Receive→Present→Verify) in-WASM. */
  roundtrip_self_test(): boolean;
  derive_group_public_params(masterKey: Uint8Array): Uint8Array;
  derive_group_identifier(masterKey: Uint8Array): Uint8Array;
  /** Client-Hälfte: echte Presentation aus einem Server-Credential. */
  create_membership_presentation(
    masterKey: Uint8Array,
    serverPublicParams: Uint8Array,
    credentialResponse: Uint8Array,
    uuid16: Uint8Array,
    redemptionTime: number,
    randomness: Uint8Array
  ): Uint8Array;
};

type ZkgroupGlue = ZkgroupWasm & {
  /** wasm-pack --target web: default-Export ist __wbg_init(opts?). */
  default: (opts?: unknown) => Promise<unknown>;
};

let modPromise: Promise<ZkgroupWasm> | null = null;

export function isZkgroupExperimentalEnabled(): boolean {
  try {
    return localStorage.getItem(FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

export function setZkgroupExperimentalEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(FLAG_KEY, "1");
    else localStorage.removeItem(FLAG_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Lädt + initialisiert das WASM einmal (Promise-memoized). Wirft, wenn das
 * Modul fehlt oder die Instanziierung scheitert.
 */
export async function loadZkgroup(): Promise<ZkgroupWasm> {
  if (!modPromise) {
    modPromise = (async () => {
      const glue = (await import(/* @vite-ignore */ WASM_MODULE_URL)) as ZkgroupGlue;
      // init() OHNE Argument: die Glue löst den .wasm-Pfad relativ zu IHRER
      // eigenen Modul-URL (/zkgroup/) auf — nicht relativ zu diesem Bundle.
      await glue.default();
      return glue;
    })().catch((e) => {
      modPromise = null; // Retry beim nächsten Aufruf erlauben
      throw e;
    });
  }
  return modPromise;
}

export type ZkgroupProbe = {
  available: boolean;
  version: string | null;
  selfTest: boolean | null;
  /** Ergebnis des vollen Mitgliedschafts-Proof-Roundtrips (null = nicht gelaufen). */
  roundtrip: boolean | null;
  reason: string | null;
};

/**
 * Diagnose für die Einstellungen: lädt das WASM, führt den leichten
 * Determinismus-Check (`self_test`) und — wenn `full` — den vollen
 * Mitgliedschafts-Proof-Roundtrip (`roundtrip_self_test`) aus.
 */
export async function probeZkgroup(full = false): Promise<ZkgroupProbe> {
  if (!isZkgroupExperimentalEnabled()) {
    return {
      available: false,
      version: null,
      selfTest: null,
      roundtrip: null,
      reason: "flag_off",
    };
  }
  try {
    const m = await loadZkgroup();
    const selfOk = m.self_test();
    const roundtripOk = full ? m.roundtrip_self_test() : null;
    const ok = selfOk && (roundtripOk ?? true);
    return {
      available: true,
      version: m.version(),
      selfTest: selfOk,
      roundtrip: roundtripOk,
      reason: ok ? null : "self_test_failed",
    };
  } catch (e) {
    return {
      available: false,
      version: null,
      selfTest: null,
      roundtrip: null,
      reason: e instanceof Error ? e.message.slice(0, 160) : "load_failed",
    };
  }
}

/**
 * GMK (32 Bytes, aus groupSecret.ts) → serialisierte GroupPublicParams —
 * der Wert, den der Server perspektivisch statt der Klartext-Mitgliederliste
 * pinnt. Wirft, wenn das WASM nicht verfügbar ist.
 */
export async function deriveGroupPublicParams(
  masterKey: Uint8Array
): Promise<Uint8Array> {
  const m = await loadZkgroup();
  return m.derive_group_public_params(masterKey);
}

/** UUID-String ("xxxxxxxx-xxxx-…") → 16 Bytes (für Aci/Pni). */
function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error("user id is not a uuid");
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export type ZkgroupServerProbe = {
  ran: boolean;
  valid: boolean | null;
  reason: string | null;
};

/**
 * Echter A3-2d-Roundtrip: holt ein Credential vom Server, erzeugt eine echte
 * Mitgliedschafts-Presentation im WASM und lässt sie server-seitig
 * verifizieren. Reine Diagnose — nicht im Nachrichtenpfad, kein Enforcement.
 * Nutzt eine feste Test-GMK; der Server kennt sie nicht, prüft nur die
 * mitgelieferten GroupPublicParams gegen die Presentation.
 */
export async function zkgroupServerRoundtrip(): Promise<ZkgroupServerProbe> {
  if (!isZkgroupExperimentalEnabled()) {
    return { ran: false, valid: null, reason: "flag_off" };
  }
  try {
    const { base64FromUint8, uint8FromBase64 } = await import("./b64");
    const { loadToken } = await import("./localIdentity");
    const { loadLocalIdentity } = await import("./localIdentity");
    const api = await import("./api");

    const token = loadToken();
    const identity = loadLocalIdentity();
    if (!token || !identity) {
      return { ran: false, valid: null, reason: "not_logged_in" };
    }

    const m = await loadZkgroup();
    const cred = await api.zkgroupCredential(token);

    const testGmk = new Uint8Array(32).fill(9);
    const gpp = m.derive_group_public_params(testGmk);
    const uuid16 = uuidToBytes(identity.userId);
    const randomness = crypto.getRandomValues(new Uint8Array(32));

    const presentation = m.create_membership_presentation(
      testGmk,
      uint8FromBase64(cred.publicParams),
      uint8FromBase64(cred.credential),
      uuid16,
      cred.redemptionTime,
      randomness
    );

    const { valid } = await api.zkgroupVerifyPresentation(token, {
      presentation: base64FromUint8(presentation),
      groupPublicParams: base64FromUint8(gpp),
    });
    return { ran: true, valid, reason: valid ? null : "server_rejected" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "roundtrip_failed";
    // 503 vom Server = zkgroup dort nicht aktiviert (VAULTCHAT_ZKGROUP=1).
    const reason = /zkgroup_unavailable|503/.test(msg)
      ? "server_disabled"
      : msg.slice(0, 160);
    return { ran: false, valid: null, reason };
  }
}

/**
 * Gruppen-gebundener Roundtrip (A3-2e): leitet die GroupPublicParams aus dem
 * GMK einer ECHTEN Gruppe ab, lädt sie auf den Server, erzeugt eine
 * Presentation mit demselben GMK und lässt sie gegen die SERVER-gespeicherten
 * Params verifizieren. Beweist: „Absender hält ein gültiges Credential UND
 * kennt das Geheimnis dieser Gruppe" — also Mitgliedschaft, ohne dass der
 * Server die Identität lernt. Reine Diagnose, NICHT im Nachrichtenpfad.
 */
export async function zkgroupGroupBoundRoundtrip(): Promise<ZkgroupServerProbe> {
  if (!isZkgroupExperimentalEnabled()) {
    return { ran: false, valid: null, reason: "flag_off" };
  }
  try {
    const { base64FromUint8, uint8FromBase64 } = await import("./b64");
    const { loadToken, loadLocalIdentity } = await import("./localIdentity");
    const { getGroupSecret } = await import("./groupSecret");
    const api = await import("./api");

    const token = loadToken();
    const identity = loadLocalIdentity();
    if (!token || !identity) {
      return { ran: false, valid: null, reason: "not_logged_in" };
    }

    const { groups } = await api.listGroups(token);
    if (!groups || groups.length === 0) {
      return { ran: false, valid: null, reason: "no_group" };
    }
    // Erste Gruppe, für die wir lokal das GMK haben (= echtes Mitglied).
    let groupId: string | null = null;
    let gmk: Uint8Array | null = null;
    for (const g of groups) {
      const gs = await getGroupSecret(g.id);
      if (gs) {
        groupId = g.id;
        gmk = uint8FromBase64(gs.keyB64);
        break;
      }
    }
    if (!groupId || !gmk) {
      return { ran: false, valid: null, reason: "no_group_secret" };
    }

    const m = await loadZkgroup();
    const gpp = m.derive_group_public_params(gmk);
    await api.zkgroupSetGroupParams(token, groupId, base64FromUint8(gpp));

    const cred = await api.zkgroupCredential(token);
    const uuid16 = uuidToBytes(identity.userId);
    const randomness = crypto.getRandomValues(new Uint8Array(32));
    const presentation = m.create_membership_presentation(
      gmk,
      uint8FromBase64(cred.publicParams),
      uint8FromBase64(cred.credential),
      uuid16,
      cred.redemptionTime,
      randomness
    );

    const { valid } = await api.zkgroupVerifyPresentation(token, {
      presentation: base64FromUint8(presentation),
      groupId,
    });
    return { ran: true, valid, reason: valid ? null : "server_rejected" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "roundtrip_failed";
    const reason = /zkgroup_unavailable|503/.test(msg)
      ? "server_disabled"
      : msg.slice(0, 160);
    return { ran: false, valid: null, reason };
  }
}
