import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Flame, Globe, House, Lock, Skull, X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { api, type Exposure, type FindingDetail } from "../lib/api";
import { cn, date, ExposureBadge, KevBadge, pct, PRIORITY_INFO, PriorityBadge, SeverityBadge, shortImage } from "../lib/ui";

// Same rule as src/collector/priority.ts, explained for one finding.
/** Every rule that applies, highest first; the first one decides the priority. */
function why(f: FindingDetail["finding"], exposure: Exposure): string[] {
  const out: string[] = [];
  const severe = f.severity === "CRITICAL" || f.severity === "HIGH";
  if (f.kev) out.push("Known to be exploited in the wild (CISA KEV). The SLA is capped at 7 days.");
  if ((f.epss ?? 0) >= 0.1) out.push(`EPSS ${pct(f.epss)}: likely to be exploited in the next 30 days (≥ 10%).`);
  if (severe && exposure === "internet") out.push("Critical/High on a workload reachable from the internet.");
  if ((f.epss ?? 0) >= 0.01 && (f.epss ?? 0) < 0.1 && severe) out.push(`EPSS ${pct(f.epss)} on a ${f.severity.toLowerCase()} finding (≥ 1%).`);
  if (severe && exposure === "lan") out.push("Critical/High on a LAN-reachable workload.");
  if (out.length === 0) out.push("Not known exploited, low exploit likelihood, and not severe-and-exposed: backlog.");
  return out;
}

const PRIORITY_OF = (f: FindingDetail["finding"], exposure: Exposure) => {
  const severe = f.severity === "CRITICAL" || f.severity === "HIGH";
  const epss = f.epss ?? 0;
  if (f.kev) return "P1" as const;
  if (epss >= 0.1 || (severe && exposure === "internet")) return "P2" as const;
  if (severe && (epss >= 0.01 || exposure === "lan")) return "P3" as const;
  return "P4" as const;
};

const SLA: Record<string, number> = { CRITICAL: 7, HIGH: 30, MEDIUM: 90, LOW: 180, UNKNOWN: 180 };

