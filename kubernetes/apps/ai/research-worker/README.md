# research-worker

The sandbox where the Hermes agent runs shell commands and code. Hermes'
`terminal.backend` is `ssh`, pointed at this pod, so anything the agent
executes happens here: in a separate namespace with no secrets, no API
access and tightly limited network access, instead of inside Hermes' own
container (which holds its API keys).

| | |
|---|---|
| **URL** | None. Hermes connects over SSH to `research-worker.research-worker.svc:22` |
| **Image** | `alpine` (stock; tools are installed at every start by `configmap.yaml`'s entrypoint) |
| **Namespace** | `research-worker` (PSA `baseline`; see Gotchas) |
| **Storage** | `research-worker-workspace`, 10Gi Longhorn RWO: workspace, SSH host keys, apk cache, Python venv, npm prefix |
| **Depends on** | Longhorn, the sops-kustomize plugin. Used by Hermes |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application for this folder |
| `kustomization.yaml` | Lists the manifests below |
| `namespace.yaml` | Namespace with Pod Security `baseline` |
| `serviceaccount.yaml`, `role.yaml`, `rolebinding.yaml` | A token-less ServiceAccount bound to an empty Role: no API access |
| `secret.sops.yaml` | `research-worker-secret`: the public key Hermes logs in with (SOPS/age encrypted) |
| `configmap.yaml` | `entrypoint.sh`: installs the toolset, sets up sshd and the persistent venv |
| `pvc.yaml` | The workspace volume |
| `deployment.yaml` | The sandbox; prefers `talos3`/`talos4` |
| `service.yaml` | ClusterIP on port 22 |
| `networkpolicy.yaml` | Default-deny, DNS, public internet on 80/443 only, SSH in from Hermes only |

## Security model

The pod runs as **root on purpose**: Hermes may install packages at any point
in a session, and a malicious package's install script runs as root whatever
sudo rules you add. So the boundary isn't inside the container. It's around it:

- **Network:** egress only to DNS and the public internet on 80/443, with
  private, link-local and loopback ranges excluded (blocks SSRF into the LAN
  or cluster). Ingress only on SSH, only from the Hermes pod.
- **No secrets** are mounted except the public key, and the ServiceAccount
  has no token.
- **Dedicated keypair.** The key Hermes uses was made only for this. It is
  not your SSH key or the key for Hermes' human-access sidecar.

## Gotchas

- **Installed apk packages don't survive a restart; the venv and npm packages
  do.** That's deliberate: OS packages spread across `/usr`, `/etc`, `/lib`,
  while the venv and npm prefix are self-contained on the PVC.
- **A base-image bump can change the Python version.** The entrypoint detects
  a venv built for an older Python, rebuilds it and reinstalls the packages it
  had.
- **System Python is pointed at the venv's packages.** Hermes' code_execution
  calls `/usr/bin/python3` without the SSH session's PATH, so the entrypoint
  symlinks system site-packages to the venv's.
- **The private key is duplicated in Hermes** as
  `RESEARCH_WORKER_SSH_PRIVATE_KEY`. Rotate both together.
- **Startup is slow** (a full `apk add` each time). A prebuilt image would fix
  that once the repo's image pipeline has a push credential.
