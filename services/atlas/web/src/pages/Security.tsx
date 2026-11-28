import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Clock, Flame, Globe, Radar, Timer, Wrench } from "lucide-react";
import { useMemo, useState, type ComponentType } from "react";
import { EChart, cssVar, useColorScheme, type EChartsOption } from "../components/EChart";
import { api, type FindingRow, type Priority, type Severity, type Summary } from "../lib/api";
import { ago, Card, CardHeader, cn, fmt, PRIORITIES, PRIORITY_INFO, SEVERITIES, shortImage } from "../lib/ui";
import { FindingDrawer } from "./FindingDrawer";
import { FindingsTable } from "./FindingsTable";

export interface SecuritySearch {
  /** Comma-separated priorities, e.g. "P1,P2". */
  p?: string;
  sev?: string;
  exp?: string;
  q?: string;
  fixable?: boolean;
  image?: string;
  /** Open finding (detail panel). */
  f?: number;
}

const route = getRouteApi("/security");

export function SecurityPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const summary = useQuery({ queryKey: ["summary"], queryFn: api.summary });
  const findings = useQuery({ queryKey: ["findings"], queryFn: api.findings });
  const s = summary.data;

  const setSearch = (patch: Partial<SecuritySearch>) =>
    navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true, resetScroll: false });
  const togglePriority = (p: Priority) => {
    const cur = new Set((search.p ?? "").split(",").filter(Boolean));
    if (cur.size === 1 && cur.has(p)) cur.clear();
    else {
      cur.clear();
      cur.add(p);
    }
    setSearch({ p: cur.size ? [...cur].join(",") : undefined });
    document.getElementById("findings")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-5 md:px-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Security</h1>
          <p className="mt-0.5 text-sm text-muted">
            Vulnerabilities in every running image, ranked by real risk: known exploitation, exploit likelihood and exposure first, CVSS second.
          </p>
        </div>
        {s && (
          <div className="flex flex-wrap gap-2 text-xs text-muted">
            <Fresh icon={Radar} label="Trivy scan ingest" at={s.freshness.collector} />
            <Fresh icon={Flame} label="KEV + EPSS" at={s.freshness.intel} />
            <Fresh icon={Globe} label="Exposure" at={s.freshness.exposure} />
          </div>
        )}
      </header>

      {summary.isError && <ErrorBox message={String(summary.error)} />}

      {/* KPIs */}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {(["P1", "P2", "P3"] as const).map((p) => (
          <PriorityKpi key={p} p={p} n={s?.byPriority[p]} active={search.p === p} onClick={() => togglePriority(p)} />
        ))}
        <Kpi icon={Timer} label="SLA due in 7 days" value={s?.dueSoon} hint="Fix in our control, due soon" tone={s && s.dueSoon > 0 ? "warn" : "ok"} />
        <Kpi icon={Clock} label="Overdue" value={s?.overdue} hint="Past the remediation SLA" tone={s && s.overdue > 0 ? "bad" : "ok"} />
        <Kpi
          icon={Wrench}
          label="Fixable now"
          value={s?.inControl}
          hint={s ? `of ${fmt.format(s.total)} open · newer image tag exists` : ""}
          onClick={() => setSearch({ fixable: search.fixable ? undefined : true })}
          active={!!search.fixable}
        />
      </section>

      {/* Trend + top images */}
      <section className="mt-3 grid gap-3 xl:grid-cols-3">
        <TrendCard />
        <TopImages rows={findings.data} onPick={(image) => setSearch({ image, p: undefined })} active={search.image} />
      </section>

      {/* Findings */}
      <section id="findings" className="mt-3 scroll-mt-4">
        <FindingsTable rows={findings.data} loading={findings.isPending} error={findings.error} search={search} setSearch={setSearch} />
      </section>

      {/* Why priority, exposure, compliance */}
      <section className="mt-3 grid gap-3 lg:grid-cols-3">
        <SeverityVsPriority rows={findings.data} />
        <ExposureCard s={s} />
        <ComplianceCard s={s} />
      </section>

      <FindingDrawer id={search.f} onClose={() => setSearch({ f: undefined })} />
    </div>
  );
}

function Fresh({ icon: Icon, label, at }: { icon: ComponentType<{ className?: string }>; label: string; at: string | null }) {
  const stale = !at || Date.now() - new Date(at).getTime() > 3 * 3600_000 * (label.startsWith("KEV") ? 4 : 1);
  return (
    <span title={at ? new Date(at).toLocaleString() : "never"} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-panel px-2.5 py-1">
      <span className={cn("size-1.5 rounded-full", stale ? "bg-p2" : "bg-ok")} />
      <Icon className="size-3.5" />
      {label} · {ago(at)}
    </span>
  );
}

