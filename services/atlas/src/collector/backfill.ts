// One-off history import, run once when the findings table is empty.
//
// Prometheus keeps 60 days of the trivy:vulnerability:present recording rule
// (kubernetes/platform/observability/monitoring/prometheusrule-trivy.yaml),
// one series per image + CVE + package + severity + fixed version. For each
// finding this recovers when it was first and last seen and when a fixed
// version first appeared. Limits, recorded on every backfilled event:
//   - Only what the rule kept: anything with a fix, plus High/Critical with
//     no fix (unfixed Medium/Low/Unknown are dropped at scrape time).
//   - Hourly resolution, no titles or scores (the next collector run fills
//     those in for findings that still exist), no workloads, and no "fix
//     within our control" history.
//   - Before 2026-11-21 the rule still counted old rollout revisions, so some
//     first/last times run up to a day long.
import type { DB } from "./apply.ts";
import { findingEvents, findings } from "../db/schema.ts";
import { findingKey } from "./snapshot.ts";
import { query, type Sample } from "./prom.ts";

const RULE = "trivy:vulnerability:present";
const WINDOW = "60d";
const STEP = "1h";

interface Hist {
  imageRegistry: string;
  imageRepository: string;
  vulnId: string;
  pkgName: string;
  severity: string;
  fixedVersion: string;
  firstSeen: number;
  lastSeen: number;
  fixAvailable: number | null;
}

export function mergeHistory(first: Sample[], last: Sample[]): Map<string, Hist> {
  const id = (m: Record<string, string>) =>
    [m.image_registry, m.image_repository, m.vuln_id, m.resource, m.severity, m.fixed_version].join("|");
  const lastBySeries = new Map(last.map((s) => [id(s.metric), Number(s.value[1])]));
  const out = new Map<string, Hist>();
  for (const s of first) {
    const m = s.metric;
    const key = findingKey(m.image_registry ?? "", m.image_repository ?? "", m.vuln_id ?? "", m.resource ?? "");
    const f = Number(s.value[1]);
    const l = lastBySeries.get(id(m)) ?? f;
    const fixed = m.fixed_version ?? "";
    const h = out.get(key);
    if (!h) {
      out.set(key, {
        imageRegistry: m.image_registry ?? "",
        imageRepository: m.image_repository ?? "",
        vulnId: m.vuln_id ?? "",
        pkgName: m.resource ?? "",
        severity: (m.severity ?? "UNKNOWN").toUpperCase(),
        fixedVersion: fixed,
        firstSeen: f,
        lastSeen: l,
        fixAvailable: fixed ? f : null,
      });
      continue;
    }
    if (l > h.lastSeen) {
      // The most recent series carries the current severity and fix.
      h.lastSeen = l;
      h.severity = (m.severity ?? h.severity).toUpperCase();
      h.fixedVersion = fixed;
    }
    h.firstSeen = Math.min(h.firstSeen, f);
    if (fixed) h.fixAvailable = h.fixAvailable === null ? f : Math.min(h.fixAvailable, f);
  }
  return out;
}

export async function backfillFromPrometheus(db: DB, now: Date): Promise<{ findings: number; resolved: number }> {
  const [first, last] = await Promise.all([
    query(`min_over_time(timestamp(${RULE})[${WINDOW}:${STEP}])`),
    query(`max_over_time(timestamp(${RULE})[${WINDOW}:${STEP}])`),
  ]);
  return applyHistory(db, mergeHistory(first, last), now);
}

export async function applyHistory(db: DB, hist: Map<string, Hist>, now: Date) {
  const d = (s: number) => new Date(s * 1000);
  // Not seen in the last two hours (the rule runs every 2 min): gone.
  const stale = now.getTime() / 1000 - 2 * 3600;
  const rows = [...hist.values()];
  let resolved = 0;
  await db.transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += 500) {
      const part = rows.slice(i, i + 500);
      const inserted = await tx
        .insert(findings)
        .values(
          part.map((h) => {
            const gone = h.lastSeen < stale;
            return {
              imageRegistry: h.imageRegistry,
              imageRepository: h.imageRepository,
              vulnId: h.vulnId,
              pkgName: h.pkgName,
              severity: h.severity,
              fixedVersion: h.fixedVersion,
              status: gone ? "resolved" : "open",
              resolution: gone ? "unknown" : null,
              firstSeenAt: d(h.firstSeen),
              lastSeenAt: d(h.lastSeen),
              fixAvailableAt: h.fixAvailable === null ? null : d(h.fixAvailable),
              resolvedAt: gone ? d(h.lastSeen) : null,
            };
          }),
        )
        .onConflictDoNothing()
        .returning({ id: findings.id, imageRegistry: findings.imageRegistry, imageRepository: findings.imageRepository, vulnId: findings.vulnId, pkgName: findings.pkgName });
      const events: (typeof findingEvents.$inferInsert)[] = [];
      for (const r of inserted) {
        const h = hist.get(findingKey(r.imageRegistry, r.imageRepository, r.vulnId, r.pkgName))!;
        const details = { source: "backfill", precision: "1h" };
        events.push({ findingId: r.id, type: "first_seen", at: d(h.firstSeen), details: { ...details, severity: h.severity } });
        if (h.fixAvailable !== null) {
          events.push({ findingId: r.id, type: "fix_available", at: d(h.fixAvailable), details: { ...details, fixedVersion: h.fixedVersion } });
        }
        if (h.lastSeen < stale) {
          events.push({ findingId: r.id, type: "resolved", at: d(h.lastSeen), details: { ...details, resolution: "unknown" } });
          resolved++;
        }
      }
      if (events.length) await tx.insert(findingEvents).values(events);
    }
  });
  return { findings: rows.length, resolved };
}
