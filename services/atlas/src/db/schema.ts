// Atlas database schema (Drizzle). The single source of truth for the tables:
// `npm run db:generate` turns changes here into a versioned SQL migration in
// src/db/migrations/, which the collector applies on start.
//
// Design rules (docs/projects/atlas.md, "What's worth getting right now"):
//   - Record events, not just current state: every change to a finding is an
//     append-only row in finding_events, so new metrics (SLA clocks,
//     time-to-fix) can be computed back over the whole history.
//   - Keep raw input: scan_reports holds each distinct Trivy report, so fields
//     we don't extract today can be extracted later for past data too.
//   - Stable identity: a finding is image repository + vulnerability +
//     package, the same key as the Trivy alert rules. Where it was seen
//     (workload, tag, digest) lives in finding_sightings. A policy violation
//     is policy + rule + workload (namespace, kind, name).
import {
  bigint,
  bigserial,
  boolean,
  index,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** One vulnerability in one image repository's package, across all its tags. */
export const findings = pgTable(
  "findings",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    // Identity
    imageRegistry: text("image_registry").notNull(),
    imageRepository: text("image_repository").notNull(),
    vulnId: text("vuln_id").notNull(),
    pkgName: text("pkg_name").notNull(),
    // Attributes (latest seen)
    /** PURL type: deb, apk, rpm (OS packages) or golang, pypi, npm, nuget... */
    pkgType: text("pkg_type"),
    /** CRITICAL, HIGH, MEDIUM, LOW or UNKNOWN. */
    severity: text("severity").notNull(),
    title: text("title"),
    score: real("score"),
    primaryLink: text("primary_link"),
    links: jsonb("links").$type<string[]>(),
    /** Empty string = no fixed version published (yet). */
    fixedVersion: text("fixed_version").notNull().default(""),
    publishedAt: ts("published_at"),
    // Lifecycle
    /** open | resolved */
    status: text("status").notNull().default("open"),
    /**
     * How it was closed. Automatic: patched (image still runs, finding gone),
     * removed (no workload runs the image any more), unknown (backfilled from
     * Prometheus). Later, set by people/agents: mitigated, not_affected,
     * risk_accepted, false_positive.
     */
    resolution: text("resolution"),
    firstSeenAt: ts("first_seen_at").notNull(),
    lastSeenAt: ts("last_seen_at").notNull(),
    /** Exposure clock starts at firstSeenAt; this is when a fixed version appeared. */
    fixAvailableAt: ts("fix_available_at"),
    /**
     * Remediation clock (SLA): when the fix came within our control. v1
     * heuristic: fixable AND a newer same-line tag of a running image exists
     * (image-update-exporter). Set once; not cleared.
     */
    fixInControlAt: ts("fix_in_control_at"),
    resolvedAt: ts("resolved_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("findings_identity").on(t.imageRegistry, t.imageRepository, t.vulnId, t.pkgName),
    index("findings_status_severity").on(t.status, t.severity),
    index("findings_vuln_id").on(t.vulnId),
  ],
);

/** Where a finding is (or was) seen: one row per workload container + image digest. */
export const findingSightings = pgTable(
  "finding_sightings",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    findingId: bigint("finding_id", { mode: "number" })
      .notNull()
      .references(() => findings.id, { onDelete: "cascade" }),
    namespace: text("namespace").notNull(),
    /** The owning workload: Deployment (resolved from its ReplicaSet), StatefulSet, DaemonSet, CronJob, Job or Pod. */
    workloadKind: text("workload_kind").notNull(),
    workloadName: text("workload_name").notNull(),
    container: text("container").notNull(),
    imageTag: text("image_tag").notNull(),
    imageDigest: text("image_digest").notNull(),
    installedVersion: text("installed_version"),
    firstSeenAt: ts("first_seen_at").notNull(),
    lastSeenAt: ts("last_seen_at").notNull(),
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    uniqueIndex("finding_sightings_identity").on(
      t.findingId,
      t.namespace,
      t.workloadKind,
      t.workloadName,
      t.container,
      t.imageDigest,
    ),
    index("finding_sightings_active").on(t.active, t.namespace),
  ],
);

