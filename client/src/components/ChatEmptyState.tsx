import type { ReactNode } from "react";
import {
  IconDownload,
  IconFolderPlus,
  IconShieldCheck,
  IconUsers,
} from "./Icons";
import { VaultChatLogo } from "./Logo";

export function ChatEmptyState({
  hasChats,
  onAddContact,
  onCreateGroup,
  onCreateFolder,
  onSaveBackup,
}: {
  hasChats?: boolean;
  onAddContact?: () => void;
  onCreateGroup?: () => void;
  onCreateFolder?: () => void;
  onSaveBackup?: () => void;
}) {
  const showQuickActions =
    !hasChats &&
    (onAddContact || onCreateGroup || onCreateFolder || onSaveBackup);

  return (
    <div className="chat-empty-state">
      <div className="chat-empty-state-card">
        <div className="chat-empty-state-logo">
          <VaultChatLogo size={60} style={{ color: "var(--accent)" }} />
        </div>
        <h2 className="chat-empty-state-title">Willkommen bei Umbra</h2>
        <p className="chat-empty-state-subtitle">
          Wähle links eine Unterhaltung — oder starte ein neues, privates
          Gespräch. Ende-zu-Ende verschlüsselt, kein Server liest mit.
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
          {onCreateFolder && (
            <QuickAction
              icon={<IconFolderPlus size={20} />}
              title="Ordner erstellen"
              description="Chats nach Themen gruppieren"
              onClick={onCreateFolder}
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
