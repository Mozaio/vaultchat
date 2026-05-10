/**
 * VaultChat Group Crypto v3 — TreeKEM/MLS Foundation.
 *
 * Status: SKELETT, NICHT IM EINSATZ.
 *
 * Ziel: echtes Forward-Secrecy bei Member-Removal. v2 (groupCrypto.ts) hat
 * diese Property nicht — alle Sender starten ihre Chain mit dem geteilten
 * rootKey, ein ausgeschlossenes Mitglied kann zukünftige Chains rekonstruieren.
 *
 * Lösung: ein Ratcheting Tree (TreeKEM) wie in RFC 9420 (MLS). Vereinfacht:
 *
 *   - Jedes Gruppenmitglied ist ein Blatt im binären Baum.
 *   - Jeder Knoten hat einen Public Key; das Blatt kennt seinen Secret Key,
 *     innere Knoten haben Secrets, die das jeweilige Mitglied via die
 *     Pfad-zur-Wurzel ableiten kann.
 *   - Bei Add/Remove/Update: der Aktor erzeugt einen neuen Pfad-Update,
 *     der für alle Mitglieder den Wurzel-Secret rotiert. Verifikation durch
 *     Signaturen (Ed25519) der Group-State-Updates.
 *   - Forward Secrecy: alte Wurzel-Secrets werden bei jedem Update verworfen.
 *   - Post-Compromise Security: nach einem Update ist der Aktor wieder sicher.
 *
 * Wire-Format v3 (Vorschlag):
 *
 *   GroupMessage      = MAGIC("GC3 ") || generation:u32 || senderLeafIdx:u32
 *                       || nonce:24   || aad-bound ciphertext
 *
 *   CommitMessage     = MAGIC("GCM3") || prevGeneration:u32 || newGeneration:u32
 *                       || pathUpdates:[(leafIdx, encryptedPathSecrets...)]
 *                       || sig (Ed25519 von Aktor über Hash(commit-content))
 *
 *   WelcomeMessage    = MAGIC("GCW3") || groupContextHash
 *                       || encryptedGroupSecrets-zu-neuem-Mitglied
 *                       || sig
 *
 * Migration-Strategie:
 *   - v2 + v3 koexistieren per `groupVersion`-Flag im Group-Record (Server
 *     hält Group-Metadata, ist server-blind für die Crypto selbst).
 *   - Neue Gruppen → v3. Bestehende Gruppen → v2 (kein Forced-Migrate, weil
 *     alle Member gleichzeitig upgraden müssten).
 *   - In jedem Group-Frame steht die Version in einem Bit am Magic-Prefix,
 *     decryptGroupPayload routed entsprechend.
 *
 * Implementations-Schritte (separate Tickets):
 *   T-G3.1  Tree-Datenstruktur + Resolution (left/right/sibling/parent).
 *   T-G3.2  RatchetTree mit BLAKE2b-basiertem KDF für Path-Secret-Update.
 *   T-G3.3  KeyPackage (jedes Member registriert es beim Server, Long-lived).
 *   T-G3.4  Welcome/Add: Aktor verschlüsselt Pfad-Secrets per HPKE/X25519.
 *   T-G3.5  Update/Remove: ähnlich, aber an alle bestehenden Member.
 *   T-G3.6  Commit-Validation: Signature-Check + Generation-Monotonie.
 *   T-G3.7  Inter-Op Test mit OpenMLS/mls-rs Test-Vektoren.
 *
 * Aufwand: ~3-4 Wochen Entwicklung + Audit.
 */

export const GROUP_V3_MAGIC = new Uint8Array([0x47, 0x43, 0x33, 0x20]); // "GC3 "
export const GROUP_V3_COMMIT_MAGIC = new Uint8Array([0x47, 0x43, 0x4d, 0x33]); // "GCM3"
export const GROUP_V3_WELCOME_MAGIC = new Uint8Array([0x47, 0x43, 0x57, 0x33]); // "GCW3"

export type LeafIndex = number;
export type Generation = number;

/**
 * KeyPackage: vom Member beim Server registriert. Enthält Long-lived
 * Identity-PK + Initial-Leaf-PK. Server ist Storage-only; alle Sigs werden
 * client-seitig verifiziert.
 */
export interface KeyPackageV3 {
  version: 3;
  identityPkB64: string;
  signaturePkB64: string; // Ed25519 für Commit-Signaturen
  leafInitPkB64: string; // X25519 für initial Leaf-Secret-Encryption
  capabilities: {
    cipherSuite: "X25519-XChaCha20Poly1305-BLAKE2b-Ed25519";
    extensions: string[];
  };
  /** Signed by identityPk over the rest of the structure. */
  signatureB64: string;
}

export interface RatchetTreeNodeV3 {
  publicKeyB64: string;
  /** Encrypted-to-parent material; nur für innere Knoten gesetzt. */
  parentHashB64?: string;
  /** Set of leaf indices that have access to this node (i.e. share its secret). */
  unmergedLeaves: LeafIndex[];
}

export interface GroupContextV3 {
  groupId: string;
  generation: Generation;
  treeHashB64: string;
  confirmedTranscriptHashB64: string;
}

/**
 * Wire-Frames — alle als TypeScript-Stubs, Implementation später.
 */
export interface CommitFrameV3 {
  prevGeneration: Generation;
  newGeneration: Generation;
  pathUpdates: Array<{
    leafIdx: LeafIndex;
    /** Pro Empfänger ein verschlüsselter Path-Secret (HPKE/X25519). */
    encryptedSecrets: Array<{ recipientLeafIdx: LeafIndex; ciphertextB64: string }>;
  }>;
  signatureB64: string; // Ed25519 vom Aktor
}

export interface WelcomeFrameV3 {
  groupContext: GroupContextV3;
  /** An den/die neuen Member verschlüsselt — enthält den initialen Wurzel-Secret. */
  encryptedGroupSecrets: Array<{
    recipientKeyPackageRefB64: string;
    ciphertextB64: string;
  }>;
  signatureB64: string;
}

/**
 * Public-API Stubs — alle werfen "not_implemented_v3" bis T-G3.* gelandet sind.
 */
export async function createGroupV3(
  _groupId: string,
  _myKeyPackage: KeyPackageV3,
  _initialMembers: KeyPackageV3[]
): Promise<{ welcome: WelcomeFrameV3; initialGenerationKey: Uint8Array }> {
  throw new Error("group_v3_not_implemented");
}

export async function processCommitV3(
  _frame: CommitFrameV3,
  _myLeafIdx: LeafIndex
): Promise<{ newGenerationKey: Uint8Array }> {
  throw new Error("group_v3_not_implemented");
}

export async function addMemberV3(
  _newKeyPackage: KeyPackageV3
): Promise<{ commit: CommitFrameV3; welcome: WelcomeFrameV3 }> {
  throw new Error("group_v3_not_implemented");
}

export async function removeMemberV3(
  _leafIdx: LeafIndex
): Promise<{ commit: CommitFrameV3 }> {
  throw new Error("group_v3_not_implemented");
}
