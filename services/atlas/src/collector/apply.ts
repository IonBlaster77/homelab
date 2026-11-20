// Writes a snapshot into the database: new findings, changes, resolutions and
// re-openings, each as an event, plus sightings and raw reports. Runs in one
// transaction, so a failed run leaves the previous state intact.
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { findingEvents, findings, findingSightings, scanReports } from "../db/schema.ts";
import { findingKey, type Snapshot } from "./snapshot.ts";

// Any Postgres driver: node-postgres in the cluster, PGlite in the tests.
export type DB = PgDatabase<any, any, any>;
type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

export interface ApplyOptions {
  now: Date;
  /** registry/repository:tag of images with a newer same-line tag. */
  imagesWithUpdate: Set<string>;
  /**
   * Report count of the last good run. If this run sees far fewer (an API
   * hiccup, Trivy rescanning everything), nothing is resolved or deactivated.
   */
  previousReportCount?: number;
  source?: string;
}

export interface ApplyStats {
  reports: number;
  skippedReports: number;
  current: number;
  created: number;
  reopened: number;
  resolved: number;
  fixAvailable: number;
  fixInControl: number;
  severityChanged: number;
  sightingsCreated: number;
  sightingsDeactivated: number;
  rawReportsStored: number;
  resolutionSkipped: boolean;
}

const chunk = <T>(xs: T[], n = 5000): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

type EventRow = typeof findingEvents.$inferInsert;

