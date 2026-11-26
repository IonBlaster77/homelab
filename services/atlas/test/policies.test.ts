// Kyverno policy ingest: the fold-up to workloads (pure) and the violation
// lifecycle in a real Postgres (PGlite), with the same migrations the cluster runs.
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { MIGRATIONS_DIR } from "../src/db/client.ts";
import * as schema from "../src/db/schema.ts";
import { policyViolationEvents, policyViolations } from "../src/db/schema.ts";
import type { DB } from "../src/collector/apply.ts";
import type { MetadataOnly, PolicyReport, PolicyReportResult, ReplicaSet } from "../src/collector/k8s.ts";
import { applyPolicySnapshot } from "../src/collector/policy-apply.ts";
import { buildPolicySnapshot } from "../src/collector/policy-snapshot.ts";

const res = (policy: string, result: string, message = result === "fail" ? `${policy} failed` : "success"): PolicyReportResult => ({
  policy,
  rule: "validation",
  result,
  message,
  category: policy.startsWith("ms-") ? "Manifest standards" : "Pod Security Standards (Restricted)",
  severity: "medium",
  source: "KyvernoValidatingPolicy",
});

/** namespace null = cluster-scoped (a ClusterPolicyReport). */
const report = (kind: string, name: string, results: PolicyReportResult[], namespace: string | null = "demo"): PolicyReport => ({
  metadata: { name: `uid-${kind}-${name}`, ...(namespace === null ? {} : { namespace }) },
  scope: { kind, name, ...(namespace === null ? {} : { namespace }) },
  results,
});

const meta = (name: string, owner?: { kind: string; name: string }): MetadataOnly => ({
  metadata: { name, namespace: "demo", ...(owner ? { ownerReferences: [{ ...owner, controller: true }] } : {}) },
});

const rs = (name: string, replicas: number, deployment = "web"): ReplicaSet => ({
  metadata: { name, namespace: "demo", ownerReferences: [{ kind: "Deployment", name: deployment, controller: true }] },
  spec: { replicas },
});

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 26, 0, minutes));

describe("buildPolicySnapshot", () => {
  test("folds Pods and ReplicaSets up to the Deployment, worst result wins", () => {
    const snap = buildPolicySnapshot(
      [
        report("Deployment", "web", [res("ms-03-requests", "pass"), res("require-run-as-nonroot", "pass")]),
        report("ReplicaSet", "web-abc", [res("ms-03-requests", "pass"), res("require-run-as-nonroot", "pass")]),
        // One pod of two fails: the workload fails.
        report("Pod", "web-abc-1", [res("ms-03-requests", "pass"), res("require-run-as-nonroot", "fail", "root in app")]),
        report("Pod", "web-abc-2", [res("ms-03-requests", "pass"), res("require-run-as-nonroot", "pass")]),
      ],
      [meta("web-abc-1", { kind: "ReplicaSet", name: "web-abc" }), meta("web-abc-2", { kind: "ReplicaSet", name: "web-abc" })],
      [rs("web-abc", 2)],
      [],
    );
    assert.deepEqual([...snap.workloads], ["demo/Deployment/web"]);
    assert.equal(snap.violations.size, 1);
    const v = [...snap.violations.values()][0]!;
    assert.equal(v.policy, "require-run-as-nonroot");
    assert.equal(v.resourceKind, "Deployment");
    assert.equal(v.resourceName, "web");
    assert.equal(v.message, "root in app");
    assert.deepEqual(snap.results.get("ms-03-requests"), { policy: "ms-03-requests", category: "Manifest standards", pass: 1, fail: 0, error: 0 });
    assert.equal(snap.results.get("require-run-as-nonroot")?.fail, 1);
  });

  test("skips old rollout revisions and pods that are already gone", () => {
    const snap = buildPolicySnapshot(
      [
        report("ReplicaSet", "web-old", [res("ms-03-requests", "fail")]),
        report("Pod", "deleted-pod", [res("ms-03-requests", "fail")]),
        report("Deployment", "web", [res("ms-03-requests", "pass")]),
      ],
      [],
      [rs("web-old", 0)],
      [],
    );
    assert.equal(snap.violations.size, 0);
    assert.equal(snap.skippedReports, 2);
    assert.equal(snap.reportCount, 1);
  });

  test("folds CronJob runs and operator pods; keeps cluster-scoped objects", () => {
    const snap = buildPolicySnapshot(
      [
        report("Job", "backup-29001", [res("ms-03-requests", "fail")]),
        report("Pod", "backup-29001-x", [res("ms-03-requests", "fail")]),
        report("Pod", "app-db-1", [res("ms-03-requests", "fail")]),
        report("Pod", "app-db-2", [res("ms-03-requests", "fail")]),
        report("Pod", "standalone", [res("ms-03-requests", "fail")]),
        // Static pods are owned by their Node: each keeps its own identity.
        report("Pod", "kube-apiserver-talos1", [res("ms-03-requests", "fail")]),
        report("Pod", "kube-scheduler-talos1", [res("ms-03-requests", "fail")]),
        report("Namespace", "demo", [res("ms-11-psa-label", "fail")], null),
      ],
      [
        meta("backup-29001-x", { kind: "Job", name: "backup-29001" }),
        meta("app-db-1", { kind: "Cluster", name: "app-db" }),
        meta("app-db-2", { kind: "Cluster", name: "app-db" }),
        meta("standalone"),
        meta("kube-apiserver-talos1", { kind: "Node", name: "talos1" }),
        meta("kube-scheduler-talos1", { kind: "Node", name: "talos1" }),
      ],
      [],
      [meta("backup-29001", { kind: "CronJob", name: "backup" })],
    );
    assert.deepEqual(
      [...snap.violations.values()].map((v) => `${v.namespace}/${v.resourceKind}/${v.resourceName}:${v.policy}`).sort(),
      [
        "/Namespace/demo:ms-11-psa-label",
        "demo/Cluster/app-db:ms-03-requests",
        "demo/CronJob/backup:ms-03-requests",
        "demo/Pod/kube-apiserver-talos1:ms-03-requests",
        "demo/Pod/kube-scheduler-talos1:ms-03-requests",
        "demo/Pod/standalone:ms-03-requests",
      ],
    );
  });

  test("warn counts as a failure, skip is ignored, error is counted apart", () => {
    const snap = buildPolicySnapshot(
      [report("Deployment", "a", [res("p1", "warn"), res("p2", "skip"), res("p3", "error")])],
      [],
      [],
      [],
    );
    assert.deepEqual([...snap.violations.values()].map((v) => v.policy), ["p1"]);
    assert.equal(snap.results.has("p2"), false);
    assert.equal(snap.results.get("p3")?.error, 1);
  });
});

