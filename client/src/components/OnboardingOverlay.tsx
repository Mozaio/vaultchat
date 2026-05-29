import { useEffect, useState } from "react";
import { IconLock, IconShieldCheck, IconUsers } from "./Icons";

const ONBOARDING_KEY = "vaultchat.onboarding.pending";

export function readOnboardingPending(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_KEY) === "1";
  } catch {
    return false;
  }
}

export function clearOnboardingPending(): void {
  try {
    localStorage.removeItem(ONBOARDING_KEY);
  } catch {
    /* ignore */
  }
}

const STEPS = [
  {
    title: "Willkommen bei Umbra",
    text: "Deine Chats sind Ende-zu-Ende verschlüsselt. Der Server sieht weder Inhalte noch den Absender bei Direktnachrichten (Sealed Sender).",
    icon: <IconShieldCheck size={36} />,
  },
  {
    title: "Backup nicht vergessen",
    text: "Der Schlüssel liegt nur auf diesem Gerät. Ohne verschlüsseltes Backup gibt es auf einem neuen Handy oder nach Datenverlust keinen Zugriff auf deine Konversationen.",
    icon: <IconLock size={34} />,
  },
  {
    title: "Loslegen",
    text: "Füge Kontakte über die Suche hinzu oder lege eine Gruppe an. Tipp: Sicherheitsnummern bei wichtigen Kontakten verifizieren.",
    icon: <IconUsers size={34} />,
  },
] as const;

type Props = {
  onDone: () => void;
  onRequestBackup: () => void;
};

export function OnboardingOverlay({ onDone, onRequestBackup }: Props) {
  const [step, setStep] = useState(0);
  const last = step === STEPS.length - 1;

  // Mark onboarding as seen the moment it's shown. Otherwise closing/reloading
  // the tab mid-flow leaves the "pending" flag set and the intro re-appears on
  // every launch until a terminal button is clicked. It's a one-time intro.
  useEffect(() => {
    clearOnboardingPending();
  }, []);

  const finish = () => {
    clearOnboardingPending();
    onDone();
  };

  return (
    <div
      className="onboarding-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
    >
      <div className="onboarding-card">
        <div className="onboarding-icon" aria-hidden>
          {STEPS[step].icon}
        </div>
        <h2 id="onboarding-title" className="onboarding-title">
          {STEPS[step].title}
        </h2>
        <p className="onboarding-text">{STEPS[step].text}</p>

        <div className="onboarding-progress" aria-hidden>
          {STEPS.map((_, i) => (
            <span key={i} className={i === step ? "active" : ""} />
          ))}
        </div>

        <div className="onboarding-actions flex-wrap">
          <button
            type="button"
            className="btn btn-secondary !text-xs"
            onClick={finish}
          >
            Überspringen
          </button>
          {step > 0 && (
            <button
              type="button"
              className="btn btn-secondary !text-xs"
              onClick={() => setStep((s) => s - 1)}
            >
              Zurück
            </button>
          )}
          {step === 1 && (
            <button
              type="button"
              className="btn btn-secondary !text-xs"
              onClick={() => {
                onRequestBackup();
                finish();
              }}
            >
              Backup jetzt
            </button>
          )}
          {!last ? (
            <button
              type="button"
              className="btn btn-primary !text-xs"
              onClick={() => setStep((s) => s + 1)}
            >
              Weiter
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary !text-xs"
              onClick={finish}
            >
              Fertig
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
