// Writes a policy snapshot into the database: new violations, re-openings and
// resolutions, each as an event (the same lifecycle as vulnerability
// findings in apply.ts). One transaction, so a failed run changes nothing.
import { inArray } from "drizzle-orm";
import { policyViolationEvents, policyViolations } from "../db/schema.ts";
import type { DB } from "./apply.ts";
import { violationKey, workloadKey, type PolicySnapshot } from "./policy-snapshot.ts";

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
type EventRow = typeof policyViolationEvents.$inferInsert;

export interface PolicyApplyOptions {
  now: Date;
  /**
   * Report count of the last good policy run, undefined if there was none.
   * If this run sees far fewer (an API hiccup, Kyverno restarting and
   * rebuilding its reports), nothing is resolved.
   */
  previousReportCount?: number;
  source?: string;
}

export interface PolicyApplyStats {
  reports: number;
  skippedReports: number;
  workloads: number;
  current: number;
  created: number;
  reopened: number;
  resolved: number;
  baseline: boolean;
  resolutionSkipped: boolean;
}

const chunk = <T>(xs: T[], n = 1000): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

export async function applyPolicySnapshot(db: DB, snap: PolicySnapshot, opts: PolicyApplyOptions): Promise<PolicyApplyStats> {
  const { now } = opts;
  const source = opts.source ?? "collector";
  const prev = opts.previousReportCount ?? 0;
  const allowResolve = !(prev > 0 && snap.reportCount < prev * 0.5);
  const stats: PolicyApplyStats = {
    reports: snap.reportCount,
    skippedReports: snap.skippedReports,
    workloads: snap.workloads.size,
    current: snap.violations.size,
    created: 0,
    reopened: 0,
    resolved: 0,
    baseline: false,
    resolutionSkipped: !allowResolve,
  };

  await db.transaction(async (tx: Tx) => {
    const existing = await tx
      .select({
        id: policyViolations.id,
        policy: policyViolations.policy,
        rule: policyViolations.rule,
        namespace: policyViolations.namespace,
        resourceKind: policyViolations.resourceKind,
        resourceName: policyViolations.resourceName,
        status: policyViolations.status,
        message: policyViolations.message,
        category: policyViolations.category,
        severity: policyViolations.severity,
      })
      .from(policyViolations);
    const keyOf = (e: (typeof existing)[number]) => violationKey(e.policy, e.rule, e.namespace, e.resourceKind, e.resourceName);
    const byKey = new Map(existing.map((e) => [keyOf(e), e]));
    // The very first policy run is the starting backlog, not "new".
    const baseline = existing.length === 0 && opts.previousReportCount === undefined;
    stats.baseline = baseline;

    const events: EventRow[] = [];

    // New violations.
    const fresh = [...snap.violations.values()].filter((v) => !byKey.has(v.key));
    for (const part of chunk(fresh, 500)) {
      const rows = await tx
        .insert(policyViolations)
        .values(
          part.map((v) => ({
            policy: v.policy,
            rule: v.rule,
            namespace: v.namespace,
            resourceKind: v.resourceKind,
            resourceName: v.resourceName,
            category: v.category,
            severity: v.severity,
            source: v.source,
            message: v.message,
            status: "open",
            baseline,
            firstSeenAt: now,
            lastSeenAt: now,
          })),
        )
        .returning({ id: policyViolations.id });
      rows.forEach((r) => events.push({ violationId: r.id, type: "first_seen", at: now, details: { source, baseline } }));
      stats.created += part.length;
    }

    // Still failing: re-open if needed, keep the latest message, move last_seen.
    const seen: number[] = [];
    for (const v of snap.violations.values()) {
      const e = byKey.get(v.key);
      if (!e) continue;
      seen.push(e.id);
      const reopen = e.status !== "open";
      if (reopen || e.message !== v.message || e.category !== v.category || e.severity !== v.severity) {
        await tx
          .update(policyViolations)
          .set({
            ...(reopen ? { status: "open", resolution: null, resolvedAt: null } : {}),
            message: v.message,
            category: v.category,
            severity: v.severity,
            updatedAt: now,
          })
          .where(inArray(policyViolations.id, [e.id]));
      }
      if (reopen) {
        events.push({ violationId: e.id, type: "reopened", at: now, details: { source } });
        stats.reopened++;
      }
    }
    for (const part of chunk(seen, 5000)) {
      await tx.update(policyViolations).set({ lastSeenAt: now }).where(inArray(policyViolations.id, part));
    }

    // Open but no longer failing: fixed if the workload is still reported
    // (and so now passes), removed if nothing reports it any more.
    if (allowResolve) {
      const byResolution: Record<"fixed" | "removed", number[]> = { fixed: [], removed: [] };
      for (const e of existing) {
        if (e.status !== "open" || snap.violations.has(keyOf(e))) continue;
        const resolution = snap.workloads.has(workloadKey(e.namespace, e.resourceKind, e.resourceName)) ? "fixed" : "removed";
        byResolution[resolution].push(e.id);
        events.push({ violationId: e.id, type: "resolved", at: now, details: { source, resolution } });
        stats.resolved++;
      }
      for (const resolution of ["fixed", "removed"] as const) {
        for (const part of chunk(byResolution[resolution], 5000)) {
          await tx
            .update(policyViolations)
            .set({ status: "resolved", resolution, resolvedAt: now, updatedAt: now })
            .where(inArray(policyViolations.id, part));
        }
      }
    }

    for (const part of chunk(events)) await tx.insert(policyViolationEvents).values(part);
  });

  return stats;
}
