import { useMemo } from "react";
import { generateQrMatrix } from "../lib/qrCode";
import { t } from "../lib/i18n";

export function QrCodeSvg({
  digits,
  size = 220,
  quietZone = 4,
  bg = "#ffffff",
  fg = "#000000",
}: {
  digits: string;
  size?: number;
  quietZone?: number;
  bg?: string;
  fg?: string;
}) {
  const path = useMemo(() => {
    let matrix: boolean[][];
    try {
      matrix = generateQrMatrix(digits);
    } catch {
      return { d: "", n: 0, error: true as const };
    }
    const n = matrix.length + quietZone * 2;
    let d = "";
    for (let y = 0; y < matrix.length; y++) {
      for (let x = 0; x < matrix[y]!.length; x++) {
        if (matrix[y]![x]) {
          d += `M${x + quietZone},${y + quietZone}h1v1h-1z`;
        }
      }
    }
    return { d, n, error: false as const };
  }, [digits, quietZone]);

  if (path.error) {
    return (
      <div
        style={{
          width: size,
          height: size,
          display: "grid",
          placeItems: "center",
          background: bg,
          color: fg,
          borderRadius: 8,
          fontSize: 12,
        }}
      >
        QR-Code nicht verfügbar
      </div>
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${path.n} ${path.n}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={t("safety.qrAria")}
      style={{ display: "block", borderRadius: 8 }}
    >
      <rect width={path.n} height={path.n} fill={bg} />
      <path d={path.d} fill={fg} />
    </svg>
  );
}
