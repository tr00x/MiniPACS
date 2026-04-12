# Task 10: Patients Pages Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace PatientsPage.tsx and PatientDetailPage.tsx stubs with full implementations that fetch data from Orthanc-proxied backend APIs.

**Architecture:** Two pages — a searchable patient list table and a patient detail view with studies table and shares section. Data flows from `GET /api/patients` (list) and `GET /api/patients/{id}` (detail) which proxy to Orthanc. Shares loaded from `GET /api/shares` and filtered client-side by patient ID. All fetches use AbortController for cleanup, typed interfaces, loading/error states.

**Tech Stack:** React 19, TypeScript, shadcn/ui (Table, Card, Input, Badge, Button), lucide-react icons, axios via `@/lib/api`

---

## Context for implementer

### Backend API responses

**`GET /api/patients`** — returns array of Orthanc patient objects:
```json
[{
  "ID": "orthanc-uuid",
  "MainDicomTags": {
    "PatientID": "MRN123",
    "PatientName": "DOE^JOHN",
    "PatientBirthDate": "19800115",
    "PatientSex": "M"
  },
  "Studies": ["study-uuid-1", "study-uuid-2"]
}]
```
Supports query params: `?search=`, `?limit=100`, `?offset=0`

**`GET /api/patients/{id}`** — returns `{ patient: {...}, studies: [...] }`:
- `patient` — same shape as list item
- `studies` — array of Orthanc study objects with `MainDicomTags`: StudyDate, StudyDescription, ModalitiesInStudy, AccessionNumber

**`GET /api/shares`** — returns array of share objects:
```json
[{
  "id": 1,
  "orthanc_patient_id": "orthanc-uuid",
  "token": "abc123...",
  "is_active": true,
  "view_count": 3,
  "created_at": "2026-04-10T10:00:00",
  "expires_at": "2026-04-17T10:00:00"
}]
```

### Existing patterns (from DashboardPage.tsx)

- Typed interfaces at top of file (e.g., `interface Transfer { ... }`)
- `useState` for data, loading, error
- `useEffect` with AbortController: `const ctrl = new AbortController(); api.get(url, { signal: ctrl.signal }); return () => ctrl.abort();`
- Error: `if (err instanceof Error && err.name !== "AbortError") setError(err.message)`
- Loading/error render: `if (loading) return <div>Loading...</div>; if (error) return <div>Error: {error}</div>;`
- Import api from `@/lib/api`
- shadcn/ui Card, Table components from `@/components/ui/`

### Existing files

- `frontend/src/pages/PatientsPage.tsx` — 3-line stub, replace entirely
- `frontend/src/pages/PatientDetailPage.tsx` — 3-line stub, replace entirely
- Routes already registered in `App.tsx`: `/patients` → PatientsPage, `/patients/:id` → PatientDetailPage

### shadcn/ui components available

Already installed (from Task 7/8): Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Card, CardContent, CardHeader, CardTitle, Input, Button, Badge

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `frontend/src/pages/PatientsPage.tsx` | Replace stub | Searchable patients table with debounced input |
| `frontend/src/pages/PatientDetailPage.tsx` | Replace stub | Patient info card + studies table + shares table |

No new files needed. Routes already wired.

---

### Task 1: PatientsPage.tsx

**Files:**
- Replace: `frontend/src/pages/PatientsPage.tsx`

- [ ] **Step 1: Write PatientsPage.tsx**

Replace the stub with:

```tsx
import { useEffect, useState, useRef } from "react";
import { Link } from "react-router-dom";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Search } from "lucide-react";
import api from "@/lib/api";

interface Patient {
  ID: string;
  MainDicomTags: {
    PatientID?: string;
    PatientName?: string;
    PatientBirthDate?: string;
    PatientSex?: string;
  };
  Studies?: string[];
}

export function PatientsPage() {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    const ctrl = new AbortController();

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(() => {
      setLoading(true);
      setError(null);
      api
        .get("/patients", {
          params: search ? { search } : {},
          signal: ctrl.signal,
        })
        .then(({ data }) => setPatients(data))
        .catch((err) => {
          if (err instanceof Error && err.name !== "AbortError") {
            setError(err.message);
          }
        })
        .finally(() => setLoading(false));
    }, 300);

    return () => {
      ctrl.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search]);

  const tag = (p: Patient, key: keyof Patient["MainDicomTags"]) =>
    p.MainDicomTags?.[key] || "";

  if (error) {
    return (
      <div className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight">Patients</h2>
        <p className="text-destructive">Error: {error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-semibold tracking-tight">Patients</h2>
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search by name or ID..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>
      {loading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Patient ID</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Birth Date</TableHead>
              <TableHead>Sex</TableHead>
              <TableHead>Studies</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {patients.map((p) => (
              <TableRow key={p.ID} className="cursor-pointer hover:bg-accent">
                <TableCell>
                  <Link to={`/patients/${p.ID}`} className="font-mono text-sm">
                    {tag(p, "PatientID")}
                  </Link>
                </TableCell>
                <TableCell>
                  <Link to={`/patients/${p.ID}`}>{tag(p, "PatientName")}</Link>
                </TableCell>
                <TableCell>{tag(p, "PatientBirthDate")}</TableCell>
                <TableCell>{tag(p, "PatientSex")}</TableCell>
                <TableCell>{p.Studies?.length || 0}</TableCell>
              </TableRow>
            ))}
            {patients.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  No patients found
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Verify dev build**

Run: `cd frontend && npx vite build`
Expected: Build succeeds

---

### Task 2: PatientDetailPage.tsx

**Files:**
- Replace: `frontend/src/pages/PatientDetailPage.tsx`

- [ ] **Step 1: Write PatientDetailPage.tsx**

Replace the stub with:

```tsx
import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Eye } from "lucide-react";
import api from "@/lib/api";

