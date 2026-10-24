# Kea DHCP

ISC Kea DHCPv4 server for the homelab VLANs, with leases stored in a
CloudNativePG PostgreSQL cluster so they survive pod restarts and can be
queried from Grafana.

| | |
|---|---|
| **URL** | None (DHCP on `10.77.20.63:67/udp`, management API on `kea-ctrl-agent.kea:8000` in-cluster only) |
| **Image** | `jonasal/kea-dhcp4`, plus `jonasal/kea-admin` as the schema init container (same version) |
| **Namespace** | `kea` |
| **Storage** | `kea-db`, a 2-instance CloudNativePG cluster on Longhorn (5Gi each) |
| **Depends on** | CloudNativePG operator, Longhorn, Cilium LB-IPAM, kube-prometheus-stack (PodMonitor) |

Subnets: VLAN 10 Management, 20 Server, 30 IoT, 110 Trusted and 120 Guest
(4h leases). Requests arrive relayed from each VLAN's gateway, and clients get
AdGuard (`10.77.20.53`) as their DNS server.

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application for this folder |
| `kustomization.yaml` | Lists the manifests below |
| `namespace.yaml` | Namespace |
| `secret-db.sops.yaml` | SOPS-encrypted owner credentials for the `kea` database |
| `secret-db-grafana.sops.yaml` | SOPS-encrypted credentials for the read-only `grafana_ro` role |
| `database.yaml` | CloudNativePG `Cluster` `kea-db`: 2 instances, managed `grafana_ro` role |
| `monitoring.yaml` | PodMonitor scraping the database's metrics |
| `configmap.yaml` | `kea-dhcp4.conf` template: subnets, pools, options, hooks, the HTTP management API |
| `deployment.yaml` | `kea-dhcp4`, with a `kea-admin` init container that creates or upgrades the schema |
| `service.yaml` | Pinned LoadBalancer for DHCP and a ClusterIP (`kea-ctrl-agent`) for the management API |
| `job-grafana-grants.yaml` | PostSync hook that grants `grafana_ro` read access to the lease tables |

## Gotchas

- **No Control Agent since Kea 3.x.** ISC removed `kea-ctrl-agent` (the
  image stops at 3.1.7). `kea-dhcp4` serves the management API itself on
  :8000 (`control-sockets` in the config). The Service keeps the old
  `kea-ctrl-agent` name so Homepage, the blackbox probe and the
  `KeaControlAgentProbeFailed` alert didn't have to change. Commands go
  straight to the server: leave out `"service"`, or set it to exactly
  `["dhcp4"]`.
- **The API has no credentials.** Kea 3.x requires an `authentication`
  block on an HTTP control socket; the empty `clients` list means none are
  checked, as before the upgrade. Anything in the cluster that can reach
  :8000 can run any command (including `config-set` and lease deletion).
  Lock this down (a CiliumNetworkPolicy, or `clients` with a password file)
  before Kea becomes the live DHCP server.
- **The schema is managed by `kea-admin`.** The `db-schema` init container
  runs `kea-admin db-init` on an empty database and `kea-admin db-upgrade`
  otherwise (a no-op when current). `kea-dhcp4` refuses to start against
  an older schema, so `kea-admin` must be the same version as `kea-dhcp4`
  (one Renovate group). Schema upgrades are one-way: going back to an older
  Kea means restoring the database from backup.
- **Hooks are loaded by bare name.** Kea 3.x only loads hooks from its own
  directory. `libdhcp_pgsql.so` must be loaded for the PostgreSQL lease
  database (built in before 2.7.4).
- **Only even minor versions** (2.6, 3.0, 3.2) are stable; odd ones are
  development releases. Renovate only offers even minors.
- **The DB password is substituted at start-up.** Kea's config has no env-var
  support, so the container `sed`s `__DB_PASSWORD__` into a copy of the
  template in `/tmp`. Changing the template needs a pod restart.
- **The grants Job re-runs on every sync.** It's a PostSync hook, and the
  GRANT statements are safe to repeat. `ALTER DEFAULT PRIVILEGES` covers
  tables Kea creates later, including ones added by schema upgrades.
- **Not the active DHCP server yet.** The MikroTik router still answers DHCP
  on the LAN, and Kea has handed out no leases. See the network notes before
  switching relays over.
