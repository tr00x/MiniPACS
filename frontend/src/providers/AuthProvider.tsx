import { useState, useEffect, useCallback, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AuthContext, type User } from "@/lib/auth";
import api from "@/lib/api";
import { qk } from "@/hooks/queries";
import { SessionTimeoutWarning } from "@/components/session-timeout-warning";

const DEFAULT_INACTIVITY_TIMEOUT = 15 * 60 * 1000; // 15 minutes
const WARNING_SECONDS = 60;

interface BootResponse {
  user: User;
  settings: Record<string, string>;
  viewers: unknown[];
  pacs_nodes: unknown[];
}

// Seed React Query caches so viewers/pacs-nodes land hot on first access —
// pages use the same query keys from queries.ts, so this is a direct handoff.
function seedBootCaches(qc: ReturnType<typeof useQueryClient>, boot: BootResponse) {
  qc.setQueryData(qk.settings(), boot.settings);
  qc.setQueryData(qk.viewers(), boot.viewers);
  qc.setQueryData(qk.pacsNodes(), boot.pacs_nodes);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [inactivityTimeout, setInactivityTimeout] = useState(DEFAULT_INACTIVITY_TIMEOUT);
  const [showTimeoutWarning, setShowTimeoutWarning] = useState(false);
  const [secondsRemaining, setSecondsRemaining] = useState(WARNING_SECONDS);

  const logout = useCallback(() => {
    const token = localStorage.getItem("access_token");
    localStorage.removeItem("access_token");
    localStorage.removeItem("refresh_token");
    if (token) {
      api.post("/auth/logout", null, {
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
    setUser(null);
    setShowTimeoutWarning(false);
  }, []);

  // Auto-logout on inactivity with 60s warning
  useEffect(() => {
    if (!user) return;
    let warningTimer: ReturnType<typeof setTimeout>;
    let logoutTimer: ReturnType<typeof setTimeout>;
    let countdownInterval: ReturnType<typeof setInterval>;

    const reset = () => {
      clearTimeout(warningTimer);
      clearTimeout(logoutTimer);
      clearInterval(countdownInterval);
      setShowTimeoutWarning(false);

      const warningMs = Math.max(inactivityTimeout - WARNING_SECONDS * 1000, 0);
      warningTimer = setTimeout(() => {
        setSecondsRemaining(WARNING_SECONDS);
        setShowTimeoutWarning(true);
        countdownInterval = setInterval(() => {
          setSecondsRemaining((prev) => {
            if (prev <= 1) {
              clearInterval(countdownInterval);
              return 0;
            }
            return prev - 1;
          });
        }, 1000);
      }, warningMs);

      logoutTimer = setTimeout(logout, inactivityTimeout);
    };

    const events = ["mousedown", "keydown", "scroll", "touchstart"];
    events.forEach((e) => window.addEventListener(e, reset));
    reset();

    return () => {
      clearTimeout(warningTimer);
      clearTimeout(logoutTimer);
      clearInterval(countdownInterval);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [user, logout, inactivityTimeout]);

  const handleStayLoggedIn = useCallback(() => {
    api
      .post("/auth/refresh", {
        refresh_token: localStorage.getItem("refresh_token"),
      })
      .then(({ data }) => {
        localStorage.setItem("access_token", data.access_token);
        if (data.refresh_token)
          localStorage.setItem("refresh_token", data.refresh_token);
      })
      .catch(() => {});
    setShowTimeoutWarning(false);
    // Timer will be reset by user interaction (clicking the button triggers mousedown)
  }, []);

  useEffect(() => {
    let cancelled = false;
    const token = localStorage.getItem("access_token");
    if (!token) {
      setLoading(false);
      return () => { cancelled = true; };
    }
    // One call replaces /auth/me + /settings + seeds viewers and pacs-nodes
    // into React Query cache. Saves 1 RTT on page load; later pages that need
    // viewers/pacs-nodes hit cache instead of the network.
    api
      .get<BootResponse>("/boot")
      .then(({ data }) => {
        if (cancelled) return;
        setUser(data.user);
        seedBootCaches(qc, data);
        const minutes = parseInt(data.settings?.auto_logout_minutes ?? "", 10);
        if (!isNaN(minutes) && minutes > 0) {
          setInactivityTimeout(minutes * 60 * 1000);
        }
      })
      .catch(() => {
        if (!cancelled) {
          localStorage.removeItem("access_token");
          localStorage.removeItem("refresh_token");
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [qc]);

  const login = async (username: string, password: string) => {
    const { data } = await api.post("/auth/login", { username, password });
    localStorage.setItem("access_token", data.access_token);
    localStorage.setItem("refresh_token", data.refresh_token);
    // Pull user + settings + viewers + pacs-nodes in one round-trip instead of
    // the old /auth/me → /settings sequence.
    const { data: boot } = await api.get<BootResponse>("/boot");
    setUser(boot.user);
    seedBootCaches(qc, boot);
    const minutes = parseInt(boot.settings?.auto_logout_minutes ?? "", 10);
    if (!isNaN(minutes) && minutes > 0) {
      setInactivityTimeout(minutes * 60 * 1000);
    }
  };

  if (loading) return (
    <div className="flex h-screen items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  );

  return (
    <AuthContext.Provider value={{ user, login, logout, isAuthenticated: !!user }}>
      {children}
      <SessionTimeoutWarning
        open={showTimeoutWarning}
        secondsRemaining={secondsRemaining}
        onStayLoggedIn={handleStayLoggedIn}
        onLogout={logout}
      />
    </AuthContext.Provider>
  );
}
