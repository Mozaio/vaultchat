import type { ReactNode } from "react";
import {
  IconDownload,
  IconFolderPlus,
  IconShieldCheck,
  IconUsers,
} from "./Icons";
import { VaultChatLogo } from "./Logo";
import { t, useLocale } from "../lib/i18n";

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
  useLocale(); // re-render on language change
  const showQuickActions =
    !hasChats &&
    (onAddContact || onCreateGroup || onCreateFolder || onSaveBackup);

  return (
    <div className="chat-empty-state">
      <div className="chat-empty-state-card">
        <div className="chat-empty-state-logo">
          <VaultChatLogo size={60} style={{ color: "var(--accent)" }} />
        </div>
        <h2 className="chat-empty-state-title">{t("empty.welcomeTitle")}</h2>
        <p className="chat-empty-state-subtitle">
          {t("empty.welcomeSubtitle")}
        </p>
      </div>
      {showQuickActions && (
        <div className="empty-quick-actions">
          {onAddContact && (
            <QuickAction
              icon={<IconShieldCheck size={20} />}
              title={t("empty.qaContact")}
              description={t("empty.qaContactDesc")}
              onClick={onAddContact}
            />
          )}
          {onCreateGroup && (
            <QuickAction
              icon={<IconUsers size={20} />}
              title={t("empty.qaGroup")}
              description={t("empty.qaGroupDesc")}
              onClick={onCreateGroup}
            />
          )}
          {onCreateFolder && (
            <QuickAction
              icon={<IconFolderPlus size={20} />}
              title={t("empty.qaFolder")}
              description={t("empty.qaFolderDesc")}
              onClick={onCreateFolder}
            />
          )}
          {onSaveBackup && (
            <QuickAction
              icon={<IconDownload size={20} />}
              title={t("empty.qaBackup")}
              description={t("empty.qaBackupDesc")}
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
