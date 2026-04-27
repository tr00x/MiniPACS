import { useEffect, useRef, useState } from "react";
import api from "@/lib/api";
import type { ImportJobStatus } from "./useImportJob";

/** Polls /api/studies/import/active every 3 s while there are active jobs.
 *  Stops polling when the response is empty, restarts when called again
 *  (or when window regains focus). Cheap — endpoint is indexed. */
export function useActiveImports() {
  const [jobs, setJobs] = useState<ImportJobStatus[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const { data } = await api.get<{ jobs: ImportJobStatus[] }>("/studies/import/active");
        if (cancelled) return;
        setJobs(data.jobs);
        if (data.jobs.length > 0) {
          timerRef.current = setTimeout(tick, 3000);
        } else {
          // idle backoff — re-check in 30 s in case a new job started elsewhere
          timerRef.current = setTimeout(tick, 30000);
        }
      } catch {
        if (!cancelled) timerRef.current = setTimeout(tick, 10000);
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return jobs;
}
