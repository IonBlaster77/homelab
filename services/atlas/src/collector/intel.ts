// Threat intelligence for ranking findings (priority.ts):
//   - CISA KEV: CVEs confirmed exploited in the wild (~1,800, JSON, ~1.5 MB).
//   - FIRST EPSS: probability each CVE is exploited in the next 30 days
//     (~300k rows, gzipped CSV, ~3 MB, published daily).
// Both are public and need no key. Only the IDs Atlas has findings for are
// stored (vuln_intel). Each feed fails on its own: if one download fails, the
// other's values are still written and the failed one's previous values kept.
//
// Egress: the collector's CiliumNetworkPolicy allows exactly these hosts.
import { gunzipSync } from "node:zlib";
import { inArray, sql } from "drizzle-orm";
import { findingEvents, findings, vulnIntel } from "../db/schema.ts";
import type { DB } from "./apply.ts";

export const KEV_URL =
  process.env.KEV_URL ?? "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
export const EPSS_URL = process.env.EPSS_URL ?? "https://epss.empiricalsecurity.com/epss_scores-current.csv.gz";

/** Sanity floors: a truncated or wrong download must not wipe good data. */
const KEV_MIN = 1000;
const EPSS_MIN = 100_000;

export interface KevEntry {
  addedAt: Date | null;
  dueAt: Date | null;
  ransomware: boolean;
  name: string;
}

export interface EpssData {
  date: Date | null;
  scores: Map<string, { epss: number; percentile: number }>;
  /** Rows in the whole file (before keeping only wanted IDs), for the sanity check. */
  total: number;
}

const day = (s: unknown) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s) ? new Date(`${s.slice(0, 10)}T00:00:00Z`) : null);

/** CISA's known_exploited_vulnerabilities.json -> CVE ID -> entry. Throws if it doesn't look like the catalog. */
export function parseKev(json: unknown, min = KEV_MIN): Map<string, KevEntry> {
  const vulns = (json as { vulnerabilities?: unknown })?.vulnerabilities;
  if (!Array.isArray(vulns)) throw new Error("KEV: no vulnerabilities array");
  const out = new Map<string, KevEntry>();
  for (const v of vulns as Record<string, unknown>[]) {
    const id = v.cveID;
    if (typeof id !== "string" || !id.startsWith("CVE-")) continue;
    out.set(id, {
      addedAt: day(v.dateAdded),
      dueAt: day(v.dueDate),
      ransomware: v.knownRansomwareCampaignUse === "Known",
      name: typeof v.vulnerabilityName === "string" ? v.vulnerabilityName : "",
    });
  }
  if (out.size < min) throw new Error(`KEV: only ${out.size} entries, expected at least ${min}`);
  return out;
}

/**
 * EPSS CSV: a comment line `#model_version:...,score_date:2026-11-27T...`,
 * then `cve,epss,percentile`, then one row per CVE. Keeps only `wanted` IDs.
 */
export function parseEpss(csv: string, wanted: Set<string>, min = EPSS_MIN): EpssData {
  const scores = new Map<string, { epss: number; percentile: number }>();
  let date: Date | null = null;
  let total = 0;
  let start = 0;
  while (start < csv.length) {
    let end = csv.indexOf("\n", start);
    if (end === -1) end = csv.length;
    const line = csv.slice(start, end).trim();
    start = end + 1;
    if (!line) continue;
    if (line.startsWith("#")) {
      const m = /score_date:(\d{4}-\d{2}-\d{2})/.exec(line);
      if (m) date = day(m[1]);
      continue;
    }
    if (line.startsWith("cve,")) continue;
    total++;
    const c1 = line.indexOf(",");
    const id = line.slice(0, c1);
    if (!wanted.has(id)) continue;
    const c2 = line.indexOf(",", c1 + 1);
    const epss = Number(line.slice(c1 + 1, c2));
    const percentile = Number(line.slice(c2 + 1));
    if (Number.isFinite(epss) && Number.isFinite(percentile)) scores.set(id, { epss, percentile });
  }
  if (total < min) throw new Error(`EPSS: only ${total} rows, expected at least ${min}`);
  return { date, scores, total };
}

async function get(url: string): Promise<Response> {
  const res = await fetch(url, { signal: AbortSignal.timeout(90_000), headers: { "User-Agent": "atlas-collector" } });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res;
}

export const fetchKev = async () => parseKev(await (await get(KEV_URL)).json());

export async function fetchEpss(wanted: Set<string>): Promise<EpssData> {
  const buf = Buffer.from(await (await get(EPSS_URL)).arrayBuffer());
  // fetch() doesn't decompress a .gz file served as binary/octet-stream.
  const text = (buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf).toString("utf8");
  return parseEpss(text, wanted);
}

export interface IntelStats {
  ids: number;
  kevOk: boolean;
  epssOk: boolean;
  kevMatched: number;
  epssMatched: number;
  kevListedEvents: number;
  errors: string[];
}

