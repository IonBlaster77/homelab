// Turns the raw Kubernetes objects into "what is true right now": the current
// findings (one per image repository + vulnerability + package), where each
// is seen, and the distinct raw reports. Pure: no I/O, so it's unit-tested.
import { createHash } from "node:crypto";
import type { ReplicaSet, VulnerabilityReport } from "./k8s.ts";
import { cleanTag } from "./prom.ts";

export interface Sighting {
  namespace: string;
  workloadKind: string;
  workloadName: string;
  container: string;
  imageTag: string;
  imageDigest: string;
  installedVersion: string | null;
}

export interface CurrentFinding {
  key: string;
  imageRegistry: string;
  imageRepository: string;
  vulnId: string;
  pkgName: string;
  pkgType: string | null;
  severity: string;
  title: string | null;
  score: number | null;
  primaryLink: string | null;
  links: string[];
  fixedVersion: string;
  publishedAt: Date | null;
  /** registry/repository:tag of every running image this finding is in. */
  imageTags: Set<string>;
  sightings: Sighting[];
}

export interface RawReport {
  imageDigest: string;
  imageRef: string;
  contentHash: string;
  report: VulnerabilityReport["report"];
}

export interface Snapshot {
  findings: Map<string, CurrentFinding>;
  reports: RawReport[];
  /** registry/repository of every image still running, vulnerable or not. */
  runningImages: Set<string>;
  reportCount: number;
  skippedReports: number;
}

const SEVERITY_RANK: Record<string, number> = { UNKNOWN: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

export const findingKey = (registry: string, repository: string, vulnId: string, pkg: string) =>
  `${registry}/${repository}|${vulnId}|${pkg}`;

const purlType = (purl?: string) => (purl?.startsWith("pkg:") ? purl.slice(4).split("/")[0] || null : null);

const dateOrNull = (s?: string) => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * @param reports    every VulnerabilityReport in the cluster
 * @param replicaSets every ReplicaSet, to drop reports of old rollout
 *                    revisions (scaled to 0) and to name the owning Deployment
 */
export function buildSnapshot(reports: VulnerabilityReport[], replicaSets: ReplicaSet[]): Snapshot {
  const rs = new Map<string, { replicas: number; deployment?: string }>();
  for (const r of replicaSets) {
    const owner = r.metadata.ownerReferences?.find((o) => o.kind === "Deployment");
    rs.set(`${r.metadata.namespace}/${r.metadata.name}`, {
      replicas: r.spec?.replicas ?? 0,
      deployment: owner?.name,
    });
  }

  const findings = new Map<string, CurrentFinding>();
  const rawReports = new Map<string, RawReport>();
  const runningImages = new Set<string>();
  let skipped = 0;

  for (const vr of reports) {
    const labels = vr.metadata.labels ?? {};
    const namespace = labels["trivy-operator.resource.namespace"] ?? vr.metadata.namespace ?? "";
    let workloadKind = labels["trivy-operator.resource.kind"] ?? "Unknown";
    let workloadName = labels["trivy-operator.resource.name"] ?? vr.metadata.name;
    const container = labels["trivy-operator.container.name"] ?? "";

    if (workloadKind === "ReplicaSet") {
      const r = rs.get(`${namespace}/${workloadName}`);
      // Gone, or kept at 0 replicas for rollback: not running anything.
      if (!r || r.replicas === 0) {
        skipped++;
        continue;
      }
      if (r.deployment) {
        workloadKind = "Deployment";
        workloadName = r.deployment;
      }
    }

    const registry = vr.report.registry?.server ?? "";
    const repository = vr.report.artifact.repository;
    const tag = cleanTag(vr.report.artifact.tag ?? "");
    const digest = vr.report.artifact.digest ?? "";
    const image = `${registry}/${repository}`;
    runningImages.add(image);

    const vulns = vr.report.vulnerabilities ?? [];
    // Hash only the fields that matter, not timestamps or link lists, so a
    // daily rescan that finds the same things doesn't store a new copy.
    const stable = vulns
      .map((v) => [v.vulnerabilityID, v.resource, v.installedVersion ?? "", v.fixedVersion ?? "", v.severity].join("\u0000"))
      .sort()
      .join("\n");
    const contentHash = createHash("sha256").update(stable).digest("hex");
    const rawKey = `${digest}|${contentHash}`;
    if (!rawReports.has(rawKey)) {
      rawReports.set(rawKey, { imageDigest: digest, imageRef: `${image}:${tag}`, contentHash, report: vr.report });
    }

    for (const v of vulns) {
      const key = findingKey(registry, repository, v.vulnerabilityID, v.resource);
      const severity = (v.severity || "UNKNOWN").toUpperCase();
      let f = findings.get(key);
      if (!f) {
        f = {
          key,
          imageRegistry: registry,
          imageRepository: repository,
          vulnId: v.vulnerabilityID,
          pkgName: v.resource,
          pkgType: purlType(v.packagePURL),
          severity,
          title: v.title ?? null,
          score: v.score ?? null,
          primaryLink: v.primaryLink ?? null,
          links: v.links ?? [],
          fixedVersion: v.fixedVersion ?? "",
          publishedAt: dateOrNull(v.publishedDate),
          imageTags: new Set(),
          sightings: [],
        };
        findings.set(key, f);
      } else {
        // Same CVE + package in several tags or workloads: keep the worst
        // severity and any published fix.
        if ((SEVERITY_RANK[severity] ?? 0) > (SEVERITY_RANK[f.severity] ?? 0)) f.severity = severity;
        if (!f.fixedVersion && v.fixedVersion) f.fixedVersion = v.fixedVersion;
      }
      f.imageTags.add(`${image}:${tag}`);
      if (
        !f.sightings.some(
          (s) =>
            s.namespace === namespace &&
            s.workloadKind === workloadKind &&
            s.workloadName === workloadName &&
            s.container === container &&
            s.imageDigest === digest,
        )
      ) {
        f.sightings.push({
          namespace,
          workloadKind,
          workloadName,
          container,
          imageTag: tag,
          imageDigest: digest,
          installedVersion: v.installedVersion ?? null,
        });
      }
    }
  }

  return {
    findings,
    reports: [...rawReports.values()],
    runningImages,
    reportCount: reports.length - skipped,
    skippedReports: skipped,
  };
}
