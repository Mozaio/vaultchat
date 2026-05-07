import type { SVGProps } from "react";

type LogoProps = SVGProps<SVGSVGElement> & { size?: number };

/**
 * VaultChat brand mark.
 *
 * Composition:
 *   - rounded square in the brand accent (the "vault")
 *   - a chat-bubble silhouette cut out of it
 *   - a small lock at the lower right of the bubble
 *
 * The whole thing is stroke-only on the inner shape so it stays legible
 * at 16px (favicon size) up to 96px (landing hero). Single color, so
 * it follows the surrounding `color`/`var(--accent)` if used inverted.
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
      <rect
        x="2"
        y="2"
        width="60"
        height="60"
        rx="14"
        fill="currentColor"
      />
      {/* chat bubble */}
      <path
        d="M16 24c0-3.3 2.7-6 6-6h20c3.3 0 6 2.7 6 6v12c0 3.3-2.7 6-6 6H30l-7 6v-6h-1c-3.3 0-6-2.7-6-6V24z"
        fill="white"
        opacity="0.95"
      />
      {/* lock body */}
      <rect
        x="36"
        y="32"
        width="10"
        height="8"
        rx="1.4"
        fill="currentColor"
      />
      {/* lock shackle */}
      <path
        d="M38 32v-2.2a3 3 0 0 1 6 0V32"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

/**
 * Compact wordmark variant for tight headers (sidebar, etc.).
 * Renders the brand mark + the "VaultChat" wordmark inline.
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
        VaultChat
      </span>
    </span>
  );
}
