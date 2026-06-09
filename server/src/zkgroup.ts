/**
 * zkgroup-Fundament — "Weg A": wir benutzen Signals AUDITIERTES zkgroup
 * (KVAC + ZK-Proofs über Ristretto255) aus @signalapp/libsignal-client,
 * statt das Chase-Perrin-Zaverucha-Paper selbst nachzubauen.
 *
 * Phase A1 (dieses Modul): Server-Seite hinter Feature-Flag —
 *   - ServerSecretParams-Bootstrap (env-gepinnt oder pro Boot generiert),
 *   - Auth-Credential-Issuance für eingeloggte User,
 *   - Status-/Probe-Endpoint, ob die native Lib auf dem Host lädt.
 * NICHT in diesem Schritt: das Sealed-Endpoint-Gate und die Client-Seite
 * (WASM-Build der zkgroup-Crate, siehe wasm/zkgroup-wasm + CI-Workflow).
 *
 * Sicherheits-Gate aus ZKGROUP_SPEC.md bleibt gewahrt: nichts hiervon ist
 * eine aktive Security-Boundary. Default ist AUS (VAULTCHAT_ZKGROUP != "1"),
 * und selbst eingeschaltet wird heute nur ausgestellt, nicht erzwungen.
 *
 * Robustheit: die Dependency ist optional (native Prebuilds). Die Imports
 * laufen über Nicht-Literal-Specifier, damit tsc das Paket NICHT auflösen
 * muss — fehlt es oder lädt das native Modul nicht, bleibt der Server voll
 * funktionsfähig und der Status meldet "unavailable" mit Grund.
 */
import { log } from "./logger.js";

/** Minimal-Interfaces der tatsächlich genutzten API (verifiziert gegen
 *  node/ts/zkgroup @ libsignal v0.95.0 — nicht raten, nachlesen). */
type ZkByteArray = { serialize(): Uint8Array };
type ZkServerSecretParams = {
  getPublicParams(): ZkByteArray;
  serialize(): Uint8Array;
};
type ZkServerSecretParamsCtor = {
  generate(): ZkServerSecretParams;
  new (contents: Uint8Array): ZkServerSecretParams;
};
type ZkAuthOps = {
  issueAuthCredentialWithPniZkc(
    aci: unknown,
    pni: unknown,
    redemptionTime: number
  ): ZkByteArray;
};
type ZkgroupModule = {
  ServerSecretParams: ZkServerSecretParamsCtor;
  ServerZkAuthOperations: new (params: ZkServerSecretParams) => ZkAuthOps;
};
type MainModule = {
  Aci: { fromUuid(uuid: string): unknown };
  Pni: { fromUuid(uuid: string): unknown };
};

export type ZkgroupStatus = {
  enabled: boolean;
  available: boolean;
  reason: string | null;
  /** base64-serialisierte ServerPublicParams — Clients brauchen sie für
   *  Credential-Empfang und Presentation-Erstellung. Öffentlich. */
  publicParams: string | null;
  /** "env" = über VAULTCHAT_ZKGROUP_SECRET_PARAMS gepinnt (überlebt
   *  Restarts), "generated" = pro Boot frisch (Credentials sterben mit
   *  dem Prozess — auf Render Free der Normalfall). */
  paramsSource: "env" | "generated" | null;
};

const ENABLED = process.env.VAULTCHAT_ZKGROUP === "1";

let status: ZkgroupStatus = {
  enabled: ENABLED,
  available: false,
  reason: ENABLED ? "not_initialized" : "flag_off",
  publicParams: null,
  paramsSource: null,
};

let issueFn:
  | ((userUuid: string, redemptionTime: number) => Uint8Array)
  | null = null;

export function getZkgroupStatus(): ZkgroupStatus {
  return status;
}

/** Tagesanfang (UTC) in Sekunden — Signals Konvention für redemptionTime. */
export function currentRedemptionTime(): number {
  return Math.floor(Date.now() / 1000 / 86400) * 86400;
}

export function issueAuthCredential(
  userUuid: string,
  redemptionTime: number
): Uint8Array {
  if (!issueFn) throw new Error("zkgroup_unavailable");
  return issueFn(userUuid, redemptionTime);
}

export async function initZkgroup(): Promise<void> {
  if (!ENABLED) {
    log.info("zkgroup_disabled", { hint: "set VAULTCHAT_ZKGROUP=1 to probe" });
    return;
  }
  try {
    // Nicht-Literal-Specifier: tsc löst dynamic imports nur bei String-
    // Literalen auf — so bricht der Build nicht, wenn die optionale
    // Dependency auf der Build-Maschine fehlt.
    const zkPath = "@signalapp/libsignal-client/dist/zkgroup/index.js";
    const mainPath = "@signalapp/libsignal-client";
    const zk = (await import(zkPath)) as ZkgroupModule;
    const main = (await import(mainPath)) as MainModule;

    const envB64 = process.env.VAULTCHAT_ZKGROUP_SECRET_PARAMS;
    let params: ZkServerSecretParams;
    let source: "env" | "generated";
    if (envB64) {
      params = new zk.ServerSecretParams(
        new Uint8Array(Buffer.from(envB64, "base64"))
      );
      source = "env";
    } else {
      params = zk.ServerSecretParams.generate();
      source = "generated";
    }

    const authOps = new zk.ServerZkAuthOperations(params);
    issueFn = (userUuid: string, redemptionTime: number) => {
      // Umbra hat keine getrennten PNIs — ACI und PNI tragen dieselbe UUID.
      // Für das Gruppen-Mitgliedschafts-Modell ist nur die ACI relevant.
      const aci = main.Aci.fromUuid(userUuid);
      const pni = main.Pni.fromUuid(userUuid);
      return authOps
        .issueAuthCredentialWithPniZkc(aci, pni, redemptionTime)
        .serialize();
    };

    status = {
      enabled: true,
      available: true,
      reason: null,
      publicParams: Buffer.from(params.getPublicParams().serialize()).toString(
        "base64"
      ),
      paramsSource: source,
    };
    log.info("zkgroup_init_ok", { paramsSource: source });
    if (source === "generated") {
      log.warn("zkgroup_params_ephemeral", {
        hint: "Set VAULTCHAT_ZKGROUP_SECRET_PARAMS to survive restarts",
      });
    }
  } catch (e) {
    const reason =
      e instanceof Error ? e.message.slice(0, 200) : "load_failed";
    status = { ...status, available: false, reason };
    issueFn = null;
    log.warn("zkgroup_init_failed", { reason });
  }
}
