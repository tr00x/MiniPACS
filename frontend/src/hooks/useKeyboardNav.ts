import { useEffect, useRef } from "react";

// Global keyboard navigation for pro-mode UX. Each binding declares a key and
// a handler; the hook installs a single keydown listener on window and routes
// events to the right binding.
//
// Typing-context guard: by default, handlers are SUPPRESSED while focus is
// inside an input/textarea/select/contenteditable so `j/k` don't hijack
// keystrokes in the search box. Opt-in to `alwaysActive: true` for bindings
// that must fire regardless (e.g. `/` to focus search, `Esc` to close).

type KeyHandler = (e: KeyboardEvent) => void;

export interface KeyBinding {
  key: string;
  handler: KeyHandler;
  alwaysActive?: boolean;
}

function isTypingContext(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (el.isContentEditable) return true;
  return false;
}

export function useKeyboardNav(bindings: KeyBinding[]) {
  // Store bindings in a ref so handler doesn't re-attach on every render.
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const typing = isTypingContext(e.target);
      for (const b of bindingsRef.current) {
        if (b.key !== e.key) continue;
        if (typing && !b.alwaysActive) continue;
        e.preventDefault();
        b.handler(e);
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
