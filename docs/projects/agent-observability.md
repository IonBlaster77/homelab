# Agent Observability, Object Storage and Lightweight Agents

See what every agent does and how many tokens it uses, move routine crons off Hermes
onto a lighter harness, and bring back point-in-time recovery for the CNPG databases
along the way.

Planned 2026-10-24. Tracked as task **#50** in the homelab task list.

Related: [`ups-rack-migration.md`](../runbooks/ups-rack-migration.md),
[`nas-and-switch-maintenance.md`](../runbooks/nas-and-switch-maintenance.md).

---

## Goal and shape

| Layer | Tool | Job |
|---|---|---|
| Object storage | **RustFS** (in-cluster, single node) | S3 for CNPG WAL archives and Langfuse |
| DB recovery | **CNPG Barman Cloud plugin** → RustFS | Point-in-time recovery for every CNPG cluster |
| Tracing | **Langfuse** (self-hosted) | Per-turn traces: model calls, tool calls, tokens, cost, for every agent |
| Orchestration | **Paperclip** (sandboxed) | Runs the light agents, schedules, per-agent budgets and usage roll-up |
| Light harness | **Pi** via Paperclip's `pi_local` adapter | Daily crons that don't need Hermes' full context |
| Totals | Prometheus + Grafana | Claude Code's built-in OpenTelemetry metrics (tokens and cost per model and day) |

Hermes stays for heavy and interactive work.

## Phases

Each phase is useful on its own; stop after any of them.

1. **RustFS + CNPG point-in-time recovery.** Highest value, smallest change, no dependency on the rest.
2. **Langfuse**, on RustFS. Wire in Hermes first, then Claude Code.
3. **Paperclip + Pi.** Move the Hermes crons that suit a light harness.
4. *(Later, optional)* An LLM proxy (LiteLLM) and off-site copies, only when the triggers below happen.

---

## Decisions made (2026-10-24)

Don't reopen these without a new reason.

- **RustFS runs in the cluster, on Longhorn.** The Synology has no Container Manager, so
  RustFS can't run on the NAS. **RustFS on an NFS volume is rejected**:
  - object stores need local-disk semantics (atomic rename, locking, fsync) that NFS
    doesn't reliably give, and MinIO explicitly didn't support it;
  - hard NFS mounts hang unkillably when the NAS or switch goes away (see the NAS
    runbook), and CNPG WAL archiving would block behind that until `pg_wal` filled.
- **Off-cluster protection comes from Longhorn's existing NAS backups.** The `default`
  recurring-job group already backs up every volume to
  `nfs://10.77.20.20:/volume1/longhorn-backups` (hourly, keep 24; daily, keep 30). The
  RustFS volume rides on that.
  - **What we gain:** restores to any moment while the cluster is alive (bad migration,
    dropped table, an app corrupting its own data), consistent base backups, and the
    standard CNPG `bootstrap.recovery` restore path.
  - **What we don't gain:** better results after losing the whole cluster. That still
    means restoring RustFS from the NAS, so up to an hour of data lost, the same as
    restoring the database volumes directly today.
- **Cloud object storage (R2/B2) is deferred, not rejected.** It's the route to
  minutes-not-an-hour data loss after a disaster. It supersedes the hardening backlog's
  "off-site CNPG Barman Cloud plugin (R2/B2)" item as a later step, not a first step.
- **Langfuse over a proxy for observability.** Hermes uses its ChatGPT login
  (`openai-codex` provider), and a standard proxy can't usefully sit in front of a
  subscription login. Langfuse's official Hermes plugin and Claude Code's Stop hook both
  work with a subscription.
- **Langfuse is exposed remotely, but only the UI.** A Cloudflare Access app (Authentik
  password + 2FA, no fallback login) at a public hostname, *plus* Authentik login inside
  Langfuse, with email/password sign-up disabled. Agents send traces to the
  **in-cluster address only**; the desktop reaches the same hostname over the LAN via
  an AdGuard rewrite. Ingestion is never public.
- **Paperclip + Pi for the routine crons.** Paperclip has a built-in `pi_local` adapter.
  Plain Pi first; forks only if one has a concrete reason (they'd need the generic
  `process` adapter, losing usage reporting, or a custom adapter).
