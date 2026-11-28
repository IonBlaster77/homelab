// Types and fetchers for the API (src/api/main.ts). Read-only.
export type Priority = "P1" | "P2" | "P3" | "P4";
export type Exposure = "internet" | "lan" | "internal";
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

export interface FindingRow {
  id: number;
  vulnId: string;
  severity: Severity;
  score: number | null;
  pkgName: string;
  image: string;
  fixedVersion: string;
  kev: boolean;
  epss: number | null;
  exposure: Exposure;
  workloads: string[];
  priority: Priority;
  dueAt: string | null;
  overdueDays: number | null;
  ageDays: number;
  inControl: boolean;
}

export interface Summary {
  total: number;
  byPriority: Partial<Record<Priority, number>>;
  bySeverity: Partial<Record<Severity, number>>;
  byExposure: Partial<Record<Exposure, number>>;
  kev: number;
  kevRansomware: number;
  fixable: number;
  inControl: number;
  overdue: number;
  dueSoon: number;
  imagesWithP1P2: number;
  policy: { category: string; open: number; resolved7d: number }[];
  freshness: { collector: string | null; intel: string | null; exposure: string | null };
}

export interface TrendPoint {
  day: string;
  open: Partial<Record<Severity, number>>;
  created: number;
  resolved: number;
}

export interface FindingDetail {
  finding: Record<string, unknown> & {
    id: number;
    vuln_id: string;
    severity: Severity;
    title: string | null;
    score: number | null;
    pkg_name: string;
    pkg_type: string | null;
    image_registry: string;
    image_repository: string;
    fixed_version: string;
    primary_link: string | null;
    links: string[] | null;
    published_at: string | null;
    first_seen_at: string;
    fix_available_at: string | null;
    fix_in_control_at: string | null;
    kev: boolean | null;
    kev_added_at: string | null;
    kev_due_at: string | null;
    kev_ransomware: boolean | null;
    kev_name: string | null;
    epss: number | null;
    epss_percentile: number | null;
    epss_date: string | null;
  };
  sightings: {
    namespace: string;
    workload_kind: string;
    workload_name: string;
    container: string;
    image_tag: string;
    image_digest: string;
    installed_version: string | null;
    first_seen_at: string;
    last_seen_at: string;
    active: boolean;
  }[];
  events: { type: string; at: string; details: Record<string, unknown> | null }[];
  exposure: { namespace: string; workload_kind: string; workload_name: string; exposure: Exposure; hosts: string[]; via: string[] }[];
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  summary: () => get<Summary>("/api/security/summary"),
  findings: () => get<FindingRow[]>("/api/security/findings"),
  trend: (days: number) => get<{ points: TrendPoint[]; liveSince: string | null }>(`/api/security/trend?days=${days}`),
  finding: (id: number) => get<FindingDetail>(`/api/security/findings/${id}`),
};