export async function applySnapshot(db: DB, snap: Snapshot, opts: ApplyOptions): Promise<ApplyStats> {
  const { now } = opts;
  const source = opts.source ?? "collector";
  const stats: ApplyStats = {
    reports: snap.reportCount,
    skippedReports: snap.skippedReports,
    current: snap.findings.size,
    created: 0,
    reopened: 0,
    resolved: 0,
    fixAvailable: 0,
    fixInControl: 0,
    severityChanged: 0,
    sightingsCreated: 0,
    sightingsDeactivated: 0,
    rawReportsStored: 0,
    resolutionSkipped: false,
  };
  const prev = opts.previousReportCount ?? 0;
  const allowResolve = !(prev > 0 && snap.reportCount < prev * 0.5);
  stats.resolutionSkipped = !allowResolve;

  await db.transaction(async (tx: Tx) => {
    const existing = await tx
      .select({
        id: findings.id,
        imageRegistry: findings.imageRegistry,
        imageRepository: findings.imageRepository,
        vulnId: findings.vulnId,
        pkgName: findings.pkgName,
        status: findings.status,
        severity: findings.severity,
        fixedVersion: findings.fixedVersion,
        fixAvailableAt: findings.fixAvailableAt,
        fixInControlAt: findings.fixInControlAt,
        title: findings.title,
      })
      .from(findings);
    const byKey = new Map(existing.map((e) => [findingKey(e.imageRegistry, e.imageRepository, e.vulnId, e.pkgName), e]));

    const events: EventRow[] = [];
    const ids = new Map<string, number>(); // key -> finding id, for sightings
    const seenIds: number[] = [];

    // New findings, inserted in batches.
    const fresh = [...snap.findings.values()].filter((f) => !byKey.has(f.key));
    for (const part of chunk(fresh, 500)) {
      const rows = await tx
        .insert(findings)
        .values(
          part.map((f) => {
            const inControl = f.fixedVersion !== "" && [...f.imageTags].some((t) => opts.imagesWithUpdate.has(t));
            return {
              imageRegistry: f.imageRegistry,
              imageRepository: f.imageRepository,
              vulnId: f.vulnId,
              pkgName: f.pkgName,
              pkgType: f.pkgType,
              severity: f.severity,
              title: f.title,
              score: f.score,
              primaryLink: f.primaryLink,
              links: f.links,
              fixedVersion: f.fixedVersion,
              publishedAt: f.publishedAt,
              status: "open",
              firstSeenAt: now,
              lastSeenAt: now,
              fixAvailableAt: f.fixedVersion ? now : null,
              fixInControlAt: inControl ? now : null,
            };
          }),
        )
        .returning({ id: findings.id, fixAvailableAt: findings.fixAvailableAt, fixInControlAt: findings.fixInControlAt });
      rows.forEach((r, i) => {
        const f = part[i]!;
        ids.set(f.key, r.id);
        events.push({ findingId: r.id, type: "first_seen", at: now, details: { source, severity: f.severity } });
        if (r.fixAvailableAt) {
          events.push({ findingId: r.id, type: "fix_available", at: now, details: { source, fixedVersion: f.fixedVersion } });
          stats.fixAvailable++;
        }
        if (r.fixInControlAt) {
          events.push({ findingId: r.id, type: "fix_in_control", at: now, details: { source, images: [...f.imageTags] } });
          stats.fixInControl++;
        }
      });
      stats.created += part.length;
    }

    // Existing findings: re-open, record changes, move last_seen.
    for (const f of snap.findings.values()) {
      const e = byKey.get(f.key);
      if (!e) continue;
      ids.set(f.key, e.id);
      seenIds.push(e.id);
      const set: Partial<typeof findings.$inferInsert> = {};
      if (e.status !== "open") {
        Object.assign(set, { status: "open", resolution: null, resolvedAt: null });
        events.push({ findingId: e.id, type: "reopened", at: now, details: { source } });
        stats.reopened++;
      }
      if (e.severity !== f.severity) {
        set.severity = f.severity;
        events.push({ findingId: e.id, type: "severity_changed", at: now, details: { source, from: e.severity, to: f.severity } });
        stats.severityChanged++;
      }
      if (e.fixedVersion !== f.fixedVersion) {
        set.fixedVersion = f.fixedVersion;
        if (f.fixedVersion && !e.fixAvailableAt) {
          set.fixAvailableAt = now;
          events.push({ findingId: e.id, type: "fix_available", at: now, details: { source, fixedVersion: f.fixedVersion } });
          stats.fixAvailable++;
        }
      }
      const fixable = f.fixedVersion !== "";
      if (fixable && !e.fixInControlAt && [...f.imageTags].some((t) => opts.imagesWithUpdate.has(t))) {
        set.fixInControlAt = now;
        events.push({ findingId: e.id, type: "fix_in_control", at: now, details: { source, images: [...f.imageTags] } });
        stats.fixInControl++;
      }
      // Backfilled findings start without details (Prometheus has no titles).
      if (Object.keys(set).length > 0 || (e.title === null && f.title !== null)) {
        await tx
          .update(findings)
          .set({
            ...set,
            title: f.title,
            score: f.score,
            primaryLink: f.primaryLink,
            links: f.links,
            pkgType: f.pkgType,
            publishedAt: f.publishedAt,
            updatedAt: now,
          })
          .where(eq(findings.id, e.id));
      }
    }
    for (const part of chunk(seenIds)) {
      await tx.update(findings).set({ lastSeenAt: now }).where(inArray(findings.id, part));
    }

    // Open findings no longer seen: resolved. Patched if the image still
    // runs (a newer tag no longer has it), removed if nothing runs it.
    if (allowResolve) {
      for (const e of existing) {
        const key = findingKey(e.imageRegistry, e.imageRepository, e.vulnId, e.pkgName);
        if (e.status !== "open" || snap.findings.has(key)) continue;
        const resolution = snap.runningImages.has(`${e.imageRegistry}/${e.imageRepository}`) ? "patched" : "removed";
        await tx
          .update(findings)
          .set({ status: "resolved", resolution, resolvedAt: now, updatedAt: now })
          .where(eq(findings.id, e.id));
        events.push({ findingId: e.id, type: "resolved", at: now, details: { source, resolution } });
        stats.resolved++;
      }
    }

    // Sightings.
    const active = await tx
      .select({
        id: findingSightings.id,
        findingId: findingSightings.findingId,
        namespace: findingSightings.namespace,
        workloadKind: findingSightings.workloadKind,
        workloadName: findingSightings.workloadName,
        container: findingSightings.container,
        imageDigest: findingSightings.imageDigest,
      })
      .from(findingSightings)
      .where(eq(findingSightings.active, true));
    const sKey = (id: number, s: { namespace: string; workloadKind: string; workloadName: string; container: string; imageDigest: string }) =>
      [id, s.namespace, s.workloadKind, s.workloadName, s.container, s.imageDigest].join("|");
    const activeByKey = new Map(active.map((a) => [sKey(a.findingId, a), a.id]));
    const keep: number[] = [];
    const newSightings: (typeof findingSightings.$inferInsert)[] = [];
    for (const f of snap.findings.values()) {
      const id = ids.get(f.key)!;
      for (const s of f.sightings) {
        const existingId = activeByKey.get(sKey(id, s));
        if (existingId !== undefined) {
          keep.push(existingId);
          activeByKey.delete(sKey(id, s));
        } else {
          newSightings.push({ findingId: id, ...s, firstSeenAt: now, lastSeenAt: now, active: true });
        }
      }
    }
    for (const part of chunk(newSightings, 1000)) {
      // A sighting that was active before, went away and came back: revive it.
      await tx
        .insert(findingSightings)
        .values(part)
        .onConflictDoUpdate({
          target: [
            findingSightings.findingId,
            findingSightings.namespace,
            findingSightings.workloadKind,
            findingSightings.workloadName,
            findingSightings.container,
            findingSightings.imageDigest,
          ],
          set: { active: true, lastSeenAt: now, installedVersion: sql`excluded.installed_version` },
        });
    }
    stats.sightingsCreated = newSightings.length;
    for (const part of chunk(keep)) {
      await tx.update(findingSightings).set({ lastSeenAt: now }).where(inArray(findingSightings.id, part));
    }
    if (allowResolve) {
      const gone = [...activeByKey.values()];
      for (const part of chunk(gone)) {
        await tx.update(findingSightings).set({ active: false }).where(inArray(findingSightings.id, part));
      }
      stats.sightingsDeactivated = gone.length;
    }

    // Raw reports: store new ones, move last_seen on the rest.
    for (const r of snap.reports) {
      const updated = await tx
        .update(scanReports)
        .set({ lastSeenAt: now })
        .where(and(eq(scanReports.imageDigest, r.imageDigest), eq(scanReports.contentHash, r.contentHash)))
        .returning({ id: scanReports.id });
      if (updated.length === 0) {
        await tx.insert(scanReports).values({ ...r, firstSeenAt: now, lastSeenAt: now });
        stats.rawReportsStored++;
      }
    }

    for (const part of chunk(events, 1000)) await tx.insert(findingEvents).values(part);
  });

  return stats;
}
