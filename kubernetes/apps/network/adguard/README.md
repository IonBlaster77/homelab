# AdGuard Home

The household DNS server. Every device on the LAN asks it for names; it
blocks ads and trackers, and answers `*.jupitertech.net` with **local**
addresses so home traffic goes straight to the Gateway (10.77.20.60) instead
of out through Cloudflare. Two instances share one LoadBalancer IP, so DNS
keeps answering while one is restarted.

| | |
|---|---|
| **URL** | https://adguard.jupitertech.net (web UI → primary, via the Gateway). DNS on **10.77.20.53**:53 UDP+TCP |
| **Images** | `adguard/adguardhome`, `linuxserver/adguardhome-sync`, `curlimages/curl` (hook) |
| **Namespace** | `adguard` (PSA `privileged`) |
| **Storage** | `adguard-primary-config`, `adguard-replica-config`: 1Gi Longhorn RWO each |
| **Depends on** | Longhorn, the Gateway (for the UI), the sops-kustomize plugin. Everything on the LAN depends on *it* |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application for this folder |
| `kustomization.yaml` | Lists the manifests below |
| `namespace.yaml` | The `adguard` namespace |
| `deployment-primary.yaml`, `pvc-primary.yaml`, `service-primary.yaml` | The primary: the instance you configure |
| `deployment-replica.yaml`, `pvc-replica.yaml`, `service-replica.yaml` | The replica, on a different node (anti-affinity) |
| `deployment-sync.yaml`, `secret-sync.sops.yaml` | adguardhome-sync: copies the primary's config to the replica |
| `service-dns.yaml` | LoadBalancer **10.77.20.53** → both instances, port 53 UDP+TCP |
| `service-ui.yaml`, `referencegrant.yaml` | The primary's UI, for the HTTPRoute (still in the gateway app) |
| `secret-api.sops.yaml` | Admin login the hook uses to call the API |
| `job-dns-rewrites.yaml` | PostSync hook: adds/removes `*.jupitertech.net` rewrites |

## Adding a hostname

There's no wildcard rewrite: each public hostname needs its own line. Add
`add_rewrite "<name>.jupitertech.net" "10.77.20.60"` to
`job-dns-rewrites.yaml`, merge, then **run a real sync**
(`argocd app sync adguard`). The hook only runs on a sync, and changing the
Job alone doesn't make the app OutOfSync, so a refresh won't run it.

## Gotchas

- **`add_rewrite` matches by domain only.** It never updates an existing
  rewrite, so changing an answer in this file does nothing on its own. To
  change one: add a `del_rewrite` for the old answer (domain *and* old
  answer), sync, then change the `add_rewrite` line and sync again. Check the
  live answer afterwards; the file and AdGuard can silently disagree.
- **`nas.jupitertech.net` is the management address** (10.77.10.20, DSM UI).
  The NAS's data interface, 10.77.20.20 on the server VLAN, is what NFS uses,
  always by IP.
- **To retire a hostname, use `del_rewrite`** in the "Retired" list. Removing
  the `add_rewrite` line alone leaves the record in AdGuard forever.
- **`Recreate`, never `RollingUpdate`.** Each instance has an RWO volume and a
  required anti-affinity, so a surge pod can't schedule and the rollout hangs.
  The other instance keeps the VIP answering meanwhile.
- **Upgrade replica first,** after a backup; check adguardhome-sync's
  minimum AdGuard version (sync ≥ 0.9.2 needs AdGuard ≥ 0.107.68).
- **The hook has a 5-minute deadline** so a stuck pull or a hung API can't
  hold the sync open; the rewrites are idempotent, so the next sync retries.
- **Testing:** query the VIP on port 53 (`Resolve-DnsName -Server 10.77.20.53`);
  never ping it, since a Cilium LoadBalancer IP doesn't answer ICMP.
