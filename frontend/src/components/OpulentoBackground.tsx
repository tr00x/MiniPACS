import { Opulento } from "uvcanvas";

/**
 * Full-bleed Opulento WebGL shader background for the login screen.
 * Sits behind everything; pointer-events disabled so it never intercepts
 * input. Honors prefers-reduced-motion via the wrapper opacity drop.
 */
export function OpulentoBackground() {
  return (
    <div
      aria-hidden
      className="fixed inset-0 -z-10 overflow-hidden bg-[#05060a] motion-reduce:opacity-50 [&>*]:pointer-events-none"
    >
      <div
        className="absolute inset-0 [&>canvas]:!h-full [&>canvas]:!w-full"
        style={{ filter: "grayscale(1) contrast(1.05) brightness(0.85)" }}
      >
        <Opulento />
      </div>
      <div className="absolute inset-0 bg-black/40" />
    </div>
  );
}
