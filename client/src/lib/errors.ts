/**
 * Strukturierte Fehlerhierarchie für VaultChat.
 *
 * Alle "internen" Fehler sollten ab Adoption diesen Typ tragen statt
 * `new Error(string_code)`. Das erlaubt einem Caller, gezielt auf Codes zu
 * matchen statt fragile String-Vergleiche zu machen.
 *
 * Migration-Strategie:
 *  - Neue throw-Stellen: VaultChatError + passender Code.
 *  - Bestehende `new Error("foo_bar")` Stellen werden bei Berührung migriert.
 *  - `parseLegacyError(e)` wandelt alte string-Codes in Errors mit Code um,
 *    damit Konsumenten einheitlich filtern können.
 */

export type ErrorCode =
  // Crypto
  | "CRYPTO_BAD_MAGIC"
  | "CRYPTO_SHORT_WIRE"
  | "CRYPTO_DECRYPT_FAILED"
  | "CRYPTO_REPLAY_OR_OUT_OF_ORDER"
  | "CRYPTO_TOO_MANY_SKIPPED"
  | "CRYPTO_NO_RECV_CHAIN"
  | "CRYPTO_NO_RATCHET_BUT_NON_BOOTSTRAP"
  | "CRYPTO_BAD_ENVELOPE_HEADER"
  | "CRYPTO_BAD_ENVELOPE_LEN"
  | "CRYPTO_SHORT_ENVELOPE"
  | "CRYPTO_BAD_UUID"
  | "CRYPTO_BAD_GROUP_CIPHER"
  | "CRYPTO_BAD_GROUP_MAGIC"
  | "CRYPTO_NO_GROUP_KEY"
  | "CRYPTO_NO_GROUP_STATE"
  | "CRYPTO_NO_SENDER_STATE"
  // Storage
  | "IDB_LOCAL_KEY_MISSING"
  | "IDB_BLOCKED_BY_OTHER_TAB"
  | "IDB_QUOTA_EXCEEDED"
  | "IDB_WRITE_FAILED"
  // Network
  | "WS_TIMEOUT"
  | "WS_RECONNECT_FAILED"
  | "WS_DISPOSED"
  | "RTC_CONFIG_UNAVAILABLE"
  // Misc
  | "INVALID_ARGUMENT"
  | "UNKNOWN";

export class VaultChatError extends Error {
  readonly code: ErrorCode;
  readonly recoverable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message?: string,
    options?: { recoverable?: boolean; details?: Record<string, unknown>; cause?: unknown }
  ) {
    super(message ?? code);
    this.name = "VaultChatError";
    this.code = code;
    this.recoverable = options?.recoverable ?? false;
    if (options?.details) this.details = options.details;
    if (options?.cause) (this as { cause?: unknown }).cause = options.cause;
  }
}

export function isVaultChatError(e: unknown): e is VaultChatError {
  return e instanceof VaultChatError;
}

export function errorCode(e: unknown): ErrorCode | null {
  if (e instanceof VaultChatError) return e.code;
  if (e instanceof Error) {
    const mapped = LEGACY_MAP[e.message];
    if (mapped) return mapped;
  }
  return null;
}

const LEGACY_MAP: Record<string, ErrorCode> = {
  bad_magic: "CRYPTO_BAD_MAGIC",
  short_wire: "CRYPTO_SHORT_WIRE",
  replay_or_out_of_order: "CRYPTO_REPLAY_OR_OUT_OF_ORDER",
  too_many_skipped: "CRYPTO_TOO_MANY_SKIPPED",
  no_recv_chain: "CRYPTO_NO_RECV_CHAIN",
  no_ratchet_but_non_bootstrap: "CRYPTO_NO_RATCHET_BUT_NON_BOOTSTRAP",
  bad_envelope_header: "CRYPTO_BAD_ENVELOPE_HEADER",
  bad_envelope_len: "CRYPTO_BAD_ENVELOPE_LEN",
  short_envelope: "CRYPTO_SHORT_ENVELOPE",
  bad_uuid: "CRYPTO_BAD_UUID",
  bad_uuid_len: "CRYPTO_BAD_UUID",
  bad_group_cipher: "CRYPTO_BAD_GROUP_CIPHER",
  bad_group_magic: "CRYPTO_BAD_GROUP_MAGIC",
  bad_gc2: "CRYPTO_BAD_GROUP_MAGIC",
  no_group_key: "CRYPTO_NO_GROUP_KEY",
  no_group_state: "CRYPTO_NO_GROUP_STATE",
  no_sender_state: "CRYPTO_NO_SENDER_STATE",
  bad_ciphertext: "CRYPTO_DECRYPT_FAILED",
  local_key_missing: "IDB_LOCAL_KEY_MISSING",
  idb_blocked_by_other_tab: "IDB_BLOCKED_BY_OTHER_TAB",
  rtc_config_unavailable: "RTC_CONFIG_UNAVAILABLE",
};
