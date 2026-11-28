import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, redirect, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Placeholder, Shell } from "./components/Shell";
import "./index.css";
import { SecurityPage, type SecuritySearch } from "./pages/Security";

const queryClient = new QueryClient({
  defaultOptions: {
    // The collector writes every 10 minutes; show cached data instantly and
    // refresh in the background.
    queries: { staleTime: 60_000, refetchInterval: 120_000, refetchOnWindowFocus: true },
  },
});

const root = createRootRoute({ component: Shell });
const index = createRoute({
  getParentRoute: () => root,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/security" });
  },
});
const security = createRoute({
  getParentRoute: () => root,
  path: "/security",
  component: SecurityPage,
  // Filters and the open finding live in the URL, so views can be linked.
  validateSearch: (s: Record<string, unknown>): SecuritySearch => ({
    p: typeof s.p === "string" ? s.p : undefined,
    sev: typeof s.sev === "string" ? s.sev : undefined,
    exp: typeof s.exp === "string" ? s.exp : undefined,
    q: typeof s.q === "string" ? s.q : undefined,
    fixable: s.fixable === true || s.fixable === "true" ? true : undefined,
    image: typeof s.image === "string" ? s.image : undefined,
    f: typeof s.f === "number" ? s.f : typeof s.f === "string" && /^\d+$/.test(s.f) ? Number(s.f) : undefined,
  }),
});
const placeholders = ["hardware", "network", "data", "inventory", "risks", "compliance"].map((p) =>
  createRoute({ getParentRoute: () => root, path: `/${p}`, component: () => <Placeholder title={p[0]!.toUpperCase() + p.slice(1)} /> }),
);

const router = createRouter({ routeTree: root.addChildren([index, security, ...placeholders]), defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
