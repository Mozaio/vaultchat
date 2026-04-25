import { useEffect, useState } from "react";
import { IconLock } from "./Icons";
import { ThemeToggle } from "./ThemeToggle";

interface LockScreenProps {
  lastActivity: Date;
  onUnlock: () => void;
}

export function LockScreen({ lastActivity, onUnlock }: LockScreenProps) {
  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString("de-DE", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  const getLastActivityText = () => {
    const diff = Date.now() - lastActivity.getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return "Gerade eben";
    if (minutes === 1) return "Vor 1 Minute";
    if (minutes < 60) return `Vor ${minutes} Minuten`;
    const hours = Math.floor(minutes / 60);
    if (hours === 1) return "Vor 1 Stunde";
    return `Vor ${hours} Stunden`;
  };

  return (
    <div className="lock-screen-overlay">
      <div className="lock-screen-panel">
        <div className="absolute top-4 right-4">
          <ThemeToggle />
        </div>

        <div className="lock-screen-icon">
          <IconLock size={64} />
        </div>

        <p className="lock-screen-time">{formatTime(currentTime)}</p>

        <p className="lock-screen-last-activity">
          {getLastActivityText()}
        </p>

        <p
          className="mb-6 text-sm"
          style={{ color: "var(--text-secondary)" }}
        >
          VaultChat ist gesperrt
        </p>

        <button
          type="button"
          onClick={onUnlock}
          className="btn btn-primary w-full"
        >
          Entsperren
        </button>
      </div>
    </div>
  );
}
