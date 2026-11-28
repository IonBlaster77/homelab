// Security tab queries. Read-only: SELECTs only, over a connection that is
// read-only at the session level as well (db.ts).
import type { Pool } from "pg";
import { priorityOf, slaDays, type Exposure, type Priority } from "../collector/priority.ts";

const EXPOSURE_BY_RANK: Exposure[] = ["internal", "lan", "internet"];
const DAY = 86_400_000;

export interface OpenFinding {
  id: number;
  vulnId: string;
  severity: string;
  score: number | null;
  title: string | null;
  pkgName: string;
  pkgType: string | null;
  image: string;
  fixedVersion: string;
  firstSeenAt: string;
  fixAvailableAt: string | null;
  fixInControlAt: string | null;
  kev: boolean;
  kevAddedAt: string | null;
  kevRansomware: boolean;
  epss: number | null;
  epssPercentile: number | null;
  exposure: Exposure;
  /** namespace/Kind/name of active sightings. */
  workloads: string[];
  priority: Priority;
  slaDays: number;
  /** Remediation clock: fix in control + SLA. Null while the fix isn't in our control. */
  dueAt: string | null;
  /** Days past due (positive) or left (negative); null without a due date. */
  overdueDays: number | null;
  /** Exposure clock: days since first seen. */
  ageDays: number;
}

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

export async function openFindings(pool: Pool, now = new Date()): Promise<OpenFinding[]> {
  const { rows } = await pool.query(`
    select f.id, f.vuln_id, f.severity, f.score, f.title, f.pkg_name, f.pkg_type,
           f.image_registry || '/' || f.image_repository as image,
           f.fixed_version, f.first_seen_at, f.fix_available_at, f.fix_in_control_at,
           coalesce(vi.kev, false) as kev, vi.kev_added_at, coalesce(vi.kev_ransomware, false) as kev_ransomware,
           vi.epss, vi.epss_percentile,
           coalesce(max(case we.exposure when 'internet' then 2 when 'lan' then 1 end), 0) as exposure_rank,
           coalesce(array_agg(distinct s.namespace || '/' || s.workload_kind || '/' || s.workload_name)
                    filter (where s.id is not null), '{}') as workloads
    from findings f
    left join vuln_intel vi on vi.vuln_id = f.vuln_id
    left join finding_sightings s on s.finding_id = f.id and s.active
    left join workload_exposure we
      on we.active and we.namespace = s.namespace and we.workload_kind = s.workload_kind and we.workload_name = s.workload_name
    where f.status = 'open'
    group by f.id, vi.vuln_id
  `);
  return rows.map((r) => {
    const exposure = EXPOSURE_BY_RANK[Number(r.exposure_rank)] ?? "internal";
    const epss = r.epss === null ? null : Number(r.epss);
    const sla = slaDays(r.severity, r.kev);
    const due = r.fix_in_control_at ? new Date(new Date(r.fix_in_control_at).getTime() + sla * DAY) : null;
    return {
      id: Number(r.id),
      vulnId: r.vuln_id,
      severity: r.severity,
      score: r.score === null ? null : Number(r.score),
      title: r.title,
      pkgName: r.pkg_name,
      pkgType: r.pkg_type,
      image: r.image,
      fixedVersion: r.fixed_version,
      firstSeenAt: iso(r.first_seen_at)!,
      fixAvailableAt: iso(r.fix_available_at),
      fixInControlAt: iso(r.fix_in_control_at),
      kev: r.kev,
      kevAddedAt: iso(r.kev_added_at),
      kevRansomware: r.kev_ransomware,
      epss,
      epssPercentile: r.epss_percentile === null ? null : Number(r.epss_percentile),
      exposure,
      workloads: (r.workloads as string[]).sort(),
      priority: priorityOf({ severity: r.severity, kev: r.kev, epss, exposure }),
      slaDays: sla,
      dueAt: iso(due),
      overdueDays: due ? Math.floor((now.getTime() - due.getTime()) / DAY) : null,
      ageDays: Math.floor((now.getTime() - new Date(r.first_seen_at).getTime()) / DAY),
    };
  });
}

