#!/bin/bash
# Re-acquire library files the LG C1 cannot decode.
#
# Prerequisite: the HDR10+/10bit/x264 custom formats from
# clusters/homelab/media/recyclarr.yaml must already be synced into
# Radarr/Sonarr, otherwise the searches below will just re-grab the same
# incompatible releases. Verify with:
#   kubectl -n media logs job/<latest recyclarr job> | tail
#
# No files are deleted. Every affected file's release title advertises the
# offending format (Hi10P / 10-bit / HDR10+ / x264), so once the custom formats
# are live the existing files score -10000 and any compliant release counts as
# an upgrade. If no compliant release exists, nothing is grabbed and the current
# file simply stays — safe by construction.
set -euo pipefail

RK=$(kubectl -n media exec deploy/radarr -- sh -c 'grep -o "<ApiKey>[^<]*" /config/config.xml | cut -d">" -f2' | tr -d '\r')
SK=$(kubectl -n media exec deploy/sonarr -- sh -c 'grep -o "<ApiKey>[^<]*" /config/config.xml | cut -d">" -f2' | tr -d '\r')

rcmd() { kubectl -n media exec deploy/radarr -- curl -s -X POST -H "X-Api-Key: $RK" \
           -H 'Content-Type: application/json' -d "$1" http://localhost:7878/api/v3/command; echo; }
scmd() { kubectl -n media exec deploy/sonarr -- curl -s -X POST -H "X-Api-Key: $SK" \
           -H 'Content-Type: application/json' -d "$1" http://localhost:8989/api/v3/command; echo; }

echo "== 1/3  Refresh, so existing files are re-scored against the new custom formats"
rcmd '{"name":"RefreshMovie","movieIds":[11,1]}'
scmd '{"name":"RefreshSeries","seriesId":17}'
scmd '{"name":"RefreshSeries","seriesId":27}'

echo "== 2/3  DV + HDR10+ movies (confirmed black on the C1)"
# movieId 11 = Lee Cronin's The Mummy (2026)   — HDR10+ alongside DV RPU
# movieId  1 = Avatar Aang: The Last Airbender — HDR10+ alongside DV RPU
rcmd '{"name":"MoviesSearch","movieIds":[11,1]}'

echo "== 3/3  Hi10P anime (10-bit AVC — no TV can decode this)"
# Overlord season 4, 13 episodes
scmd '{"name":"EpisodeSearch","episodeIds":[877,878,879,880,881,882,883,884,885,886,887,888,889]}'
# One-Punch Man S02E07 + S02E10
scmd '{"name":"EpisodeSearch","episodeIds":[1772,1775]}'

echo
echo "Done. Watch progress with:  kubectl -n media exec deploy/radarr -- \\"
echo "  curl -s -H \"X-Api-Key: \$RK\" 'http://localhost:7878/api/v3/queue'"
echo
echo "Bluey (99 files of 2160p x264) deliberately needs no action: confirmed"
echo "watched and working on the C1. 4K H.264 is not a compatibility problem."
