import { useEffect, useState } from "react";
import { safetyNumber } from "../lib/crypto";
import {
  acceptKeyChange,
  confirmPeerVerified,
  getPin,
  trustLabel,
  type PeerPin,
} from "../lib/trust";

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="app-surface w-full max-w-lg rounded-2xl p-6" style={{ borderColor: 'var(--border)', background: 'var(--bg-elevated)' }}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
            Sicherheitsnummer · {peerLabel}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-secondary !px-3 !py-1.5 !text-xs"
          >
            Schließen
          </button>
        </div>

        {pin?.state === "mismatch" && (
          <div className="mb-4 rounded-xl border p-3 text-sm" style={{ borderColor: 'rgba(239,68,68,0.5)', background: 'var(--danger-soft)', color: 'var(--danger)' }}>
            <p className="font-semibold">Schlüssel hat sich geändert.</p>
            <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
              Der Peer hat entweder sein Konto neu erstellt oder es gab einen
              MITM/Spoofing-Versuch. Vergleiche unbedingt die Sicherheitsnummer
              out-of-band, bevor du weitermachst.
            </p>
          </div>
        )}

        <p className="mb-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
          Vergleiche die Nummern- und Emoji-Sequenz persönlich oder über einen
          bereits vertrauenswürdigen Kanal mit deinem Gegenüber. Stimmen sie
          überein, ist kein Man-in-the-Middle im Spiel.
        </p>

        <div className="mb-4 grid grid-cols-4 gap-2 rounded-xl border p-3 font-mono text-sm" style={{ borderColor: 'var(--border)', background: 'var(--bg-glass)', color: 'var(--accent)' }}>
          {groups.map((g, i) => (
            <span key={i} className="rounded px-2 py-1 text-center" style={{ background: 'var(--bg-sidebar)' }}>
              {g}
            </span>
          ))}
        </div>

        <div className="mb-4 flex flex-wrap justify-center gap-2 rounded-xl border p-3 text-3xl" style={{ borderColor: 'var(--border)', background: 'var(--bg-glass)' }}>
          {emojiSeq.map((e, i) => (
            <span key={i}>{e}</span>
          ))}
        </div>

        <div className="mb-3 flex items-center justify-between rounded-xl border px-3 py-2 text-xs" style={{ borderColor: 'var(--border)', background: 'var(--bg-sidebar)' }}>
          <span style={{ color: 'var(--text-muted)' }}>
            Status: <span className="font-mono" style={{ color: 'var(--accent)' }}>{trustLabel(pin?.state ?? "new")}</span>
          </span>
          <div className="flex gap-2">
            {pin?.state === "mismatch" && (
              <button
                type="button"
                onClick={() => void onAcceptChange()}
                className="rounded-lg border px-3 py-1 text-sm hover:opacity-80"
                style={{ borderColor: 'var(--warning)', color: 'var(--warning)', background: 'rgba(245,158,11,0.1)' }}
              >
                Neu pinnen
              </button>
            )}
            <button
              type="button"
              onClick={() => void onVerify()}
              className="rounded-lg px-3 py-1 text-sm text-white transition hover:opacity-90"
              style={{ background: 'linear-gradient(135deg, var(--accent-hover), var(--accent))' }}
            >
              Als verifiziert markieren
            </button>
          </div>
        </div>

        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Die Sequenz ist eine deterministische Funktion beider
          Identity-Public-Keys mit BLAKE2b. Jedes Gerätepaar hat dieselbe Nummer.
        </p>
      </div>
    </div>
  );
}
