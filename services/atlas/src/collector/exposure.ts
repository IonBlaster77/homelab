// Which workloads can be reached from outside the cluster, for ranking
// findings (priority.ts). Worked out from what the cluster already says:
//
//   internet  a hostname with a public DNS record that the Cloudflare tunnel
//             forwards: either through the shared Gateway (an HTTPRoute) or
//             straight to a Service (a direct tunnel rule, e.g. auth.*).
//             Cloudflare Access still sits in front, but it's reachable.
//   lan       an HTTPRoute whose hostnames have no public DNS record (so only
//             reachable through the Gateway's LAN VIP), or a LoadBalancer
//             Service.
//
// Anything else is internal only and has no row. A Service is followed to
// its pods by label selector, and each pod to its owning workload with the
// same fold-up as the policy ingest (workloadResolver), so the names match
// finding_sightings.
//
// Public DNS is checked through Cloudflare's DNS-over-HTTPS resolver, not the
// cluster's own DNS (AdGuard rewrites every hostname to the LAN VIP). Answers
// are cached for an hour.
import { inArray, sql } from "drizzle-orm";
import { workloadExposure } from "../db/schema.ts";
import type { DB } from "./apply.ts";
import type { HTTPRoute, MetadataOnly, Service } from "./k8s.ts";
import { workloadKey, type Workload } from "./policy-snapshot.ts";

export const DOH_URL = process.env.DOH_URL ?? "https://cloudflare-dns.com/dns-query";

export interface TunnelRule {
  /** Undefined for the catch-all rule. May be a wildcard ("*.example.net"). */
  hostname?: string;
  service: string;
}

export interface ExposedWorkload extends Workload {
  exposure: "internet" | "lan";
  hosts: string[];
  via: string[];
}

/**
 * cloudflared's config.yaml `ingress:` list. A line-based reader for the two
 * keys used (no YAML dependency): each `- hostname:` or `- service:` item
 * starts a rule, `service:` sets its target.
 */
export function parseTunnelIngress(configYaml: string): TunnelRule[] {
  const rules: TunnelRule[] = [];
  let inIngress = false;
  let cur: Partial<TunnelRule> | null = null;
  const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "");
  for (const raw of configYaml.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "");
    if (/^\S/.test(line)) {
      inIngress = /^ingress:\s*$/.test(line);
      continue;
    }
    if (!inIngress) continue;
    const item = /^\s*-\s+(hostname|service):\s*(.+)$/.exec(line);
    const key = /^\s+(hostname|service):\s*(.+)$/.exec(line);
    if (item) {
      if (cur?.service) rules.push(cur as TunnelRule);
      cur = { [item[1]!]: unquote(item[2]!) };
    } else if (key && cur) {
      cur[key[1] as "hostname" | "service"] = unquote(key[2]!);
    }
  }
  if (cur?.service) rules.push(cur as TunnelRule);
  return rules;
}

const hostMatches = (pattern: string, host: string) =>
  pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1 : pattern === host;

/** `http://name.ns.svc.cluster.local:80` -> { namespace, name }, else null. */
export function serviceOfUrl(url: string): { namespace: string; name: string } | null {
  const m = /^\w+:\/\/([a-z0-9-]+)\.([a-z0-9-]+)\.svc(?:\.[a-z0-9.-]+)?(?::\d+)?(?:\/|$)/.exec(url);
  return m ? { name: m[1]!, namespace: m[2]! } : null;
}

export interface ExposureInput {
  routes: HTTPRoute[];
  services: Service[];
  pods: MetadataOnly[];
  tunnel: TunnelRule[];
  /** Hostnames with a public DNS record. */
  publicHosts: Set<string>;
  resolve: (scope: { namespace?: string; kind: string; name: string }) => Workload | null;
}