export interface TrendPoint {
  day: string;
  open: Record<string, number>;
  created: number;
  resolved: number;
}

/** Open findings by severity at the end of each day, plus new and resolved per day. */
export async function trend(pool: Pool, days: number): Promise<TrendPoint[]> {
  const { rows } = await pool.query(
    `
    with d as (
      select generate_series(date_trunc('day', now()) - ($1::int - 1) * interval '1 day', date_trunc('day', now()), interval '1 day') as day
    )
    select d.day,
           f.severity,
           count(*) filter (where f.first_seen_at < d.day + interval '1 day' and (f.resolved_at is null or f.resolved_at >= d.day + interval '1 day')) as open,
           count(*) filter (where f.first_seen_at >= d.day and f.first_seen_at < d.day + interval '1 day') as created,
           count(*) filter (where f.resolved_at >= d.day and f.resolved_at < d.day + interval '1 day') as resolved
    from d cross join findings f
    group by d.day, f.severity
    order by d.day
  `,
    [days],
  );
  const byDay = new Map<string, TrendPoint>();
  for (const r of rows) {
    const day = new Date(r.day).toISOString().slice(0, 10);
    let p = byDay.get(day);
    if (!p) byDay.set(day, (p = { day, open: {}, created: 0, resolved: 0 }));
    p.open[r.severity] = Number(r.open);
    p.created += Number(r.created);
    p.resolved += Number(r.resolved);
  }
  return [...byDay.values()];
}

/**
 * When the collector's first good run happened: history before it was
 * backfilled from Prometheus, which never had unfixed Medium/Low/Unknown
 * findings (dropped at scrape time), so earlier days undercount those.
 */
export async function liveSince(pool: Pool): Promise<string | null> {
  const { rows } = await pool.query(`select min(started_at) as at from collector_runs where ok and kind = 'collect'`);
  return iso(rows[0]?.at ?? null);
}

export async function findingDetail(pool: Pool, id: number) {
  const [f, sightings, events, exposure] = await Promise.all([
    pool.query(
      `select f.*, vi.kev, vi.kev_added_at, vi.kev_due_at, vi.kev_ransomware, vi.kev_name, vi.epss, vi.epss_percentile, vi.epss_date
       from findings f left join vuln_intel vi on vi.vuln_id = f.vuln_id where f.id = $1`,
      [id],
    ),
    pool.query(
      `select namespace, workload_kind, workload_name, container, image_tag, image_digest, installed_version,
              first_seen_at, last_seen_at, active
       from finding_sightings where finding_id = $1 order by active desc, last_seen_at desc limit 200`,
      [id],
    ),
    pool.query(`select type, at, details from finding_events where finding_id = $1 order by at, id limit 200`, [id]),
    pool.query(
      `select we.namespace, we.workload_kind, we.workload_name, we.exposure, we.hosts, we.via
       from workload_exposure we
       join finding_sightings s on s.active and s.finding_id = $1
         and s.namespace = we.namespace and s.workload_kind = we.workload_kind and s.workload_name = we.workload_name
       where we.active`,
      [id],
    ),
  ]);
  if (f.rows.length === 0) return null;
  return { finding: f.rows[0], sightings: sightings.rows, events: events.rows, exposure: exposure.rows };
}

/** Small policy-violation summary for the Security tab's compliance card. */
export async function policySummary(pool: Pool) {
  const { rows } = await pool.query(`
    select category, count(*) filter (where status = 'open') as open,
           count(*) filter (where status = 'resolved' and resolved_at > now() - interval '7 days') as resolved_7d
    from policy_violations group by category order by 2 desc
  `);
  return rows.map((r) => ({ category: r.category || "Other", open: Number(r.open), resolved7d: Number(r.resolved_7d) }));
}

export async function freshness(pool: Pool) {
  const { rows } = await pool.query(`
    select (select max(finished_at) from collector_runs where ok) as collector,
           (select max(updated_at) from vuln_intel) as intel,
           (select max(last_seen_at) from workload_exposure where active) as exposure
  `);
  return { collector: iso(rows[0].collector), intel: iso(rows[0].intel), exposure: iso(rows[0].exposure) };
}