- **Paperclip is sandboxed like `playwright-mcp`/`research-worker`.** Its adapters launch
  agent CLIs *inside its own pod*, so its namespace gets default-deny, tight egress and
  no cluster credentials beyond what a cron needs.

## Lessons from the last time (task #13, MinIO + Barman)

- `backups.postgresql.cnpg.io` collides with `backups.longhorn.io`. Always use the full name.
- MinIO's images stopped being published, which left a PostSync hook unpullable. **Pin
  RustFS by digest and cache it in Harbor**, so an upstream change can't strand it.
- Task #29 noted the old in-tree `barmanObjectStore` path was on its way out. Use the
  **Barman Cloud plugin** (`ObjectStore` CRD), not `spec.backup.barmanObjectStore`.

---

## Phase 1: RustFS + CNPG point-in-time recovery

**RustFS**
- Version 1.0 GA (2026-09-16), Apache 2.0. **Single-node mode only.** I found no
  confirmation that distributed mode is stable after the 1.0 release.
- Namespace `rustfs` (or under `kubernetes/platform/storage/`), ClusterIP only, no HTTPRoute.
  The console can be reached by port-forward when needed.
- Buckets, each with its own access key: `cnpg` (one prefix per cluster) and `langfuse`.
- Volume: Longhorn with **two or more replicas**, never `longhorn-nvme-single`. Confirm
  it carries `recurring-job-group.longhorn.io/default=enabled` once created (the labeler
  is a PostSync hook and may not have run yet).
- Enable bucket versioning on `cnpg` so a compromised database pod can't silently
  overwrite its own history. **Pair it with a lifecycle rule that expires noncurrent
  versions after ~30 days.** Barman deletes expired backups, but on a versioned bucket a
  delete only hides the object, so without the rule the bucket never shrinks. RustFS
  supports AWS-style lifecycle rules (prefix/tag filters, noncurrent-version expiry, set
  with `rc`); they run in a background scanner, not instantly.

**CNPG**
- **Barman Cloud plugin requirements (checked 2026-10-24), all met:**
  - CNPG **1.26 or newer** (running 1.30.1)
  - **cert-manager** (running v1.21.3)
  - install into **the operator's namespace**, `cnpg-system`
- Latest plugin release: **v0.15.1**, from the release `manifest.yaml` or the
  `cnpg/plugin-barman-cloud` Helm chart. Pin the version; the Helm chart otherwise
  installs the latest.
- One `ObjectStore` per cluster (`barmancloud.cnpg.io/v1`) with
  `endpointURL: http://<rustfs-service>:9000`, `destinationPath: s3://cnpg/<cluster>/`,
  and `s3Credentials` from a SOPS secret. Then `plugins:` on each Cluster, and a daily
  `ScheduledBackup` (method `plugin`).