function ErrorBox({ message }: { message: string }) {
  return <div className="mb-3 rounded-lg border border-p1/40 bg-p1/10 px-3 py-2 text-sm text-p1">Couldn't load data: {message}</div>;
}

function PriorityKpi({ p, n, active, onClick }: { p: Priority; n: number | undefined; active: boolean; onClick: () => void }) {
  const i = PRIORITY_INFO[p];
  return (
    <button
      onClick={onClick}
      title={`${i.rule}. Click to filter.`}
      className={cn(
        "group relative overflow-hidden rounded-xl border border-line bg-panel p-4 text-left transition hover:border-faint",
        active && "ring-2 ring-inset " + i.ring,
      )}
    >
      <span className="absolute inset-y-0 left-0 w-1" style={{ background: i.color }} />
      <div className="flex items-center justify-between">
        <span className={cn("text-xs font-semibold", i.text)}>{p}</span>
        <span className="text-[11px] text-faint group-hover:text-muted">{active ? "filtered" : "filter"}</span>
      </div>
      <div className="tabular mt-1 text-2xl font-semibold">{n === undefined ? "–" : fmt.format(n)}</div>
      <div className="mt-0.5 text-xs text-muted">{i.label}</div>
    </button>
  );
}

function Kpi({
  icon: Icon,
  label,
  value,
  hint,
  tone,
  onClick,
  active,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: number | undefined;
  hint?: string;
  tone?: "ok" | "warn" | "bad";
  onClick?: () => void;
  active?: boolean;
}) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      onClick={onClick}
      className={cn("rounded-xl border border-line bg-panel p-4 text-left", onClick && "transition hover:border-faint", active && "ring-2 ring-inset ring-accent/50")}
    >
      <div className="flex items-center gap-1.5 text-xs text-muted">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div className={cn("tabular mt-1 text-2xl font-semibold", tone === "bad" && "text-p1", tone === "warn" && "text-p2", tone === "ok" && "text-ok")}>
        {value === undefined ? "–" : fmt.format(value)}
      </div>
      {hint && <div className="mt-0.5 truncate text-xs text-faint">{hint}</div>}
    </Comp>
  );
}

