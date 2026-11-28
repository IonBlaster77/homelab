// Risk ranking: threat intel (KEV/EPSS) parsing and storage, workload
// exposure, and the priority rule. Database parts run against PGlite with the
// same migrations the cluster runs.
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { MIGRATIONS_DIR } from "../src/db/client.ts";
import * as schema from "../src/db/schema.ts";
import { findingEvents, findings, findingSightings, vulnIntel, workloadExposure } from "../src/db/schema.ts";
import type { DB } from "../src/collector/apply.ts";
import {
  applyExposure,
  buildExposure,
  hostnamesOf,
  parseTunnelIngress,
  serviceOfUrl,
  type ExposedWorkload,
} from "../src/collector/exposure.ts";
import { applyIntel, parseEpss, parseKev, wantedIds } from "../src/collector/intel.ts";
import type { HTTPRoute, MetadataOnly, ReplicaSet, Service } from "../src/collector/k8s.ts";
import { workloadResolver } from "../src/collector/policy-snapshot.ts";
import { openByPriority, priorityOf, slaDays } from "../src/collector/priority.ts";

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 28, 0, minutes));

// --- Intel parsing ------------------------------------------------------------

describe("parseKev", () => {
  const catalog = {
    title: "CISA Catalog of Known Exploited Vulnerabilities",
    vulnerabilities: [
      { cveID: "CVE-2024-1", vulnerabilityName: "Foo RCE", dateAdded: "2026-11-27", dueDate: "2026-12-18", knownRansomwareCampaignUse: "Known" },
      { cveID: "CVE-2024-2", vulnerabilityName: "Bar", dateAdded: "2025-01-02", dueDate: "2025-01-23", knownRansomwareCampaignUse: "Unknown" },
      { cveID: "not-a-cve" },
    ],
  };

  test("maps CVE IDs to their dates and ransomware flag", () => {
    const kev = parseKev(catalog, 1);
    assert.equal(kev.size, 2);
    assert.deepEqual(kev.get("CVE-2024-1"), {
      addedAt: new Date("2026-11-27T00:00:00Z"),
      dueAt: new Date("2026-12-18T00:00:00Z"),
      ransomware: true,
      name: "Foo RCE",
    });
    assert.equal(kev.get("CVE-2024-2")?.ransomware, false);
  });

  test("rejects a catalog that is too small or the wrong shape", () => {
    assert.throws(() => parseKev(catalog), /only 2 entries/);
    assert.throws(() => parseKev({ nope: true }, 1), /no vulnerabilities array/);
  });
});

describe("parseEpss", () => {
  const csv = [
    "#model_version:v2026.06.15,score_date:2026-11-27T12:00:25Z",
    "cve,epss,percentile",
    "CVE-1999-0001,0.04753,0.92661",
    "CVE-2024-1,0.94,0.999",
    "CVE-2024-3,0.0004,0.1",
    "",
  ].join("\n");

  test("keeps only wanted IDs, reads the score date", () => {
    const e = parseEpss(csv, new Set(["CVE-2024-1", "CVE-2024-3", "CVE-2099-9"]), 1);
    assert.equal(e.total, 3);
    assert.deepEqual(e.date, new Date("2026-11-27T00:00:00Z"));
    assert.deepEqual([...e.scores.keys()].sort(), ["CVE-2024-1", "CVE-2024-3"]);
    assert.deepEqual(e.scores.get("CVE-2024-1"), { epss: 0.94, percentile: 0.999 });
  });

  test("rejects a truncated file", () => {
    assert.throws(() => parseEpss(csv, new Set()), /only 3 rows/);
  });
});

// --- Exposure -----------------------------------------------------------------

// The real cloudflared config shape (kubernetes/platform/networking/cloudflared/configmap.yaml).
const TUNNEL_YAML = `# comment
ingress:
  - hostname: auth.example.net
    service: http://authentik-server.authentik.svc.cluster.local:80
    originRequest:
      httpHostHeader: auth.example.net

  - hostname: "*.example.net"
    service: https://cilium-gateway-homelab-gateway.networking.svc.cluster.local:443
    originRequest:
      noTLSVerify: true

  - service: http_status:404
`;

