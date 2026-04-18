# Homelab Cluster Bootstrap Playbook

Full procedure for bringing the cluster up from bare metal after a wipe.  
Estimated time: **30–45 minutes** from powered-off nodes to fully synced ArgoCD.

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
# From the repo root
sops -d clusters/homelab/talos/talos1.yaml | \
  talosctl apply-config --insecure --nodes 10.77.20.11 --file /dev/stdin

sops -d clusters/homelab/talos/talos2.yaml | \
  talosctl apply-config --insecure --nodes 10.77.20.12 --file /dev/stdin

sops -d clusters/homelab/talos/talos3.yaml | \
  talosctl apply-config --insecure --nodes 10.77.20.13 --file /dev/stdin

sops -d clusters/homelab/talos/talos4.yaml | \
  talosctl apply-config --insecure --nodes 10.77.20.14 --file /dev/stdin
```

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

```bash
helm repo add argo https://argoproj.github.io/argo-helm
helm repo update

helm install argocd argo/argo-cd \
  --namespace argocd \
  --create-namespace \
  --values clusters/homelab/bootstrap/argocd-values.yaml
```

Wait for ArgoCD to be ready:
```bash
kubectl -n argocd rollout status deployment/argocd-server --timeout=5m
```

---

## Phase 7 — Apply Bootstrap Secrets

These must be applied **before** ArgoCD tries to sync anything from git.

### 7a. SOPS age key (lets ArgoCD repo-server decrypt secrets in git)

```bash
kubectl create secret generic sops-age \
  --namespace argocd \
  --from-file=keys.txt=$HOME/.config/sops/age/keys.txt
```

### 7b. SOPS patch for argocd-repo-server

Patches the repo-server deployment to install sops and mount the age key:
```bash
kubectl apply -f clusters/homelab/bootstrap/argocd-sops-patch.yaml
```

Wait for the repo-server to restart with the patch applied:
```bash
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
  --from-literal=password=<GITHUB_PAT_FROM_BITWARDEN>

kubectl label secret argocd-repo-homelab \
  --namespace argocd \
  argocd.argoproj.io/secret-type=repository
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

ArgoCD will now auto-sync `bootstrap-apps` and create Application cards for:
- `cilium` — adopts the existing Helm release
- `cilium-config` — IP pool + L2 announcements (manual sync, not ready yet)
- `longhorn` — Longhorn storage (manual sync)
- `longhorn-config` — StorageClasses (manual sync)

Give it ~60 seconds then verify:
```bash
kubectl get applications -n argocd
# bootstrap-apps → Synced/Healthy
# cilium         → Synced/Healthy  (adopts the Helm release from Phase 5)
# cilium-config  → Unknown (not yet synced — expected)
# longhorn       → Unknown (not yet synced — expected)
# longhorn-config→ Unknown (not yet synced — expected)
```

---

## Phase 9 — Sync cilium-config (IP Pool + L2 Announcements)

Cilium is running but doesn't know which IPs to announce yet. Syncing `cilium-config`
creates the IP pool and L2 policy, which triggers IP assignment for all pending
LoadBalancer services — including the ArgoCD server waiting for 10.77.20.50.

**In the ArgoCD UI** (`http://localhost:8080` via port-forward, or 10.77.20.50 once IPs are assigned):

1. Click the **`cilium-config`** application card
2. Click **Sync** → **Synchronize**
3. Wait for the card to turn green (Synced / Healthy)

> **Note:** ArgoCD's own service IP (10.77.20.50) is assigned as part of this sync.
> If you port-forwarded to reach the UI, it will remain accessible — the sync does not
> interrupt the UI session.

Verify via CLI that the pool and policy were created and the IP was assigned:
```bash
kubectl get ciliumloadbalancerippool
kubectl get ciliuml2announcementpolicy
kubectl get svc argocd-server -n argocd
# EXTERNAL-IP should show 10.77.20.50 within 10-20 seconds
```

