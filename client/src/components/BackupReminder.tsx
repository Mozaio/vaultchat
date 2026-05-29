import { IconShieldCheck, IconX } from "./Icons";
import { t, useLocale } from "../lib/i18n";

/**
 * Backup-Erinnerungsbanner über dem Chat-Layout. Wird gerendert, solange der
 * User noch nicht "dauerhaft ausblenden" geklickt hat. Persistenz im
 * localStorage über key "vaultchat.backupReminder.dismissed".
 *
 * War vorher inline in ChatShell — als eigene Datei jetzt isoliert testbar
 * und vermindert ChatShell.tsx weiter.
 */
export function BackupReminder({
  onExport,
  onDismiss,
}: {
  onExport: () => void;
  onDismiss: () => void;
}) {
  useLocale();
  return (
    <div className="backup-reminder mx-3 mt-2 shrink-0 md:mx-4">
      <IconShieldCheck
        size={18}
        className="shrink-0"
        style={{ color: "var(--accent)" }}
        aria-hidden
      />
      <div className="backup-reminder-text">
        <strong>{t("backup.title")}</strong>
        <span> {t("backup.text")}</span>
      </div>
      <button
        type="button"
        className="btn btn-primary !shrink-0 !px-2.5 !py-1 !text-xs"
        onClick={onExport}
      >
        {t("common.export")}
      </button>
      <button
        type="button"
        className="!text-[var(--text-muted)] hover:!text-[var(--text)]"
        title={t("backup.dismiss")}
        aria-label={t("backup.dismiss")}
        onClick={onDismiss}
      >
        <IconX size={16} />
      </button>
    </div>
  );
}
