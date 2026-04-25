import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

/**
 * App-level transition overlay. Lives above the router so it survives
 * route changes — the moment of unmount/remount between two pages is
 * hidden under a single solid panel. The login flow triggers it via
 * `window.dispatchEvent(new CustomEvent('pacs:transition'))`, then we:
 *   1. fade IN the cover (≈300ms)
 *   2. hold (≈250ms) — long enough for navigate() + Suspense fallback
 *      to settle without ever being visible to the user
 *   3. fade OUT, revealing the next page already painted
 */
export function AppTransition() {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const onTransition = () => {
      setActive(true);
      // Total cover ≈ 550ms (300 fade-in + 250 hold). Fade-out is driven
      // by AnimatePresence exit when we flip active=false.
      window.setTimeout(() => setActive(false), 550);
    };
    window.addEventListener("pacs:transition", onTransition);
    return () => window.removeEventListener("pacs:transition", onTransition);
  }, []);

  return (
    <AnimatePresence>
      {active && (
        <motion.div
          key="pacs-transition"
          initial={{ opacity: 0, backdropFilter: "blur(0px)" }}
          animate={{ opacity: 1, backdropFilter: "blur(20px)" }}
          exit={{ opacity: 0, backdropFilter: "blur(0px)" }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          className="fixed inset-0 z-[9999] bg-black/70 pointer-events-none"
        />
      )}
    </AnimatePresence>
  );
}
