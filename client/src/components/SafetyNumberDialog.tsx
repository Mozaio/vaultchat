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
      <div className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">
            Sicherheitsnummer · {peerLabel}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            Schließen
          </button>
        </div>

        {pin?.state === "mismatch" && (
          <div className="mb-4 rounded-xl border border-red-800/60 bg-red-950/40 p-3 text-sm text-red-200">
            <p className="font-semibold">Schlüssel hat sich geändert.</p>
            <p className="mt-1 text-xs text-red-300/90">
              Der Peer hat entweder sein Konto neu erstellt oder es gab einen
              MITM/Spoofing-Versuch. Vergleiche unbedingt die Sicherheitsnummer
              out-of-band, bevor du weitermachst.
            </p>
          </div>
        )}

        <p className="mb-3 text-sm text-zinc-400">
          Vergleiche die Nummern- und Emoji-Sequenz persönlich oder über einen
          bereits vertrauenswürdigen Kanal mit deinem Gegenüber. Stimmen sie
          überein, ist kein Man-in-the-Middle im Spiel.
        </p>

        <div className="mb-4 grid grid-cols-4 gap-2 rounded-xl border border-zinc-800 bg-zinc-900/50 p-3 font-mono text-sm text-emerald-300">
          {groups.map((g, i) => (
            <span key={i} className="rounded bg-zinc-950 px-2 py-1 text-center">
              {g}
            </span>
          ))}
        </div>

        <div className="mb-4 flex flex-wrap justify-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/50 p-3 text-3xl">
          {emojiSeq.map((e, i) => (
            <span key={i}>{e}</span>
          ))}
        </div>

        <div className="mb-3 flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs">
          <span className="text-zinc-400">
            Status: <span className="font-mono text-emerald-400">{trustLabel(pin?.state ?? "new")}</span>
          </span>
          <div className="flex gap-2">
            {pin?.state === "mismatch" && (
              <button
                type="button"
                onClick={() => void onAcceptChange()}
                className="rounded-lg border border-amber-600 px-3 py-1 text-amber-200 hover:bg-amber-900/30"
              >
                Neu pinnen
              </button>
            )}
            <button
              type="button"
              onClick={() => void onVerify()}
              className="rounded-lg bg-emerald-600 px-3 py-1 text-white hover:bg-emerald-500"
            >
              Als verifiziert markieren
            </button>
          </div>
        </div>

        <p className="text-xs text-zinc-500">
          Die Sequenz ist eine deterministische Funktion beider
          Identity-Public-Keys mit BLAKE2b. Jedes Gerätepaar hat dieselbe Nummer.
        </p>
      </div>
    </div>
  );
}
