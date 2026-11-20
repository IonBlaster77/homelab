"""RouterOS patch tracker for the Patch Ops tab. Stdlib only.

Every INTERVAL it logs in to each MikroTik device over the RouterOS API
(read-only users), reads the installed RouterOS version and the RouterBOARD
firmware, asks MikroTik's update server for the newest version on the
device's channel, and reads the changelog of every release in between to
find CVEs / security fixes. Results are exported as Prometheus metrics; the
Homepage cards and the alert rules read them from Prometheus.

Metrics (label device = router | switch):
  routeros_patch_info{device, name, model, installed, latest, channel,
                      status, version, security, firmware}  1
      Display strings for the Homepage cards (one series per device).
  routeros_update_available{device}            1 = newer RouterOS on the channel
  routeros_security_update_available{device}   1 = that update mentions CVEs/security
  routeros_security_fixes_pending{device}      CVE IDs + other security lines found
  routeros_firmware_upgrade_pending{device}    1 = current-firmware != upgrade-firmware
  routeros_latest_release_timestamp_seconds{device}
  routeros_patch_check_success{device}         0 = device or update server unreadable
  routeros_patch_check_last_run_timestamp_seconds

"Security update" means the changelogs say so (a CVE ID, or the words
security/vulnerability). MikroTik sometimes fixes things quietly and
announces them later on https://mikrotik.com/supportsec, so treat a green
card as "nothing announced", not a guarantee.
"""

import os, re, socket, threading, time, urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

INTERVAL = int(os.environ.get("INTERVAL_SECONDS", "3600"))
PORT = int(os.environ.get("PORT", "9106"))
UPDATE_BASE = "https://upgrade.mikrotik.com/routeros"
UA = {"User-Agent": "homelab-routeros-patch-check"}

# Where each device's read-only API login comes from.
#   exporter: the mikrotik-exporter's config.yaml (devices: list), matched by address
#   files:    a directory with address / username / password files
DEVICES = [
    {
        "device": "router",
        "name": "Juno",
        "address": "10.77.10.1",
        "channel": "long-term",
        "creds": ("exporter", "/secrets/router/config.yaml"),
    },
    {
        "device": "switch",
        "name": "Aggregation switch",
        "address": "10.77.10.2",
        "channel": "long-term",
        "creds": ("files", "/secrets/switch"),
    },
]

state = {"body": "# no run yet\n"}
changelog_cache = {}  # version -> text, or None for "no such release"


# --- RouterOS API (https://help.mikrotik.com/docs/display/ROS/API) ----------

def _enc_len(n):
    if n < 0x80:
        return bytes([n])
    if n < 0x4000:
        return (n | 0x8000).to_bytes(2, "big")
    if n < 0x200000:
        return (n | 0xC00000).to_bytes(3, "big")
    if n < 0x10000000:
        return (n | 0xE0000000).to_bytes(4, "big")
    return b"\xf0" + n.to_bytes(4, "big")


