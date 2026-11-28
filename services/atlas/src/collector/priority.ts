// Ranking findings by real risk, not CVSS severity alone (decided 2026-11-28,
// docs/projects/atlas.md). Starting defaults, to tune:
//
//   P1  Known exploited (CISA KEV).
//   P2  Likely exploited soon (EPSS >= 10%), or Critical/High on an
//       internet-reachable workload.
//   P3  Critical/High that is either somewhat likely (EPSS >= 1%) or
//       LAN-reachable.
//   P4  Everything else.
//
// SLA (remediation clock): Critical 7, High 30, Medium 90, Low 180 days; a
// KEV finding gets at most KEV_SLA_DAYS whatever its severity.
//
// Pure, so the UI/API and the collector's metrics use the same rule.
import { sql } from "drizzle-orm";
import type { DB } from "./apply.ts";

export type Priority = "P1" | "P2" | "P3" | "P4";
export type Exposure = "internet" | "lan" | "internal";

export const EPSS_HIGH = 0.1;
export const EPSS_MEDIUM = 0.01;
export const KEV_SLA_DAYS = 7;
export const SLA_DAYS: Record<string, number> = { CRITICAL: 7, HIGH: 30, MEDIUM: 90, LOW: 180, UNKNOWN: 180 };

export interface RiskInput {
  severity: string;
  kev: boolean;
  /** null = no EPSS score (not a CVE, or too new to be scored). */
  epss: number | null;
  exposure: Exposure;
}

export function priorityOf(f: RiskInput): Priority {
  const severe = f.severity === "CRITICAL" || f.severity === "HIGH";
  const epss = f.epss ?? 0;
  if (f.kev) return "P1";
  if (epss >= EPSS_HIGH || (severe && f.exposure === "internet")) return "P2";
  if (severe && (epss >= EPSS_MEDIUM || f.exposure === "lan")) return "P3";
  return "P4";
}

export function slaDays(severity: string, kev: boolean): number {
  const base = SLA_DAYS[severity] ?? SLA_DAYS.UNKNOWN!;
  return kev ? Math.min(base, KEV_SLA_DAYS) : base;
}

export interface PriorityCount {
  priority: Priority;
  severity: string;
  exposure: Exposure;
  kev: boolean;
  n: number;
}

const EXPOSURE_BY_RANK: Exposure[] = ["internal", "lan", "internet"];

/**
 * Open findings counted by priority, severity, exposure and KEV. A finding's
 * exposure is the most exposed workload it's actively seen on.
 */
export async function openByPriority(db: DB): Promise<PriorityCount[]> {
  const res = await db.execute(sql`
    select f.severity,
           coalesce(vi.kev, false) as kev,
           vi.epss,
           coalesce(max(case we.exposure when 'internet' then 2 when 'lan' then 1 end), 0) as exposure_rank
    from findings f
    left join vuln_intel vi on vi.vuln_id = f.vuln_id
    left join finding_sightings s on s.finding_id = f.id and s.active
    left join workload_exposure we
      on we.active and we.namespace = s.namespace and we.workload_kind = s.workload_kind and we.workload_name = s.workload_name
    where f.status = 'open'
    group by f.id, f.severity, vi.kev, vi.epss
  `);
  // node-postgres returns { rows }, PGlite returns { rows } too.
  const rows = (res as unknown as { rows: { severity: string; kev: boolean; epss: number | null; exposure_rank: number | string }[] }).rows;
  const counts = new Map<string, PriorityCount>();
  for (const r of rows) {
    const exposure = EXPOSURE_BY_RANK[Number(r.exposure_rank)] ?? "internal";
    const kev = !!r.kev;
    const priority = priorityOf({ severity: r.severity, kev, epss: r.epss === null ? null : Number(r.epss), exposure });
    const key = `${priority}|${r.severity}|${exposure}|${kev}`;
    const c = counts.get(key);
    if (c) c.n++;
    else counts.set(key, { priority, severity: r.severity, exposure, kev, n: 1 });
  }
  return [...counts.values()];
}
