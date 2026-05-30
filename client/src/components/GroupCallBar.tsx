/**
 * Group call header bar + tile grid (audio-only MVP).
 *
 * Displays:
 *  - "Voice room" join/leave button when no one is in the call yet
 *  - When call is active: tile grid (one per peer + self) with
 *    speaking-indicator ring, mute pill, peer connection-quality dot
 *  - Mute toggle, push-to-talk hold (Space), Auflegen
 *
 * Receives a `state` snapshot prop that is published by the
 * GroupCallController in groupCall.ts.
 */

import { useEffect, useRef, useState } from "react";
import type { GroupCallState } from "../lib/groupCall";
import { IconMic, IconPhone, IconScreenShare, IconUsers } from "./Icons";
import { t, useLocale } from "../lib/i18n";

type Props = {
  /** Active call state (null = not in a call). */
  state: GroupCallState | null;
  /** Local user — needed to render the self-tile. */
  selfUserId: string;
  selfUsername: string;
  /** Handler to join the call (creates GroupCallController upstream). */
  onJoin: () => void;
  /** Handler to leave the call. */
  onLeave: () => void;
  /** Toggle local mute. */
  onToggleMute: () => void;
  /** Toggle screen sharing (step 1: local preview only). */
  onToggleScreenShare?: () => void;
  /** Indicator: is anyone else currently in the room (from announces). */
  occupants: number;
  /** Connection-quality summary string for the user (debug-friendly). */
  qualityHint?: string;
};

export function GroupCallBar({
  state,
  selfUserId,
  selfUsername,
  onJoin,
  onLeave,
  onToggleMute,
  onToggleScreenShare,
  occupants,
  qualityHint,
}: Props) {
  useLocale();
  const screenStream = state?.localScreenStream ?? null;
  const inCall = !!state;

  // Push-to-talk: hold Space to speak. We don't know the previous mute
  // state on key-up reliably (user might have toggled mid-hold), so
  // we just set muted=true on key-up and rely on user pressing the
  // mute button for permanent state.
  const [pttActive, setPttActive] = useState(false);
  useEffect(() => {
    if (!inCall) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat && !isTypingTarget(e.target)) {
        e.preventDefault();
        setPttActive(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space" && !isTypingTarget(e.target)) {
        e.preventDefault();
        setPttActive(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [inCall]);

  // Outside ChatShell, hide everything when nobody is in the room AND
  // we're not in a call. The bar collapses to a small "Voice • 0" idle
  // pill so users always know the room exists.
  if (!inCall && occupants === 0) {
    return (
      <div className="group-call-bar idle">
        <button
          type="button"
          className="group-call-join-btn"
          onClick={onJoin}
          title={t("call.start")}
        >
          <IconMic size={16} aria-hidden />
          <span>{t("call.start")}</span>
        </button>
      </div>
    );
  }

  if (!inCall && occupants > 0) {
    return (
      <div className="group-call-bar pending">
        <span className="group-call-occupants">
          <IconUsers size={14} aria-hidden />{" "}
          {occupants === 1
            ? t("call.talkingOne")
            : t("call.talking", { n: occupants })}
        </span>
        <button
          type="button"
          className="group-call-join-btn primary"
          onClick={onJoin}
        >
          <IconMic size={16} aria-hidden />
          <span>{t("call.join")}</span>
        </button>
      </div>
    );
  }

  // In-call view
  const peerList = state ? Array.from(state.peers.values()) : [];
  const total = peerList.length + 1;

  return (
    <div className={`group-call-bar active${pttActive ? " ptt-active" : ""}`}>
      <div className="group-call-header">
        <span className="group-call-header-status">
          <span className="gc-live-dot" aria-hidden />
          {total === 1
            ? t("call.roomSelf")
            : t("call.roomConnected", { n: total })}
        </span>
        <span className="group-call-header-hint">{t("call.pttHint")}</span>
      </div>
      {screenStream && (
        <div className="group-call-screen">
          <span className="group-call-screen-badge">
            <IconScreenShare size={12} aria-hidden /> {t("call.youShare")}
          </span>
          <ScreenPreview stream={screenStream} />
        </div>
      )}
      {peerList
        .filter((p) => p.screenStream)
        .map((p) => (
          <div key={`screen-${p.userId}`} className="group-call-screen">
            <span className="group-call-screen-badge">
              <IconScreenShare size={12} aria-hidden />{" "}
              {t("call.peerShares", { name: p.username })}
            </span>
            <ScreenPreview stream={p.screenStream!} />
          </div>
        ))}
      <div className="group-call-grid" data-count={total}>
        <Tile
          label={selfUsername}
          isSelf
          muted={state?.localMuted ?? false}
          speaking={pttActive && !(state?.localMuted ?? false)}
        />
        {peerList.map((p) => (
          <Tile
            key={p.userId}
            label={p.username}
            speaking={p.speaking}
            muted={p.muted}
            connectionWarning={
              p.iceState === "disconnected" || p.iceState === "failed"
            }
            stream={p.stream}
          />
        ))}
      </div>
      <div className="group-call-controls">
        <button
          type="button"
          className={`group-call-control mute${state?.localMuted ? " muted" : ""}`}
          onClick={onToggleMute}
          title={state?.localMuted ? t("call.unmute") : t("call.mute")}
        >
          <IconMic size={18} aria-hidden />
        </button>
        {onToggleScreenShare && (
          <button
            type="button"
            className={`group-call-control screen${screenStream ? " active" : ""}`}
            onClick={onToggleScreenShare}
            title={screenStream ? t("call.stopShare") : t("call.share")}
            aria-pressed={!!screenStream}
          >
            <IconScreenShare size={18} aria-hidden />
          </button>
        )}
        <button
          type="button"
          className="group-call-control hangup"
          onClick={onLeave}
          title={t("call.hangup")}
        >
          <IconPhone size={18} aria-hidden />
        </button>
        {qualityHint && (
          <span className="group-call-quality" title={qualityHint}>
            {qualityHint}
          </span>
        )}
      </div>
    </div>
  );
}

function Tile({
  label,
  isSelf,
  speaking,
  muted,
  connectionWarning,
  stream,
}: {
  label: string;
  isSelf?: boolean;
  speaking: boolean;
  muted: boolean;
  connectionWarning?: boolean;
  stream?: MediaStream | null;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (audioRef.current && stream) {
      audioRef.current.srcObject = stream;
    }
  }, [stream]);
  const initials = label
    .split(/\s+/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <div
      className={`gc-tile${speaking ? " speaking" : ""}${
        connectionWarning ? " warn" : ""
      }${isSelf ? " self" : ""}`}
    >
      <div className="gc-tile-avatar">
        <span aria-hidden>{initials || "?"}</span>
      </div>
      <div className="gc-tile-name">{label}</div>
      {connectionWarning && (
        <div className="gc-tile-reconnecting">{t("call.reconnecting")}</div>
      )}
      <div className="gc-tile-icons">
        {muted && (
          <span className="gc-tile-icon muted" aria-label={t("call.muted")}>
            <IconMic size={12} />
            <span className="gc-tile-mute-slash" aria-hidden />
          </span>
        )}
      </div>
      {!isSelf && stream && (
        <audio ref={audioRef} autoPlay playsInline />
      )}
    </div>
  );
}

function ScreenPreview({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <video
      ref={ref}
      className="group-call-screen-video"
      autoPlay
      muted
      playsInline
      title={t("call.fullscreen")}
      onClick={() => {
        void ref.current?.requestFullscreen?.().catch(() => {});
      }}
    />
  );
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!t || !(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (t.isContentEditable) return true;
  return false;
}
