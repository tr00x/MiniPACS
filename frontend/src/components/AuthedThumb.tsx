import { useEffect, useState } from "react";
import api from "@/lib/api";

/**
 * Worklist thumbnail.
 *
 * Two paths:
 *  - `inlineB64` provided (string): render synchronously from a data URL.
 *    The grid pulls all thumbs in one shot via `/api/studies?include=thumbs`,
 *    so 50 cards = 1 request instead of 50.
 *  - `inlineB64 === null`: backend told us the study has no renderable
 *    thumbnail (mid-ingest, no series, etc.) — show "No preview" placeholder
 *    without firing a doomed extra request.
 *  - `inlineB64 === undefined`: caller hasn't opted into the bulk path —
 *    fall back to per-study async fetch (detail pages, legacy callers).
 */
export function AuthedThumb({
  studyId,
  inlineB64,
}: {
  studyId: string;
  inlineB64?: string | null;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (inlineB64 !== undefined) return; // bulk path handles it
    let active = true;
    let url: string | null = null;
    setFailed(false);
    setSrc(null);
    api
      .get(`/studies/${studyId}/thumb`, { responseType: "blob" })
      .then((res) => {
        if (!active) return;
        url = URL.createObjectURL(res.data as Blob);
        setSrc(url);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [studyId, inlineB64]);

  if (inlineB64 === null) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-muted to-muted-foreground/10 text-xs text-muted-foreground">
        No preview
      </div>
    );
  }
  if (inlineB64) {
    return (
      <img
        src={`data:image/webp;base64,${inlineB64}`}
        alt=""
        className="h-full w-full object-contain"
      />
    );
  }
  if (failed || !src) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-muted to-muted-foreground/10 text-xs text-muted-foreground">
        {failed ? "No preview" : ""}
      </div>
    );
  }
  return <img src={src} alt="" className="h-full w-full object-contain" />;
}
