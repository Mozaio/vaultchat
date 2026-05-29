import { useEffect, useState } from "react";
import { safetyNumber } from "../lib/crypto";
import {
  acceptKeyChange,
  confirmPeerVerified,
  getPin,
  trustLabel,
  type PeerPin,
} from "../lib/trust";
import { IconCheck, IconCopy, IconX } from "./Icons";
import { QrCodeSvg } from "./QrCodeSvg";

export function SafetyNumberDialog({
  peerId,
  myPublicKey,
  peerPublicKey,
  peerLabel,
  onClose,
  onTrustChanged,
}: {
  peerId: string;
  myPublicKey: string;
  peerPublicKey: string;
  peerLabel: string;
  onClose: () => void;
  onTrustChanged?: (pin: PeerPin) => void;
}) {
  const [groups, setGroups] = useState<string[]>([]);
  const [emojiSeq, setEmojiSeq] = useState<string[]>([]);
  const [pin, setPin] = useState<PeerPin | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [copied, setCopied] = useState(false);

  function copyNumber() {
    const text = groups.join(" ").trim();
    if (!text) return;
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

  useEffect(() => {
    void (async () => {
      const res = await safetyNumber(myPublicKey, peerPublicKey);
      setGroups(res.groups);
      setEmojiSeq(res.emojiSeq);
      setPin(await getPin(peerId));
    })();
  }, [myPublicKey, peerPublicKey, peerId]);

  async function onVerify() {
    const p = await confirmPeerVerified(peerId, peerPublicKey);
    setPin(p);
    onTrustChanged?.(p);
  }

  async function onAcceptChange() {
    const p = await acceptKeyChange(peerId, peerPublicKey);
    setPin(p);
    onTrustChanged?.(p);
  }

  // Split groups into chunks of 5 for display
  const chunkedGroups: string[][] = [];
  for (let i = 0; i < groups.length; i += 5) {
    chunkedGroups.push(groups.slice(i, i + 5));
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="safety-number-title"
    >
      <div className="safety-number-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="header">
          <div>
            <h2 id="safety-number-title" className="title">Sicherheitsnummer</h2>
            <p className="subtitle">mit {peerLabel}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="close-btn"
            aria-label="Sicherheitsnummer-Dialog schließen"
          >
            <IconX size={18} />
          </button>
        </div>

        {/* Warning if key mismatch */}
        {pin?.state === "mismatch" && (
          <div className="mb-4 rounded-xl border p-3 text-sm" style={{ 
            borderColor: 'rgba(245,158,11,0.5)', 
            background: 'var(--warning-soft, rgba(245,158,11,0.1))', 
            color: 'var(--warning)' 
          }}>
            <p className="font-semibold">⚠️ Der Sicherheitsschlüssel hat sich geändert.</p>
            <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
              Dies kann bedeuten: neues Gerät, oder möglicher MITM-Angriff.
            </p>
          </div>
        )}

        {/* Number blocks - 5 per row */}
        <div className="mb-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Vergleiche diese Nummern persönlich oder über einen sicheren Kanal:
            </p>
            <div className="flex items-center gap-1.5">
              {!showQr && groups.length > 0 && (
                <button
                  type="button"
                  onClick={copyNumber}
                  className="safety-qr-toggle"
                  title="Sicherheitsnummer kopieren"
                  aria-label="Sicherheitsnummer kopieren"
                >
                  {copied ? (
                    <>
                      <IconCheck size={11} /> Kopiert
                    </>
                  ) : (
                    <>
                      <IconCopy size={11} /> Kopieren
                    </>
                  )}
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowQr((v) => !v)}
                className="safety-qr-toggle"
                aria-pressed={showQr}
              >
                {showQr ? "Nummer anzeigen" : "QR-Code anzeigen"}
              </button>
            </div>
          </div>
          {showQr ? (
            <div className="safety-qr-wrap">
              <QrCodeSvg digits={groups.join("")} size={232} />
              <p className="safety-qr-hint">
                Scanne diesen Code in Umbra des Gegenübers — die Nummer
                stimmt überein, wenn beide Seiten denselben Code anzeigen.
              </p>
            </div>
          ) : (
            <>
              {chunkedGroups.map((chunk, chunkIdx) => (
                <div key={chunkIdx} className="number-blocks">
                  {chunk.map((num, idx) => (
                    <span key={idx} className="number-block">{num}</span>
                  ))}
                </div>
              ))}
            </>
          )}
        </div>

        {/* Emoji grid - 4x2 */}
        <div className="mb-4">
          <p className="mb-2 text-xs" style={{ color: 'var(--text-muted)' }}>
            Emoji-Sequenz zum einfachen Abgleich:
          </p>
          <div className="emoji-grid">
            {emojiSeq.map((emoji, i) => (
              <span key={i} className="emoji-item">{emoji}</span>
            ))}
          </div>
        </div>

        {/* Trust status */}
        <div className="mb-4 flex items-center justify-between rounded-xl border px-4 py-3" style={{ 
          borderColor: 'var(--border)', 
          background: 'var(--bg-sidebar)' 
        }}>
          <div className="flex items-center gap-2">
            <span style={{ color: 'var(--text-muted)' }}>Status:</span>
            <span className="font-semibold" style={{ 
              color: pin?.state === "verified" ? "var(--accent)" : 
                     pin?.state === "mismatch" ? "var(--danger)" : "var(--warning)" 
            }}>
              {trustLabel(pin?.state ?? "new")}
            </span>
          </div>
          {pin?.state === "mismatch" && (
            <button
              type="button"
              onClick={() => void onAcceptChange()}
              className="btn-qr text-xs"
              style={{ borderColor: 'var(--warning)', color: 'var(--warning)' }}
            >
              Schlüssel akzeptieren
            </button>
          )}
        </div>

        {/* Action buttons */}
        <div className="actions">
          <button
            type="button"
            onClick={() => void onVerify()}
            className="btn-verify"
          >
            <IconCheck size={16} />
            <span>Als verifiziert markieren</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="btn-qr"
          >
            Schließen
          </button>
        </div>

        {/* Explanation */}
        <div className="explanation">
          <p>
            <strong>Wie funktioniert das?</strong><br/>
            Die Sicherheitsnummer ist eine deterministische Funktion beider 
            Identity-Public-Keys mit BLAKE2b. Jedes Gerätepaar hat dieselbe Nummer.
          </p>
        </div>
      </div>
    </div>
  );
}
