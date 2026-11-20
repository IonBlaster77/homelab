// Atlas vulnerability collector. Every INTERVAL_SECONDS it reads Trivy
// Operator's VulnerabilityReports and the cluster's ReplicaSets, works out
// what is true now, and records the differences in Postgres (see apply.ts).
// On the very first start (empty database) it imports history from Prometheus
// first (backfill.ts).
//
// Env: DATABASE_URL (required), INTERVAL_SECONDS (600), PORT (8080),
// BACKFILL (true), KUBE_API, PROM_URL (see k8s.ts / prom.ts).
//
// HTTP: /healthz (503 once three intervals pass without a good run) and
// /metrics (Prometheus).
import { createServer } from "node:http";
import { count, desc, eq, sql } from "drizzle-orm";
import { connect } from "../db/client.ts";
import { collectorRuns, findings } from "../db/schema.ts";
import { applySnapshot, type DB } from "./apply.ts";
import { backfillFromPrometheus } from "./backfill.ts";
import { listReplicaSets, listVulnerabilityReports } from "./k8s.ts";
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
};

async function previousReportCount(db: DB): Promise<number | undefined> {
  const [last] = await db
    .select({ stats: collectorRuns.stats })
    .from(collectorRuns)
    .where(sql`${collectorRuns.ok} and ${collectorRuns.kind} = 'collect'`)
    .orderBy(desc(collectorRuns.id))
    .limit(1);
  const n = last?.stats?.reports;
  return typeof n === "number" ? n : undefined;
}

async function runOnce(db: DB) {
  const started = new Date();
  const [run] = await db.insert(collectorRuns).values({ kind: "collect", startedAt: started }).returning({ id: collectorRuns.id });
  try {
    const [reports, replicaSets, updates] = await Promise.all([
      listVulnerabilityReports(),
      listReplicaSets(),
      // Only feeds "fix within our control"; a Prometheus outage shouldn't stop the run.
      imagesWithUpdate().catch((e: unknown) => {
        log("image updates unavailable, skipping fix_in_control this run", { error: String(e) });
        return new Set<string>();
      }),
    ]);
    const snap = buildSnapshot(reports, replicaSets);
    const stats = await applySnapshot(db, snap, {
      now: started,
      imagesWithUpdate: updates,
      previousReportCount: await previousReportCount(db),
    });
    await db
      .update(collectorRuns)
      .set({ finishedAt: new Date(), ok: true, stats: { ...stats } })
      .where(eq(collectorRuns.id, run!.id));
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
    await db
      .update(collectorRuns)
      .set({ finishedAt: new Date(), ok: false, error: String(e instanceof Error ? e.stack : e) })
      .where(eq(collectorRuns.id, run!.id))
      .catch(() => {});
    log("run failed", { error: String(e) });
  }
}

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