/**
 * Append-only history. Types: first_seen, fix_available, fix_in_control,
 * severity_changed, resolved, reopened. `details` holds the before/after
 * values and the source (collector or backfill).
 */
export const findingEvents = pgTable(
  "finding_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    findingId: bigint("finding_id", { mode: "number" })
      .notNull()
      .references(() => findings.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    at: ts("at").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>(),
  },
  (t) => [index("finding_events_finding").on(t.findingId, t.at), index("finding_events_type_at").on(t.type, t.at)],
);

/**
 * Each distinct Trivy report, kept raw. A report is stored once per image
 * digest + content hash; repeat sightings only move last_seen_at, so this
 * grows only when a rescan finds something different.
 */
export const scanReports = pgTable(
  "scan_reports",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    imageDigest: text("image_digest").notNull(),
    imageRef: text("image_ref").notNull(),
    contentHash: text("content_hash").notNull(),
    report: jsonb("report").notNull(),
    firstSeenAt: ts("first_seen_at").notNull(),
    lastSeenAt: ts("last_seen_at").notNull(),
  },
  (t) => [uniqueIndex("scan_reports_identity").on(t.imageDigest, t.contentHash)],
);

/**
 * One Kyverno policy (rule) failing on one workload. Kyverno reports every
 * Pod, ReplicaSet and controller separately; the collector folds those up to
 * the owning workload (policy-snapshot.ts), so a rollout doesn't look like a
 * violation fixed and re-raised. Cluster-scoped objects (Namespaces) have
 * namespace "".
 */
export const policyViolations = pgTable(
  "policy_violations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    // Identity
    policy: text("policy").notNull(),
    /** Kyverno rule name; "validation" for CEL ValidatingPolicies. */
    rule: text("rule").notNull(),
    namespace: text("namespace").notNull(),
    resourceKind: text("resource_kind").notNull(),
    resourceName: text("resource_name").notNull(),
    // Attributes (latest seen)
    /** e.g. "Pod Security Standards (Baseline)", "Manifest standards". */
    category: text("category").notNull().default(""),
    severity: text("severity").notNull().default(""),
    /** e.g. KyvernoValidatingPolicy. */
    source: text("source").notNull().default(""),
    message: text("message").notNull().default(""),
    // Lifecycle
    /** open | resolved */
    status: text("status").notNull().default("open"),
    /**
     * Automatic: fixed (the workload still exists and now passes), removed
     * (nothing reports the workload any more). Later, set by people/agents:
     * exception (a reviewed PolicyException), risk_accepted.
     */
    resolution: text("resolution"),
    /**
     * Present in the very first policy run, so "new this week" doesn't count
     * the whole starting backlog.
     */
    baseline: boolean("baseline").notNull().default(false),
    firstSeenAt: ts("first_seen_at").notNull(),
    lastSeenAt: ts("last_seen_at").notNull(),
    resolvedAt: ts("resolved_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("policy_violations_identity").on(t.policy, t.rule, t.namespace, t.resourceKind, t.resourceName),
    index("policy_violations_status_category").on(t.status, t.category),
    index("policy_violations_workload").on(t.namespace, t.resourceKind, t.resourceName),
  ],
);

/** Append-only history of policy violations. Types: first_seen, resolved, reopened. */
export const policyViolationEvents = pgTable(
  "policy_violation_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    violationId: bigint("violation_id", { mode: "number" })
      .notNull()
      .references(() => policyViolations.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    at: ts("at").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>(),
  },
  (t) => [
    index("policy_violation_events_violation").on(t.violationId, t.at),
    index("policy_violation_events_type_at").on(t.type, t.at),
  ],
);

/** One row per collector run, for health checks and debugging. */
export const collectorRuns = pgTable("collector_runs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  kind: text("kind").notNull().default("collect"), // collect | backfill
  startedAt: ts("started_at").notNull(),
  finishedAt: ts("finished_at"),
  ok: boolean("ok"),
  stats: jsonb("stats").$type<Record<string, unknown>>(),
  error: text("error"),
});
