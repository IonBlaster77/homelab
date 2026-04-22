# Homelab Cluster Bootstrap Playbook

Full procedure for bringing the cluster up from bare metal after a wipe.  
Estimated time: **45–60 minutes** from powered-off nodes to fully synced ArgoCD.

---

## Cluster Overview

| Component | Version |
|---|---|
| Talos OS | v1.12.6 |
| Kubernetes | v1.35.0 |
| Cilium | v1.17.0 |
| ArgoCD | v3.3.7 (Helm chart argo-cd-9.5.2) |

4 nodes: talos1–3 (control-plane), talos4 (worker)  
Storage: Longhorn on SSD (`/var/lib/longhorn`) + NVMe (`/var/lib/longhorn-nvme`) per node

---

## Prerequisites

Before starting, confirm you have:

| Item | Where |
|---|---|
| Age private key | Password manager |
| GitHub PAT | Password manager |
| ArgoCD admin password | Password manager |
| `talosctl` installed and configured (`~/.talos/config`) | Local machine |
| `kubectl` installed | Local machine |
| `helm` installed | Local machine |
| `sops` installed with age key at `~/.config/sops/age/keys.txt` | Local machine |
| `argocd` CLI installed (optional but useful) | Local machine |

Verify SOPS can decrypt before you start:
```bash
sops -d clusters/homelab/talos/talos1.yaml | head -3
# Should print: version: v1alpha1
```

---

## Phase 1 — Boot Nodes from Talos Image Factory

The cluster uses a custom Talos image with `iscsi-tools`, `util-linux-tools`, and `nfs-utils`
baked in (required for Longhorn). Boot each node from the Image Factory ISO, **not** the
generic Talos ISO.

**Image Factory ISO URL:**
```
https://factory.talos.dev/image/203464d7568ceebc8d7d6f16811629d1722c3e1a4d4f2979c85587f19367f17b/v1.12.6/metal-amd64.iso
```

> **⚠️ USB enumeration warning:** If booting from a USB stick, ensure the USB is **not**
> plugged in when Talos installs to disk and reboots — or use a different boot method
> (iDRAC/iLO/IPMI). With USB plugged in, the USB becomes `/dev/sda` and Talos will install
> itself onto the USB instead of the internal SSD. The configs use `install.disk: /dev/sda`
> which assumes no USB is present at install time.

1. Write the ISO to a USB drive or mount it via iDRAC/iLO/IPMI on each node
2. Boot all four nodes — they will enter **maintenance mode** and sit waiting for config
3. Confirm each node is reachable in maintenance mode:
   ```bash
   talosctl --nodes 10.77.20.11 get machinestatus --insecure
   talosctl --nodes 10.77.20.12 get machinestatus --insecure
   talosctl --nodes 10.77.20.13 get machinestatus --insecure
   talosctl --nodes 10.77.20.14 get machinestatus --insecure
   ```

---

## Phase 2 — Apply Talos Machine Configs

The configs in git are SOPS-encrypted, so decrypt before applying.

```bash
# From the repo root (homelab/)
sops -d clusters/homelab/talos/talos1.yaml | \
  talosctl apply-config --insecure --nodes 10.77.20.11 --file /dev/stdin

sops -d clusters/homelab/talos/talos2.yaml | \
  talosctl apply-config --insecure --nodes 10.77.20.12 --file /dev/stdin

sops -d clusters/homelab/talos/talos3.yaml | \
  talosctl apply-config --insecure --nodes 10.77.20.13 --file /dev/stdin

sops -d clusters/homelab/talos/talos4.yaml | \
  talosctl apply-config --insecure --nodes 10.77.20.14 --file /dev/stdin
```

