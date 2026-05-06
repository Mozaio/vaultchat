import type { ReactNode } from "react";
import {
  IconDownload,
  IconMessageSquare,
  IconShieldCheck,
  IconUsers,
} from "./Icons";

export function ChatEmptyState({
  hasChats,
  onAddContact,
  onCreateGroup,
  onSaveBackup,
}: {
  hasChats?: boolean;
  onAddContact?: () => void;
  onCreateGroup?: () => void;
  onSaveBackup?: () => void;
}) {
  const showQuickActions =
    !hasChats && (onAddContact || onCreateGroup || onSaveBackup);

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
      {showQuickActions && (
        <div className="empty-quick-actions">
          {onAddContact && (
            <QuickAction
              icon={<IconShieldCheck size={20} />}
              title="Neuer Kontakt"
              description="Per Benutzername hinzufügen"
              onClick={onAddContact}
            />
          )}
          {onCreateGroup && (
            <QuickAction
              icon={<IconUsers size={20} />}
              title="Gruppe erstellen"
              description="Mehrere Personen auf einmal"
              onClick={onCreateGroup}
            />
          )}
          {onSaveBackup && (
            <QuickAction
              icon={<IconDownload size={20} />}
              title="Backup speichern"
              description="Identität verschlüsselt sichern"
              onClick={onSaveBackup}
            />
          )}
        </div>
      )}
    </div>
  );
}

function QuickAction({
  icon,
  title,
  description,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="empty-quick-action" onClick={onClick}>
      <span className="empty-quick-action-icon">{icon}</span>
      <span className="empty-quick-action-text">
        <strong>{title}</strong>
        {description && <span>{description}</span>}
      </span>
    </button>
  );
}
