# Kea DHCP

ISC Kea DHCPv4 server for the homelab VLANs, with leases stored in a
CloudNativePG PostgreSQL cluster so they survive pod restarts and can be
queried from Grafana.

| | |
|---|---|
| **URL** | None (DHCP on `10.77.20.63:67/udp`, control agent API on `kea-ctrl-agent.kea:8000` in-cluster only) |
| **Image** | `jonasal/kea-dhcp4`, `jonasal/kea-ctrl-agent` |
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
| `configmap.yaml` | `kea-dhcp4.conf` template (subnets, pools, options) and the control agent config |
| `configmap-db-schema.yaml` | Upstream `dhcpdb_create.pgsql` schema, applied once by an init container |
| `deployment.yaml` | `kea-dhcp4` plus `kea-ctrl-agent` sidecar sharing a control socket |
| `service.yaml` | Pinned LoadBalancer for DHCP and a ClusterIP for the control agent |
| `job-grafana-grants.yaml` | PostSync hook that grants `grafana_ro` read access to the lease tables |

## Gotchas

- **The schema ConfigMap is synced with `Replace=true`.** It is ~288KB of SQL,
  and a normal apply would write a `last-applied-configuration` annotation
  bigger than Kubernetes' 256KB limit, failing every sync.
- **The DB password is substituted at start-up.** Kea's config has no env-var
  support, so the container `sed`s `__DB_PASSWORD__` into a copy of the
  template in `/tmp`. Changing the template needs a pod restart.
- **The schema init is idempotent.** The `db-init` init container only loads
  the schema if `schema_version` doesn't exist yet.
- **The grants Job re-runs on every sync.** It's a PostSync hook, and the
  GRANT statements are safe to repeat. `ALTER DEFAULT PRIVILEGES` covers
  tables Kea creates later.
- **Not the active DHCP server yet.** The MikroTik router still answers DHCP
  on the LAN, and Kea has handed out no leases. See the network notes before
  switching relays over.
