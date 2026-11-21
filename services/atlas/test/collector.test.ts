// Collector tests against a real Postgres (PGlite: Postgres compiled to WASM,
// in-process), with the same migrations the cluster runs.
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { MIGRATIONS_DIR } from "../src/db/client.ts";
import * as schema from "../src/db/schema.ts";
import { findingEvents, findings, findingSightings } from "../src/db/schema.ts";
import { applySnapshot, type DB } from "../src/collector/apply.ts";
import { applyHistory, mergeHistory } from "../src/collector/backfill.ts";
import type { ReplicaSet, Vulnerability, VulnerabilityReport } from "../src/collector/k8s.ts";
import { buildSnapshot } from "../src/collector/snapshot.ts";

const vuln = (id: string, pkg: string, severity: string, fixedVersion = ""): Vulnerability => ({
  vulnerabilityID: id,
  resource: pkg,
  installedVersion: "1.0.0",
  fixedVersion,
  severity,
  title: `${id} in ${pkg}`,
  score: 7.5,
  primaryLink: `https://avd.aquasec.com/nvd/${id.toLowerCase()}`,
  packagePURL: `pkg:deb/debian/${pkg}@1.0.0`,
});

const report = (rs: string, repo: string, tag: string, vulns: Vulnerability[], kind = "ReplicaSet"): VulnerabilityReport => ({
  metadata: {
    name: `${kind.toLowerCase()}-${rs}-app`,
    namespace: "demo",
    labels: {
      "trivy-operator.resource.kind": kind,
      "trivy-operator.resource.name": rs,
      "trivy-operator.resource.namespace": "demo",
      "trivy-operator.container.name": "app",
    },
  },
  report: {
    registry: { server: "ghcr.io" },
    artifact: { repository: repo, tag, digest: `sha256:${repo}-${tag}` },
    vulnerabilities: vulns,
  },
});

const replicaSet = (name: string, replicas: number, deployment = "web"): ReplicaSet => ({
  metadata: { name, namespace: "demo", ownerReferences: [{ kind: "Deployment", name: deployment, controller: true }] },
  spec: { replicas },
});

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 21, 0, minutes));

let db: DB;
beforeEach(async () => {
  const d = drizzle(new PGlite(), { schema });
  await migrate(d, { migrationsFolder: MIGRATIONS_DIR });
  db = d;
});

const byVuln = async () => {
  const rows = await db.select().from(findings).orderBy(asc(findings.vulnId));
  return Object.fromEntries(rows.map((r) => [r.vulnId, r]));
};
const eventTypes = async (vulnId: string) => {
  const [f] = await db.select({ id: findings.id }).from(findings).where(eq(findings.vulnId, vulnId));
  const ev = await db.select().from(findingEvents).where(eq(findingEvents.findingId, f!.id)).orderBy(asc(findingEvents.id));
  return ev.map((e) => e.type);
};

describe("buildSnapshot", () => {
  test("skips old rollout revisions and names the Deployment", () => {
    const snap = buildSnapshot(
      [report("web-new", "acme/web", "2", [vuln("CVE-1", "openssl", "HIGH", "3.1")]), report("web-old", "acme/web", "1", [vuln("CVE-9", "zlib", "LOW")])],
      [replicaSet("web-new", 1), replicaSet("web-old", 0)],
    );
    assert.equal(snap.skippedReports, 1);
    assert.deepEqual([...snap.findings.values()].map((f) => f.vulnId), ["CVE-1"]);
    const s = [...snap.findings.values()][0]!.sightings[0]!;
    assert.equal(s.workloadKind, "Deployment");
    assert.equal(s.workloadName, "web");
  });

  test("strips full references from tags", () => {
    const snap = buildSnapshot([report("web-new", "acme/web", "acme/web:2", [vuln("CVE-1", "openssl", "HIGH")])], [replicaSet("web-new", 1)]);
    assert.deepEqual([...[...snap.findings.values()][0]!.imageTags], ["ghcr.io/acme/web:2"]);
  });
});