ArgoCD UI is now permanently reachable at **http://10.77.20.50** (no port-forward needed)  
Login: `admin` / ArgoCD admin password

---

## Phase 10 — Sync Longhorn

**In the ArgoCD UI** (http://10.77.20.50):

1. Click the **`longhorn`** application card
2. Click **Sync** → **Synchronize**
3. Longhorn will take 3–5 minutes to install — the card will show progressing pods

Longhorn reads the `node.longhorn.io/default-disks-config` annotation set in the Talos
machineconfig and automatically creates two disk pools per node:
- `ssd` → `/var/lib/longhorn` on sda4 (~200 GB per node)
- `nvme` → `/var/lib/longhorn-nvme` on nvme0n1p1 (~246 GB per node)

Watch progress — wait until the card shows **Synced / Healthy** before moving on.

Verify via CLI once healthy:
```bash
kubectl get nodes.longhorn.io -n longhorn-system
# Each node should show 2 disks scheduled
```

Longhorn UI will be reachable at **http://10.77.20.51** once its LoadBalancer service gets its IP.

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

## Final Verification

Run through this checklist before declaring the cluster healthy:

```bash
# All nodes Ready
kubectl get nodes

# All system pods Running
kubectl get pods -n kube-system
kubectl get pods -n argocd
kubectl get pods -n longhorn-system

# All ArgoCD Applications healthy
kubectl get applications -n argocd

# LoadBalancer IPs assigned
kubectl get svc -n argocd argocd-server          # → 10.77.20.50
kubectl get svc -n longhorn-system longhorn-frontend  # → 10.77.20.51

# Cilium network healthy
kubectl -n kube-system exec -it \
  $(kubectl -n kube-system get pod -l app.kubernetes.io/name=cilium-agent \
    -o jsonpath='{.items[0].metadata.name}') \
  -- cilium status

# Longhorn disk pools per node (should see 2 disks per node, both scheduled)
kubectl get nodes.longhorn.io -n longhorn-system -o wide

# StorageClasses (longhorn-ssd is the only default)
kubectl get storageclass
```

---

## IP Reference

| IP | Service |
|---|---|
| 10.77.20.10 | Talos control-plane VIP |
| 10.77.20.11 | talos1 |
| 10.77.20.12 | talos2 |
| 10.77.20.13 | talos3 |
| 10.77.20.14 | talos4 (worker) |
| 10.77.20.50 | ArgoCD UI (`http://10.77.20.50`) |
| 10.77.20.51 | Longhorn UI (`http://10.77.20.51`) |
| 10.77.20.52 | Cilium shared ingress (future apps) |
| 10.77.20.53–99 | Free pool for future LoadBalancer services |

---

## Troubleshooting

**Nodes stuck NotReady after Cilium install**  
Check Cilium pod logs: `kubectl -n kube-system logs -l app.kubernetes.io/name=cilium-agent --tail=50`  
Common cause: k8sServiceHost/Port wrong in cilium-values.yaml — verify 10.77.20.10:6443 is reachable.

**ArgoCD repo-server CrashLoopBackOff after SOPS patch**  
The sops binary download in the init container failed (network issue). Check:
`kubectl -n argocd logs deployment/argocd-repo-server -c install-sops`

**ArgoCD shows repository unreachable**  
The GitHub secret label is missing or the PAT has expired. Recreate the repo secret (Phase 7d).

**Longhorn disk not appearing on a node**  
The node annotation may not have been applied. Verify:
`kubectl get node talos1 -o jsonpath='{.metadata.annotations}'`  
Look for `node.longhorn.io/default-disks-config`. If missing, the Talos machineconfig  
didn't apply — run `talosctl apply-config` for that node again.

**LoadBalancer IPs stuck Pending after cilium-config sync**  
Verify the L2 policy interface name matches the actual NIC:
`talosctl --nodes 10.77.20.11 get addresses`  
The interface should be `enp0s31f6`. If it differs, update `clusters/homelab/cilium/l2-policy.yaml`.