describe("parseTunnelIngress", () => {
  test("reads hostname/service pairs and the catch-all", () => {
    assert.deepEqual(parseTunnelIngress(TUNNEL_YAML), [
      { hostname: "auth.example.net", service: "http://authentik-server.authentik.svc.cluster.local:80" },
      { hostname: "*.example.net", service: "https://cilium-gateway-homelab-gateway.networking.svc.cluster.local:443" },
      { service: "http_status:404" },
    ]);
  });

  test("serviceOfUrl", () => {
    assert.deepEqual(serviceOfUrl("http://authentik-server.authentik.svc.cluster.local:80"), { name: "authentik-server", namespace: "authentik" });
    assert.equal(serviceOfUrl("http_status:404"), null);
    assert.equal(serviceOfUrl("https://example.com"), null);
  });
});

describe("buildExposure", () => {
  const pod = (ns: string, name: string, labels: Record<string, string>, owner?: { kind: string; name: string }): MetadataOnly => ({
    metadata: { name, namespace: ns, labels, ...(owner ? { ownerReferences: [{ ...owner, controller: true }] } : {}) },
  });
  const rs = (ns: string, name: string, deployment: string, replicas = 1): ReplicaSet => ({
    metadata: { name, namespace: ns, ownerReferences: [{ kind: "Deployment", name: deployment, controller: true }] },
    spec: { replicas },
  });
  const svc = (ns: string, name: string, selector: Record<string, string> | undefined, type = "ClusterIP"): Service => ({
    metadata: { name, namespace: ns },
    spec: { type, ...(selector ? { selector } : {}) },
  });
  const route = (ns: string, name: string, hosts: string[], backends: { name: string; namespace?: string }[]): HTTPRoute => ({
    metadata: { name, namespace: ns },
    spec: { parentRefs: [{ name: "homelab-gateway", namespace: "networking" }], hostnames: hosts, rules: [{ backendRefs: backends }] },
  });

  const pods = [
    pod("media", "seerr-abc-1", { app: "seerr" }, { kind: "ReplicaSet", name: "seerr-abc" }),
    pod("media", "seerr-old-1", { app: "seerr" }, { kind: "ReplicaSet", name: "seerr-old" }), // old revision, 0 replicas
    pod("monitoring", "grafana-x-1", { app: "grafana" }, { kind: "ReplicaSet", name: "grafana-x" }),
    pod("authentik", "authentik-server-y-1", { app: "authentik", component: "server" }, { kind: "ReplicaSet", name: "authentik-server-y" }),
    pod("authentik", "authentik-worker-z-1", { app: "authentik", component: "worker" }, { kind: "ReplicaSet", name: "authentik-worker-z" }),
    pod("adguard", "adguard-0", { app: "adguard" }, { kind: "StatefulSet", name: "adguard" }),
    pod("other", "internal-1", { app: "internal" }, { kind: "ReplicaSet", name: "internal-q" }),
  ];
  const replicaSets = [
    rs("media", "seerr-abc", "seerr"),
    rs("media", "seerr-old", "seerr", 0),
    rs("monitoring", "grafana-x", "grafana"),
    rs("authentik", "authentik-server-y", "authentik-server"),
    rs("authentik", "authentik-worker-z", "authentik-worker"),
    rs("other", "internal-q", "internal"),
  ];
  const services = [
    svc("media", "seerr", { app: "seerr" }),
    svc("monitoring", "grafana", { app: "grafana" }),
    svc("authentik", "authentik-server", { app: "authentik", component: "server" }),
    svc("adguard", "adguard-dns", { app: "adguard" }, "LoadBalancer"),
    svc("networking", "cilium-gateway-homelab-gateway", undefined, "LoadBalancer"),
    svc("other", "internal", { app: "internal" }),
  ];
  const routes = [
    route("media", "seerr", ["requests.example.net"], [{ name: "seerr" }]),
    route("monitoring", "grafana", ["grafana.example.net"], [{ name: "grafana" }]),
  ];
  const tunnel = parseTunnelIngress(TUNNEL_YAML);

  const build = (publicHosts: string[]) =>
    buildExposure({ routes, services, pods, tunnel, publicHosts: new Set(publicHosts), resolve: workloadResolver(pods, replicaSets, []) });
  const view = (m: Map<string, ExposedWorkload>) =>
    Object.fromEntries([...m].map(([k, v]) => [k, { exposure: v.exposure, hosts: v.hosts, via: v.via }]));

  test("public DNS + tunnel = internet; route without public DNS = lan; LoadBalancer = lan", () => {
    assert.deepEqual(view(build(["requests.example.net", "auth.example.net"])), {
      "media/Deployment/seerr": { exposure: "internet", hosts: ["requests.example.net"], via: ["HTTPRoute media/seerr"] },
      "monitoring/Deployment/grafana": { exposure: "lan", hosts: ["grafana.example.net"], via: ["HTTPRoute monitoring/grafana"] },
      // Direct tunnel rule, not an HTTPRoute; the worker isn't behind the Service.
      "authentik/Deployment/authentik-server": { exposure: "internet", hosts: ["auth.example.net"], via: ["tunnel auth.example.net"] },
      "adguard/StatefulSet/adguard": { exposure: "lan", hosts: [], via: ["Service adguard/adguard-dns (LoadBalancer)"] },
    });
  });

  test("a public record the tunnel doesn't forward is not internet", () => {
    const m = buildExposure({
      routes,
      services,
      pods,
      tunnel: [{ hostname: "auth.example.net", service: "http://authentik-server.authentik.svc.cluster.local:80" }, { service: "http_status:404" }],
      publicHosts: new Set(["requests.example.net"]),
      resolve: workloadResolver(pods, replicaSets, []),
    });
    assert.equal(m.get("media/Deployment/seerr")?.exposure, "lan");
  });

  test("hostnamesOf lists exact hostnames for the DNS check", () => {
    assert.deepEqual(hostnamesOf(routes, tunnel), ["auth.example.net", "grafana.example.net", "requests.example.net"]);
  });
});

