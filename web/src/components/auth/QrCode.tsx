// SPDX-License-Identifier: Apache-2.0
import { useMemo } from "react";
import qrcode from "qrcode-generator";

/** QR code rendered client side as SVG (the TOTP secret never goes to a third-party service). */
export function QrCode({ value, label, size = 192, testId = "totp-qr" }: { value: string; label: string; size?: number; testId?: string }) {
  const { count, path } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { count: n + 8, path: d };
  }, [value]);
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${count} ${count}`} width={size} height={size} className="mx-auto rounded-md bg-white" shapeRendering="crispEdges" data-testid={testId}>
      <path d={path} fill="#000" />
    </svg>
  );
}
