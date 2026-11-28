import { useQuery } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import { Boxes, Database, LayoutDashboard, ListChecks, Network, Server, ShieldExclamationPoint, TriangleExclamationPoint } from "lucide-react";
import type { ComponentType } from "react";
import { cn } from "../lib/ui";

const NAV: { to: string; label: string; icon: ComponentType<{ className?: string }>; ready?: boolean }[] = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/security", label: "Security", icon: ShieldExclamationPoint, ready: true },
  { to: "/hardware", label: "Hardware", icon: Server },
  { to: "/network", label: "Network", icon: Network },
  { to: "/data", label: "Data", icon: Database },
  { to: "/inventory", label: "Inventory", icon: Boxes },
  { to: "/risks", label: "Risk register", icon: TriangleExclamationPoint },
  { to: "/compliance", label: "Compliance", icon: ListChecks },
];

export function Shell() {
  const me = useQuery({ queryKey: ["me"], queryFn: () => fetch("/api/me").then((r) => (r.ok ? (r.json() as Promise<{ email: string | null }>) : { email: null })), staleTime: Infinity });
  return (
    <div className="flex h-full">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-line bg-panel md:flex">
        <div className="flex items-center gap-2.5 px-4 py-4">
          <img src="/favicon.svg" alt="" className="size-7" />
          <div>
            <div className="text-sm font-semibold leading-tight">Atlas</div>
            <div className="text-[11px] leading-tight text-faint">homelab ops &amp; security</div>
          </div>
        </div>
        <nav className="flex flex-col gap-0.5 px-2">
          {NAV.map(({ to, label, icon: Icon, ready }) => (
            <Link
              key={to}
              to={to}
              activeOptions={{ exact: to === "/" }}
              className="group flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-muted hover:bg-panel-2 hover:text-fg"
              activeProps={{ className: "bg-panel-2 !text-fg font-medium" }}
            >
              <Icon className="size-4 shrink-0" />
              <span className="flex-1">{label}</span>
              {!ready && <span className="text-[10px] text-faint opacity-0 group-hover:opacity-100">soon</span>}
            </Link>
          ))}
        </nav>
        <div className="mt-auto border-t border-line px-4 py-3 text-[11px] text-faint">
          {me.data?.email && <div className="truncate text-muted" title="Signed in through Cloudflare Access">{me.data.email}</div>}
          Read-only · prototype
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}

export function Placeholder({ title }: { title: string }) {
  return (
    <div className="grid h-full place-items-center p-8 text-center">
      <div>
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className={cn("mt-1 text-sm text-muted")}>Not built yet. The Security tab is the first one.</p>
        <Link to="/security" className="mt-4 inline-block rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white">
          Open Security
        </Link>
      </div>
    </div>
  );
}
