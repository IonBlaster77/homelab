// Turns Kyverno's PolicyReports into "what is true right now", per workload:
// which policies each one passes and fails. Pure: no I/O, so it's unit-tested.
//
// Kyverno writes one report per checked object, and pod policies are also
// applied to the controllers (autogen), so one Deployment shows up as the
// Deployment, each of its ReplicaSets and each Pod. Pods and ReplicaSets get
// new names on every rollout, so results are folded up to the owning
// workload:
//   Pod -> ReplicaSet -> Deployment      Pod -> Job -> CronJob
//   Pod -> StatefulSet / DaemonSet / any other controller (CNPG Cluster,
//          Longhorn InstanceManager, ...)
//   Pod with no owner, or a static pod (owned by its Node) -> itself
// A workload fails a policy if any of its objects does.
import type { MetadataOnly, ObjectMeta, PolicyReport, ReplicaSet } from "./k8s.ts";

export interface CurrentViolation {
  key: string;
  policy: string;
  rule: string;
  category: string;
  severity: string;
  source: string;
  namespace: string;
  resourceKind: string;
  resourceName: string;
  message: string;
}

export interface PolicyResultCount {
  policy: string;
  category: string;
  /** Workloads, not raw objects. */
  pass: number;
  fail: number;
  error: number;
}

export interface PolicySnapshot {
  violations: Map<string, CurrentViolation>;
  /** Per policy: how many workloads pass, fail or errored. */
  results: Map<string, PolicyResultCount>;
  /** namespace/kind/name of every workload that appears in any report. */
  workloads: Set<string>;
  reportCount: number;
  skippedReports: number;
}

export const workloadKey = (namespace: string, kind: string, name: string) => `${namespace}/${kind}/${name}`;

export const violationKey = (policy: string, rule: string, namespace: string, kind: string, name: string) =>
  `${policy}|${rule}|${workloadKey(namespace, kind, name)}`;

const controllerOf = (m: ObjectMeta | undefined) =>
  m?.ownerReferences?.find((o) => o.controller) ?? m?.ownerReferences?.[0];

export interface Workload {
  namespace: string;
  kind: string;
  name: string;
}

/**
 * The fold-up described at the top, as a function: object -> owning workload,
 * or null when it runs nothing (a Pod already gone, an old ReplicaSet). Also
 * used by exposure.ts, so both agree on what a workload is.
 *
 * @param pods        every Pod's metadata (owners)
 * @param replicaSets every ReplicaSet: old rollout revisions (0 replicas) are
 *                    skipped, the rest name their Deployment
 * @param jobs        every Job's metadata: Jobs a CronJob made fold up to it
 */
export function workloadResolver(
  pods: MetadataOnly[],
  replicaSets: ReplicaSet[],
  jobs: MetadataOnly[],
): (scope: { namespace?: string; kind: string; name: string }) => Workload | null {
  const podMeta = new Map(pods.map((p) => [`${p.metadata.namespace}/${p.metadata.name}`, p.metadata]));
  const rs = new Map(
    replicaSets.map((r) => [
      `${r.metadata.namespace}/${r.metadata.name}`,
      { replicas: r.spec?.replicas ?? 0, deployment: r.metadata.ownerReferences?.find((o) => o.kind === "Deployment")?.name },
    ]),
  );
  const cronJobOf = new Map(
    jobs.map((j) => [
      `${j.metadata.namespace}/${j.metadata.name}`,
      j.metadata.ownerReferences?.find((o) => o.kind === "CronJob")?.name,
    ]),
  );

  return (scope) => {
    const namespace = scope.namespace ?? "";
    let kind = scope.kind;
    let name = scope.name;
    if (kind === "Pod") {
      const meta = podMeta.get(`${namespace}/${name}`);
      if (!meta) return null; // deleted between the two list calls
      const owner = controllerOf(meta);
      // Static (mirror) pods are "owned" by their Node; folding them would
      // merge kube-apiserver, scheduler etc. into one. Their names are stable.
      if (owner && owner.kind !== "Node") {
        kind = owner.kind;
        name = owner.name;
      }
    }
    if (kind === "ReplicaSet") {
      const r = rs.get(`${namespace}/${name}`);
      // Gone, or kept at 0 replicas for rollback: not running anything.
      if (!r || r.replicas === 0) return null;
      if (r.deployment) {
        kind = "Deployment";
        name = r.deployment;
      }
    }
    if (kind === "Job") {
      const cronJob = cronJobOf.get(`${namespace}/${name}`);
      if (cronJob) {
        kind = "CronJob";
        name = cronJob;
      }
    }
    return { namespace, kind, name };
  };
}

/**
 * @param reports     every PolicyReport and ClusterPolicyReport
 * @param pods, replicaSets, jobs  see workloadResolver
 */
export function buildPolicySnapshot(
  reports: PolicyReport[],
  pods: MetadataOnly[],
  replicaSets: ReplicaSet[],
  jobs: MetadataOnly[],
): PolicySnapshot {
  /** The workload an object belongs to, or null to skip its report. */
  const resolve = workloadResolver(pods, replicaSets, jobs);

  // Per workload + policy + rule: the worst result seen, and the first
  // failure message.
  const RANK: Record<string, number> = { pass: 0, error: 1, fail: 2 };
  const agg = new Map<
    string,
    { result: string; message: string; policy: string; rule: string; category: string; severity: string; source: string; w: { namespace: string; kind: string; name: string } }
  >();
  const workloads = new Set<string>();
  let skipped = 0;
  let counted = 0;

  for (const report of reports) {
    if (!report.scope) {
      skipped++;
      continue;
    }
    const w = resolve(report.scope);
    if (!w) {
      skipped++;
      continue;
    }
    counted++;
    workloads.add(workloadKey(w.namespace, w.kind, w.name));
    for (const r of report.results ?? []) {
      // warn is Kyverno's "Audit + warn"; it still means the check failed.
      const result = r.result === "warn" ? "fail" : r.result;
      if (!(result in RANK)) continue; // skip
      const rule = r.rule ?? "";
      const key = violationKey(r.policy, rule, w.namespace, w.kind, w.name);
      const prev = agg.get(key);
      if (!prev) {
        agg.set(key, {
          result,
          message: result === "fail" ? (r.message ?? "") : "",
          policy: r.policy,
          rule,
          category: r.category ?? "",
          severity: r.severity ?? "",
          source: r.source ?? "",
          w,
        });
      } else if ((RANK[result] ?? 0) > (RANK[prev.result] ?? 0)) {
        prev.result = result;
        if (result === "fail") prev.message = r.message ?? "";
      }
    }
  }

  const violations = new Map<string, CurrentViolation>();
  const results = new Map<string, PolicyResultCount>();
  for (const [key, a] of agg) {
    let c = results.get(a.policy);
    if (!c) {
      c = { policy: a.policy, category: a.category, pass: 0, fail: 0, error: 0 };
      results.set(a.policy, c);
    }
    if (a.result === "pass") c.pass++;
    else if (a.result === "error") c.error++;
    else {
      c.fail++;
      violations.set(key, {
        key,
        policy: a.policy,
        rule: a.rule,
        category: a.category,
        severity: a.severity,
        source: a.source,
        namespace: a.w.namespace,
        resourceKind: a.w.kind,
        resourceName: a.w.name,
        message: a.message,
      });
    }
  }

  return { violations, results, workloads, reportCount: counted, skippedReports: skipped };
}
