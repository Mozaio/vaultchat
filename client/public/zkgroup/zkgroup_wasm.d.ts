/* tslint:disable */
/* eslint-disable */

/**
 * Erzeugt eine echte Mitgliedschafts-Presentation aus einem
 * SERVER-ausgestellten Credential. Das ist die Client-Hälfte des
 * realen Flows (A3-2d): das Ergebnis geht an den Server-Verify.
 */
export function create_membership_presentation(master_key: Uint8Array, server_public_params: Uint8Array, credential_response: Uint8Array, uuid16: Uint8Array, redemption_time: bigint, randomness: Uint8Array): Uint8Array;

/**
 * GMK → GroupIdentifier (öffentliche, unverlinkbare Gruppen-Kennung).
 */
export function derive_group_identifier(master_key: Uint8Array): Uint8Array;

/**
 * GMK (32 Bytes, aus groupSecret.ts) → serialisierte GroupPublicParams.
 * Das ist der Wert, den der Server später statt der Klartext-
 * Mitgliederliste kennt.
 */
export function derive_group_public_params(master_key: Uint8Array): Uint8Array;

/**
 * VOLLER Mitgliedschafts-Proof im Browser: Issue → Receive → Present →
 * Verify (inkl. Negativprüfungen) gegen die echte auditierte Crate.
 * Beweist, dass das gesamte zkgroup-Protokoll im App-Bundle läuft —
 * nicht nur die Schlüsselableitung.
 */
export function roundtrip_self_test(): boolean;

/**
 * Leichter Determinismus-Check (GMK → Params).
 */
export function self_test(): boolean;

/**
 * Build-Identität für den Status-/Debug-Pfad im Client.
 */
export function version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly create_membership_presentation: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: bigint, j: number, k: number) => [number, number, number, number];
    readonly derive_group_identifier: (a: number, b: number) => [number, number, number, number];
    readonly derive_group_public_params: (a: number, b: number) => [number, number, number, number];
    readonly roundtrip_self_test: () => [number, number, number];
    readonly self_test: () => [number, number, number];
    readonly version: () => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
