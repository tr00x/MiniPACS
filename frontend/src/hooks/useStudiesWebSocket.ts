import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

/**
 * Live worklist feed. Opens a WebSocket to /api/ws/studies authenticated with
 * the current access token, invalidates ['studies'] on every new-study event,
 * and raises a subtle toast so a rad sitting on the worklist sees incoming
 * scans without reaching for refresh.
 *
 * Reconnect uses exponential backoff capped at 30s so a backend restart or
 * a transient CF Tunnel blip recovers without user action. The socket is
 * closed on logout (userLoggedIn=false) so a logged-out tab is not a
 * dangling subscriber.
 */
export function useStudiesWebSocket(userLoggedIn: boolean) {
  const qc = useQueryClient();
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!userLoggedIn) return;
    cancelledRef.current = false;

    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (cancelledRef.current) return;
      const token = localStorage.getItem("access_token");
      if (!token) return;

      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${window.location.host}/api/ws/studies?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        retryRef.current = 0;
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "new-study") {
            qc.invalidateQueries({ queryKey: ["studies"] });
            qc.invalidateQueries({ queryKey: ["patients"] });
            qc.invalidateQueries({ queryKey: ["dashboard"] });
            const name = msg.patient_name || "Unknown";
            const desc = msg.study_description ? ` — ${msg.study_description}` : "";
            toast.info(`Новое исследование: ${name}${desc}`);
          }
        } catch {
          // silently drop malformed frames — server owns the protocol
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (cancelledRef.current) return;
        const attempt = retryRef.current++;
        const delay = Math.min(30_000, 1_000 * Math.pow(2, attempt));
        reconnectTimer = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // onclose will follow; no need to retry twice
      };
    };

    connect();

    return () => {
      cancelledRef.current = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          /* ignore */
        }
        wsRef.current = null;
      }
    };
  }, [userLoggedIn, qc]);
}
