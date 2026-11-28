// Atlas API + web server (Hono). Prototype: the Security tab's read-only
// endpoints, and the built UI from web/dist.
//
// Read-only by construction: GET routes only, and every database session is
// opened with default_transaction_read_only=on (so even a bug can't write).
// Point it at the replica service (atlas-db-ro) where possible.
//
// Login: Cloudflare Access (Authentik + passkey) in front, and every request
// must carry a valid Access token (access.ts), because the Gateway is also
// reachable on the LAN without Access. Without CF_ACCESS_* it only runs on
// loopback (local development). Authentik OIDC with group -> role mapping
// comes later (docs/projects/atlas.md, "Users and permissions").
//
// Env: DATABASE_URL (required; no password in it if DB_PASSWORD_FILE is set),
// DB_PASSWORD_FILE, DB_SSL (require|disable, default require), DB_SSL_CA_FILE
// (verify the server against this CA), HOST (127.0.0.1), PORT (8081),
// WEB_DIR (web/dist), CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { secureHeaders } from "hono/secure-headers";
import pg from "pg";
import { AccessVerifier, tokenFrom, type AccessIdentity } from "./access.ts";
import { findingDetail, freshness, liveSince, openFindings, policySummary, trend, type OpenFinding } from "./security.ts";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
const url = new URL(process.env.DATABASE_URL);
// pg lets the URL's (empty) password win over a `password` option, so put it in the URL.
if (process.env.DB_PASSWORD_FILE) url.password = encodeURIComponent(readFileSync(process.env.DB_PASSWORD_FILE, "utf8").trim());
const pool = new pg.Pool({
  connectionString: url.toString(),
  // CNPG serves TLS with its own CA (secret atlas-db-ca). Without the CA
  // file (local runs through a port-forward, where the hostname can't
  // match anyway) the connection is encrypted but not verified.
  ssl:
    process.env.DB_SSL === "disable"
      ? false
      : process.env.DB_SSL_CA_FILE
        ? { ca: readFileSync(process.env.DB_SSL_CA_FILE, "utf8"), rejectUnauthorized: true }
        : { rejectUnauthorized: false },
  options: "-c default_transaction_read_only=on -c statement_timeout=15000",
  max: 4,
});

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...extra }));

// An idle connection dropping (failover, restart, network) is emitted on the
// pool; unhandled, it would crash the process. The pool reconnects on its own.
pool.on("error", (e) => log("idle database connection lost", { error: String(e) }));

// The open-findings list (17k rows) is shared by the summary and the table;
// the collector only changes it every 10 minutes.
let cache: { at: number; rows: OpenFinding[] } | undefined;
async function cachedFindings(): Promise<OpenFinding[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.rows;
  const started = Date.now();
  const rows = await openFindings(pool);
  cache = { at: Date.now(), rows };
  log("open findings loaded", { rows: rows.length, ms: Date.now() - started });
  return rows;
}

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8081);
const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
const access =
  process.env.CF_ACCESS_TEAM_DOMAIN && process.env.CF_ACCESS_AUD
    ? new AccessVerifier(process.env.CF_ACCESS_TEAM_DOMAIN, process.env.CF_ACCESS_AUD)
    : undefined;
if (!access && !loopback) throw new Error("refusing to listen beyond loopback without CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD");

const app = new Hono<{ Variables: { identity: AccessIdentity | undefined } }>();

// Middleware runs in registration order: security headers on everything
// (401s included), then the health check (no token, no data, for the
// kubelet), then the Access check in front of everything else.
app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
    },
    referrerPolicy: "no-referrer",
    crossOriginResourcePolicy: "same-origin",
  }),
);

app.get("/api/healthz", (c) => c.text("ok\n"));

