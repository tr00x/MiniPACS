import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

/**
 * Cinematic cross-route transition: camera-flash style.
 *
 * Sequence (total ~900ms):
 *   t=0     : event fires → flash starts ramping up (white, blurred, scaling)
 *   t=180ms : peak white — fully opaque, route swap happens under it
 *   t=320ms : flash starts fading
 *   t=900ms : fully transparent, dashboard fully revealed
 *
 * The flash isn't just white — it's a radial burst that expands from the
 * center, so it reads as a "zoom into light" rather than a flat fade.
 */
export function AppTransition() {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const onTransition = () => {
      setActive(true);
      window.setTimeout(() => setActive(false), 320);
    };
    window.addEventListener("pacs:transition", onTransition);
    return () => window.removeEventListener("pacs:transition", onTransition);
  }, []);

  return (
    <AnimatePresence>
      {active && (
        <motion.div
          key="pacs-flash"
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1.4 }}
          exit={{ opacity: 0, scale: 1.8, transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] } }}
          transition={{ duration: 0.18, ease: [0.6, 0, 0.4, 1] }}
          className="fixed inset-0 z-[9999] pointer-events-none"
          style={{
            background:
              "radial-gradient(ellipse at center, rgba(255,255,255,1) 0%, rgba(255,240,255,0.95) 30%, rgba(180,120,255,0.6) 60%, rgba(0,0,0,0) 100%)",
            mixBlendMode: "screen",
          }}
        />
      )}
    </AnimatePresence>
  );
}