> **⚠️ talos4 NVMe pre-requisite:** The NVMe drive (`/dev/nvme0n1`) in talos4 previously
> contained a Windows installation. Talos does **not** automatically wipe user disks —
> if the NVMe has existing partitions, the `mountUserDisks` startup phase will block
> forever and kubelet will never start (`/etc/kubernetes` becomes read-only).
>
> Before applying talos4's config, check whether the NVMe is clean:
> ```bash
> talosctl --nodes 10.77.20.14 get discoveredvolumes --insecure 2>&1 | grep nvme
> # Safe to proceed if nvme0n1 shows no partitions, or partitions already labelled XFS
> # Needs wipe if you see: EFI system partition / Microsoft basic data
> ```
>
> If the NVMe has foreign partitions, apply talos4.yaml without the `disks:` section
> first (comment it out in `/tmp/talos4_plain.yaml`, re-encrypt), get the node into
> the cluster, then run the wipe pod:
> ```bash
> # Wipe pod — runs once on talos4, deletes itself
> kubectl apply -f - <<'EOF'
> apiVersion: v1
> kind: Pod
> metadata:
>   name: nvme-wipe
>   namespace: kube-system
> spec:
>   nodeName: talos4
>   tolerations:
>     - operator: Exists
>   containers:
>   - name: wipe
>     image: alpine
>     securityContext:
>       privileged: true
>     command: ["sh", "-c", "apk add sgdisk util-linux -q && sgdisk --zap-all /dev/nvme0n1 && wipefs -a /dev/nvme0n1 && echo NVMe wiped"]
>     volumeMounts:
>     - name: dev
>       mountPath: /dev
>   volumes:
>   - name: dev
>     hostPath:
>       path: /dev
>   restartPolicy: Never
> EOF
> kubectl wait pod/nvme-wipe -n kube-system --for=condition=Ready --timeout=60s
> kubectl logs nvme-wipe -n kube-system   # should end with "NVMe wiped"
> kubectl delete pod nvme-wipe -n kube-system
>
> # Then re-apply talos4.yaml with the disks section restored
> sops -d clusters/homelab/talos/talos4.yaml | \
>   talosctl apply-config --nodes 10.77.20.14 --file /dev/stdin --mode=auto
> ```

Each node will reboot and install Talos to disk. Wait for them to come back up
(~2–3 minutes). The nodes will re-enter a ready-but-not-yet-clustered state.

---

## Phase 3 — Bootstrap etcd

Run this on **one node only** — talos1 is canonical. This initialises etcd and
brings the Kubernetes control plane up.

```bash
talosctl bootstrap --nodes 10.77.20.11
```

Wait for all nodes to join and the API server to be healthy (~3–5 minutes):
```bash
talosctl --nodes 10.77.20.11 health --wait-timeout 10m
```

---

## Phase 4 — Get kubeconfig

```bash
talosctl --nodes 10.77.20.11 kubeconfig ~/.kube/config
```

Verify the API server is reachable:
```bash
kubectl get nodes
# Nodes will show NotReady — this is expected, Cilium is not installed yet
```

---

## Phase 5 — Install Cilium (MUST come before ArgoCD)

kube-proxy is disabled in the Talos config, so **no Services work until Cilium is
running**. ArgoCD's own Service won't get an IP until Cilium is up. Install Cilium
manually via Helm before anything else.

```bash
helm repo add cilium https://helm.cilium.io/
helm repo update

helm install cilium cilium/cilium \
  --namespace kube-system \
  --version 1.17.0 \
  --values clusters/homelab/bootstrap/cilium-values.yaml
```

Wait for Cilium to be fully ready:
```bash
kubectl -n kube-system rollout status daemonset/cilium --timeout=5m
kubectl -n kube-system wait pod \
  --selector app.kubernetes.io/name=cilium-agent \
  --for=condition=Ready \
  --timeout=5m
```

Verify nodes are now Ready:
```bash
kubectl get nodes
# All four should show Ready
```

---

## Phase 6 — Install ArgoCD

ArgoCD chart version: **argo-cd-9.5.2** (app version v3.3.7).

The `argocd-values.yaml` includes the full SOPS CMP integration — the sops binary
is installed via an init container, and a CMP sidecar handles decryption. No manual
patch is needed beyond applying the values file.

```bash
helm repo add argo https://argoproj.github.io/argo-helm
helm repo update

helm install argocd argo/argo-cd \
  --namespace argocd \
  --create-namespace \
  --version 9.5.2 \
  --values clusters/homelab/bootstrap/argocd-values.yaml
```

Wait for ArgoCD to be ready:
```bash
kubectl -n argocd rollout status deployment/argocd-server --timeout=5m
```

---

## Phase 7 — Apply Bootstrap Secrets and Config

These must be applied **before** ArgoCD tries to sync anything from git.

### 7a. SOPS age key (lets ArgoCD repo-server decrypt secrets in git)

