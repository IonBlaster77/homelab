import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { useDeferredValue, useMemo, useRef, useState, type ReactNode } from "react";
import type { Exposure, FindingRow, Priority, Severity } from "../lib/api";
import { Card, cn, ExposureBadge, fmt, KevBadge, pct, PRIORITIES, PriorityBadge, SEVERITIES, SEVERITY_INFO, SeverityBadge, shortImage } from "../lib/ui";
import type { SecuritySearch } from "./Security";

type SortKey = "priority" | "severity" | "epss" | "exposure" | "due" | "age" | "image";
const SEV_RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i])) as Record<Severity, number>;
const EXP_RANK: Record<Exposure, number> = { internet: 0, lan: 1, internal: 2 };
const P_RANK = Object.fromEntries(PRIORITIES.map((p, i) => [p, i])) as Record<Priority, number>;

/** Default order: priority, then exploit likelihood, then severity, then exposure. */
const byRisk = (a: FindingRow, b: FindingRow) =>
  P_RANK[a.priority] - P_RANK[b.priority] ||
  (b.epss ?? 0) - (a.epss ?? 0) ||
  SEV_RANK[a.severity] - SEV_RANK[b.severity] ||
  EXP_RANK[a.exposure] - EXP_RANK[b.exposure] ||
  a.id - b.id;