class RouterOS:
    def __init__(self, address, port=8728, timeout=15):
        self.sock = socket.create_connection((address, port), timeout=timeout)
        self.buf = b""

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass

    def _recv(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("connection closed by device")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _read_len(self):
        b = self._recv(1)[0]
        if b < 0x80:
            return b
        if b < 0xC0:
            return ((b & 0x3F) << 8) | self._recv(1)[0]
        if b < 0xE0:
            return ((b & 0x1F) << 16) | int.from_bytes(self._recv(2), "big")
        if b < 0xF0:
            return ((b & 0x0F) << 24) | int.from_bytes(self._recv(3), "big")
        return int.from_bytes(self._recv(4), "big")

    def _send(self, words):
        data = b"".join(_enc_len(len(w.encode())) + w.encode() for w in words) + b"\x00"
        self.sock.sendall(data)

    def _read_sentence(self):
        words = []
        while True:
            n = self._read_len()
            if n == 0:
                return words
            words.append(self._recv(n).decode("utf-8", "replace"))

    def talk(self, *words):
        """Send one command, return its !re rows as dicts. Raises on !trap/!fatal."""
        self._send(list(words))
        rows, err = [], None
        while True:
            s = self._read_sentence()
            if not s:
                continue
            kind, attrs = s[0], {}
            for w in s[1:]:
                if w.startswith("="):
                    k, _, v = w[1:].partition("=")
                    attrs[k] = v
            if kind == "!re":
                rows.append(attrs)
            elif kind in ("!trap", "!fatal"):
                err = attrs.get("message", kind)
                if kind == "!fatal":
                    raise RuntimeError(err)
            elif kind == "!done":
                if err:
                    raise RuntimeError(err)
                return rows

    def login(self, user, password):
        # Plain login, RouterOS 6.43+ and all of v7.
        self.talk("/login", "=name=" + user, "=password=" + password)


# --- credentials -------------------------------------------------------------

def _unquote(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
        q, v = v[0], v[1:-1]
        if q == "'":
            v = v.replace("''", "'")
    return v


def exporter_creds(path, address):
    """Pull user/password for `address` out of the mikrotik-exporter config.

    Only needs the simple `devices:` list that file uses (name/address/user/
    password/port keys under '- ' items), so no YAML library is required."""
    with open(path) as f:
        return parse_exporter_config(f.read(), address)


def parse_exporter_config(text, address):
    devices, cur = [], None
    for raw in text.splitlines():
        s = raw.strip()
        if not s or s.startswith("#"):
            continue
        if s.startswith("- "):
            cur = {}
            devices.append(cur)
            s = s[2:]
        if cur is None or ":" not in s:
            continue
        k, _, v = s.partition(":")
        if k.strip() in ("name", "address", "user", "password", "port") and v.strip():
            cur[k.strip()] = _unquote(v)
    for d in devices:
        if d.get("address") == address:
            return d["user"], d["password"]
    raise RuntimeError(f"no device with address {address} in the exporter config")


def file_creds(directory):
    def rd(name):
        with open(os.path.join(directory, name)) as f:
            return f.read().strip()
    return rd("username"), rd("password")


def creds_for(dev):
    kind, path = dev["creds"]
    if kind == "exporter":
        return exporter_creds(path, dev["address"])
    return file_creds(path)


# --- versions and MikroTik's update server -----------------------------------

def parse_version(s):
    """'7.24.6 (long-term)' -> (7, 24, 6); '7.24' -> (7, 24, 0)."""
    m = re.match(r"\s*(\d+)\.(\d+)(?:\.(\d+))?", s or "")
    if not m:
        raise ValueError(f"unparseable version {s!r}")
    return int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)


def vstr(v):
    return f"{v[0]}.{v[1]}" if v[2] == 0 else f"{v[0]}.{v[1]}.{v[2]}"


def http_text(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def newest(major, channel):
    """('7.24.6', 1793348669) for the channel's newest release."""
    feed = f"NEWEST6.{channel}" if major == 6 else f"NEWESTa7.{channel}"
    parts = http_text(f"{UPDATE_BASE}/{feed}").split()
    return parts[0], int(parts[1]) if len(parts) > 1 else 0


def changelog(version):
    if version not in changelog_cache:
        try:
            changelog_cache[version] = http_text(f"{UPDATE_BASE}/{version}/CHANGELOG")
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
            changelog_cache[version] = None
    return changelog_cache[version]


def releases_between(installed, latest):
    """Every release after `installed` up to and including `latest`.

    MikroTik has no index, so walk minor by minor: X.Y, X.Y.1, X.Y.2 ... until
    a version's changelog is missing (the newest minor stops at `latest`)."""
    out = []
    major = installed[0]
    for minor in range(installed[1], latest[1] + 1):
        start = installed[2] + 1 if minor == installed[1] else 0
        patch, misses = start, 0
        while True:
            v = (major, minor, patch)
            if v > latest:
                break
            if changelog(vstr(v)) is None:
                if patch == 0:  # some minors skip X.Y.0 naming quirks; try .1
                    patch += 1
                    continue
                misses += 1
                if misses >= 2:
                    break
            else:
                out.append(vstr(v))
                misses = 0
            patch += 1
    return out


SEC_WORDS = re.compile(r"security|vulnerab", re.I)
CVE = re.compile(r"CVE-\d{4}-\d{4,}")


def security_findings(versions):
    cves, other = set(), 0
    for v in versions:
        for line in (changelog(v) or "").splitlines():
            ids = CVE.findall(line)
            if ids:
                cves.update(ids)
            elif SEC_WORDS.search(line):
                other += 1
    return sorted(cves), other


# --- one check per device ----------------------------------------------------

def check(dev):
    user, password = creds_for(dev)
    api = RouterOS(dev["address"])
    try:
        api.login(user, password)
        res = api.talk("/system/resource/print")[0]
        rb = api.talk("/system/routerboard/print")[0]
    finally:
        api.close()

    installed = parse_version(res.get("version"))
    latest_s, released = newest(installed[0], dev["channel"])
    latest = parse_version(latest_s)
    update = latest > installed
    cves, other = security_findings(releases_between(installed, latest)) if update else ([], 0)
    sec_count = len(cves) + other

    cur_fw, up_fw = rb.get("current-firmware", ""), rb.get("upgrade-firmware", "")
    fw_pending = bool(cur_fw and up_fw and cur_fw != up_fw)

    if not update:
        status = "✅ Up to date"
    elif sec_count:
        status = "🔴 Security update"
    else:
        status = "🟡 Update available"
    if fw_pending and not update:
        status = "🟡 Firmware pending"

    if sec_count:
        shown = ", ".join(cves[:3]) + (f" +{len(cves) - 3}" if len(cves) > 3 else "")
        security = f"{len(cves)} CVE" + ("s" if len(cves) != 1 else "") + (f" ({shown})" if cves else "")
        if other:
            security += f"{' + ' if cves else ''}{other} other security fix" + ("es" if other != 1 else "")
    else:
        security = "None announced" if update else "—"

    return {
        "model": rb.get("model") or res.get("board-name", ""),
        "installed": vstr(installed),
        "latest": latest_s,
        "released": released,
        "update": update,
        "security_update": update and sec_count > 0,
        "sec_count": sec_count,
        "fw_pending": fw_pending,
        "status": status,
        "version": f"{vstr(installed)} → {latest_s}" if update else vstr(installed),
        "security": security,
        "firmware": f"{cur_fw} → {up_fw} (reboot)" if fw_pending else (cur_fw or "?"),
    }


def esc(v):
    return str(v).replace("\\", "\\\\").replace("\n", " ").replace('"', '\\"')


last_good = {}


def run_once():
    lines = []
    ok = {}
    for dev in DEVICES:
        try:
            last_good[dev["device"]] = check(dev)
            ok[dev["device"]] = 1
        except Exception as e:  # keep the last good result, flag the failure
            ok[dev["device"]] = 0
            # never log credentials: only the device, the stage and the error text
            print(f"{dev['device']}: check failed: {type(e).__name__}: {e}", flush=True)

    def metric(name, help_, typ, rows):
        lines.append(f"# HELP {name} {help_}")
        lines.append(f"# TYPE {name} {typ}")
        lines.extend(rows)

    info_rows, gauges = [], {k: [] for k in ("upd", "sec", "seccount", "fw", "rel")}
    for dev in DEVICES:
        d = last_good.get(dev["device"])
        if not d:
            continue
        lbl = f'device="{dev["device"]}"'
        status = d["status"] if ok[dev["device"]] else "⚠️ Check failing (last good shown)"
        info_rows.append(
            "routeros_patch_info{" + lbl + "," + ",".join(
                f'{k}="{esc(v)}"' for k, v in (
                    ("name", dev["name"]), ("model", d["model"]), ("installed", d["installed"]),
                    ("latest", d["latest"]), ("channel", dev["channel"]), ("status", status),
                    ("version", d["version"]), ("security", d["security"]), ("firmware", d["firmware"]),
                )) + "} 1")
        gauges["upd"].append(f"routeros_update_available{{{lbl}}} {int(d['update'])}")
        gauges["sec"].append(f"routeros_security_update_available{{{lbl}}} {int(d['security_update'])}")
        gauges["seccount"].append(f"routeros_security_fixes_pending{{{lbl}}} {d['sec_count']}")
        gauges["fw"].append(f"routeros_firmware_upgrade_pending{{{lbl}}} {int(d['fw_pending'])}")
        gauges["rel"].append(f"routeros_latest_release_timestamp_seconds{{{lbl}}} {d['released']}")

    metric("routeros_patch_info", "RouterOS patch state, display strings for Homepage.", "gauge", info_rows)
    metric("routeros_update_available", "1 if a newer RouterOS exists on the device's channel.", "gauge", gauges["upd"])
    metric("routeros_security_update_available", "1 if that update's changelogs mention CVEs or security fixes.", "gauge", gauges["sec"])
    metric("routeros_security_fixes_pending", "CVE IDs plus other security changelog lines between installed and latest.", "gauge", gauges["seccount"])
    metric("routeros_firmware_upgrade_pending", "1 if RouterBOARD current-firmware differs from upgrade-firmware.", "gauge", gauges["fw"])
    metric("routeros_latest_release_timestamp_seconds", "Build time of the newest release on the channel.", "gauge", gauges["rel"])
    metric("routeros_patch_check_success", "0 if the device or the update server could not be read on the last run.", "gauge",
           [f'routeros_patch_check_success{{device="{k}"}} {v}' for k, v in ok.items()])
    metric("routeros_patch_check_last_run_timestamp_seconds", "When the last check finished.", "gauge",
           [f"routeros_patch_check_last_run_timestamp_seconds {int(time.time())}"])
    state["body"] = "\n".join(lines) + "\n"


def loop():
    while True:
        try:
            run_once()
        except Exception as e:
            print(f"run failed: {type(e).__name__}: {e}", flush=True)
        time.sleep(INTERVAL)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path not in ("/metrics", "/healthz"):
            self.send_error(404)
            return
        body = state["body"].encode() if self.path == "/metrics" else b"ok\n"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    if os.environ.get("RUN_ONCE"):
        run_once()
        print(state["body"])
    else:
        threading.Thread(target=loop, daemon=True).start()
        ThreadingHTTPServer(("", PORT), Handler).serve_forever()
