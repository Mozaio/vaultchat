import type { SVGProps } from "react";

type LogoProps = SVGProps<SVGSVGElement> & { size?: number };

/**
 * Umbra brand mark.
 *
 * Composition (an eclipse — the "umbra" is the full shadow):
 *   - rounded square tile in the brand accent
 *   - a faint corona ring
 *   - a bright disc (the light) carved into a crescent by an offset disc
 *     in the tile color — your messages slip into the shadow, unseen.
 *
 * Single color (follows the surrounding `color` / `var(--accent)`), white
 * detailing only. Stays legible from 16px (favicon) up to the landing hero.
 *
 * NB: the exported symbols keep their historical names so existing imports
 * don't break; the product brand is "Umbra".
 */
export function VaultChatLogo({ size = 48, ...props }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      {...props}
    >
      <rect x="2" y="2" width="60" height="60" rx="16" fill="currentColor" />
      {/* faint corona */}
      <circle
        cx="32"
        cy="32"
        r="19"
        stroke="white"
        strokeWidth="1.5"
        fill="none"
        opacity="0.35"
      />
      {/* light disc */}
      <circle cx="32" cy="32" r="15" fill="white" opacity="0.96" />
      {/* umbra — carves the bright disc into a crescent */}
      <circle cx="39" cy="27" r="14.5" fill="currentColor" />
    </svg>
  );
}

/**
 * Compact wordmark variant for tight headers (sidebar, etc.).
 * Renders the brand mark + the "Umbra" wordmark inline.
 */
export function VaultChatWordmark({
  size = 22,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={className}
      style={{ display: "inline-flex", alignItems: "center", gap: "0.55rem" }}
    >
      <VaultChatLogo size={size} style={{ color: "var(--accent)" }} />
      <span
        style={{
          fontWeight: 700,
          letterSpacing: "-0.01em",
          fontSize: `${size * 0.78}px`,
          color: "var(--text)",
        }}
      >
        Umbra
      </span>
    </span>
  );
}
