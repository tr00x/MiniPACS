import { QueryClient } from "@tanstack/react-query";

// Single app-wide QueryClient.
// - staleTime 30s: most PACS data (worklist, patients, pacs-nodes, viewers,
//   settings) changes on the order of seconds-to-minutes, not milliseconds,
//   so 30s of "fresh without refetch" is safe and makes navigation instant.
// - gcTime 5min: keep inactive queries in memory so back-navigation is
//   served from cache without a network trip.
// - refetchOnWindowFocus off: the user tabbing back to the portal should
//   not trigger a storm of refetches; we have post-login warmup + explicit
//   invalidations on mutations for freshness.
// - retry 1: a single retry covers transient Orthanc hiccups without
//   multiplying the client load during an actual outage.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
      // networkMode left at the default "online". Previously set to
      // "offlineFirst" hoping to survive 502s gracefully, but in practice it
      // caused useQuery hooks to never fire on a cold mount inside headless
      // chromium (and likely some real browsers too) — the app rendered but
      // no /api/studies / /api/patients request was ever sent. The backend
      // stale-while-error layer already covers the "Orthanc hiccup" case.
    },
    mutations: {
      retry: 0,
    },
  },
});