// --- Priority -----------------------------------------------------------------

describe("priorityOf", () => {
  test("KEV first, then likely or exposed severe, then the rest", () => {
    assert.equal(priorityOf({ severity: "LOW", kev: true, epss: null, exposure: "internal" }), "P1");
    assert.equal(priorityOf({ severity: "MEDIUM", kev: false, epss: 0.2, exposure: "internal" }), "P2");
    assert.equal(priorityOf({ severity: "HIGH", kev: false, epss: 0, exposure: "internet" }), "P2");
    assert.equal(priorityOf({ severity: "MEDIUM", kev: false, epss: 0, exposure: "internet" }), "P4");
    assert.equal(priorityOf({ severity: "CRITICAL", kev: false, epss: 0.02, exposure: "internal" }), "P3");
    assert.equal(priorityOf({ severity: "HIGH", kev: false, epss: null, exposure: "lan" }), "P3");
    assert.equal(priorityOf({ severity: "CRITICAL", kev: false, epss: 0.001, exposure: "internal" }), "P4");
  });

  test("KEV caps the SLA", () => {
    assert.equal(slaDays("HIGH", false), 30);
    assert.equal(slaDays("HIGH", true), 7);
    assert.equal(slaDays("LOW", true), 7);
    assert.equal(slaDays("CRITICAL", true), 7);
  });
});

// --- Database -----------------------------------------------------------------