/** Distinct CVE IDs across all findings (open and resolved, so history can be ranked too). */
export async function wantedIds(db: DB): Promise<Set<string>> {
  const rows = await db.selectDistinct({ id: findings.vulnId }).from(findings);
  return new Set(rows.map((r) => r.id).filter((id) => id.startsWith("CVE-")));
}

const chunk = <T>(xs: T[], n = 2000): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/**
 * Writes intel for `ids`. `kev` / `epss` undefined = that feed failed this
 * time: keep its previous values. A CVE newly in KEV gets a kev_listed event
 * on each of its open findings (baseline: true on the very first intel run,
 * so the starting backlog isn't counted as "newly exploited").
 */
export async function applyIntel(
  db: DB,
  ids: Set<string>,
  kev: Map<string, KevEntry> | undefined,
  epss: EpssData | undefined,
  now: Date,
): Promise<Omit<IntelStats, "errors" | "kevOk" | "epssOk">> {
  const stats = { ids: ids.size, kevMatched: 0, epssMatched: 0, kevListedEvents: 0 };
  await db.transaction(async (tx) => {
    const prevRows = await tx.select().from(vulnIntel);
    const prev = new Map(prevRows.map((r) => [r.vulnId, r]));
    const baseline = prevRows.length === 0;
    const newlyKev: string[] = [];
    const rows: (typeof vulnIntel.$inferInsert)[] = [];

    for (const id of ids) {
      const p = prev.get(id);
      const row: typeof vulnIntel.$inferInsert = {
        vulnId: id,
        kev: p?.kev ?? false,
        kevAddedAt: p?.kevAddedAt ?? null,
        kevDueAt: p?.kevDueAt ?? null,
        kevRansomware: p?.kevRansomware ?? false,
        kevName: p?.kevName ?? null,
        epss: p?.epss ?? null,
        epssPercentile: p?.epssPercentile ?? null,
        epssDate: p?.epssDate ?? null,
        updatedAt: now,
      };
      if (kev) {
        const k = kev.get(id);
        // CISA does occasionally remove entries; follow the catalog.
        row.kev = !!k;
        row.kevAddedAt = k?.addedAt ?? null;
        row.kevDueAt = k?.dueAt ?? null;
        row.kevRansomware = k?.ransomware ?? false;
        row.kevName = k?.name ?? null;
        if (k && !p?.kev) newlyKev.push(id);
      }
      if (epss) {
        const s = epss.scores.get(id);
        row.epss = s?.epss ?? null;
        row.epssPercentile = s?.percentile ?? null;
        row.epssDate = s ? epss.date : null;
      }
      if (row.kev) stats.kevMatched++;
      if (row.epss !== null && row.epss !== undefined) stats.epssMatched++;
      rows.push(row);
    }

    for (const part of chunk(rows)) {
      await tx
        .insert(vulnIntel)
        .values(part)
        .onConflictDoUpdate({
          target: vulnIntel.vulnId,
          set: {
            kev: sql`excluded.kev`,
            kevAddedAt: sql`excluded.kev_added_at`,
            kevDueAt: sql`excluded.kev_due_at`,
            kevRansomware: sql`excluded.kev_ransomware`,
            kevName: sql`excluded.kev_name`,
            epss: sql`excluded.epss`,
            epssPercentile: sql`excluded.epss_percentile`,
            epssDate: sql`excluded.epss_date`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }

    for (const part of chunk(newlyKev, 500)) {
      const open = await tx
        .select({ id: findings.id, vulnId: findings.vulnId })
        .from(findings)
        .where(sql`${findings.status} = 'open' and ${inArray(findings.vulnId, part)}`);
      if (open.length === 0) continue;
      await tx.insert(findingEvents).values(
        open.map((f) => ({
          findingId: f.id,
          type: "kev_listed",
          at: now,
          details: { source: "intel", kevAddedAt: kev?.get(f.vulnId)?.addedAt?.toISOString() ?? null, baseline },
        })),
      );
      stats.kevListedEvents += open.length;
    }
  });
  return stats;
}

/** Fetch both feeds (each may fail alone) and write them. Throws only if both fail. */
export async function refreshIntel(db: DB, now: Date): Promise<IntelStats> {
  const ids = await wantedIds(db);
  const errors: string[] = [];
  const [kev, epss] = await Promise.all([
    fetchKev().catch((e: unknown) => void errors.push(`kev: ${String(e)}`)),
    fetchEpss(ids).catch((e: unknown) => void errors.push(`epss: ${String(e)}`)),
  ]);
  if (!kev && !epss) throw new Error(errors.join("; "));
  const stats = await applyIntel(db, ids, kev ?? undefined, epss ?? undefined, now);
  return { ...stats, kevOk: !!kev, epssOk: !!epss, errors };
}

/** When intel was last written (null if never), so a restart doesn't refetch straight away. */
export async function lastIntelAt(db: DB): Promise<Date | null> {
  const [r] = await db.select({ at: sql<Date | null>`max(${vulnIntel.updatedAt})` }).from(vulnIntel);
  return r?.at ? new Date(r.at) : null;
}
