# Media stack

Jellyfin for watching, and the *arr apps that find, download, rename and
subtitle what gets watched. Everything runs in the `media` namespace as one
Argo CD app; each component has its own folder.

```
Seerr (requests) → Sonarr / Radarr → Prowlarr (indexers, via FlareSolverr)
                         ↓
          qBittorrent (VPN) / NZBGet → Unpackerr → NAS library → Jellyfin
                         ↑
      Recyclarr (quality profiles), Bazarr (subtitles), arr-dashboard (overview)
```

| Component | Folder | Image | URL | Config volume |
|---|---|---|---|---|
| Jellyfin | `jellyfin/` | `jellyfin/jellyfin` | jellyfin.jupitertech.net | 10Gi |
| Seerr | `seerr/` | `ghcr.io/seerr-team/seerr` | seerr.jupitertech.net | 2Gi |
| Sonarr (TV) | `sonarr/` | `linuxserver/sonarr` | sonarr.jupitertech.net | 2Gi |
| Radarr (movies) | `radarr/` | `linuxserver/radarr` | radarr.jupitertech.net | 2Gi |
| Prowlarr (indexers) | `prowlarr/` | `linuxserver/prowlarr` | prowlarr.jupitertech.net | 2Gi |
| Bazarr (subtitles) | `bazarr/` | `linuxserver/bazarr` | bazarr.jupitertech.net | 2Gi |
| Recyclarr | `recyclarr/` | `recyclarr/recyclarr` | none (CronJob, daily 03:00) | none |
| arr-dashboard | `arr-dashboard/` | `khak1s/arr-dashboard` | arrdashboard.jupitertech.net | 2Gi |
| qBittorrent + Gluetun | `qbittorrent/` | `linuxserver/qbittorrent`, `qmcgaw/gluetun` | qbittorrent.jupitertech.net | 2Gi |
| NZBGet | `nzbget/` | `linuxserver/nzbget` | nzbget.jupitertech.net | 2Gi |
| Unpackerr | `unpackerr/` | `golift/unpackerr` | none | none |
| FlareSolverr | `flaresolverr/` | `ghcr.io/flaresolverr/flaresolverr` | none (used by Prowlarr) | none |

Config volumes are Longhorn (`longhorn-ssd`) RWO, covered by the hourly NAS
backups. Every component also mounts the shared library.

## Shared files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application for this folder |
| `kustomization.yaml` | The shared files plus every component folder |
| `namespace.yaml` | The `media` namespace, PSA `privileged` (for Gluetun; see Gotchas) |
| `pv-media-nfs.yaml`, `pvc-media-nfs.yaml` | The library: NAS `10.77.20.20:/volume1/Media` over NFSv4, `ReadWriteMany`, reclaim `Retain` |
| `referencegrant.yaml` | Lets the HTTPRoutes (in `networking`) reach the Services here |

Inside each component folder: `deployment.yaml` (or `cronjob.yaml`),
`service.yaml`, `pvc.yaml`, `httproute.yaml`, any `secret*.sops.yaml`, and a
`kustomization.yaml` listing them.

## Gotchas

- **The library is never deleted by Argo CD.** The NFS volume is `Retain`,
  so even a prune only detaches it. The config volumes are not: they're
  `Delete`, so a component's `pvc.yaml` must never disappear from its folder.
- **The NFS mount is `hard`.** If the NAS or switch goes away mid-I/O, pods
  hang rather than error, and only a node power-off clears it. Scale media
  down before NAS or switch maintenance (`docs/runbooks/nas-and-switch-maintenance.md`).
- **qBittorrent only talks through Gluetun.** The VPN sidecar needs
  `NET_ADMIN` and `/dev/net/tun`, which is why the whole namespace is PSA
  `privileged`. If torrents stall at 0 bytes, check the NAS share quota, then
  that qBittorrent is bound to `tun0`, then the active-torrent queue cap.
- **Jellyfin has no GPU,** so it never transcodes video. Files that the LG C1
  can't direct-play (Dolby Vision + HDR10+ dual metadata, Hi10P) play black
  with audio; Recyclarr's profiles exist to avoid grabbing those.
- **NZBGet keeps its config in memory.** A bad settings save shows nothing
  until the next restart. Its "Duplicate" history can also silently block
  re-grabs; clear it alongside the *arr blocklist.
- **Recyclarr's `# name` comments next to `trash_id`s aren't validated.**
  Check IDs against the TRaSH guides and dry-run with `--preview` before
  changing profiles.
- **API keys are duplicated.** `recyclarr/secret.sops.yaml` and
  `unpackerr/secret.sops.yaml` hold copies of Sonarr's and Radarr's keys.