describe("intel, exposure and priority in the database", () => {
  let db: DB;
  beforeEach(async () => {
    const d = drizzle(new PGlite(), { schema });
    await migrate(d, { migrationsFolder: MIGRATIONS_DIR });
    db = d;
  });

  const addFinding = async (vulnId: string, severity: string, status = "open") => {
    const [f] = await db
      .insert(findings)
      .values({ imageRegistry: "r", imageRepository: `img-${vulnId}`, vulnId, pkgName: "p", severity, status, firstSeenAt: at(0), lastSeenAt: at(0) })
      .returning({ id: findings.id });
    return f!.id;
  };
  const kevOf = (ids: string[]) =>
    new Map(ids.map((id) => [id, { addedAt: new Date("2026-11-01T00:00:00Z"), dueAt: null, ransomware: false, name: id }]));
  const epssOf = (scores: Record<string, number>) => ({
    date: new Date("2026-11-27T00:00:00Z"),
    total: 300_000,
    scores: new Map(Object.entries(scores).map(([k, v]) => [k, { epss: v, percentile: 0.5 }])),
  });

  test("wantedIds skips non-CVE IDs", async () => {
    await addFinding("CVE-1", "HIGH");
    await addFinding("GHSA-xxxx", "HIGH");
    assert.deepEqual([...(await wantedIds(db))], ["CVE-1"]);
  });

  test("kev_listed events: baseline on the first run, real afterwards; a failed feed keeps old values", async () => {
    const f1 = await addFinding("CVE-1", "HIGH");
    const f2 = await addFinding("CVE-2", "MEDIUM");
    await addFinding("CVE-3", "LOW", "resolved");
    const ids = await wantedIds(db);

    const s1 = await applyIntel(db, ids, kevOf(["CVE-1", "CVE-3"]), epssOf({ "CVE-1": 0.5, "CVE-2": 0.01 }), at(0));
    assert.deepEqual(s1, { ids: 3, kevMatched: 2, epssMatched: 2, kevListedEvents: 1 }); // CVE-3's finding is resolved

    // KEV adds CVE-2; EPSS download failed this time.
    const s2 = await applyIntel(db, ids, kevOf(["CVE-1", "CVE-2", "CVE-3"]), undefined, at(10));
    assert.equal(s2.kevListedEvents, 1);
    assert.equal(s2.epssMatched, 2);

    const events = await db.select().from(findingEvents).where(eq(findingEvents.type, "kev_listed")).orderBy(asc(findingEvents.id));
    assert.deepEqual(
      events.map((e) => [e.findingId, (e.details as { baseline: boolean }).baseline]),
      [
        [f1, true],
        [f2, false],
      ],
    );
    const [cve1] = await db.select().from(vulnIntel).where(eq(vulnIntel.vulnId, "CVE-1"));
    assert.equal(cve1?.epss, 0.5);
    assert.equal(cve1?.kev, true);

    // Removed from KEV.
    await applyIntel(db, ids, kevOf([]), undefined, at(20));
    const [after] = await db.select().from(vulnIntel).where(eq(vulnIntel.vulnId, "CVE-1"));
    assert.equal(after?.kev, false);
  });

  const exposed = (ns: string, kind: string, name: string, exposure: "internet" | "lan"): [string, ExposedWorkload] => [
    `${ns}/${kind}/${name}`,
    { namespace: ns, kind, name, exposure, hosts: [], via: ["test"] },
  ];

  test("applyExposure upserts, deactivates what's gone, and ignores an empty run", async () => {
    const s1 = await applyExposure(db, new Map([exposed("a", "Deployment", "web", "internet"), exposed("b", "Deployment", "x", "lan")]), at(0));
    assert.deepEqual(s1, { internet: 1, lan: 1, deactivated: 0, skippedDeactivation: false });
    const s2 = await applyExposure(db, new Map([exposed("a", "Deployment", "web", "lan")]), at(10));
    assert.equal(s2.deactivated, 1);
    const s3 = await applyExposure(db, new Map(), at(20));
    assert.equal(s3.skippedDeactivation, true);

    const rows = await db.select().from(workloadExposure).orderBy(asc(workloadExposure.namespace));
    assert.deepEqual(
      rows.map((r) => [r.namespace, r.exposure, r.active, r.firstSeenAt.getTime() === at(0).getTime()]),
      [
        ["a", "lan", true, true],
        ["b", "lan", false, true],
      ],
    );
  });

  test("openByPriority uses the most exposed active sighting", async () => {
    const f1 = await addFinding("CVE-1", "HIGH"); // on an internet and an internal workload -> P2
    const f2 = await addFinding("CVE-2", "MEDIUM"); // KEV -> P1
    await addFinding("CVE-3", "LOW"); // nothing -> P4
    const sight = (findingId: number, ns: string, name: string, active = true) =>
      db.insert(findingSightings).values({
        findingId,
        namespace: ns,
        workloadKind: "Deployment",
        workloadName: name,
        container: "c",
        imageTag: "1",
        imageDigest: "sha256:x",
        firstSeenAt: at(0),
        lastSeenAt: at(0),
        active,
      });
    await sight(f1, "a", "web");
    await sight(f1, "b", "internal");
    await sight(f2, "c", "old", false); // inactive sighting on an exposed workload doesn't count
    await applyExposure(db, new Map([exposed("a", "Deployment", "web", "internet"), exposed("c", "Deployment", "old", "internet")]), at(0));
    await applyIntel(db, await wantedIds(db), kevOf(["CVE-2"]), epssOf({}), at(0));

    const counts = (await openByPriority(db)).sort((x, y) => x.priority.localeCompare(y.priority));
    assert.deepEqual(counts, [
      { priority: "P1", severity: "MEDIUM", exposure: "internal", kev: true, n: 1 },
      { priority: "P2", severity: "HIGH", exposure: "internet", kev: false, n: 1 },
      { priority: "P4", severity: "LOW", exposure: "internal", kev: false, n: 1 },
    ]);
  });
});