- **Set the S3 checksum env vars from the start.** Newer boto3 data-integrity checks
  break some S3-compatible stores (`x-amz-content-sha256` errors, plugin issue #393). Put
  `AWS_REQUEST_CHECKSUM_CALCULATION=when_required` and
  `AWS_RESPONSE_CHECKSUM_VALIDATION=when_required` in
  `spec.instanceSidecarConfiguration.env` on every `ObjectStore`.
- Not yet confirmed: the exact sidecar and image model (the docs reference
  `instanceSidecarConfiguration`, implying a plugin sidecar in each Postgres pod), and
  how RustFS handles path-style requests. Check both on the first cluster.
- **Warning: enabling this rolls each cluster's pods.** Expect the ~30–40 s primary
  restarts seen during the CNPG 1.29→1.30 upgrade. Do one cluster at a time, starting
  with something low-stakes. Check Authentik login after `authentik-db`.
- Alerts: WAL archiving failing (`cnpg_pg_stat_archiver_failed_count` rising, or the
  last archive age growing), `pg_wal` filling, and the RustFS volume filling.

**Done when:** a test restore of one database to a chosen time, into a scratch
namespace, matches. Write the four-step disaster restore as a runbook: rebuild the
cluster → restore the RustFS volume from the NAS → start RustFS → CNPG recovery.

## Phase 2: Langfuse

- Helm chart. Dependencies: Postgres, ClickHouse, Redis and S3 (RustFS).
- Rough size: ClickHouse is the heavy part; the community guidance is 4+ vCPU and
  8–16 GB for the whole stack. **Size against requests, not usage.**
- Hermes: official plugin (`hermes plugins install langfuse`,
  `HERMES_LANGFUSE_PUBLIC_KEY` / `HERMES_LANGFUSE_SECRET_KEY`). The Hermes NetworkPolicy
  needs egress to the Langfuse Service.
- Claude Code: Langfuse's Stop-hook integration in `settings.json` on each machine.
  Separately, enable `CLAUDE_CODE_ENABLE_TELEMETRY` metrics to Alloy/Prometheus for
  Grafana totals (Langfuse rejects Claude Code's OpenTelemetry logs and metrics).
- **Masking:** transcripts carry command output. Known leak sources here are Talos
  dry-run diffs (decrypted keys) and *arr `apikey=` URLs. Configure Langfuse masking for
  those patterns before connecting Claude Code.
- One reporting source per agent, otherwise calls are counted twice.

**Done when:** a Hermes turn and a Claude Code session both appear as traces with token
counts, the UI works remotely through Access + Authentik, and ingestion is unreachable
from outside.

## Phase 3: Paperclip + Pi

- Inventory Hermes' cron jobs (needs a read-only `kubectl exec` into the Hermes pod).
  Sort them into *self-contained* (move) vs *needs MCP tools or Hermes memory* (stay for now).
- **Pi has no built-in MCP.** For crons that use infra-mcp tools (e.g. the daily log
  review's `loki_patterns`): either small CLI wrappers that call the APIs directly
  (preferred: no tool definitions in context, fits Pi's design) or the community
  `pi-mcp-adapter` (read it and pin a version first).
- Paperclip: own namespace, CNPG or chart Postgres, its own login mode, UI behind
  Cloudflare Access like Langfuse.
- Pi's traces go to Langfuse through an extension. If Pi can't report, that's
  trigger 2 below.

## Phase 4 triggers (an LLM proxy and off-site copies)

Add LiteLLM (or similar) only when one of these happens:
1. Crons move onto **pay-per-token API keys or a local model**. Budgets, virtual keys
   and routing then pay for themselves.
2. A harness **can't report to Langfuse itself**. The proxy becomes its reporting source.

Add cloud object storage (R2/B2) for `cnpg` when an hour of data loss after a disaster
is no longer acceptable.

---

## Open decisions

### Phase 1: decided 2026-10-24

| # | Decision | Decided |
|---|---|---|
| 1 | RustFS volume size and class | **50Gi on `longhorn-ssd`** (SSD scheduled ~140/247 GB on talos1-3; talos3's NVMe is nearly full with Harbor). Grow later. |
| 2 | Which CNPG clusters get point-in-time recovery | **authentik, grafana, harbor, matrix.** Skip **kea-db**: Kea has never handed out a lease. |
| 3 | Retention | **14 days**, daily base backups. Plenty for "oops" recovery; the NAS dailies keep 30 days anyway. |
| 4 | Interaction with #49 (Longhorn strict-local) | **Do #49 after this phase.** With point-in-time recovery in place, relying on CNPG's own replication is safer. **RustFS itself must never move to `longhorn-local`:** it's a single pod that holds every database's WAL archive, so it needs Longhorn's replicas. |

### Needed before phase 2

| # | Decision | Recommendation |
|---|---|---|
| 5 | Capacity: deploy Langfuse now, or after #34 adds two nodes | Every node is at 60–66% CPU requested (~1.4 cores free each). **Try now with tight requests and a single ClickHouse**; if it doesn't fit, #34 comes first. |
| 6 | ClickHouse: chart-bundled (community-supported) or ClickHouse operator (officially supported) | **Bundled, single replica.** Fewer moving parts; revisit if it bites. |
| 7 | Redis: chart-bundled or the existing Sentinel HA (`redis-sentinel.redis:26379`) | **Reuse the existing Redis** (checked 2026-10-24, compatible; see below). |
| 8 | Postgres | **Own CNPG cluster**, consistent with everything else, and it gets phase 1's point-in-time recovery. |
| 9 | Trace retention | **Built-in retention is Enterprise-only for self-hosting** (checked 2026-10-24); the open-source edition keeps data forever. **Recommend a nightly CronWorkflow** that deletes traces older than 30 days via the API, plus a RustFS lifecycle rule on the raw-event prefix. See below. |
| 10 | Hostname | `langfuse.jupitertech.net`: Cloudflare Access app + AdGuard rewrite + Authentik app. |

#### Detail for #7: Langfuse on the existing Redis

Langfuse supports Sentinel natively:

```
REDIS_SENTINEL_ENABLED=true
REDIS_SENTINEL_NODES=redis-0.redis.redis.svc.cluster.local:26379,redis-1...,redis-2...
REDIS_SENTINEL_MASTER_NAME=mymaster
REDIS_AUTH=<password>          # Sentinel itself has no password here
REDIS_KEY_PREFIX=langfuse:
```

Sentinel and cluster mode can't be combined; ours is Sentinel, so that's fine.

| Langfuse requirement | Ours | OK? |
|---|---|---|
| Redis ≥ 7 (7.2 recommended for v4) | `redis:8.10.2-alpine` | Yes |
| `maxmemory-policy noeviction`: Redis holds BullMQ *queues*, and eviction stalls workers | No `maxmemory` set, so Redis's default `noeviction` | Yes |
| ACL `on ~* +@all` on its keys | `requirepass` on the default user: all keys, all commands | Yes, but too broad (below) |

Things to handle when wiring it:
- **Use a key prefix (`langfuse:`), not a DB index.** The docs only show the DB number in
  `REDIS_CONNECTION_STRING`, which Sentinel mode doesn't use, so I'm not sure Sentinel
  mode can select one. The prefix keeps it clear of Harbor's keys either way.
- **Shared password.** Langfuse would use the same password as Harbor and could read or
  `FLUSHALL` Harbor's data. Better: add a **Redis ACL user** limited to
  `~langfuse:* +@all -flushall -flushdb`. That needs an `aclfile` or `user` lines in the
  `config` init container, and is a good first real Redis ACL exercise.
- **No memory ceiling.** If Langfuse's workers stall (e.g. ClickHouse down), its queues
  grow in RAM on the same Redis that Harbor uses, with AOF on 4Gi PVCs. Add an alert on
  `redis_memory_used_bytes`. Consider a generous `maxmemory`, accepting that at the cap
  `noeviction` makes *all* writes fail, Harbor's included.
- **Failover drops in-flight work.** BullMQ locks can be lost on a Sentinel failover
  (~5–15 s). Acceptable for trace ingestion; workers retry.
- **NetworkPolicy:** the `redis` namespace needs ingress from Langfuse's pods on 6379 and 26379.

#### Detail for #9: trace retention without Enterprise

- **Nightly delete job.** List traces older than the cutoff and call the batch
  `DELETE /api/public/traces`, which removes their observations and scores from every
  store. Run it as an Argo **CronWorkflow** with a project API key. Deletion is
  asynchronous (usually within 15 min) and rate-limited, so batch it, then re-query to
  confirm. No official script exists, so it's a small one to write.
- **Raw events in S3.** Langfuse writes every incoming event to S3 first, and deleting
  traces doesn't reliably clean those up. Add a RustFS lifecycle rule on the *events
  prefix only* (not media) to expire them after a few days. They're only needed for
  reprocessing.
- **Alternatives:** let it grow and size ClickHouse's disk (traces are small; fine for
  months), or buy an Enterprise licence. Avoid hand-adding ClickHouse TTLs: Langfuse
  owns its schema and migrations.

### Needed before phase 3

| # | Decision | Recommendation |
|---|---|---|
| 11 | Pi's model sign-in | ChatGPT plan (shares Hermes' limits) or an API key (pay per token, which is proxy trigger 1). **Plan first**, and measure. |
| 12 | MCP for Pi | **CLI wrappers** over `pi-mcp-adapter`. |
| 13 | Cluster access for crons | Read-only, borrowed from infra-mcp's ClusterRole, per cron, never broader. |
| 14 | Which crons move | Decided by the inventory. |
