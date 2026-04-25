import { IconShieldCheck } from "./Icons";

export function ChatEmptyState() {
  return (
    <div className="chat-empty-state">
      <div className="chat-empty-state-icon">
        <IconShieldCheck size={48} />
      </div>
      <h2 className="chat-empty-state-title">
        Deine Nachrichten sind sicher
      </h2>
      <p className="chat-empty-state-subtitle">
        Ende-zu-Ende verschlüsselt · Sealed Sender · Zero Knowledge
      </p>
      <div className="chat-empty-state-pills">
        <span className="feature-pill">🔒 Double Ratchet</span>
        <span className="feature-pill">👁 Sealed Sender</span>
        <span className="feature-pill">⏱ Auto-Lock</span>
      </div>
    </div>
  );
}