export function FindingDrawer({ id, onClose }: { id: number | undefined; onClose: () => void }) {
  const q = useQuery({ queryKey: ["finding", id], queryFn: () => api.finding(id!), enabled: id !== undefined });

  useEffect(() => {
    if (id === undefined) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", h);
    return () => removeEventListener("keydown", h);
  }, [id, onClose]);

  if (id === undefined) return null;
  const d = q.data;
  const f = d?.finding;
  const rank = { internet: 2, lan: 1, internal: 0 } as const;
  const exposure: Exposure = (d?.exposure ?? []).reduce<Exposure>((m, e) => (rank[e.exposure] > rank[m] ? e.exposure : m), "internal");
  const sla = f ? Math.min(SLA[f.severity] ?? 180, f.kev ? 7 : Infinity) : 0;
  const due = f?.fix_in_control_at ? new Date(new Date(f.fix_in_control_at).getTime() + sla * 86_400_000) : null;
  const active = d?.sightings.filter((s) => s.active) ?? [];
  const versions = [...new Set(active.map((s) => s.installed_version).filter(Boolean))];

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" onClick={onClose} aria-label="Close" />
      <aside className="relative flex h-full w-full max-w-[620px] flex-col border-l border-line bg-panel shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            {f ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <PriorityBadge p={PRIORITY_OF(f, exposure)} long />
                  <SeverityBadge s={f.severity} />
                  {f.kev && <KevBadge />}
                  <ExposureBadge e={exposure} />
                </div>
                <h2 className="mt-2 font-mono text-lg font-semibold">{f.vuln_id}</h2>
                <p className="mt-0.5 text-sm text-muted">{f.title ?? "No title"}</p>
              </>
            ) : (
              <div className="h-16 w-72 animate-pulse rounded bg-panel-2" />
            )}
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-muted hover:bg-panel-2 hover:text-fg" aria-label="Close">
            <X className="size-5" />
          </button>
        </div>

        {q.isError && <div className="m-5 rounded-lg bg-p1/10 p-3 text-sm text-p1">{String(q.error)}</div>}

        {f && d && (
          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4 text-sm">
            <Section title="Why this priority">
              <ul className={cn("space-y-1 rounded-lg border-l-2 bg-panel-2 px-3 py-2", "border-[color:var(--c)]")} style={{ ["--c" as string]: PRIORITY_INFO[PRIORITY_OF(f, exposure)].color }}>
                {why(f, exposure).map((w, i) => (
                  <li key={w} className={cn(i > 0 && "text-muted")}>
                    {i > 0 && <span className="text-faint">Also: </span>}
                    {w}
                  </li>
                ))}
              </ul>
            </Section>

            <div className="grid grid-cols-2 gap-3">
              <Stat label="CVSS" value={f.score !== null ? Number(f.score).toFixed(1) : "—"} />
              <Stat
                label="EPSS (30-day exploit probability)"
                value={pct(f.epss)}
                hint={
                  f.epss_percentile === null
                    ? "not scored"
                    : Number(f.epss_percentile) >= 0.99
                      ? "top 1% of all CVEs"
                      : `higher than ${Math.floor(Number(f.epss_percentile) * 100)}% of CVEs`
                }
              />
              {f.kev && (
                <>
                  <Stat label="Added to KEV" value={date(f.kev_added_at)} icon={Flame} />
                  <Stat label="Ransomware use" value={f.kev_ransomware ? "Known" : "Not known"} icon={Skull} tone={f.kev_ransomware ? "bad" : undefined} />
                </>
              )}
            </div>

            <Section title="Package and fix">
              <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1.5">
                <dt className="text-muted">Package</dt>
                <dd className="font-mono">
                  {f.pkg_name} {f.pkg_type && <span className="text-faint">({f.pkg_type})</span>}
                </dd>
                <dt className="text-muted">Installed</dt>
                <dd className="font-mono">{versions.length ? versions.join(", ") : "—"}</dd>
                <dt className="text-muted">Fixed in</dt>
                <dd className={cn("font-mono", f.fixed_version ? "text-ok" : "text-faint")}>{f.fixed_version || "no fixed version published yet"}</dd>
                <dt className="text-muted">Image</dt>
                <dd className="truncate font-mono" title={`${f.image_registry}/${f.image_repository}`}>
                  {f.image_registry}/{f.image_repository}
                </dd>
              </dl>
            </Section>

            <Section title="Clocks">
              {f.fixed_version && !f.fix_in_control_at && (
                <p className="mb-2 rounded-lg bg-p2/10 px-3 py-2 text-xs text-p2">
                  A fix exists ({f.fixed_version}) but no newer tag of this image ships it yet, so the SLA clock hasn't started. Options: wait for
                  upstream, rebuild the image, or mitigate.
                </p>
              )}
              <Timeline
                items={[
                  { label: "Published", at: f.published_at },
                  { label: "First seen here (exposure clock starts)", at: f.first_seen_at },
                  { label: "Fix published", at: f.fix_available_at },
                  { label: "Fix within our control (SLA clock starts)", at: f.fix_in_control_at },
                  { label: `SLA due (${sla} days${f.kev ? ", KEV" : ""})`, at: due?.toISOString() ?? null, due: true },
                ]}
              />
            </Section>

            <Section title={`Running in ${active.length} place${active.length === 1 ? "" : "s"}`}>
              <ul className="divide-y divide-line rounded-lg border border-line">
                {active.map((s) => {
                  const e = d.exposure.find((x) => x.namespace === s.namespace && x.workload_kind === s.workload_kind && x.workload_name === s.workload_name);
                  const Icon = e?.exposure === "internet" ? Globe : e?.exposure === "lan" ? House : Lock;
                  return (
                    <li key={`${s.namespace}/${s.workload_kind}/${s.workload_name}/${s.container}/${s.image_digest}`} className="px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate">
                          <span className="text-muted">{s.namespace}/</span>
                          {s.workload_name} <span className="text-xs text-faint">{s.workload_kind} · {s.container}</span>
                        </span>
                        <Icon className={cn("size-4 shrink-0", e?.exposure === "internet" ? "text-p2" : "text-faint")} />
                      </div>
                      <div className="mt-0.5 truncate font-mono text-xs text-faint">
                        {shortImage(`${f.image_registry}/${f.image_repository}`)}:{s.image_tag}
                        {e && e.hosts.length > 0 && <span className="ml-2 text-p2">{e.hosts.join(", ")}</span>}
                      </div>
                    </li>
                  );
                })}
                {active.length === 0 && <li className="px-3 py-2 text-muted">No running workload (it'll resolve as removed).</li>}
              </ul>
            </Section>

            <Section title="History">
              <ol className="space-y-1.5">
                {d.events.map((e, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="tabular w-24 shrink-0 text-xs text-faint">{date(e.at)}</span>
                    <span className="text-xs">
                      {e.type.replace(/_/g, " ")}
                      {e.details?.source ? <span className="text-faint"> · {String(e.details.source)}</span> : null}
                      {e.details?.baseline ? <span className="text-faint"> (baseline)</span> : null}
                    </span>
                  </li>
                ))}
              </ol>
            </Section>

            {(f.primary_link || (f.links?.length ?? 0) > 0) && (
              <Section title="References">
                <ul className="space-y-1">
                  {[...new Set([f.primary_link, ...(f.links ?? [])].filter(Boolean) as string[])].slice(0, 8).map((l) => (
                    <li key={l}>
                      <a href={l} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1 truncate text-xs text-accent hover:underline">
                        <ExternalLink className="size-3 shrink-0" />
                        <span className="truncate">{l}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            <p className="border-t border-line pt-3 text-xs text-faint">
              Coming: link to the Renovate PR that fixes this, and triage (not affected / accepted, stored as VEX).
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h4 className="mb-1.5 text-xs font-semibold tracking-wide text-faint uppercase">{title}</h4>
      {children}
    </section>
  );
}

function Stat({ label, value, hint, icon: Icon, tone }: { label: string; value: string; hint?: string; icon?: typeof Flame; tone?: "bad" }) {
  return (
    <div className="rounded-lg border border-line bg-panel-2 px-3 py-2">
      <div className="flex items-center gap-1 text-[11px] text-muted">
        {Icon && <Icon className="size-3" />}
        {label}
      </div>
      <div className={cn("tabular mt-0.5 text-base font-semibold", tone === "bad" && "text-p1")}>{value}</div>
      {hint && <div className="text-[11px] text-faint">{hint}</div>}
    </div>
  );
}

function Timeline({ items }: { items: { label: string; at: string | null; due?: boolean }[] }) {
  const now = Date.now();
  return (
    <ol className="relative ml-1.5 space-y-2 border-l border-line pl-4">
      {items.map((i) => {
        const past = i.at && new Date(i.at).getTime() <= now;
        const overdue = i.due && past;
        return (
          <li key={i.label} className="relative">
            <span
              className={cn(
                "absolute top-1.5 -left-[21px] size-2.5 rounded-full border-2 border-panel",
                !i.at ? "bg-line" : overdue ? "bg-p1" : i.due ? "bg-p2" : "bg-accent",
              )}
            />
            <div className="flex justify-between gap-3 text-xs">
              <span className={cn(!i.at && "text-faint")}>{i.label}</span>
              <span className={cn("tabular shrink-0", overdue ? "font-semibold text-p1" : "text-muted")}>{i.at ? date(i.at) : "—"}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
