// Small shadcn-style primitives on Tailwind, plus Atlas' risk badges.
import { clsx, type ClassValue } from "clsx";
import { Globe, House, Lock } from "lucide-react";
import type { ReactNode } from "react";
import { twMerge } from "tailwind-merge";
import type { Exposure, Priority, Severity } from "./api";

export const cn = (...v: ClassValue[]) => twMerge(clsx(v));

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-xl border border-line bg-panel", className)}>{children}</div>;
}

export function CardHeader({ title, hint, right }: { title: string; hint?: string; right?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-2">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      </div>
      {right}
    </div>
  );
}

export const PRIORITY_INFO: Record<Priority, { label: string; color: string; text: string; ring: string; bg: string; rule: string }> = {
  P1: { label: "Exploited", color: "var(--color-p1)", text: "text-p1", ring: "ring-p1/40", bg: "bg-p1/15", rule: "In CISA's Known Exploited Vulnerabilities catalog" },
  P2: { label: "Likely / exposed", color: "var(--color-p2)", text: "text-p2", ring: "ring-p2/40", bg: "bg-p2/15", rule: "EPSS ≥ 10%, or Critical/High on an internet-reachable workload" },
  P3: { label: "Elevated", color: "var(--color-p3)", text: "text-p3", ring: "ring-p3/40", bg: "bg-p3/15", rule: "Critical/High with EPSS ≥ 1%, or on a LAN-reachable workload" },
  P4: { label: "Backlog", color: "var(--color-p4)", text: "text-p4", ring: "ring-p4/40", bg: "bg-p4/15", rule: "Everything else" },
};

export const SEVERITY_INFO: Record<Severity, { color: string; text: string; short: string }> = {
  CRITICAL: { color: "var(--color-sev-critical)", text: "text-sev-critical", short: "Crit" },
  HIGH: { color: "var(--color-sev-high)", text: "text-sev-high", short: "High" },
  MEDIUM: { color: "var(--color-sev-medium)", text: "text-sev-medium", short: "Med" },
  LOW: { color: "var(--color-sev-low)", text: "text-sev-low", short: "Low" },
  UNKNOWN: { color: "var(--color-sev-unknown)", text: "text-sev-unknown", short: "Unk" },
};
export const SEVERITIES: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"];
export const PRIORITIES: Priority[] = ["P1", "P2", "P3", "P4"];

export function PriorityBadge({ p, long }: { p: Priority; long?: boolean }) {
  const i = PRIORITY_INFO[p];
  return (
    <span title={i.rule} className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold ring-1 ring-inset", i.text, i.bg, i.ring)}>
      {p}
      {long && <span className="font-medium">· {i.label}</span>}
    </span>
  );
}

export function SeverityBadge({ s }: { s: Severity }) {
  const i = SEVERITY_INFO[s];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", i.text)}>
      <span className="size-2 rounded-full" style={{ background: i.color }} />
      {s.charAt(0) + s.slice(1).toLowerCase()}
    </span>
  );
}

export function ExposureBadge({ e }: { e: Exposure }) {
  if (e === "internet")
    return (
      <span title="Reachable from the internet through the Cloudflare tunnel (behind Access)" className="inline-flex items-center gap-1 text-xs font-medium text-p2">
        <Globe className="size-3.5" /> Internet
      </span>
    );
  if (e === "lan")
    return (
      <span title="Reachable on the LAN: Gateway route without public DNS, or a LoadBalancer" className="inline-flex items-center gap-1 text-xs text-muted">
        <House className="size-3.5" /> LAN
      </span>
    );
  return (
    <span title="Cluster-internal only" className="inline-flex items-center gap-1 text-xs text-faint">
      <Lock className="size-3.5" /> Internal
    </span>
  );
}

export function KevBadge() {
  return (
    <span title="Known exploited in the wild (CISA KEV)" className="rounded bg-p1 px-1 py-px text-[10px] font-bold tracking-wide text-white">
      KEV
    </span>
  );
}

export const fmt = new Intl.NumberFormat("en-AU");
export const pct = (x: number | null) => (x === null ? "—" : x >= 0.1 ? `${(x * 100).toFixed(0)}%` : x >= 0.01 ? `${(x * 100).toFixed(1)}%` : `${(x * 100).toFixed(2)}%`);

export function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export const date = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "—";

/** Short image name: drop the registry, keep the last two path parts. */
export const shortImage = (image: string) => {
  const parts = image.split("/").slice(1);
  return parts.slice(-2).join("/") || image;
};
