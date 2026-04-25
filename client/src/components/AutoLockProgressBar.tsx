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
    <div 
      className={`auto-lock-bar ${isWarning ? 'warning' : ''}`}
      style={{ width: `${progress}%` }}
    />
  );
}