describe("applyPolicySnapshot", () => {
  let db: DB;
  beforeEach(async () => {
    const d = drizzle(new PGlite(), { schema });
    await migrate(d, { migrationsFolder: MIGRATIONS_DIR });
    db = d;
  });

  const rows = async () => {
    const r = await db.select().from(policyViolations).orderBy(asc(policyViolations.resourceName), asc(policyViolations.policy));
    return Object.fromEntries(r.map((v) => [`${v.resourceName}:${v.policy}`, v]));
  };
  const events = async (id: number) =>
    (await db.select().from(policyViolationEvents).where(eq(policyViolationEvents.violationId, id)).orderBy(asc(policyViolationEvents.id))).map(
      (e) => e.type,
    );
  const snapOf = (reports: PolicyReport[]) => buildPolicySnapshot(reports, [], [], []);

  test("records the lifecycle: baseline, new, fixed, removed, reopened", async () => {
    // Run 1: the starting backlog.
    let s = await applyPolicySnapshot(
      db,
      snapOf([report("Deployment", "a", [res("ms-03-requests", "fail")]), report("Deployment", "b", [res("ms-07-probes", "fail")])]),
      { now: at(0) },
    );
    assert.equal(s.created, 2);
    assert.equal(s.baseline, true);
    let r = await rows();
    assert.equal(r["a:ms-03-requests"]!.baseline, true);

    // Run 2: a is fixed (still reported, now passes), b is deleted, c is new.
    s = await applyPolicySnapshot(
      db,
      snapOf([report("Deployment", "a", [res("ms-03-requests", "pass")]), report("Deployment", "c", [res("ms-09-image-tag", "fail")])]),
      { now: at(10), previousReportCount: 2 },
    );
    assert.equal(s.baseline, false);
    assert.equal(s.resolved, 2);
    r = await rows();
    assert.equal(r["a:ms-03-requests"]!.status, "resolved");
    assert.equal(r["a:ms-03-requests"]!.resolution, "fixed");
    assert.equal(r["b:ms-07-probes"]!.resolution, "removed");
    assert.equal(r["c:ms-09-image-tag"]!.baseline, false);
    assert.equal(r["c:ms-09-image-tag"]!.status, "open");

    // Run 3: a regresses.
    s = await applyPolicySnapshot(
      db,
      snapOf([
        report("Deployment", "a", [res("ms-03-requests", "fail", "new message")]),
        report("Deployment", "c", [res("ms-09-image-tag", "fail")]),
      ]),
      { now: at(20), previousReportCount: 2 },
    );
    assert.equal(s.reopened, 1);
    r = await rows();
    const a = r["a:ms-03-requests"]!;
    assert.equal(a.status, "open");
    assert.equal(a.resolution, null);
    assert.equal(a.message, "new message");
    assert.equal(a.firstSeenAt.getTime(), at(0).getTime());
    assert.equal(a.lastSeenAt.getTime(), at(20).getTime());
    assert.deepEqual(await events(a.id), ["first_seen", "resolved", "reopened"]);
  });

  test("resolves nothing when far fewer reports arrive than last time", async () => {
    await applyPolicySnapshot(
      db,
      snapOf([1, 2, 3, 4].map((i) => report("Deployment", `w${i}`, [res("ms-03-requests", "fail")]))),
      { now: at(0) },
    );
    const s = await applyPolicySnapshot(db, snapOf([report("Deployment", "w1", [res("ms-03-requests", "fail")])]), {
      now: at(10),
      previousReportCount: 4,
    });
    assert.equal(s.resolutionSkipped, true);
    assert.equal(s.resolved, 0);
    const open = await db.select().from(policyViolations).where(eq(policyViolations.status, "open"));
    assert.equal(open.length, 4);
  });

  test("an empty table after earlier policy runs is not a baseline", async () => {
    const s = await applyPolicySnapshot(db, snapOf([report("Deployment", "a", [res("ms-03-requests", "fail")])]), {
      now: at(0),
      previousReportCount: 10,
    });
    assert.equal(s.baseline, false);
  });
});