/** Every hostname that appears in an HTTPRoute or a direct tunnel rule (for the DNS check). */
export function hostnamesOf(routes: HTTPRoute[], tunnel: TunnelRule[]): string[] {
  const hosts = new Set<string>();
  for (const r of routes) for (const h of r.spec?.hostnames ?? []) if (!h.includes("*")) hosts.add(h);
  for (const t of tunnel) if (t.hostname && !t.hostname.includes("*")) hosts.add(t.hostname);
  return [...hosts].sort();
}

export function buildExposure(input: ExposureInput): Map<string, ExposedWorkload> {
  const { routes, services, pods, tunnel, publicHosts, resolve } = input;
  const svc = new Map(services.map((s) => [`${s.metadata.namespace}/${s.metadata.name}`, s]));
  const podsByNs = new Map<string, MetadataOnly[]>();
  for (const p of pods) {
    const ns = p.metadata.namespace ?? "";
    let list = podsByNs.get(ns);
    if (!list) podsByNs.set(ns, (list = []));
    list.push(p);
  }

  // Direct tunnel rules: exact hostname -> a Service other than the Gateway.
  const direct = new Map<string, { namespace: string; name: string }>();
  for (const t of tunnel) {
    if (!t.hostname || t.hostname.includes("*")) continue;
    const s = serviceOfUrl(t.service);
    if (s && !s.name.startsWith("cilium-gateway-")) direct.set(t.hostname, s);
  }
  /** Reachable through the tunnel at all (some rule other than a 404 catch-all matches). */
  const tunnelled = (host: string) =>
    tunnel.some((t) => t.hostname && hostMatches(t.hostname, host) && !t.service.startsWith("http_status:"));
  const internet = (host: string) => publicHosts.has(host) && tunnelled(host);

  const out = new Map<string, ExposedWorkload>();
  const workloadsOfService = (namespace: string, name: string): Workload[] => {
    const sel = svc.get(`${namespace}/${name}`)?.spec?.selector;
    if (!sel || Object.keys(sel).length === 0) return []; // no selector: hand-made Endpoints, skip
    const found = new Map<string, Workload>();
    for (const p of podsByNs.get(namespace) ?? []) {
      const labels = p.metadata.labels ?? {};
      if (!Object.entries(sel).every(([k, v]) => labels[k] === v)) continue;
      const w = resolve({ namespace, kind: "Pod", name: p.metadata.name });
      if (w) found.set(workloadKey(w.namespace, w.kind, w.name), w);
    }
    return [...found.values()];
  };
  const add = (w: Workload, level: "internet" | "lan", hosts: string[], via: string) => {
    const key = workloadKey(w.namespace, w.kind, w.name);
    let e = out.get(key);
    if (!e) out.set(key, (e = { ...w, exposure: level, hosts: [], via: [] }));
    if (level === "internet") e.exposure = "internet";
    for (const h of hosts) if (!e.hosts.includes(h)) e.hosts.push(h);
    if (!e.via.includes(via)) e.via.push(via);
  };

  for (const r of routes) {
    const ns = r.metadata.namespace ?? "";
    const hosts = r.spec?.hostnames ?? [];
    const level = hosts.some(internet) ? "internet" : "lan";
    for (const rule of r.spec?.rules ?? []) {
      for (const b of rule.backendRefs ?? []) {
        if ((b.kind ?? "Service") !== "Service" || (b.group ?? "") !== "") continue;
        for (const w of workloadsOfService(b.namespace ?? ns, b.name)) add(w, level, hosts, `HTTPRoute ${ns}/${r.metadata.name}`);
      }
    }
  }
  for (const [host, s] of direct) {
    const level = internet(host) ? "internet" : "lan";
    for (const w of workloadsOfService(s.namespace, s.name)) add(w, level, [host], `tunnel ${host}`);
  }
  for (const s of services) {
    if (s.spec?.type !== "LoadBalancer") continue;
    const ns = s.metadata.namespace ?? "";
    for (const w of workloadsOfService(ns, s.metadata.name)) add(w, "lan", [], `Service ${ns}/${s.metadata.name} (LoadBalancer)`);
  }
  for (const e of out.values()) {
    e.hosts.sort();
    e.via.sort();
  }
  return out;
}

