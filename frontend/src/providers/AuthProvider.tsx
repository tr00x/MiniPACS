import { useState, useEffect, useCallback, type ReactNode } from "react";
import { AuthContext, type User } from "@/lib/auth";
import api from "@/lib/api";

const DEFAULT_INACTIVITY_TIMEOUT = 15 * 60 * 1000; // 15 minutes

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [inactivityTimeout, setInactivityTimeout] = useState(DEFAULT_INACTIVITY_TIMEOUT);

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
  }, []);

  // Auto-logout on inactivity
  useEffect(() => {
    if (!user) return;
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(logout, inactivityTimeout);
    };
    const events = ["mousedown", "keydown", "scroll", "touchstart"];
    events.forEach((e) => window.addEventListener(e, reset));
    reset();
    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [user, logout, inactivityTimeout]);

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
    </AuthContext.Provider>
  );
}
