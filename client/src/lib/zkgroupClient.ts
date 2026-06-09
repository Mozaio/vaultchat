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