const COMPARE: Record<SortKey, (a: FindingRow, b: FindingRow) => number> = {
  priority: byRisk,
  severity: (a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || (b.score ?? 0) - (a.score ?? 0) || byRisk(a, b),
  epss: (a, b) => (b.epss ?? -1) - (a.epss ?? -1) || byRisk(a, b),
  exposure: (a, b) => EXP_RANK[a.exposure] - EXP_RANK[b.exposure] || byRisk(a, b),
  due: (a, b) => (b.overdueDays ?? -1e9) - (a.overdueDays ?? -1e9) || byRisk(a, b),
  age: (a, b) => b.ageDays - a.ageDays || byRisk(a, b),
  image: (a, b) => a.image.localeCompare(b.image) || byRisk(a, b),
};

const COLS = "grid-cols-[64px_minmax(190px,1.6fr)_86px_64px_92px_minmax(160px,1.3fr)_minmax(120px,1fr)_110px_96px_52px]";

export function FindingsTable({
  rows,
  loading,
  error,
  search,
  setSearch,
}: {
  rows: FindingRow[] | undefined;
  loading: boolean;
  error: Error | null;
  search: SecuritySearch;
  setSearch: (p: Partial<SecuritySearch>) => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "priority", desc: false });
  const [q, setQ] = useState(search.q ?? "");
  const dq = useDeferredValue(q.trim().toLowerCase());

  const pSet = useMemo(() => new Set((search.p ?? "").split(",").filter(Boolean)), [search.p]);
  const sevSet = useMemo(() => new Set((search.sev ?? "").split(",").filter(Boolean)), [search.sev]);
  const expSet = useMemo(() => new Set((search.exp ?? "").split(",").filter(Boolean)), [search.exp]);

  const filtered = useMemo(() => {
    const out = (rows ?? []).filter(
      (f) =>
        (pSet.size === 0 || pSet.has(f.priority)) &&
        (sevSet.size === 0 || sevSet.has(f.severity)) &&
        (expSet.size === 0 || expSet.has(f.exposure)) &&
        (!search.fixable || f.inControl) &&
        (!search.image || f.image === search.image) &&
        (!dq ||
          f.vulnId.toLowerCase().includes(dq) ||
          f.pkgName.toLowerCase().includes(dq) ||
          f.image.toLowerCase().includes(dq) ||
          f.workloads.some((w) => w.toLowerCase().includes(dq))),
    );
    const cmp = COMPARE[sort.key];
    out.sort(sort.desc ? (a, b) => cmp(b, a) : cmp);
    return out;
  }, [rows, pSet, sevSet, expSet, search.fixable, search.image, dq, sort]);

  const toggle = (key: "p" | "sev" | "exp", set: Set<string>, v: string) => {
    const n = new Set(set);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    setSearch({ [key]: n.size ? [...n].join(",") : undefined });
  };
  const anyFilter = pSet.size || sevSet.size || expSet.size || search.fixable || search.image || dq;

  const parent = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: filtered.length, getScrollElement: () => parent.current, estimateSize: () => 46, overscan: 12 });

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const f of rows ?? []) {
      c[f.priority] = (c[f.priority] ?? 0) + 1;
      c[f.severity] = (c[f.severity] ?? 0) + 1;
      c[f.exposure] = (c[f.exposure] ?? 0) + 1;
    }
    return c;
  }, [rows]);

  return (
    <Card className="overflow-hidden">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <h3 className="mr-2 text-sm font-semibold">Findings</h3>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onBlur={() => setSearch({ q: q.trim() || undefined })}
            placeholder="CVE, package, image, workload…"
            className="h-8 w-64 rounded-lg border border-line bg-panel-2 pr-2 pl-8 text-sm placeholder:text-faint focus:border-accent focus:outline-none"
          />
        </div>
        <ChipGroup>
          {PRIORITIES.map((p) => (
            <Chip key={p} on={pSet.has(p)} onClick={() => toggle("p", pSet, p)} n={counts[p]}>
              {p}
            </Chip>
          ))}
        </ChipGroup>
        <ChipGroup>
          {SEVERITIES.map((s) => (
            <Chip key={s} on={sevSet.has(s)} onClick={() => toggle("sev", sevSet, s)} n={counts[s]} dot={SEVERITY_INFO[s].color}>
              {SEVERITY_INFO[s].short}
            </Chip>
          ))}
        </ChipGroup>
        <ChipGroup>
          {(["internet", "lan", "internal"] as const).map((e) => (
            <Chip key={e} on={expSet.has(e)} onClick={() => toggle("exp", expSet, e)} n={counts[e]}>
              {e === "lan" ? "LAN" : e[0]!.toUpperCase() + e.slice(1)}
            </Chip>
          ))}
        </ChipGroup>
        <ChipGroup>
          <Chip on={!!search.fixable} onClick={() => setSearch({ fixable: search.fixable ? undefined : true })}>
            Fixable now
          </Chip>
        </ChipGroup>
        {search.image && (
          <span className="inline-flex items-center gap-1 rounded-lg border border-accent/50 bg-accent/10 px-2 py-1 font-mono text-xs">
            {shortImage(search.image)}
            <button onClick={() => setSearch({ image: undefined })} aria-label="Clear image filter">
              <X className="size-3.5" />
            </button>
          </span>
        )}
        <span className="tabular ml-auto text-xs text-muted">
          {rows ? `${fmt.format(filtered.length)} of ${fmt.format(rows.length)}` : ""}
          {anyFilter ? (
            <button
              className="ml-2 text-accent hover:underline"
              onClick={() => {
                setQ("");
                setSearch({ p: undefined, sev: undefined, exp: undefined, fixable: undefined, image: undefined, q: undefined });
              }}
            >
              Reset
            </button>
          ) : null}
        </span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <div className="min-w-[1180px]">
          <div className={cn("grid gap-3 border-b border-line bg-panel-2 px-4 py-2 text-[11px] font-medium tracking-wide text-faint uppercase", COLS)}>
            <Th k="priority" sort={sort} setSort={setSort}>Risk</Th>
            <span>Vulnerability</span>
            <Th k="severity" sort={sort} setSort={setSort}>Severity</Th>
            <Th k="epss" sort={sort} setSort={setSort} title="Probability of exploitation in the next 30 days (FIRST EPSS)">EPSS</Th>
            <Th k="exposure" sort={sort} setSort={setSort}>Exposure</Th>
            <Th k="image" sort={sort} setSort={setSort}>Image</Th>
            <span>Workloads</span>
            <span>Fix</span>
            <Th k="due" sort={sort} setSort={setSort} title="Remediation SLA: from when the fix came within our control">SLA</Th>
            <Th k="age" sort={sort} setSort={setSort} title="Days since first seen (exposure clock)">Age</Th>
          </div>
          <div ref={parent} className="h-[560px] overflow-y-auto">
            {loading && <div className="p-8 text-center text-sm text-muted">Loading 17k findings…</div>}
            {error && <div className="p-8 text-center text-sm text-p1">Couldn't load findings: {String(error)}</div>}
            {rows && filtered.length === 0 && <div className="p-8 text-center text-sm text-muted">No findings match these filters.</div>}
            <div style={{ height: v.getTotalSize(), position: "relative" }}>
              {v.getVirtualItems().map((vi) => {
                const f = filtered[vi.index]!;
                return (
                  <button
                    key={f.id}
                    onClick={() => setSearch({ f: f.id })}
                    style={{ position: "absolute", top: 0, left: 0, width: "100%", height: vi.size, transform: `translateY(${vi.start}px)` }}
                    className={cn(
                      "grid items-center gap-3 border-b border-line/60 px-4 text-left text-sm hover:bg-panel-2",
                      COLS,
                      search.f === f.id && "bg-accent/10",
                    )}
                  >
                    <span>
                      <PriorityBadge p={f.priority} />
                    </span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate font-mono text-[13px]">{f.vulnId}</span>
                        {f.kev && <KevBadge />}
                      </span>
                      <span className="block truncate text-xs text-muted">{f.pkgName}</span>
                    </span>
                    <span className="flex flex-col">
                      <SeverityBadge s={f.severity} />
                      {f.score !== null && <span className="tabular text-[11px] text-faint">CVSS {f.score.toFixed(1)}</span>}
                    </span>
                    <span className={cn("tabular text-xs", (f.epss ?? 0) >= 0.1 ? "font-semibold text-p2" : (f.epss ?? 0) >= 0.01 ? "text-p3" : "text-muted")}>
                      {pct(f.epss)}
                    </span>
                    <span>
                      <ExposureBadge e={f.exposure} />
                    </span>
                    <span className="truncate font-mono text-xs" title={f.image}>
                      {shortImage(f.image)}
                    </span>
                    <span className="min-w-0 text-xs text-muted" title={f.workloads.join("\n")}>
                      {f.workloads.length === 0 ? (
                        <span className="text-faint">not running</span>
                      ) : (
                        <>
                          <span className="block truncate">{f.workloads[0]!.split("/").slice(-1)[0]}</span>
                          <span className="block truncate text-faint">
                            {f.workloads[0]!.split("/")[0]}
                            {f.workloads.length > 1 && ` · +${f.workloads.length - 1}`}
                          </span>
                        </>
                      )}
                    </span>
                    <span className="min-w-0 text-xs">
                      {f.fixedVersion ? (
                        <span className="block truncate font-mono text-ok" title={f.fixedVersion}>
                          {f.fixedVersion}
                        </span>
                      ) : (
                        <span className="text-faint">no fix yet</span>
                      )}
                    </span>
                    <span className="text-xs">
                      <SlaCell f={f} />
                    </span>
                    <span className="tabular text-xs text-muted">{f.ageDays}d</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

function SlaCell({ f }: { f: FindingRow }) {
  if (f.overdueDays === null) return <span className="text-faint" title="The fix isn't within our control yet (no newer image tag)">waiting</span>;
  if (f.overdueDays > 0) return <span className="font-semibold text-p1">{f.overdueDays}d over</span>;
  const left = -f.overdueDays;
  return <span className={cn(left <= 7 ? "font-medium text-p2" : "text-muted")}>{left}d left</span>;
}

function Th({
  k,
  sort,
  setSort,
  children,
  title,
}: {
  k: SortKey;
  sort: { key: SortKey; desc: boolean };
  setSort: (s: { key: SortKey; desc: boolean }) => void;
  children: string;
  title?: string;
}) {
  const on = sort.key === k;
  return (
    <button title={title} onClick={() => setSort({ key: k, desc: on ? !sort.desc : false })} className={cn("flex items-center gap-0.5 text-left uppercase hover:text-fg", on && "text-fg")}>
      {children}
      {on && (sort.desc ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />)}
    </button>
  );
}

function ChipGroup({ children }: { children: ReactNode }) {
  return <div className="flex overflow-hidden rounded-lg border border-line">{children}</div>;
}

function Chip({ on, onClick, n, dot, children }: { on: boolean; onClick: () => void; n?: number; dot?: string; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 border-line px-2 py-1 text-xs text-muted not-first:border-l hover:bg-panel-2 hover:text-fg",
        on && "bg-accent/15 text-fg",
      )}
    >
      {dot && <span className="size-1.5 rounded-full" style={{ background: dot }} />}
      {children}
      {n !== undefined && <span className="tabular text-[10px] text-faint">{n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n}</span>}
    </button>
  );
}
