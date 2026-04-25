import { IconMessageSquare, IconUsers, IconPhone, IconShield, IconSettings } from "./Icons";

type NavItem = "chats" | "groups" | "calls" | "security" | "settings";

interface BottomNavProps {
  active: NavItem;
  onNavigate: (item: NavItem) => void;
}

const NAV_ITEMS: { id: NavItem; label: string; icon: (props: { size?: number }) => JSX.Element }[] = [
  { id: "chats", label: "Chats", icon: IconMessageSquare },
  { id: "groups", label: "Gruppen", icon: IconUsers },
  { id: "calls", label: "Anruf", icon: IconPhone },
  { id: "security", label: "Sicherheit", icon: IconShield },
  { id: "settings", label: "Einstellungen", icon: IconSettings },
];

export function BottomNav({ active, onNavigate }: BottomNavProps) {
  return (
    <nav className="bottom-nav" role="navigation" aria-label="Hauptnavigation">
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        const isActive = active === item.id;
        return (
          <button
            key={item.id}
            type="button"
            className={`bottom-nav-item ${isActive ? "active" : ""}`}
            onClick={() => onNavigate(item.id)}
            aria-label={item.label}
            aria-current={isActive ? "page" : undefined}
          >
            <Icon size={22} />
            <span className="bottom-nav-label">{item.label}</span>
            {isActive && <span className="bottom-nav-indicator" />}
          </button>
        );
      })}
    </nav>
  );
}
