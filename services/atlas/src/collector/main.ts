// Atlas collector. Every INTERVAL_SECONDS it reads Trivy Operator's
// VulnerabilityReports and the cluster's ReplicaSets, works out what is true
// now, and records the differences in Postgres (see apply.ts). On the very
// first start (empty database) it imports history from Prometheus first
// (backfill.ts).
//
// The same run then reads Kyverno's PolicyReports and records policy
// violations per workload (policy-snapshot.ts, policy-apply.ts). That part
// fails on its own: a Kyverno problem never stops the vulnerability history.
//
// Env: DATABASE_URL (required), INTERVAL_SECONDS (600), PORT (8080),
// BACKFILL (true), KUBE_API, PROM_URL (see k8s.ts / prom.ts).
//
// HTTP: /healthz (503 once three intervals pass without a good run) and
// /metrics (Prometheus).
import { createServer } from "node:http";
import { and, count, desc, eq, gt, sql } from "drizzle-orm";
import { connect } from "../db/client.ts";
import { collectorRuns, findings, policyViolations } from "../db/schema.ts";
import { applySnapshot, type DB } from "./apply.ts";
import { backfillFromPrometheus } from "./backfill.ts";
import {
  listClusterPolicyReports,
  listJobMetadata,
  listPodMetadata,
  listPolicyReports,
  listReplicaSets,
  listVulnerabilityReports,
  type ReplicaSet,
} from "./k8s.ts";
import { applyPolicySnapshot } from "./policy-apply.ts";
import { buildPolicySnapshot, type PolicyResultCount } from "./policy-snapshot.ts";
import { imagesWithUpdate } from "./prom.ts";
import { buildSnapshot } from "./snapshot.ts";

const INTERVAL = Number(process.env.INTERVAL_SECONDS ?? 600) * 1000;
const PORT = Number(process.env.PORT ?? 8080);

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...extra }));

const metrics = {
  startedAt: Date.now(),
  lastSuccess: 0,
  lastDuration: 0,
  runsOk: 0,
  runsFailed: 0,
  open: {} as Record<string, number>,
  policy: {
    lastSuccess: 0,
    runsOk: 0,
    runsFailed: 0,
    results: [] as PolicyResultCount[],
    open: [] as { policy: string; category: string; namespace: string; n: number }[],
    new7d: 0,
    resolved7d: {} as Record<string, number>,
  },
};

/** Report count of the last good collect run: `stats.reports`, or `stats.policy.reports` with policy=true. */
async function previousReportCount(db: DB, policy = false): Promise<number | undefined> {
  const runs = await db
    .select({ stats: collectorRuns.stats })
    .from(collectorRuns)
    .where(sql`${collectorRuns.ok} and ${collectorRuns.kind} = 'collect'`)
    .orderBy(desc(collectorRuns.id))
    .limit(policy ? 20 : 1);
  for (const r of runs) {
    const s = policy ? (r.stats?.policy as Record<string, unknown> | undefined) : r.stats;
    const n = s?.reports;
    if (typeof n === "number") return n;
  }
  return undefined;
}

/** The Kyverno part of a run. Throws on failure; the caller records it. */
async function collectPolicies(db: DB, now: Date, replicaSets: ReplicaSet[]) {
  const [nsReports, clusterReports, pods, jobs] = await Promise.all([
    listPolicyReports(),
    listClusterPolicyReports(),
    listPodMetadata(),
    listJobMetadata(),
  ]);
  const snap = buildPolicySnapshot([...nsReports, ...clusterReports], pods, replicaSets, jobs);
  const stats = await applyPolicySnapshot(db, snap, { now, previousReportCount: await previousReportCount(db, true) });

  const week = new Date(now.getTime() - 7 * 86_400_000);
  const [open, [fresh], resolved] = await Promise.all([
    db
      .select({ policy: policyViolations.policy, category: policyViolations.category, namespace: policyViolations.namespace, n: count() })
      .from(policyViolations)
      .where(eq(policyViolations.status, "open"))
      .groupBy(policyViolations.policy, policyViolations.category, policyViolations.namespace),
    db
      .select({ n: count() })
      .from(policyViolations)
      .where(and(eq(policyViolations.baseline, false), gt(policyViolations.firstSeenAt, week))),
    db
      .select({ resolution: policyViolations.resolution, n: count() })
      .from(policyViolations)
      .where(and(eq(policyViolations.status, "resolved"), gt(policyViolations.resolvedAt, week)))
      .groupBy(policyViolations.resolution),
  ]);
  metrics.policy.results = [...snap.results.values()];
  metrics.policy.open = open;
  metrics.policy.new7d = fresh?.n ?? 0;
  metrics.policy.resolved7d = Object.fromEntries(resolved.map((r) => [r.resolution ?? "unknown", r.n]));
  return stats;
}