describe("applySnapshot", () => {
  test("records the lifecycle: first seen, fix available, in control, patched, reopened", async () => {
    const rs = [replicaSet("web-1", 1)];
    const none = new Set<string>();

    // Run 1: CVE-1 fixable, CVE-2 not yet.
    let snap = buildSnapshot(
      [report("web-1", "acme/web", "1", [vuln("CVE-1", "openssl", "HIGH", "3.1"), vuln("CVE-2", "glibc", "CRITICAL")])],
      rs,
    );
    let stats = await applySnapshot(db, snap, { now: at(0), imagesWithUpdate: none });
    assert.equal(stats.created, 2);
    let f = await byVuln();
    assert.equal(f["CVE-1"]!.fixAvailableAt?.getTime(), at(0).getTime());
    assert.equal(f["CVE-2"]!.fixAvailableAt ?? "none", "none");

    // Run 2: a newer tag exists; CVE-2 gets a fix.
    snap = buildSnapshot(
      [report("web-1", "acme/web", "1", [vuln("CVE-1", "openssl", "HIGH", "3.1"), vuln("CVE-2", "glibc", "CRITICAL", "2.41")])],
      rs,
    );
    stats = await applySnapshot(db, snap, { now: at(10), imagesWithUpdate: new Set(["ghcr.io/acme/web:1"]), previousReportCount: 1 });
    assert.equal(stats.fixAvailable, 1);
    assert.equal(stats.fixInControl, 2);
    f = await byVuln();
    assert.equal(f["CVE-1"]!.fixInControlAt?.getTime(), at(10).getTime());
    assert.equal(f["CVE-2"]!.fixAvailableAt?.getTime(), at(10).getTime());

    // Run 3: bumped to tag 2, which no longer has CVE-1.
    const rs2 = [replicaSet("web-1", 0), replicaSet("web-2", 1)];
    snap = buildSnapshot(
      [
        report("web-1", "acme/web", "1", [vuln("CVE-1", "openssl", "HIGH", "3.1"), vuln("CVE-2", "glibc", "CRITICAL", "2.41")]),
        report("web-2", "acme/web", "2", [vuln("CVE-2", "glibc", "CRITICAL", "2.41")]),
      ],
      rs2,
    );
    stats = await applySnapshot(db, snap, { now: at(20), imagesWithUpdate: none, previousReportCount: 1 });
    assert.equal(stats.resolved, 1);
    f = await byVuln();
    assert.equal(f["CVE-1"]!.status, "resolved");
    assert.equal(f["CVE-1"]!.resolution, "patched");
    assert.equal(f["CVE-2"]!.status, "open");

    // Run 4: CVE-1 comes back.
    snap = buildSnapshot([report("web-2", "acme/web", "2", [vuln("CVE-1", "openssl", "HIGH", "3.1"), vuln("CVE-2", "glibc", "CRITICAL", "2.41")])], rs2);
    stats = await applySnapshot(db, snap, { now: at(30), imagesWithUpdate: none, previousReportCount: 1 });
    assert.equal(stats.reopened, 1);
    assert.deepEqual(await eventTypes("CVE-1"), ["first_seen", "fix_available", "fix_in_control", "resolved", "reopened"]);
    assert.deepEqual(await eventTypes("CVE-2"), ["first_seen", "fix_available", "fix_in_control"]);
  });

  test("marks findings removed when nothing runs the image", async () => {
    const rs = [replicaSet("web-1", 1), replicaSet("db-1", 1, "db")];
    let snap = buildSnapshot(
      [report("web-1", "acme/web", "1", [vuln("CVE-1", "openssl", "HIGH")]), report("db-1", "acme/db", "1", [vuln("CVE-2", "glibc", "LOW")])],
      rs,
    );
    await applySnapshot(db, snap, { now: at(0), imagesWithUpdate: new Set() });
    snap = buildSnapshot([report("db-1", "acme/db", "1", [vuln("CVE-2", "glibc", "LOW")])], [replicaSet("db-1", 1, "db")]);
    await applySnapshot(db, snap, { now: at(10), imagesWithUpdate: new Set(), previousReportCount: 2 });
    const f = await byVuln();
    assert.equal(f["CVE-1"]!.resolution, "removed");
    const sightings = await db.select().from(findingSightings).where(eq(findingSightings.findingId, f["CVE-1"]!.id));
    assert.equal(sightings[0]!.active, false);
  });

  test("resolves nothing when far fewer reports arrive than last time", async () => {
    const reports = [1, 2, 3, 4].map((i) => report(`web-${i}`, `acme/app${i}`, "1", [vuln(`CVE-${i}`, "openssl", "HIGH")]));
    const rs = [1, 2, 3, 4].map((i) => replicaSet(`web-${i}`, 1, `app${i}`));
    await applySnapshot(db, buildSnapshot(reports, rs), { now: at(0), imagesWithUpdate: new Set() });
    const stats = await applySnapshot(db, buildSnapshot(reports.slice(0, 1), rs), {
      now: at(10),
      imagesWithUpdate: new Set(),
      previousReportCount: 4,
    });
    assert.equal(stats.resolutionSkipped, true);
    assert.equal(stats.resolved, 0);
    assert.equal((await db.select().from(findings).where(eq(findings.status, "open"))).length, 4);
  });

  test("stores each distinct raw report once", async () => {
    const r = [report("web-1", "acme/web", "1", [vuln("CVE-1", "openssl", "HIGH")])];
    const rs = [replicaSet("web-1", 1)];
    const a = await applySnapshot(db, buildSnapshot(r, rs), { now: at(0), imagesWithUpdate: new Set() });
    const b = await applySnapshot(db, buildSnapshot(r, rs), { now: at(10), imagesWithUpdate: new Set(), previousReportCount: 1 });
    assert.equal(a.rawReportsStored, 1);
    assert.equal(b.rawReportsStored, 0);
  });
});

describe("backfill", () => {
  const sample = (m: Record<string, string>, v: number) => ({ metric: m, value: [0, String(v)] as [number, string] });
  const series = (fixed: string) => ({
    image_registry: "ghcr.io",
    image_repository: "acme/web",
    vuln_id: "CVE-1",
    resource: "openssl",
    severity: "High",
    fixed_version: fixed,
  });
  const t0 = at(0).getTime() / 1000;

  test("merges series into one finding with first seen and fix time", async () => {
    // Unfixed from t0, a fix published 1h later, last seen 3h in.
    const hist = mergeHistory(
      [sample(series(""), t0), sample(series("3.1"), t0 + 3600)],
      [sample(series(""), t0 + 3000), sample(series("3.1"), t0 + 3 * 3600)],
    );
    assert.equal(hist.size, 1);
    const h = [...hist.values()][0]!;
    assert.equal(h.firstSeen, t0);
    assert.equal(h.fixAvailable, t0 + 3600);
    assert.equal(h.fixedVersion, "3.1");
    assert.equal(h.severity, "HIGH");

    // Last seen 3h before "now" + 10h: resolved, with unknown resolution.
    const r = await applyHistory(db, hist, new Date((t0 + 13 * 3600) * 1000));
    assert.equal(r.resolved, 1);
    const [f] = await db.select().from(findings);
    assert.equal(f!.status, "resolved");
    assert.equal(f!.resolution, "unknown");
    assert.deepEqual(await eventTypes("CVE-1"), ["first_seen", "fix_available", "resolved"]);
  });
});
