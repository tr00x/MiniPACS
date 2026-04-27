import { useEffect, useState } from "react";

/** Listens for window-level drag/drop. When files are dropped (and the
 *  user wasn't editing a text field), captures them and reports back.
 *  Consumer pops the files via `take()`, which clears the state. */
export function useGlobalFileDrop() {
  const [pending, setPending] = useState<File[] | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const isEditingTarget = (t: EventTarget | null) => {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable;
    };

    const onOver = (e: DragEvent) => {
      // If the dialog's own dropzone (or any inner handler) already
      // called preventDefault, don't overlay the window-wide hint.
      if (e.defaultPrevented) return;
      if (isEditingTarget(e.target)) return;
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes("Files")) return;
      e.preventDefault();
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      // window-level dragleave fires constantly when crossing children;
      // only count true exits (relatedTarget == null when the cursor leaves the document).
      if (e.relatedTarget === null) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      setDragging(false);
      // Inner dropzone (e.g. ImportDialog) handled this — don't double-open.
      if (e.defaultPrevented) return;
      if (isEditingTarget(e.target)) return;
      if (!e.dataTransfer || e.dataTransfer.files.length === 0) return;
      e.preventDefault();
      const files: File[] = [];
      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        files.push(e.dataTransfer.files[i]);
      }
      setPending(files);
    };

    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  const take = () => {
    const f = pending;
    setPending(null);
    return f;
  };

  return { pending, dragging, take };
}
