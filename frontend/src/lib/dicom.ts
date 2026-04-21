/**
 * Shared DICOM utility functions used across the portal.
 */

/** Convert DICOM name "DOE^JOHN" → "John Doe". Handles empty/null and single-part names. */
export function formatDicomName(raw: string): string {
  if (!raw) return "Unknown";
  const parts = raw.split("^");
  const last = parts[0] || "";
  const first = parts[1] || "";
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  if (first && last) return `${cap(first)} ${cap(last)}`;
  return cap(last || first);
}

/** Convert 8-digit DICOM date "20260411" → "Apr 11, 2026". Returns "—" for invalid/empty. */
export function formatDicomDate(raw: string): string {
  if (!raw || raw.length !== 8) return raw || "—";
  const y = raw.slice(0, 4);
  const m = parseInt(raw.slice(4, 6), 10) - 1;
  const d = parseInt(raw.slice(6, 8), 10);
  return new Date(parseInt(y), m, d).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Convert ISO timestamp string → "Apr 11, 2026, 9:30 PM". Returns "—" for null. */
export function formatTimestamp(raw: string | null): string {
  if (!raw) return "—";
  const d = new Date(raw);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Calculate age from DICOM 8-digit birth date → "41 yrs". Returns "" if invalid. */
export function calculateAge(birthDate: string): string {
  if (!birthDate || birthDate.length !== 8) return "";
  const y = parseInt(birthDate.slice(0, 4));
  const m = parseInt(birthDate.slice(4, 6)) - 1;
  const d = parseInt(birthDate.slice(6, 8));
  const birth = new Date(y, m, d);
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  if (
    now.getMonth() < birth.getMonth() ||
    (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate())
  ) {
    age--;
  }
  return `${age} yrs`;
}

/** Get initials from DICOM name "DOE^JOHN" → "JD". Returns "?" if empty. */
export function getInitials(name: string): string {
  const parts = name.split("^");
  const last = parts[0]?.[0] || "";
  const first = parts[1]?.[0] || "";
  return (first + last).toUpperCase() || "?";
}

/** Deterministic avatar color from DICOM name — one of 8 tailwind bg classes. */
export function getAvatarColor(name: string): string {
  const colors = [
    "bg-blue-500",
    "bg-emerald-500",
    "bg-violet-500",
    "bg-amber-500",
    "bg-rose-500",
    "bg-cyan-500",
    "bg-pink-500",
    "bg-indigo-500",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

/** Tailwind class string for a DICOM modality badge. Returns "" for unknown modalities. */
export function getModalityColor(modality: string): string {
  const map: Record<string, string> = {
    CT: "bg-blue-500/10 text-blue-700 border-blue-200",
    MR: "bg-violet-500/10 text-violet-700 border-violet-200",
    CR: "bg-amber-500/10 text-amber-700 border-amber-200",
    DX: "bg-amber-500/10 text-amber-700 border-amber-200",
    US: "bg-emerald-500/10 text-emerald-700 border-emerald-200",
    NM: "bg-rose-500/10 text-rose-700 border-rose-200",
    PT: "bg-pink-500/10 text-pink-700 border-pink-200",
    XA: "bg-cyan-500/10 text-cyan-700 border-cyan-200",
  };
  return map[modality] ?? "";
}

/** Icon map for known external DICOM viewers. Keyed by icon_key from the database. */
/** Favicon URLs via Google proxy (avoids CORS) — size 64 for crisp display */
export const VIEWER_LOGOS: Record<string, string> = {
  ohif: "https://www.google.com/s2/favicons?domain=ohif.org&sz=64",
  stone: "https://www.google.com/s2/favicons?domain=orthanc-server.com&sz=64",
  osirix: "https://www.google.com/s2/favicons?domain=osirix-viewer.com&sz=64",
  horos: "https://www.google.com/s2/favicons?domain=horosproject.org&sz=64",
  radiant: "https://www.google.com/s2/favicons?domain=radiantviewer.com&sz=64",
  slicer: "https://www.google.com/s2/favicons?domain=slicer.org&sz=64",
  microdicom: "https://www.google.com/s2/favicons?domain=microdicom.com&sz=64",
  postdicom: "https://www.google.com/s2/favicons?domain=postdicom.com&sz=64",
  meddream: "https://www.google.com/s2/favicons?domain=softneta.com&sz=64",
};

/** Determine share link status from is_active flag and expires_at timestamp. */
export const EXPIRY_PRESETS = [
  { label: "7 days", days: 7 },
  { label: "14 days", days: 14 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "No expiry", days: 0 },
];

export function getShareStatus(share: {
  is_active: boolean | number;
  expires_at: string | null;
}): { label: string; variant: "default" | "secondary" | "destructive" } {
  if (!share.is_active) return { label: "Revoked", variant: "secondary" };
  if (share.expires_at && new Date(share.expires_at) < new Date()) {
    return { label: "Expired", variant: "destructive" };
  }
  return { label: "Active", variant: "default" };
}
