import { useEffect, useRef, useState } from "react";
import { IconLock, IconShieldCheck, IconUsers } from "./Icons";
import { t, useLocale } from "../lib/i18n";
import { useFocusTrap } from "../lib/useFocusTrap";

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
  { titleKey: "ob.s1.title", textKey: "ob.s1.text", icon: <IconShieldCheck size={36} /> },
  { titleKey: "ob.s2.title", textKey: "ob.s2.text", icon: <IconLock size={34} /> },
  { titleKey: "ob.s3.title", textKey: "ob.s3.text", icon: <IconUsers size={34} /> },
] as const;

type Props = {
  onDone: () => void;
  onRequestBackup: () => void;
};

export function OnboardingOverlay({ onDone, onRequestBackup }: Props) {
  useLocale(); // re-render on language change
  const cardRef = useRef<HTMLDivElement>(null);
  useFocusTrap(cardRef);
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
      <div ref={cardRef} className="onboarding-card">
        <div className="onboarding-icon" aria-hidden>
          {STEPS[step].icon}
        </div>
        <h2 id="onboarding-title" className="onboarding-title">
          {t(STEPS[step].titleKey)}
        </h2>
        <p className="onboarding-text">{t(STEPS[step].textKey)}</p>

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
            {t("common.skip")}
          </button>
          {step > 0 && (
            <button
              type="button"
              className="btn btn-secondary !text-xs"
              onClick={() => setStep((s) => s - 1)}
            >
              {t("common.back")}
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
              {t("ob.backupNow")}
            </button>
          )}
          {!last ? (
            <button
              type="button"
              className="btn btn-primary !text-xs"
              onClick={() => setStep((s) => s + 1)}
            >
              {t("common.next")}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary !text-xs"
              onClick={finish}
            >
              {t("common.done")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