if (access) {
  app.use("*", async (c, next) => {
    let r: Awaited<ReturnType<AccessVerifier["verify"]>>;
    try {
      r = await access.verify(tokenFrom(c.req));
    } catch (e) {
      log("access check failed", { error: String(e) });
      return c.text("Access check unavailable\n", 503);
    }
    if (!r.ok) {
      log("access denied", { path: c.req.path, reason: r.reason, ip: c.req.header("x-forwarded-for") ?? "" });
      return c.text("Sign in through https://atlas.jupitertech.net (Cloudflare Access).\n", 401);
    }
    c.set("identity", r.id);
    await next();
  });
}

app.use("/api/*", compress());

app.get("/api/me", (c) => c.json({ email: c.get("identity")?.email ?? null }));

// The table's columns only (titles, sightings etc. come from the detail
// endpoint): keeps 17k rows at a few MB before gzip.
app.get("/api/security/findings", async (c) => {
  c.header("Cache-Control", "no-store");
  const rows = await cachedFindings();
  return c.json(
    rows.map((f) => ({
      id: f.id,
      vulnId: f.vulnId,
      severity: f.severity,
      score: f.score,
      pkgName: f.pkgName,
      image: f.image,
      fixedVersion: f.fixedVersion,
      kev: f.kev,
      epss: f.epss,
      exposure: f.exposure,
      workloads: f.workloads,
      priority: f.priority,
      dueAt: f.dueAt,
      overdueDays: f.overdueDays,
      ageDays: f.ageDays,
      inControl: f.fixInControlAt !== null,
    })),
  );
});

app.get("/api/security/summary", async (c) => {
  const rows = await cachedFindings();
  const count = (pred: (f: OpenFinding) => boolean) => rows.reduce((n, f) => n + (pred(f) ? 1 : 0), 0);
  const by = <K extends string>(key: (f: OpenFinding) => K) => {
    const out: Record<string, number> = {};
    for (const f of rows) out[key(f)] = (out[key(f)] ?? 0) + 1;
    return out;
  };
  const [policy, fresh] = await Promise.all([policySummary(pool), freshness(pool)]);
  return c.json({
    total: rows.length,
    byPriority: by((f) => f.priority),
    bySeverity: by((f) => f.severity),
    byExposure: by((f) => f.exposure),
    kev: count((f) => f.kev),
    kevRansomware: count((f) => f.kevRansomware),
    fixable: count((f) => f.fixedVersion !== ""),
    inControl: count((f) => f.fixInControlAt !== null),
    overdue: count((f) => (f.overdueDays ?? -1) > 0),
    dueSoon: count((f) => f.overdueDays !== null && f.overdueDays <= 0 && f.overdueDays > -7),
    overdueByPriority: by((f) => ((f.overdueDays ?? -1) > 0 ? f.priority : "_")),
    imagesWithP1P2: new Set(rows.filter((f) => f.priority === "P1" || f.priority === "P2").map((f) => f.image)).size,
    policy,
    freshness: fresh,
  });
});

app.get("/api/security/trend", async (c) => {
  const days = Math.min(Math.max(Number(c.req.query("days") ?? 30) || 30, 7), 90);
  const [points, live] = await Promise.all([trend(pool, days), liveSince(pool)]);
  return c.json({ points, liveSince: live });
});

app.get("/api/security/findings/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
  const d = await findingDetail(pool, id);
  return d ? c.json(d) : c.json({ error: "not found" }, 404);
});

app.onError((e, c) => {
  log("request failed", { path: c.req.path, error: String(e) });
  return c.json({ error: "internal error" }, 500);
});

// The built UI, with index.html for client-side routes.
const webDir = resolve(process.env.WEB_DIR ?? "web/dist");
if (existsSync(webDir)) {
  app.use("/*", serveStatic({ root: webDir }));
  app.get("*", serveStatic({ path: `${webDir}/index.html` }));
}

serve({ fetch: app.fetch, hostname: host, port }, () => log("api listening", { host, port, web: existsSync(webDir), access: !!access }));
