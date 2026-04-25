import { useState, useEffect, useRef } from "react";
import { useNavigate, Navigate } from "react-router-dom";
import { motion, AnimatePresence } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import api from "@/lib/api";
import { OpulentoBackground } from "@/components/OpulentoBackground";
import { qk } from "@/hooks/queries";

export function LoginPage() {
  const { login, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [shakeKey, setShakeKey] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const [clinicName, setClinicName] = useState("MiniPACS");
  const [clinicPhone, setClinicPhone] = useState("");
  const [clinicEmail, setClinicEmail] = useState("");
  const usernameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.get("/settings/public").then(({ data }) => {
      if (data.clinic_name) setClinicName(data.clinic_name);
      if (data.clinic_phone) setClinicPhone(data.clinic_phone);
      if (data.clinic_email) setClinicEmail(data.clinic_email);
    }).catch(() => {});
  }, []);

  if (isAuthenticated) return <Navigate to="/" replace />;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(username, password);
      // Warm the dashboard + first worklist page while the transition plays —
      // by the time the fade-out ends (~650ms) the queries are in cache, so
      // the dashboard mounts with data instead of skeletons.
      // Warm dashboard + worklist queries so the next page mounts with
      // data already in cache.
      Promise.allSettled([
        queryClient.prefetchQuery({
          queryKey: qk.dashboard(),
          queryFn: async () => (await api.get("/dashboard")).data,
        }),
        queryClient.prefetchQuery({
          queryKey: qk.studies({ limit: 25, offset: 0 }),
          queryFn: async () => (await api.get("/studies", { params: { limit: 25, offset: 0 } })).data,
        }),
      ]);
      setLeaving(true);
      // Trigger the App-level transition overlay (300ms fade-in, 250ms hold,
      // 300ms fade-out). Navigate at ~280ms — by then the cover is opaque,
      // so the route swap and Suspense fallback happen entirely under it.
      window.dispatchEvent(new CustomEvent("pacs:transition"));
      setTimeout(() => navigate("/"), 280);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { status?: number } };
      if (axiosErr?.response?.status === 429) {
        setError("Too many login attempts. Please try again later.");
      } else {
        setError("Invalid credentials");
      }
      setPassword("");
      setShakeKey((k) => k + 1);
      setLoading(false);
      requestAnimationFrame(() => usernameRef.current?.focus());
    }
  };

  const fieldBase =
    "w-full rounded-md bg-white/5 px-3 py-2.5 text-sm text-white placeholder-white/40 " +
    "border border-white/10 outline-none transition-all duration-200 " +
    "focus:border-white/30 focus:bg-white/10 focus:ring-4 focus:ring-white/5";

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden text-white">
      <OpulentoBackground />

      <AnimatePresence>
        {!leaving && (
          <motion.div
            key="login-card"
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 1.04, filter: "blur(12px)" }}
            transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
            className="relative z-10 w-full max-w-[420px] px-4"
          >
            <motion.div
              key={shakeKey}
              className={`relative rounded-2xl border border-white/10 bg-white/5 p-8 shadow-[0_20px_80px_-20px_rgba(0,0,0,0.8)] backdrop-blur-2xl ${
                error && shakeKey > 0 ? "opu-shake" : ""
              }`}
            >
              <div className="mb-7 text-center">
                <motion.h1
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.15, duration: 0.45 }}
                  className="text-2xl font-semibold tracking-tight"
                >
                  {clinicName}
                </motion.h1>
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.25, duration: 0.45 }}
                  className="mt-1 text-xs text-white/50"
                >
                  Clinical imaging portal
                </motion.p>
              </div>

              <form onSubmit={handleSubmit} className="space-y-4">
                {[
                  { label: "Username", id: "username", type: "text", value: username, set: setUsername, ref: usernameRef, auto: "username", delay: 0.30 },
                  { label: "Password", id: "password", type: "password", value: password, set: setPassword, ref: null, auto: "current-password", delay: 0.38 },
                ].map((f) => (
                  <motion.div
                    key={f.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: f.delay, duration: 0.4 }}
                    className="space-y-1.5"
                  >
                    <label htmlFor={f.id} className="text-xs font-medium uppercase tracking-wide text-white/60">
                      {f.label}
                    </label>
                    <input
                      id={f.id}
                      ref={f.ref as React.RefObject<HTMLInputElement> | undefined}
                      type={f.type}
                      value={f.value}
                      onChange={(e) => f.set(e.target.value)}
                      autoFocus={f.id === "username"}
                      autoComplete={f.auto}
                      disabled={loading || leaving}
                      className={fieldBase}
                    />
                  </motion.div>
                ))}

                <AnimatePresence>
                  {error && (
                    <motion.p
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      className="text-xs text-rose-300"
                    >
                      {error}
                    </motion.p>
                  )}
                </AnimatePresence>

                <motion.button
                  type="submit"
                  disabled={loading || leaving}
                  whileHover={{ scale: loading ? 1 : 1.01 }}
                  whileTap={{ scale: loading ? 1 : 0.98 }}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.46, duration: 0.4 }}
                  className="group relative w-full overflow-hidden rounded-md bg-white py-2.5 text-sm font-semibold text-black transition-colors hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span className="relative z-10 inline-flex items-center justify-center gap-2">
                    {loading ? (
                      <>
                        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
                          <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                        </svg>
                        Signing in…
                      </>
                    ) : leaving ? (
                      "Welcome back"
                    ) : (
                      "Sign in"
                    )}
                  </span>
                </motion.button>
              </form>

              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.55, duration: 0.4 }}
                className="mt-6 space-y-1 text-center text-[11px] leading-relaxed text-white/40"
              >
                <p>This system contains protected health information. Unauthorized access is prohibited.</p>
                {(clinicPhone || clinicEmail) && (
                  <p>
                    Need help?{" "}
                    {clinicPhone && <span>Call {clinicPhone}</span>}
                    {clinicPhone && clinicEmail && " · "}
                    {clinicEmail && (
                      <a href={`mailto:${clinicEmail}`} className="underline hover:text-white/70">
                        {clinicEmail}
                      </a>
                    )}
                  </p>
                )}
              </motion.div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
