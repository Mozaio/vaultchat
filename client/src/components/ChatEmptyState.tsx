import { IconMessageSquare } from "./Icons";

export function ChatEmptyState() {
  return (
    <div className="chat-empty-state">
      <div className="chat-empty-state-card">
        <div className="chat-empty-state-icon">
          <IconMessageSquare size={38} />
        </div>
        <h2 className="chat-empty-state-title">
          Keine Unterhaltung ausgewaehlt
        </h2>
        <p className="chat-empty-state-subtitle">
          Waehle links einen Chat aus oder erstelle eine private Gruppe.
        </p>
      </div>
    </div>
  );
}