interface PatientData {
  MainDicomTags: {
    PatientID?: string;
    PatientName?: string;
    PatientBirthDate?: string;
    PatientSex?: string;
  };
}

interface Study {
  ID: string;
  MainDicomTags: {
    StudyDate?: string;
    StudyDescription?: string;
    ModalitiesInStudy?: string;
    AccessionNumber?: string;
  };
}

interface Share {
  id: number;
  orthanc_patient_id: string;
  token: string;
  is_active: boolean;
  view_count: number;
  created_at: string;
  expires_at: string | null;
}

export function PatientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [patient, setPatient] = useState<PatientData | null>(null);
  const [studies, setStudies] = useState<Study[]>([]);
  const [shares, setShares] = useState<Share[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);

    Promise.all([
      api.get(`/patients/${id}`, { signal: ctrl.signal }),
      api.get("/shares", { signal: ctrl.signal }),
    ])
      .then(([patientRes, sharesRes]) => {
        setPatient(patientRes.data.patient);
        setStudies(patientRes.data.studies);
        setShares(
          sharesRes.data.filter(
            (s: Share) => s.orthanc_patient_id === id
          )
        );
      })
      .catch((err) => {
        if (err instanceof Error && err.name !== "AbortError") {
          setError(err.message);
        }
      })
      .finally(() => setLoading(false));

    return () => ctrl.abort();
  }, [id]);

  const ptag = (key: keyof PatientData["MainDicomTags"]) =>
    patient?.MainDicomTags?.[key] || "";

  const stag = (s: Study, key: keyof Study["MainDicomTags"]) =>
    s.MainDicomTags?.[key] || "";

  if (loading) {
    return <p className="text-muted-foreground">Loading...</p>;
  }

  if (error) {
    return <p className="text-destructive">Error: {error}</p>;
  }

  if (!patient) {
    return <p className="text-muted-foreground">Patient not found</p>;
  }

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-semibold tracking-tight">
        {ptag("PatientName")}
      </h2>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Patient Information
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm md:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Patient ID</dt>
              <dd className="font-mono">{ptag("PatientID")}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Birth Date</dt>
              <dd>{ptag("PatientBirthDate")}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Sex</dt>
              <dd>{ptag("PatientSex")}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Total Studies</dt>
              <dd>{studies.length}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Studies</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Modality</TableHead>
                <TableHead>Accession</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {studies.map((s) => (
                <TableRow key={s.ID}>
                  <TableCell>{stag(s, "StudyDate")}</TableCell>
                  <TableCell>{stag(s, "StudyDescription")}</TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {stag(s, "ModalitiesInStudy") || "\u2014"}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {stag(s, "AccessionNumber")}
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" asChild>
                      <Link to={`/studies/${s.ID}`}>
                        <Eye className="h-4 w-4" />
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {studies.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="text-center text-muted-foreground"
                  >
                    No studies found
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Patient Shares</CardTitle>
        </CardHeader>
        <CardContent>
          {shares.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No shares for this patient
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Token</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Views</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Expires</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shares.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-mono text-xs">
                      {s.token.slice(0, 16)}...
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={s.is_active ? "default" : "secondary"}
                      >
                        {s.is_active ? "Active" : "Revoked"}
                      </Badge>
                    </TableCell>
                    <TableCell>{s.view_count}</TableCell>
                    <TableCell>{s.created_at}</TableCell>
                    <TableCell>{s.expires_at || "No expiry"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Verify production build**

Run: `cd frontend && npx vite build`
Expected: Build succeeds

---

### Task 3: Commit

- [ ] **Step 1: Stage and commit**

```bash
git add frontend/src/pages/PatientsPage.tsx frontend/src/pages/PatientDetailPage.tsx
git commit -m "feat: add patients list and patient detail pages"
```

---

## Verification Checklist

- [ ] TypeScript compiles with no errors (`npx tsc --noEmit`)
- [ ] Production build succeeds (`npx vite build`)
- [ ] `/patients` route renders table with search
- [ ] `/patients/:id` route renders patient detail with studies and shares
- [ ] Search debounces (300ms delay)
- [ ] AbortController cancels fetches on unmount
- [ ] Loading and error states display correctly
- [ ] No `any` types in component code