```bash
kubectl create secret generic sops-age \
  --namespace argocd \
  --from-file=keys.txt=$HOME/.config/sops/age/keys.txt
```

### 7b. CMP ConfigMap (plugin config for SOPS decryption sidecar)

```bash
kubectl apply -f clusters/homelab/bootstrap/argocd-cmp-configmap.yaml
```

Restart the repo-server so it picks up the ConfigMap:
```bash
kubectl -n argocd rollout restart deployment/argocd-repo-server
kubectl -n argocd rollout status deployment/argocd-repo-server --timeout=5m
```

### 7c. ArgoCD admin password

```bash
sops -d clusters/homelab/bootstrap/argocd-secrets.yaml | kubectl apply -f -
```

### 7d. GitHub repo credentials

Retrieve the GitHub PAT from your password manager, then:
```bash
kubectl create secret generic argocd-repo-homelab \
  --namespace argocd \
  --from-literal=type=git \
  --from-literal=url=https://github.com/IonBlaster77/homelab.git \
  --from-literal=username=IonBlaster77 \
  --from-literal=password=<GITHUB_PAT_FROM_PASSWORD_MANAGER>

kubectl label secret argocd-repo-homelab \
  --namespace argocd \
  argocd.argoproj.io/secret-type=repository
```

### 7e. GHCR pull secret (for ArgoCD to pull from GitHub Container Registry)

```bash
sops -d clusters/homelab/bootstrap/ghcr-secret.yaml | kubectl apply -f -
```

---

## Phase 8 — Wire Up ArgoCD GitOps

### 8a. Apply the AppProject

Restricts ArgoCD to only sync from the homelab GitHub repo:
```bash
kubectl apply -f clusters/homelab/bootstrap/argocd-appproject.yaml
```

### 8b. Apply bootstrap-apps

This is the root Application that watches `gitops/argocd-apps/` and auto-syncs new
Application manifests as they are added to the repo:
```bash
kubectl apply -f clusters/homelab/bootstrap/bootstrap-apps.yaml
```

ArgoCD will now auto-sync `bootstrap-apps` and create Application cards for all apps.

Give it ~60 seconds then verify:
```bash
kubectl get applications -n argocd
# bootstrap-apps → Synced/Healthy
# cilium         → Synced/Healthy  (adopts the Helm release from Phase 5)
# Others         → Unknown (not yet synced — expected until storage is ready)
```

---

## Phase 9 — Sync cilium-config (IP Pool + L2 Announcements)

Cilium is running but doesn't know which IPs to announce yet. Syncing `cilium-config`
creates the IP pool and L2 policy, which triggers IP assignment for all pending
LoadBalancer services — including the ArgoCD server waiting for 10.77.20.50.

**In the ArgoCD UI** (via port-forward `kubectl port-forward svc/argocd-server -n argocd 8080:80`):

1. Click the **`cilium-config`** application card
2. Click **Sync** → **Synchronize**
3. Wait for the card to turn green (Synced / Healthy)

> **Note:** ArgoCD's own service IP (10.77.20.50) is assigned as part of this sync.
> If you port-forwarded to reach the UI, it will remain accessible.

Verify via CLI:
```bash
kubectl get ciliumloadbalancerippool
kubectl get ciliuml2announcementpolicy
kubectl get svc argocd-server -n argocd
# EXTERNAL-IP should show 10.77.20.50 within 10-20 seconds
```

ArgoCD UI is now permanently reachable at **http://10.77.20.50**  
Login: `admin` / ArgoCD admin password

---

## Phase 10 — Sync Longhorn