async function runOnce(db: DB) {
  const started = new Date();
  const [run] = await db.insert(collectorRuns).values({ kind: "collect", startedAt: started }).returning({ id: collectorRuns.id });
  let replicaSets: ReplicaSet[] | undefined;
  let vulnStats: Record<string, unknown> | undefined;
  let vulnError: string | undefined;
  try {
    const [reports, rsList, updates] = await Promise.all([
      listVulnerabilityReports(),
      listReplicaSets(),
      // Only feeds "fix within our control"; a Prometheus outage shouldn't stop the run.
      imagesWithUpdate().catch((e: unknown) => {
        log("image updates unavailable, skipping fix_in_control this run", { error: String(e) });
        return new Set<string>();
      }),
    ]);
    replicaSets = rsList;
    const snap = buildSnapshot(reports, rsList);
    const stats = await applySnapshot(db, snap, {
      now: started,
      imagesWithUpdate: updates,
      previousReportCount: await previousReportCount(db),
    });
    vulnStats = { ...stats };
    const open = await db
      .select({ severity: findings.severity, n: count() })
      .from(findings)
      .where(eq(findings.status, "open"))
      .groupBy(findings.severity);
    metrics.open = Object.fromEntries(open.map((o) => [o.severity, o.n]));
    metrics.lastSuccess = Date.now();
    metrics.lastDuration = (Date.now() - started.getTime()) / 1000;
    metrics.runsOk++;
    log("run ok", { ...stats, seconds: metrics.lastDuration });
  } catch (e) {
    metrics.runsFailed++;
    vulnError = String(e instanceof Error ? e.stack : e);
    log("run failed", { error: String(e) });
  }

  // Kyverno. Its own try: recorded under stats.policy, never fails the run.
  let policy: Record<string, unknown>;
  try {
    const stats = await collectPolicies(db, started, replicaSets ?? (await listReplicaSets()));
    policy = { ...stats };
    metrics.policy.lastSuccess = Date.now();
    metrics.policy.runsOk++;
    log("policy run ok", { ...stats });
  } catch (e) {
    policy = { error: String(e) };
    metrics.policy.runsFailed++;
    log("policy run failed", { error: String(e) });
  }

  await db
    .update(collectorRuns)
    .set({
      finishedAt: new Date(),
      ok: vulnError === undefined,
      stats: { ...vulnStats, policy },
      ...(vulnError === undefined ? {} : { error: vulnError }),
    })
    .where(eq(collectorRuns.id, run!.id))
    .catch((e: unknown) => log("could not record the run", { error: String(e) }));
}

/** Prometheus label value escaping (backslash, quote, newline). */
const lv = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

