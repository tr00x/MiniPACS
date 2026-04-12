import { useState, useEffect, useCallback, type ReactNode } from "react";
import { AuthContext, type User } from "@/lib/auth";
import api from "@/lib/api";
import { SessionTimeoutWarning } from "@/components/session-timeout-warning";

const DEFAULT_INACTIVITY_TIMEOUT = 15 * 60 * 1000; // 15 minutes
const WARNING_SECONDS = 60;

export function AuthProvider({ children }: { children: ReactNode }) {
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
    if (token) {
      api
        .get("/auth/me")
        .then(async ({ data }) => {
          if (!cancelled) {
            setUser(data);
            try {
              const { data: settings } = await api.get("/settings");
              const minutes = parseInt(settings.auto_logout_minutes, 10);
              if (!cancelled && !isNaN(minutes) && minutes > 0) {
                setInactivityTimeout(minutes * 60 * 1000);
              }
            } catch {
              // fallback to default
            }
          }
        })
        .catch(() => {
          if (!cancelled) {
            localStorage.removeItem("access_token");
            localStorage.removeItem("refresh_token");
          }
        })
        .finally(() => { if (!cancelled) setLoading(false); });
    } else {
      setLoading(false);
    }
    return () => { cancelled = true; };
  }, []);

  const login = async (username: string, password: string) => {
    const { data } = await api.post("/auth/login", { username, password });
    localStorage.setItem("access_token", data.access_token);
    localStorage.setItem("refresh_token", data.refresh_token);
    const { data: me } = await api.get("/auth/me");
    setUser(me);
    try {
      const { data: settings } = await api.get("/settings");
      const minutes = parseInt(settings.auto_logout_minutes, 10);
      if (!isNaN(minutes) && minutes > 0) {
        setInactivityTimeout(minutes * 60 * 1000);
      }
    } catch {
      // fallback to default
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