function TrendCard() {
  const [days, setDays] = useState(30);
  const [hideUnknown, setHideUnknown] = useState(true);
  const trend = useQuery({ queryKey: ["trend", days], queryFn: () => api.trend(days) });
  const scheme = useColorScheme();
  const sevs = SEVERITIES.filter((s) => !(hideUnknown && s === "UNKNOWN")).reverse();

  // Skip the empty days before history starts; days before the collector went
  // live were backfilled from Prometheus and undercount Medium/Low/Unknown.
  const d = useMemo(() => {
    const pts = trend.data?.points ?? [];
    const first = pts.findIndex((p) => Object.values(p.open).some((n) => (n ?? 0) > 0));
    return first > 0 ? pts.slice(first) : pts;
  }, [trend.data]);
  const liveDay = trend.data?.liveSince?.slice(0, 10);
  const liveIdx = liveDay ? d.findIndex((p) => p.day >= liveDay) : -1;

  const option = useMemo<EChartsOption>(() => {
    const line = cssVar("--color-line");
    const faint = cssVar("--color-faint");
    const backfill =
      liveIdx > 0
        ? {
            silent: true,
            itemStyle: { color: faint, opacity: 0.08 },
            label: { show: true, position: "insideTop", color: faint, fontSize: 10, formatter: "backfilled from Prometheus\n(no unfixed Med/Low/Unknown)" },
            data: [[{ xAxis: d[0]!.day.slice(5) }, { xAxis: d[liveIdx]!.day.slice(5) }]],
          }
        : undefined;
    return {
      grid: { left: 44, right: 12, top: 30, bottom: 26 },
      legend: { top: 0, left: 0, itemWidth: 10, itemHeight: 10, icon: "circle", textStyle: { fontSize: 11 } },
      tooltip: { trigger: "axis" },
      xAxis: {
        type: "category",
        data: d.map((p) => p.day.slice(5)),
        axisLine: { lineStyle: { color: line } },
        axisTick: { show: false },
        axisLabel: { fontSize: 11 },
      },
      yAxis: { type: "value", splitLine: { lineStyle: { color: line, opacity: 0.6 } }, axisLabel: { fontSize: 11 } },
      series: sevs.map((sev, i) => ({
        name: sev.charAt(0) + sev.slice(1).toLowerCase(),
        type: "line",
        stack: "open",
        symbol: "none",
        smooth: 0.2,
        lineStyle: { width: 1.5, color: cssVar(`--color-sev-${sev.toLowerCase()}`) },
        itemStyle: { color: cssVar(`--color-sev-${sev.toLowerCase()}`) },
        areaStyle: { opacity: 0.22 },
        data: d.map((p) => p.open[sev as Severity] ?? 0),
        ...(i === 0 && backfill ? { markArea: backfill } : {}),
      })),
    };
    // scheme: re-read the CSS variables when the theme flips.
  }, [d, liveIdx, hideUnknown, scheme]); // eslint-disable-line react-hooks/exhaustive-deps

  // Change since live collection started (or the window start, if later).
  const last = d.at(-1);
  const first = d[Math.max(liveIdx, 0)];
  const total = (p?: { open: Partial<Record<Severity, number>> }) =>
    p ? sevs.reduce((n, s) => n + (p.open[s] ?? 0), 0) : 0;
  const delta = last && first ? total(last) - total(first) : 0;
  const since = first ? new Date(`${first.day}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : "";

  return (
    <Card className="xl:col-span-2">
      <CardHeader
        title="Open findings over time"
        hint={
          trend.data
            ? `${delta <= 0 ? "▼" : "▲"} ${fmt.format(Math.abs(delta))} since ${since}${hideUnknown ? " · Unknown severity hidden" : ""}`
            : "Loading…"
        }
        right={
          <div className="flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted">
              <input type="checkbox" checked={!hideUnknown} onChange={(e) => setHideUnknown(!e.target.checked)} className="accent-accent" />
              Unknown
            </label>
            <Segmented value={days} options={[14, 30, 60]} onChange={setDays} render={(d) => `${d}d`} />
          </div>
        }
      />
      <EChart option={option} className="h-64 w-full px-2 pb-2" />
    </Card>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  render,
}: {
  value: T;
  options: T[];
  onChange: (v: T) => void;
  render?: (v: T) => string;
}) {
  return (
    <div className="flex rounded-lg border border-line bg-panel-2 p-0.5 text-xs">
      {options.map((o) => (
        <button
          key={String(o)}
          onClick={() => onChange(o)}
          className={cn("rounded-md px-2 py-0.5 text-muted", o === value && "bg-panel text-fg shadow-sm")}
        >
          {render ? render(o) : String(o)}
        </button>
      ))}
    </div>
  );
}

/** Images ranked by their worst findings: what to rebuild or bump first. */
function TopImages({ rows, onPick, active }: { rows: FindingRow[] | undefined; onPick: (image: string | undefined) => void; active?: string }) {
  const top = useMemo(() => {
    const m = new Map<string, { image: string; P1: number; P2: number; P3: number; fixable: number; internet: boolean }>();
    for (const f of rows ?? []) {
      if (f.priority === "P4") continue;
      let e = m.get(f.image);
      if (!e) m.set(f.image, (e = { image: f.image, P1: 0, P2: 0, P3: 0, fixable: 0, internet: false }));
      e[f.priority as "P1" | "P2" | "P3"]++;
      if (f.inControl) e.fixable++;
      if (f.exposure === "internet") e.internet = true;
    }
    return [...m.values()].sort((a, b) => b.P1 - a.P1 || b.P2 - a.P2 || b.P3 - a.P3).slice(0, 9);
  }, [rows]);
  const max = Math.max(1, ...top.map((t) => t.P1 + t.P2 + t.P3));

  return (
    <Card>
      <CardHeader
        title="Fix these images first"
        hint="Ranked by P1, then P2, then P3 findings"
        right={
          active && (
            <button onClick={() => onPick(undefined)} className="text-xs text-accent hover:underline">
              Clear filter
            </button>
          )
        }
      />
      <ul className="px-2 pb-3">
        {top.map((t) => (
          <li key={t.image}>
            <button
              onClick={() => onPick(active === t.image ? undefined : t.image)}
              className={cn("w-full rounded-lg px-2 py-1.5 text-left hover:bg-panel-2", active === t.image && "bg-panel-2")}
              title={t.image}
            >
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="flex min-w-0 items-center gap-1.5">
                  {t.internet && <Globe className="size-3 shrink-0 text-p2" />}
                  <span className="truncate font-mono">{shortImage(t.image)}</span>
                </span>
                <span className="tabular shrink-0 text-muted">
                  {t.P1 > 0 && <b className="text-p1">{t.P1} </b>}
                  {t.P2 > 0 && <span className="text-p2">{t.P2} </span>}
                  <span className="text-p3">{t.P3}</span>
                </span>
              </div>
              <div className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-panel-2">
                {PRIORITIES.slice(0, 3).map((p) => (
                  <span key={p} style={{ width: `${(t[p as "P1"] / max) * 100}%`, background: PRIORITY_INFO[p].color }} />
                ))}
              </div>
            </button>
          </li>
        ))}
        {rows && top.length === 0 && <li className="px-2 py-6 text-center text-sm text-muted">Nothing above P4. 🎉</li>}
      </ul>
    </Card>
  );
}

/** How the ranking reshuffles CVSS severity: each severity's findings split by priority. */
function SeverityVsPriority({ rows }: { rows: FindingRow[] | undefined }) {
  const scheme = useColorScheme();
  const option = useMemo<EChartsOption>(() => {
    const counts = new Map<string, number>();
    for (const f of rows ?? []) counts.set(`${f.severity}|${f.priority}`, (counts.get(`${f.severity}|${f.priority}`) ?? 0) + 1);
    const line = cssVar("--color-line");
    return {
      grid: { left: 70, right: 16, top: 26, bottom: 20 },
      legend: { top: 0, left: 0, itemWidth: 10, itemHeight: 10, icon: "circle", textStyle: { fontSize: 11 } },
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      xAxis: { type: "log", logBase: 10, min: 1, splitLine: { lineStyle: { color: line, opacity: 0.6 } }, axisLabel: { fontSize: 10 } },
      yAxis: {
        type: "category",
        inverse: true,
        data: SEVERITIES.map((s) => s.charAt(0) + s.slice(1).toLowerCase()),
        axisTick: { show: false },
        axisLine: { lineStyle: { color: line } },
        axisLabel: { fontSize: 11 },
      },
      series: PRIORITIES.map((p) => ({
        name: p,
        type: "bar",
        barMaxWidth: 10,
        itemStyle: { color: cssVar(`--color-${p.toLowerCase()}`), borderRadius: 2 },
        data: SEVERITIES.map((s) => counts.get(`${s}|${p}`) || null),
      })),
    };
  }, [rows, scheme]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Card>
      <CardHeader title="Severity vs priority" hint="Most Critical/High findings aren't urgent; some Medium/Unknown ones are (log scale)" />
      <EChart option={option} className="h-56 w-full px-2 pb-2" />
    </Card>
  );
}

function ExposureCard({ s }: { s: Summary | undefined }) {
  const items = [
    { k: "internet", label: "Internet-reachable", color: "var(--color-p2)", hint: "Public DNS + Cloudflare tunnel (behind Access)" },
    { k: "lan", label: "LAN-reachable", color: "var(--color-accent)", hint: "Gateway route without public DNS, or LoadBalancer" },
    { k: "internal", label: "Cluster-internal", color: "var(--color-p4)", hint: "No route in from outside" },
  ] as const;
  const total = s?.total ?? 0;
  return (
    <Card>
      <CardHeader title="Where findings are reachable" hint="By the most exposed workload running the image" />
      <div className="space-y-3 px-4 pb-4">
        {items.map((i) => {
          const n = s?.byExposure[i.k] ?? 0;
          return (
            <div key={i.k} title={i.hint}>
              <div className="flex justify-between text-xs">
                <span className="text-muted">{i.label}</span>
                <span className="tabular">
                  {fmt.format(n)} <span className="text-faint">· {total ? Math.round((n / total) * 100) : 0}%</span>
                </span>
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-panel-2">
                <div className="h-full rounded-full" style={{ width: `${total ? (n / total) * 100 : 0}%`, background: i.color }} />
              </div>
            </div>
          );
        })}
        <p className="pt-1 text-xs text-faint">
          {s ? `${fmt.format(s.imagesWithP1P2)} images hold every P1/P2 finding.` : ""}
        </p>
      </div>
    </Card>
  );
}

function ComplianceCard({ s }: { s: Summary | undefined }) {
  const total = s?.policy.reduce((n, p) => n + p.open, 0) ?? 0;
  const fixed = s?.policy.reduce((n, p) => n + p.resolved7d, 0) ?? 0;
  return (
    <Card>
      <CardHeader title="Policy compliance (Kyverno)" hint={s ? `${fmt.format(total)} open violations · ${fmt.format(fixed)} fixed this week` : ""} />
      <ul className="space-y-2 px-4 pb-4 text-xs">
        {s?.policy.map((p) => (
          <li key={p.category} className="flex items-center justify-between gap-2">
            <span className="truncate text-muted">{p.category}</span>
            <span className="tabular shrink-0">
              {fmt.format(p.open)}
              {p.resolved7d > 0 && <span className="ml-1.5 text-ok">−{p.resolved7d}</span>}
            </span>
          </li>
        ))}
        <li className="pt-1 text-faint">Full Compliance tab comes later.</li>
      </ul>
    </Card>
  );
}