// --- Public DNS (DoH) -------------------------------------------------------

const dnsCache = new Map<string, { public: boolean; at: number }>();
const DNS_TTL = 3_600_000;

async function lookupPublic(host: string): Promise<boolean> {
  const url = new URL(DOH_URL);
  url.searchParams.set("name", host);
  url.searchParams.set("type", "A");
  const res = await fetch(url, { headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`DoH ${host}: HTTP ${res.status}`);
  const body = (await res.json()) as { Status?: number; Answer?: unknown[] };
  // 0 = NOERROR; a CNAME to the tunnel shows up as Answer entries. 3 = NXDOMAIN.
  return body.Status === 0 && Array.isArray(body.Answer) && body.Answer.length > 0;
}

/**
 * Hostnames with a public DNS record. A failed lookup reuses the last answer,
 * or counts as public if there is none (the safe side for ranking risk).
 * Throws if every lookup fails, so the previous exposure is kept instead.
 */
export async function publicHostnames(hosts: string[], now = Date.now()): Promise<{ hosts: Set<string>; failed: number }> {
  const out = new Set<string>();
  let failed = 0;
  await Promise.all(
    hosts.map(async (h) => {
      const c = dnsCache.get(h);
      if (c && now - c.at < DNS_TTL) {
        if (c.public) out.add(h);
        return;
      }
      try {
        const pub = await lookupPublic(h);
        dnsCache.set(h, { public: pub, at: now });
        if (pub) out.add(h);
      } catch {
        failed++;
        if (c ? c.public : true) out.add(h);
      }
    }),
  );
  if (hosts.length > 0 && failed === hosts.length) throw new Error(`public DNS check failed for all ${failed} hostnames`);
  return { hosts: out, failed };
}

// --- Database ---------------------------------------------------------------

export interface ExposureStats {
  internet: number;
  lan: number;
  deactivated: number;
  skippedDeactivation: boolean;
}

/** Current exposure -> workload_exposure (upsert active rows, deactivate the rest). */
export async function applyExposure(db: DB, current: Map<string, ExposedWorkload>, now: Date): Promise<ExposureStats> {
  const stats: ExposureStats = { internet: 0, lan: 0, deactivated: 0, skippedDeactivation: false };
  for (const e of current.values()) stats[e.exposure]++;
  await db.transaction(async (tx) => {
    const prev = await tx
      .select({ id: workloadExposure.id, namespace: workloadExposure.namespace, kind: workloadExposure.workloadKind, name: workloadExposure.workloadName })
      .from(workloadExposure)
      .where(sql`${workloadExposure.active}`);
    if (current.size > 0) {
      await tx
        .insert(workloadExposure)
        .values(
          [...current.values()].map((e) => ({
            namespace: e.namespace,
            workloadKind: e.kind,
            workloadName: e.name,
            exposure: e.exposure,
            hosts: e.hosts,
            via: e.via,
            firstSeenAt: now,
            lastSeenAt: now,
            active: true,
          })),
        )
        .onConflictDoUpdate({
          target: [workloadExposure.namespace, workloadExposure.workloadKind, workloadExposure.workloadName],
          set: {
            exposure: sql`excluded.exposure`,
            hosts: sql`excluded.hosts`,
            via: sql`excluded.via`,
            lastSeenAt: sql`excluded.last_seen_at`,
            active: sql`true`,
          },
        });
    }
    // Nothing exposed at all is far more likely an API hiccup than reality.
    if (current.size === 0 && prev.length > 0) {
      stats.skippedDeactivation = true;
      return;
    }
    const gone = prev.filter((p) => !current.has(workloadKey(p.namespace, p.kind, p.name))).map((p) => p.id);
    if (gone.length > 0) {
      await tx.update(workloadExposure).set({ active: false }).where(inArray(workloadExposure.id, gone));
      stats.deactivated = gone.length;
    }
  });
  return stats;
}
