import { useEffect, useState } from "react";

interface AutoLockProgressBarProps {
  timeoutMs: number;
  onTimeout: () => void;
  resetTrigger?: number;
}

export function AutoLockProgressBar({ 
  timeoutMs, 
  onTimeout, 
  resetTrigger = 0 
}: AutoLockProgressBarProps) {
  const [progress, setProgress] = useState(100);
  const [isWarning, setIsWarning] = useState(false);
  const remainingMs = Math.max(0, Math.round((progress / 100) * timeoutMs));
  const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  const isCritical = remainingMs <= 10_000;
  
  const WARNING_THRESHOLD = 60_000; // Last 60 seconds

  useEffect(() => {
    setProgress(100);
    setIsWarning(false);
  }, [resetTrigger]);

  useEffect(() => {
    const interval = setInterval(() => {
      setProgress((prev) => {
        const newProgress = prev - (100 / (timeoutMs / 1000));
        if (newProgress <= 0) {
          clearInterval(interval);
          onTimeout();
          return 0;
        }
        if (newProgress <= (WARNING_THRESHOLD / timeoutMs) * 100) {
          setIsWarning(true);
        }
        return newProgress;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [timeoutMs, onTimeout]);

  return (
    <div className="auto-lock-wrap" title={`Auto-Lock in ${remainingMinutes} Minuten`}>
      <div
        className={`auto-lock-bar ${isWarning ? "warning" : ""} ${isCritical ? "critical" : ""}`}
        style={{ width: `${progress}%` }}
      />
      <span className="auto-lock-tooltip">
        Auto-Lock in {remainingMinutes} Minuten
      </span>
    </div>
  );
}