**In the ArgoCD UI** (http://10.77.20.50):

1. Click the **`longhorn`** application card
2. Click **Sync** → **Synchronize**
3. Longhorn will take 3–5 minutes to install

Longhorn reads the `node.longhorn.io/default-disks-config` annotation set in the Talos
machineconfig and automatically creates two disk pools per node:
- `ssd` → `/var/lib/longhorn` on sda4 (~200 GB per node)
- `nvme` → `/var/lib/longhorn-nvme` on nvme0n1p1 (~246 GB per node)

Wait until the card shows **Synced / Healthy** before moving on.

Verify:
```bash
kubectl get nodes.longhorn.io -n longhorn-system
# Each node should show 2 disks scheduled
```

Longhorn UI: **http://10.77.20.51** once its LoadBalancer service gets its IP.

---

## Phase 11 — Sync longhorn-config (StorageClasses)

**In the ArgoCD UI** (http://10.77.20.50):

1. Click the **`longhorn-config`** application card
2. Click **Sync** → **Synchronize**
3. Wait for **Synced / Healthy**

This creates:
- `longhorn-ssd` — default StorageClass, SSD pool, general workloads
- `longhorn-nvme` — opt-in StorageClass, NVMe pool, latency-sensitive workloads

The built-in `longhorn` StorageClass installed by the Helm chart will also be marked
default. Remove that flag so only `longhorn-ssd` is the default:
```bash
kubectl patch storageclass longhorn \
  -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}'
```

Verify:
```bash
kubectl get storageclass
# longhorn-ssd   (default) ← correct
# longhorn-nvme             ← opt-in, correct
# longhorn                  ← no longer default, correct
```

---

## Phase 12 — Sync Remaining Apps (in order)

With Longhorn providing storage, sync the remaining applications. Order matters for
apps with dependencies.

### 12a. gateway-api-crds

Must be synced before the gateway app. Click **Sync** in the ArgoCD UI.

```bash
kubectl get applications gateway-api-crds -n argocd
# → Synced/Healthy
```

### 12b. cert-manager + cert-manager-config

cert-manager handles TLS certificates. Sync `cert-manager` first, then `cert-manager-config`.

```bash
# cert-manager needs a moment to start its webhook
kubectl -n cert-manager rollout status deployment/cert-manager-webhook --timeout=3m
```

Then sync `cert-manager-config` from the UI. This creates:
- `cloudflare-api-token` secret (SOPS-encrypted in git, decrypted by ArgoCD CMP)
- Let's Encrypt staging and production ClusterIssuers

### 12c. cnpg (CloudNativePG operator)

> **⚠️ CRD annotation size limit:** cnpg CRDs exceed Kubernetes' 262144-byte annotation
> limit for client-side apply. The cnpg app uses `ServerSideApply=true` in its syncOptions,
> but if you hit `metadata.annotations: Too long` errors, apply manually:
> ```bash
> helm pull cnpg/cloudnative-pg --version <VERSION> --untar --untardir /tmp/cnpg
> kubectl apply --server-side --force-conflicts -f /tmp/cnpg/cloudnative-pg/crds/
> ```

Sync `cnpg` from the ArgoCD UI.

### 12d. monitoring + monitoring-config

> **⚠️ PSA enforcement:** The monitoring namespace requires `privileged` enforcement for
> node-exporter (hostNetwork, hostPID, hostPath). This is handled by
> `clusters/homelab/monitoring/namespace.yaml` which ArgoCD applies. If node-exporter
> pods show `0/4` Running after sync, check:
> ```bash
> kubectl get pods -n monitoring | grep node-exporter
> kubectl describe pod <node-exporter-pod> -n monitoring | grep -A5 Events
> ```
> The namespace labels are in git and ArgoCD will apply them — but if you applied the
> namespace manually (e.g. via `CreateNamespace=true`) before the namespace.yaml synced,
> you may need to force-sync or manually apply:
> ```bash
> kubectl apply -f clusters/homelab/monitoring/namespace.yaml
> kubectl rollout restart daemonset monitoring-prometheus-node-exporter -n monitoring
> ```

> **⚠️ kube-prometheus-stack CRD annotation overflow:** The large kube-prometheus-stack
> CRDs (prometheusagents, prometheuses, scrapeconfigs, thanosrulers, etc.) exceed the
> 262144-byte annotation limit. The monitoring app uses `ServerSideApply=true`, but on
> first sync you may still hit this. If sync fails with `metadata.annotations: Too long`:
> ```bash
> helm pull prometheus-community/kube-prometheus-stack --version 83.6.0 \
>   --untar --untardir /tmp/kps
> kubectl apply --server-side --force-conflicts \
>   -f /tmp/kps/kube-prometheus-stack/charts/crds/crds/
> # Then re-sync the monitoring app from the ArgoCD UI
> ```

Sync `monitoring` then `monitoring-config` from the ArgoCD UI.

`monitoring-config` applies:
- `grafana-admin-secret` (SOPS-encrypted: Grafana admin username/password)
- `grafana-db-credentials` (SOPS-encrypted: CloudNativePG username/password)
- `grafana-db-cluster` (CNPG PostgreSQL cluster)

Grafana will be accessible via the gateway (https://grafana.jupitertech.net) once
the gateway app is synced.

### 12e. gateway

Sync `gateway` from the ArgoCD UI. This creates:
- `networking` namespace
- A Cilium Gateway (LoadBalancer pinned to 10.77.20.60)
- HTTPRoutes for all services (argocd, grafana, longhorn, adguard, home)
- A wildcard TLS certificate for `*.jupitertech.net` via Let's Encrypt

Wait for the certificate to be issued (~60s):
```bash
kubectl get certificate -n networking
# jupitertech-wildcard → Ready: True
```

### 12f. adguard

Sync `adguard` from the ArgoCD UI. This deploys:
- Primary AdGuard instance (read-write)
- Replica AdGuard instance (read-only)
- adguardhome-sync sidecar (syncs replica settings to primary every 5 minutes)
- DNS LoadBalancer service at 10.77.20.53 (port 53 UDP+TCP)

Verify:
```bash
kubectl get pods -n adguard
kubectl get svc adguard-dns -n adguard
# EXTERNAL-IP → 10.77.20.53
```

### 12g. homepage

Sync `homepage` from the ArgoCD UI. Homepage is the internal dashboard at
https://home.jupitertech.net.

### 12h. Final sync check

All 14 apps should now be Synced/Healthy:
```bash
kubectl get applications -n argocd
# adguard, bootstrap-apps, cert-manager, cert-manager-config, cilium, cilium-config,
# cnpg, gateway, gateway-api-crds, homepage, longhorn, longhorn-config,
# monitoring, monitoring-config — all Synced/Healthy
```

---

## Phase 13 — AdGuard DNS Rewrites (automated via ArgoCD PostSync hook)

DNS rewrites are declared in git and applied automatically by ArgoCD after each sync
via `clusters/homelab/adguard/dns-rewrites-job.yaml`. No manual steps required.

The PostSync Job calls the AdGuard API using credentials from the `adguard-api-credentials`
Secret and idempotently adds each rewrite only if it doesn't already exist. Rewrites
currently configured:

| Domain | Answer |
|---|---|
| `nas.jupitertech.net` | `10.77.20.20` |
| `argocd.jupitertech.net` | `10.77.20.60` |
| `grafana.jupitertech.net` | `10.77.20.60` |
| `longhorn.jupitertech.net` | `10.77.20.60` |
| `adguard.jupitertech.net` | `10.77.20.60` |
| `home.jupitertech.net` | `10.77.20.60` |
| `auth.jupitertech.net` | `10.77.20.60` |
| `pgadmin.jupitertech.net` | `10.77.20.60` |
| `radarr.jupitertech.net` | `10.77.20.60` |
| `sonarr.jupitertech.net` | `10.77.20.60` |
| `prowlarr.jupitertech.net` | `10.77.20.60` |
| `qbittorrent.jupitertech.net` | `10.77.20.60` |
| `jellyfin.jupitertech.net` | `10.77.20.60` |
| `jellyseerr.jupitertech.net` | `10.77.20.60` |
| `bazarr.jupitertech.net` | `10.77.20.60` |

To verify after sync:

```bash
kubectl port-forward svc/adguard-primary -n adguard 3030:3000 &>/dev/null &
curl -s -u "$(kubectl get secret adguard-api-credentials -n adguard -o jsonpath='{.data.username}' | base64 -d):$(kubectl get secret adguard-api-credentials -n adguard -o jsonpath='{.data.password}' | base64 -d)" \
  http://localhost:3030/control/rewrite/list | jq .
kill %1
```

To force re-apply outside of a normal sync (e.g. if rewrites were manually deleted):

```bash
kubectl delete job adguard-dns-rewrites -n adguard --ignore-not-found
kubectl apply -f clusters/homelab/adguard/dns-rewrites-job.yaml
```

> **Note on NAT hairpinning:** The MikroTik already handles hairpin NAT, so internal
> clients can resolve and reach these services regardless of whether AdGuard DNS rewrites
> are present. The rewrites are optional — they make DNS resolution faster and avoid
> the hairpin path — but the services are fully functional without them.

---

## Final Verification

Run through this checklist before declaring the cluster healthy:

```bash
# All nodes Ready
kubectl get nodes

# All system pods Running
kubectl get pods -n kube-system
kubectl get pods -n argocd
kubectl get pods -n longhorn-system
kubectl get pods -n monitoring

# All ArgoCD Applications healthy
kubectl get applications -n argocd -o wide

# LoadBalancer IPs assigned
kubectl get svc -n argocd argocd-server              # → 10.77.20.50
kubectl get svc -n longhorn-system longhorn-frontend  # → 10.77.20.51
kubectl get svc -n adguard adguard-dns                # → 10.77.20.53
kubectl get svc -n networking cilium-gateway-homelab-gateway  # → 10.77.20.60

# Gateway TLS cert issued
kubectl get certificate -n networking

# Cilium network healthy
kubectl -n kube-system exec -it \
  $(kubectl -n kube-system get pod -l app.kubernetes.io/name=cilium-agent \
    -o jsonpath='{.items[0].metadata.name}') \
  -- cilium status

# Longhorn disk pools per node (should see 2 disks per node, both scheduled)
kubectl get nodes.longhorn.io -n longhorn-system -o wide

# StorageClasses (longhorn-ssd is the only default)
kubectl get storageclass

# Prometheus PVC bound (50Gi on longhorn-ssd)
kubectl get pvc -n monitoring

# Grafana DB CNPG cluster healthy
kubectl get cluster -n monitoring
```

---

## IP Reference

| IP | Service |
|---|---|
| 10.77.20.10 | Talos control-plane VIP |
| 10.77.20.11 | talos1 (control-plane) |
| 10.77.20.12 | talos2 (control-plane) |
| 10.77.20.13 | talos3 (control-plane) |
| 10.77.20.14 | talos4 (worker) |
| 10.77.20.50 | ArgoCD UI (`http://10.77.20.50`) |
| 10.77.20.51 | Longhorn UI (`http://10.77.20.51`) |
| 10.77.20.53 | AdGuard DNS (port 53 UDP+TCP) |
| 10.77.20.60 | Cilium Gateway — all HTTPS services |

**HTTPS services (all via 10.77.20.60 gateway):**

| URL | Service |
|---|---|
| https://argocd.jupitertech.net | ArgoCD UI |
| https://grafana.jupitertech.net | Grafana monitoring |
| https://longhorn.jupitertech.net | Longhorn UI |
| https://adguard.jupitertech.net | AdGuard Home UI |
| https://home.jupitertech.net | Homepage dashboard |

---

## Known Issues and Workarounds

### Kubernetes 1.35 — StatefulSet `terminatingReplicas` schema error

**Symptom:** ArgoCD shows `ComparisonError: .status.terminatingReplicas: field not declared in schema`
on StatefulSet-based apps (cilium, cert-manager, cnpg, monitoring).

**Root cause:** Kubernetes 1.35 added `terminatingReplicas` to the StatefulSet status spec,
but ArgoCD's bundled OpenAPI schema doesn't include the field yet. Normal refresh and
hard refresh do not fix this — the schema is compiled into the ArgoCD binary.

**Fix (already applied in `argocd-values.yaml`):** Global ignore rule suppresses the diff:
```yaml
configs:
  cm:
    resource.customizations.ignoreDifferences.apps_StatefulSet: |
      jsonPointers:
        - /status/terminatingReplicas
```
Applied via `helm upgrade argocd argo/argo-cd --version 9.5.2 -n argocd --values clusters/homelab/bootstrap/argocd-values.yaml`.

If you still see the error after a fresh install, verify the ConfigMap was applied:
```bash
kubectl get cm argocd-cm -n argocd -o yaml | grep terminatingReplicas
```

### ArgoCD v3 — stale `operationState` from failed Helm render

**Symptom:** An app is stuck `Progressing` with `operationState.message: "revision: HEAD"`.
This happens when a Helm sync partially fails and leaves a stale operation recorded on the
Application object.

**Fix:**
```bash
kubectl patch application <APP_NAME> -n argocd --type json \
  -p '[{"op":"remove","path":"/status/operationState"}]'
```

### Application stuck with `deletionTimestamp` (stale finalizers)

**Symptom:** An Application shows `Progressing` with a `deletionTimestamp` set, blocking
the parent app-of-apps from going Healthy.

**Root cause:** An accidental deletion left finalizers on the Application object
(`pre-delete-finalizer.argocd.argoproj.io`) which prevent cleanup.

**Fix:**
```bash
kubectl patch application <APP_NAME> -n argocd --type json \
  -p '[{"op":"remove","path":"/metadata/finalizers"}]'
```

### node-exporter DaemonSet — 0 pods (PSA violation)

**Symptom:** `monitoring-prometheus-node-exporter` DaemonSet shows 0/4 pods. Pod events show:
`violates PodSecurity "baseline:latest": host namespaces (hostNetwork=true, hostPID=true), hostPath volumes`

**Root cause:** The cluster-wide PSA default is `baseline`, which blocks node-exporter's
required host capabilities.

**Fix (already in git):** `clusters/homelab/monitoring/namespace.yaml` labels the monitoring
namespace `privileged`. If the label wasn't applied before node-exporter started:
```bash
kubectl apply -f clusters/homelab/monitoring/namespace.yaml
kubectl rollout restart daemonset monitoring-prometheus-node-exporter -n monitoring
```

### kube-prometheus-stack / cnpg — CRD annotation too long

**Symptom:** Sync fails with `metadata.annotations: Too long: may not be more than 262144 bytes`
on PrometheusAgent, Prometheus, ScrapeConfig, ThanosRuler, AlertmanagerConfig, or CNPG CRDs.

**Root cause:** These Helm charts include very large CRDs that exceed the kubectl annotation
limit used by client-side apply to track managed fields.

**Fix:** Apply the CRDs manually with server-side apply (bypasses the annotation):
```bash
# kube-prometheus-stack
helm pull prometheus-community/kube-prometheus-stack --version 83.6.0 \
  --untar --untardir /tmp/kps
kubectl apply --server-side --force-conflicts \
  -f /tmp/kps/kube-prometheus-stack/charts/crds/crds/

# cnpg
helm pull cnpg/cloudnative-pg --version <VERSION> --untar --untardir /tmp/cnpg
kubectl apply --server-side --force-conflicts -f /tmp/cnpg/cloudnative-pg/crds/
```
Then re-sync from the ArgoCD UI.

### Nodes stuck NotReady after Cilium install

Check Cilium pod logs:
```bash
kubectl -n kube-system logs -l app.kubernetes.io/name=cilium-agent --tail=50
```
Common cause: `k8sServiceHost`/`k8sServicePort` wrong in `cilium-values.yaml` — verify
`10.77.20.10:6443` is reachable.

### ArgoCD repo-server CrashLoopBackOff after install

The sops init container failed (network issue or image not reachable). Check:
```bash
kubectl -n argocd logs deployment/argocd-repo-server -c install-sops
```
The init container pulls `ghcr.io/getsops/sops:v3.12.1`. If GHCR is unreachable, the pod
will crash. Retry once networking is stable.

### ArgoCD shows repository unreachable

The GitHub secret label is missing or the PAT has expired. Recreate the repo secret (Phase 7d).

### Longhorn disk not appearing on a node

The node annotation may not have been applied. Verify:
```bash
kubectl get node talos1 -o jsonpath='{.metadata.annotations}' | grep longhorn
```
Look for `node.longhorn.io/default-disks-config`. If missing, the Talos machineconfig
didn't apply — run `talosctl apply-config` for that node again.

### talos4 kubelet won't start — `/etc/kubernetes/bootstrap-kubeconfig: read-only file system`

Root cause: the NVMe (`/dev/nvme0n1`) has foreign partitions (Windows, old OS etc). The
`mountUserDisks` startup phase blocks forever, so the `/etc/kubernetes` overlay is never
mounted.

Fix: follow the NVMe wipe procedure in Phase 2 above.

Quick confirmation:
```bash
talosctl --nodes 10.77.20.14 dmesg | grep "filesystem type mismatch"
# If you see "vfat != xfs" you hit this issue
```

### LoadBalancer IPs stuck Pending after cilium-config sync

Verify the L2 policy interface name matches the actual NIC:
```bash
talosctl --nodes 10.77.20.11 get addresses
```
The interface should be `enp0s31f6`. If it differs, update `clusters/homelab/cilium/l2-policy.yaml`.
