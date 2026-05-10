/**
 * Branded Types für Base64-Schlüssel-Material und Wire-Bytes.
 *
 * VaultChat reicht extrem viele Base64-Strings durch (Public Keys, Sealed
 * Envelopes, DR-Wire, Signed-Pre-Key-Sigs, …). Auf Typebene sind das alle
 * `string` — sodass z.B. ein `envelope` versehentlich als `publicKey`
 * weitergegeben werden kann ohne dass TS warnt.
 *
 * Branded Types lösen das ohne Runtime-Kosten: zur Laufzeit immer noch ein
 * String, aber TypeScript erlaubt nur die jeweils passende Sub-Domäne.
 *
 * Nutzung (gradual adoption):
 *
 *     export function sealSender(
 *       senderUserId: UserId,
 *       innerB64: DrWireB64,
 *       recipientPk: PublicKeyB64,
 *     ): Promise<SealedEnvelopeB64>
 *
 *     const env = await sealSender(uid, wire, pk);
 *     // env: SealedEnvelopeB64 — nicht mit PublicKeyB64 verwechselbar.
 *
 * Für Konvertierung gibt es `asXxx`-Helfer (no-op zur Laufzeit, nur Cast).
 * Diese sollten an System-Boundaries (Server-Antworten, IDB-Reads) verwendet
 * werden, nicht inline im App-Code.
 */

declare const brand: unique symbol;
type Branded<T, B extends string> = T & { readonly [brand]: B };

export type Base64<B extends string> = Branded<string, `b64:${B}`>;

export type PublicKeyB64 = Base64<"PublicKey">;
export type PrivateKeyB64 = Base64<"PrivateKey">;
export type SignedPreKeyB64 = Base64<"SignedPreKey">;
export type OneTimePreKeyB64 = Base64<"OneTimePreKey">;
export type PqKemPublicKeyB64 = Base64<"PqKemPublicKey">;
export type PqKemSecretKeyB64 = Base64<"PqKemSecretKey">;
export type PqKemCiphertextB64 = Base64<"PqKemCiphertext">;
export type SealedEnvelopeB64 = Base64<"SealedEnvelope">;
export type DrWireB64 = Base64<"DrWire">;
export type GroupCiphertextB64 = Base64<"GroupCiphertext">;
export type SignatureB64 = Base64<"Signature">;
export type SymmetricKeyB64 = Base64<"SymmetricKey">;
export type WrappedSecretB64 = Base64<"WrappedSecret">;

export type UserId = Branded<string, "UserId">;
export type GroupId = Branded<string, "GroupId">;
export type MessageId = Branded<string, "MessageId">;

/**
 * Cast-Helper. Zur Laufzeit identisch zur Eingabe — nur ein Type-Tag.
 * An System-Grenzen (API-Response, IDB-Read) verwenden, NICHT inline um
 * eine Type-Warnung wegzuwerfen.
 */
export const asPublicKeyB64 = (s: string): PublicKeyB64 => s as PublicKeyB64;
export const asPrivateKeyB64 = (s: string): PrivateKeyB64 => s as PrivateKeyB64;
export const asSignedPreKeyB64 = (s: string): SignedPreKeyB64 => s as SignedPreKeyB64;
export const asOneTimePreKeyB64 = (s: string): OneTimePreKeyB64 => s as OneTimePreKeyB64;
export const asPqKemPublicKeyB64 = (s: string): PqKemPublicKeyB64 => s as PqKemPublicKeyB64;
export const asPqKemSecretKeyB64 = (s: string): PqKemSecretKeyB64 => s as PqKemSecretKeyB64;
export const asPqKemCiphertextB64 = (s: string): PqKemCiphertextB64 =>
  s as PqKemCiphertextB64;
export const asSealedEnvelopeB64 = (s: string): SealedEnvelopeB64 =>
  s as SealedEnvelopeB64;
export const asDrWireB64 = (s: string): DrWireB64 => s as DrWireB64;
export const asGroupCiphertextB64 = (s: string): GroupCiphertextB64 =>
  s as GroupCiphertextB64;
export const asSignatureB64 = (s: string): SignatureB64 => s as SignatureB64;
export const asSymmetricKeyB64 = (s: string): SymmetricKeyB64 => s as SymmetricKeyB64;
export const asWrappedSecretB64 = (s: string): WrappedSecretB64 => s as WrappedSecretB64;
export const asUserId = (s: string): UserId => s as UserId;
export const asGroupId = (s: string): GroupId => s as GroupId;
export const asMessageId = (s: string): MessageId => s as MessageId;
