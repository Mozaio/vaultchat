import { IconLock, IconShieldCheck, IconTimer } from "./Icons";

export function ChatEmptyState() {
  return (
    <div className="chat-empty-state">
      <div className="chat-empty-state-card">
        <div className="chat-empty-state-icon">
          <IconShieldCheck size={42} />
        </div>
        <h2 className="chat-empty-state-title">
          Waehle einen Chat oder starte eine sichere Gruppe
        </h2>
        <p className="chat-empty-state-subtitle">
          Nachrichten bleiben Ende-zu-Ende verschluesselt. Server sehen nur Relay-Daten, nicht den Inhalt.
        </p>
        <div className="chat-empty-state-pills">
          <span className="feature-pill"><IconLock size={13} /> Double Ratchet</span>
          <span className="feature-pill"><IconShieldCheck size={13} /> Sealed Sender</span>
          <span className="feature-pill"><IconTimer size={13} /> Auto-Lock</span>
        </div>
      </div>
    </div>
  );
}
