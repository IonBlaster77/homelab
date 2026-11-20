# Atlas (code)

TypeScript, run directly by Node 26 (type stripping, no build step).
Deployment and operations: [`kubernetes/apps/ops/atlas/`](../../kubernetes/apps/ops/atlas/README.md).

```
src/db/schema.ts          tables (Drizzle); the source of truth
src/db/migrations/        generated SQL, applied by the collector on start
src/db/client.ts          connect + migrate
src/collector/main.ts     loop, /healthz, /metrics, first-run backfill
src/collector/k8s.ts      Kubernetes list calls (no client library)
src/collector/prom.ts     Prometheus queries
src/collector/snapshot.ts reports -> current findings (pure, unit-tested)
src/collector/apply.ts    snapshot -> database changes + events
src/collector/backfill.ts history import from Prometheus
test/                     node:test against PGlite (real Postgres, in-process)
```

## Working on it

```bash
npm ci
npm run typecheck
npm test
npm run db:generate   # after changing src/db/schema.ts
```

Run the collector locally against the cluster:

```bash
kubectl proxy &                                   # Kubernetes API on :8001
kubectl -n monitoring port-forward svc/monitoring-kube-prometheus-prometheus 19090:9090 &
KUBE_API=http://127.0.0.1:8001 PROM_URL=http://127.0.0.1:19090 \
  DATABASE_URL=postgres://... npm run collector
```

Node 22 needs `--experimental-strip-types` to run the sources; Node 24+ doesn't.