function serve() {
  const server = createServer((req, res) => {
    if (req.url === "/healthz") {
      const ref = metrics.lastSuccess || metrics.startedAt;
      const ok = Date.now() - ref < 3 * INTERVAL + 60_000;
      res.writeHead(ok ? 200 : 503).end(ok ? "ok\n" : "no successful run recently\n");
      return;
    }
    if (req.url === "/metrics") {
      const lines = [
        "# HELP atlas_collector_last_success_timestamp_seconds Unix time of the last successful run.",
        "# TYPE atlas_collector_last_success_timestamp_seconds gauge",
        `atlas_collector_last_success_timestamp_seconds ${Math.floor(metrics.lastSuccess / 1000)}`,
        "# HELP atlas_collector_last_duration_seconds Duration of the last successful run.",
        "# TYPE atlas_collector_last_duration_seconds gauge",
        `atlas_collector_last_duration_seconds ${metrics.lastDuration}`,
        "# HELP atlas_collector_runs_total Collector runs since start.",
        "# TYPE atlas_collector_runs_total counter",
        `atlas_collector_runs_total{result="ok"} ${metrics.runsOk}`,
        `atlas_collector_runs_total{result="failed"} ${metrics.runsFailed}`,
        "# HELP atlas_findings_open Open findings in the Atlas database, by severity.",
        "# TYPE atlas_findings_open gauge",
        ...Object.entries(metrics.open).map(([s, n]) => `atlas_findings_open{severity="${s}"} ${n}`),
        // Kyverno policy violations (policy-snapshot.ts folds objects up to workloads).
        "# HELP atlas_policy_last_success_timestamp_seconds Unix time of the last successful Kyverno policy run.",
        "# TYPE atlas_policy_last_success_timestamp_seconds gauge",
        `atlas_policy_last_success_timestamp_seconds ${Math.floor(metrics.policy.lastSuccess / 1000)}`,
        "# HELP atlas_policy_runs_total Kyverno policy runs since start.",
        "# TYPE atlas_policy_runs_total counter",
        `atlas_policy_runs_total{result="ok"} ${metrics.policy.runsOk}`,
        `atlas_policy_runs_total{result="failed"} ${metrics.policy.runsFailed}`,
        "# HELP atlas_policy_workloads Workloads per Kyverno policy and result (pass, fail, error), from the last run.",
        "# TYPE atlas_policy_workloads gauge",
        ...metrics.policy.results.flatMap((r) =>
          (["pass", "fail", "error"] as const).map(
            (res) => `atlas_policy_workloads{policy="${lv(r.policy)}",category="${lv(r.category)}",result="${res}"} ${r[res]}`,
          ),
        ),
        "# HELP atlas_policy_violations_open Open policy violations in the Atlas database.",
        "# TYPE atlas_policy_violations_open gauge",
        ...metrics.policy.open.map(
          (o) =>
            `atlas_policy_violations_open{policy="${lv(o.policy)}",category="${lv(o.category)}",namespace="${lv(o.namespace)}"} ${o.n}`,
        ),
        "# HELP atlas_policy_violations_new_7d Violations first seen in the last 7 days (the starting backlog excluded).",
        "# TYPE atlas_policy_violations_new_7d gauge",
        `atlas_policy_violations_new_7d ${metrics.policy.new7d}`,
        "# HELP atlas_policy_violations_resolved_7d Violations resolved in the last 7 days, by resolution (fixed, removed).",
        "# TYPE atlas_policy_violations_resolved_7d gauge",
        ...["fixed", "removed"].map((r) => `atlas_policy_violations_resolved_7d{resolution="${r}"} ${metrics.policy.resolved7d[r] ?? 0}`),
      ];
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" }).end(lines.join("\n") + "\n");
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(PORT);
  return server;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const server = serve();
  const { db, pool } = await connect(url);
  log("migrations applied");

  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(findings);
  if (n === 0 && process.env.BACKFILL !== "false") {
    const started = new Date();
    const [run] = await db.insert(collectorRuns).values({ kind: "backfill", startedAt: started }).returning({ id: collectorRuns.id });
    try {
      const r = await backfillFromPrometheus(db, started);
      await db.update(collectorRuns).set({ finishedAt: new Date(), ok: true, stats: r }).where(eq(collectorRuns.id, run!.id));
      log("backfill done", r);
    } catch (e) {
      await db.update(collectorRuns).set({ finishedAt: new Date(), ok: false, error: String(e) }).where(eq(collectorRuns.id, run!.id));
      log("backfill failed, continuing without history", { error: String(e) });
    }
  }

  let timer: NodeJS.Timeout | undefined;
  let stopping = false;
  const loop = async () => {
    await runOnce(db);
    if (!stopping) timer = setTimeout(loop, INTERVAL);
  };
  const stop = async () => {
    stopping = true;
    clearTimeout(timer);
    server.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await loop();
}

main().catch((e) => {
  log("fatal", { error: String(e instanceof Error ? e.stack : e) });
  process.exit(1);
});
