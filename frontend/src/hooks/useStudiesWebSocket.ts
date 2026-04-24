import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import api from "@/lib/api";

/**
 * Live worklist feed. Opens a WebSocket to /api/ws/studies authenticated with
 * the current access token, invalidates ['studies'] on every new-study event,
 * and raises a subtle toast so a rad sitting on the worklist sees incoming
 * scans without reaching for refresh.
 *
 * Auth is handed over via Sec-WebSocket-Protocol (the browser's only way to
 * pass a token on a WS open besides the URL), so the JWT never lands in
 * nginx / Cloudflare access logs.
 *
 * On close-code 1008 (auth rejected) we first try to refresh the access
 * token via /api/auth/refresh and reconnect with the new one — otherwise
 * the socket would silently die after the 30-minute access-token TTL with
 * no UI signal. Regular closes (network blip, backend restart) get the
 * exponential-backoff treatment.
 */
export function useStudiesWebSocket(userLoggedIn: boolean) {
  const qc = useQueryClient();
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const cancelledRef = useRef(false);
  const refreshingRef = useRef(false);

  useEffect(() => {
    if (!userLoggedIn) return;
    cancelledRef.current = false;
    refreshingRef.current = false;

    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleReconnect = () => {
      if (cancelledRef.current) return;
      const attempt = retryRef.current++;
      const delay = Math.min(30_000, 1_000 * Math.pow(2, attempt));
      reconnectTimer = setTimeout(connect, delay);
    };

    const tryRefreshThenReconnect = async () => {
      if (refreshingRef.current) return;
      refreshingRef.current = true;
      try {
        const refresh = localStorage.getItem("refresh_token");
        if (!refresh) {
          // no refresh token — treat like a normal reconnect; REST 401 path
          // will eventually force a full re-login.
          scheduleReconnect();
          return;
        }
        const { data } = await api.post("/auth/refresh", { refresh_token: refresh });
        localStorage.setItem("access_token", data.access_token);
        if (data.refresh_token) localStorage.setItem("refresh_token", data.refresh_token);
        // Reset backoff — we have a fresh token, go straight back on.
        retryRef.current = 0;
        connect();
      } catch {
        // Refresh failed (refresh_token expired or revoked). Fall back to the
        // backoff path — eventually a REST 401 will tear the session down.
        scheduleReconnect();
      } finally {
        refreshingRef.current = false;
      }
    };

    const connect = () => {
      if (cancelledRef.current) return;
      const token = localStorage.getItem("access_token");
      if (!token) return;

      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${window.location.host}/api/ws/studies`;
      // Second arg carries the bearer token via Sec-WebSocket-Protocol.
      // Server looks for the non-"bearer" entry and treats it as the JWT.
      const ws = new WebSocket(url, ["bearer", token]);
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
            toast.info(`New study: ${name}${desc}`);
          }
        } catch {
          // silently drop malformed frames — server owns the protocol
        }
      };

      ws.onclose = (ev) => {
        wsRef.current = null;
        if (cancelledRef.current) return;
        // 1008 = policy violation = server rejected the token. Try to refresh
        // before backing off, otherwise the loop just spins with the stale
        // token forever past the 30-min access-token TTL.
        if (ev.code === 1008) {
          tryRefreshThenReconnect();
          return;
        }
        scheduleReconnect();
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
