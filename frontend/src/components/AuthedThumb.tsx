import { useEffect, useState } from "react";
import api from "@/lib/api";

export function AuthedThumb({ studyId }: { studyId: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
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
  }, [studyId]);

  if (failed || !src) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-muted to-muted-foreground/10 text-xs text-muted-foreground">
        {failed ? "No preview" : ""}
      </div>
    );
  }
  return <img src={src} alt="" className="h-full w-full object-contain" />;
}
