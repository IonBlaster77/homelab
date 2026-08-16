# Whole-Home Distributed Audio

Multiroom audio across the house: Home Assistant + Music Assistant as the brain, cheap
DIY ESP32 endpoints per zone, upgrading individual rooms to Pi/commercial gear only as
requirements demand.

**Philosophy:** cheap and fast. Build, live with it, tune, upgrade only what needs it.
Currently testing/MVP phase.

**Location:** Magill, Adelaide SA. Household is all-Apple.

Related: [`BOOTSTRAP.md`](BOOTSTRAP.md), [`NAS-AND-SWITCH-MAINTENANCE.md`](NAS-AND-SWITCH-MAINTENANCE.md).
Tracked as task **#39** in the homelab task list.

---

## ⚠️ Critical path: the hub does not exist yet

**Verified 2026-08-16 against the live cluster and this repo: there is no Home Assistant
and no Music Assistant.** No namespace, no manifests, no ArgoCD app — the only near-match
is `homepage`, which is the unrelated dashboard. Every zone below depends on a hub that
has not been built.

This does **not** block ordering hardware, and the sequencing actually works in your
favour: AliExpress lead time is ~3 weeks, so **order the disposable layer now and build
HA + MA during that window.** The parts arrive into a working hub instead of a box.

Deploying HA and MA on Talos is not a trivial "add an app" step, and the following need
deciding as part of it:

- **HA needs persistent storage** — a Longhorn PVC, and it should be in the existing
  backup groups (see the `default` recurring-job group; backups run 02:00 Adelaide).
- **HA is historically hostile to containers/k8s** — the supervised/add-on model does not
  apply here. Expect plain HA Container, which means **no add-on store**; Music Assistant
  gets deployed as its own separate workload rather than as an HA add-on.
- **mDNS/discovery is the hard part on Cilium** — see Networking below. This is the single
  most likely thing to eat a weekend.
- **Host networking vs. LoadBalancer** — HA discovery protocols generally assume L2
  adjacency with the devices. Decide deliberately; this interacts with the VLAN question.

---

## Core Architecture

| Layer | Choice |
|---|---|
| **Hub** | Home Assistant + Music Assistant, self-hosted on the Talos k8s cluster |
| **Sync protocol** | ESPHome + **Sendspin** (MA's native sync protocol, ESP32-only, technical preview, bridges to AirPlay) |
| **Second protocol** | **AirPlay** — household is all-Apple. WiiM units, HomePods, Apple TVs join via AirPlay; Sendspin↔AirPlay bridging keeps everything in one sync group |
| **Casting in** | MA's Spotify Connect plugin + AirPlay Receiver plugin, so family can cast from native apps onto MA zones/groups (Sonos-style) |
| **DSP/EQ** | MA built-in per-player DSP (parametric EQ, tone controls, limiter) |
| **Control** | HA touchscreen wall panels planned later, all rooms |

**Why Sendspin over squeezelite-esp32:** ESPHome integration (telemetry, OTA, git-managed
YAML config) matters more than having a native AirPlay receiver on each node.

**Caveats to test, not assume:**
- Spotify Connect and AirPlay Receiver plugins are **early-stage** — expect a few seconds
  of command lag. Test before relying on them, especially for TTS/announcement
  interruption behaviour.
- MA's built-in DSP covers AirPlay, Squeezelite and Sendspin players (and Universal groups
  running those). CamillaDSP/hardware DSP is only justified later for a serious listening
  room (crossovers, room correction, convolution).
- Wall panels are a **usability** play — they reduce reliance on the AirPlay-receiver-in-
  Control-Centre flow for family members.

---

## Standard Zone Build

The "cheap ESP32 zone" — most rooms.

| Part | Choice | Notes |
|---|---|---|
| MCU | ESP32-S3 N16R8 (or N8R8) | **Must have PSRAM (R8).** Octal SPI PSRAM on S3 — set `psram: mode: octal` in ESPHome or it **silently fails**. Octal PSRAM uses **GPIO 33–37 — avoid those pins for I2S** |
| DAC | PCM5102A breakout ("GY-PCM5102") | ~$3–5. **Tie SCK pin to GND** (internal PLL mode) — the most common wiring mistake. 3.3V logic, no level shifting needed |
| Amp | TPA3116D2 2.0 stereo board | **Must have mute/SD pin broken out** AND **accessible gain-setting resistors/jumpers** — see the gain-structure section below; both matter for idle noise. Avoid boards with onboard pot/NE5532 preamp (noise source) |
| PSU | 24V DC, RCM-marked plugpack | Standardise voltage across every zone — one spare covers any room |
| Buck | 24V→5V for ESP32 | Not needed where 5V is separately available (e.g. patio) |
| Enclosure | Sealed ABS project box | Same model/connector scheme across zones for interchangeability |

### Firmware pattern

One shared `common.yaml` ESPHome package (wifi, API, OTA, diagnostics) + thin per-room
override files with pin map + substitutions. Matches the existing SOPS+Age GitOps pattern.

> **Not yet written down or settled — do this before zone 2.**

### Idle hiss is mostly gain structure — set gain to 20dB

**Revised 2026-08-16: this, not the mute pin, is the first-order cause of idle hiss.**

The PCM5102A outputs **~2.1V RMS**. A TPA3116 at its common default **36dB gain** reaches
full output from about **0.35V** — so the amp is being fed roughly **15dB more signal than
it needs**, and every unnecessary dB amplifies the amp's own noise floor into the tweeter
at idle and at low volume.

**Set gain to 20dB.** That largely removes the hiss and still leaves far more output than
any speaker on this list needs. It matters most in the bedroom and office, which are
*low-volume* rooms where noise floor, not power, is the dominant quality factor.

Hence the amp spec requires accessible gain resistors/jumpers, not just a mute pin.

### The mute pin still matters — second-order

Must **unmute after the I2S clock is stable** (short delay, ~30–50ms) and **mute before it
stops**. Tuned by ear per build, not from a datasheet. Test in the actual room —
especially the kids' room, overnight.

### Zone tiering — set expectations per room

| Tier | Zones | Build |
|---|---|---|
| **Utility** — intelligibility, not fidelity | kids, garage, bathroom, patio | Standard build, 20dB gain, cheap speakers fine |
| **Quality** — will actually be listened to | bedroom, office, lounge | Same electronics are fine; **the speakers are what will disappoint** |

The 10–15W satellites (Optimus, Jaycar CS2459) are correctly matched to **utility zones
only**. In the quality tier the electronics are not the limiting factor — the speakers are.
Note also that a 25W amp into 10W speakers makes the per-zone volume ceiling a
**speaker-protection** measure, not just a neighbour one.

### Alternatives considered

Esparagus Audio Brick (DIN-rail, Ethernet) — viable but pricier/slower to ship.

**Sonocotta Louder-ESP32 / Louder-ESP32-Mini (TAS5805M) — reconsidered 2026-08-16 and now
the recommended default for the two quality zones (bedroom, office).** The TAS5805M has
*hardware* DSP: per-zone EQ and limiting that costs the cluster nothing, with no separate
DAC, no gain-structure lottery and nothing to solder. MA's built-in DSP softens the
argument but doesn't eliminate it. Still the wrong choice for utility zones on price.

---

## Zone-by-Zone Plan

### Kids room — **first build**
Sleep music + HA announcements. Lowest quality bar (current reference: a $20 karaoke
speaker). Cheap ESP32+DAC+amp. Presence/volume ceiling important.

**This is the canary zone for idle-noise tuning.**

### Garage
Cheap ESP32 zone. Tolerant of noise floor issues. *WiFi signal is a risk — metal/roller
doors. Check before wiring.*

### Bathroom
No power currently — needs a cable run + conduit (planned, achievable). Passive IP-rated
speaker only in the wet area; **electronics mounted dry**, outside the wet zone, in
roof/cupboard.

### Bedroom
Wife also listens critically here — leans "better quality." **Low-volume/noise-floor is
the dominant design constraint, not power.** AWA speakers are a plausible long-term home
if not used elsewhere. shairport-sync (via Pi, if used) would give native AirPlay casting.

### Office — highest-use room
Requires a **direct low-latency path**: network audio (Sendspin/AirPlay) must **NOT** carry
TV/game/desktop audio.

Plan: separate paths into one amp with multiple inputs — USB DAC for desktop, AirPlay/
Sendspin (via Pi ideally, for shairport-sync) for laptop and house audio.

The FO48U monitor has decent built-in 2.1 speakers (2×15W + 20W sub) but **can't be relied
on for always-on announcements/background music, since the monitor isn't always powered
on** — this room needs its own independent always-on zone regardless of monitor state.

AWA speaker purchase reconsidered as not ideal here (near-field desk use, large cabinets,
dated tonal character) — leaning toward studio monitors or a compact modern pair bought
deliberately later. **Build a cheap test zone here now anyway** to live with in the interim.

### Lounge / kitchen / dining — open plan, high-use
**TV audio must stay direct (HDMI ARC), never through MA.**

WiiM Amp — **the original, NOT the Amp Ultra; Ultra dropped AirPlay support** — is the
leading candidate for the permanent solution: 100W, streaming, ARC.

Build a cheap ESP32 test zone now to live with in the interim. Decide 1 zone vs. multiple
(grouped) after living with it — **lean toward starting with one central zone.**

### Patio — outdoor, couch/smoking area
Real use case: phone speaker is too quiet for videos while sitting outside. Used at all
hours **including late night/early morning.**

- **MAX98357A REJECTED here, revised 2026-08-16.** It was the *weakest* amp in the build
  (3.2W into 4Ω) going to the *only outdoor* zone — where there is no room gain, no wall
  reflections, and the stated problem is already "too quiet". Outdoors needs **more**
  power than indoors for the same perceived loudness, not less. Use the **standard
  PCM5102A + TPA3116** pair like every other zone; bridge to mono if running a single
  speaker. (This is why the DAC order quantity is 10, not 9.)
- **Run 24V to the patio, not 12V — decide this before the conduit is sealed.** At 12V a
  TPA3116 gives ~10W/ch into 8Ω (already ~3× the MAX98357A); at 24V it's ~25W and the
  patio becomes an ordinary zone on the standard PSU. A spare conductor pair is being
  pulled anyway, so the marginal cost now is near zero — and this is the one decision
  here that is genuinely expensive to revisit later
- IP65-rated outdoor speaker
- Sealed enclosure mounted under the curved plastic patio roof (out of direct weather;
  still use an IP-rated box and **orient cable entry downward** as cheap insurance)
- Conformal-coated board
- **Power: 5V and 24V via new conduit to the eave** (was 5V/12V — see the amp change
  above). 5V straight to ESP32, 24V to amp, no buck converter needed
- **Pull a spare conductor pair while the conduit is open.** Use a drip loop at cable entry
- **PIR motion sensor on the same ESP32**; gating logic lives in HA ("only play announcement
  if patio presence true in last N minutes") — same pattern reusable for kids' room bedtime
  automation later
- Volume from phone (MA app or eventual HA dashboard). **Set a conservative max-volume
  ceiling** given late-night use near neighbours
- *WiFi signal is a risk — distance from AP. Check before wiring.*

**Rejected for patio:** standalone battery/Bluetooth speaker — can't join the Sendspin/
AirPlay sync group cleanly, and can't host a presence sensor or be gated by HA automation.
The wired build was chosen once presence-gating became a requirement.

---

## Speakers

Speaker sourcing is decided separately from electronics — all decisions here are
speaker-agnostic.

> **General principle — the three layers, by permanence:**
> - **Speakers and cable runs are permanent** → spend deliberately
> - **Amp is semi-permanent** → upgrading costs a re-terminate
> - **ESP32+DAC is fully disposable** (~$16/zone) → buy freely, swap without consequence

| Candidate | Verdict |
|---|---|
| **AWA HF104** (1971, 8Ω, 75W, bookshelf, $70/pair, Athelstone) | **Leaning no.** Too large for office desk use, uncertain 50-year-old component condition, and tonal character (harsher tweeter, less controlled bass, weaker crossover) works *against* the warm/vocal-forward profile the household picked the Wharfedale for. Still viable as a cheap bench/tuning pair, but a cheaper pair would do the same job |
| **Optimus Pro-X33AV** (wall-mount satellites, 8Ω, 15W, $49/pair, Gulfview Heights, ~35–40min) | **Good candidate for kids/garage.** Low power handling matches cheap amp output better; pre-fitted wall brackets solve mounting |
| **Jaycar CS2459** Digitech passive bookshelf pair (2×10W, ~$42) | **Best power-handling match** to the standard TPA3116 build, known condition (new). **Currently sold out** online and possibly in-store — check before assuming available |
| **Wharfedale Diamond 12.1i** | **Endgame lounge reference.** Already selected in a prior session against the household's full music taste profile (vocal-forward, warm, non-fatiguing; ELAC rejected as too analytical). Target for the lounge, not a current purchase |

---

## Networking / Infrastructure — unresolved

- **mDNS across IoT/server VLANs** — Sendspin discovery needs it, or fall back to manual IP
  + DHCP reservations per endpoint. **Decide before scaling past zone 1–2.** This interacts
  with the open question about MikroTik likely being the real DHCP server rather than Kea
  (Kea has recorded 0 leases ever) — worth resolving *before* committing to a reservation
  scheme, or the reservations get made on the wrong box
- **WiFi signal check in garage and patio before committing wiring.** Both are likely
  weak-signal (garage: metal/roller doors; patio: distance from AP). If marginal, Ethernet
  via W5500 module is the fallback for that zone
- **MA/HA resource headroom** for 7 concurrent Sendspin streams + per-player DSP. Cluster
  sat at 22–48% CPU / 25–51% memory per node on 2026-08-16, so there is room, but this is
  unmeasured for this workload. Note talos2 has only ~15.6Gi allocatable vs ~23Gi
  elsewhere. Two more nodes are planned (task #34)
- **Naming convention** for MA players / HA entities / zone display names — **not settled.
  Do this before zone 2; renaming later breaks group definitions**
- **Power-outage recovery** — confirm ESPHome WiFi/API reconnect timing is acceptable,
  especially kids' room after a breaker trip at night
- **Announcement ducking vs. interrupting** — decide once, standardise across zones
- **Per-zone max volume ceilings** — needed for kids' room, bedroom and patio (late-night
  neighbours) **before go-live, not after an incident**
- **Basic HA dashboard** (zone media player cards + group buttons) — build early and rough
  as a cheap signal on whether the zone/group structure makes sense, before investing in
  wall panels

---

## Sourcing

| Item | Source |
|---|---|
| ESP32-S3 N16R8 | **AliExpress** (EC-Buying, ~$12.39, ~3wk) is the cheap default. **Phipps Electronics** (~$30.95, AU stock, 2–3 day) is the fast option *if* lead time actually blocks progress — but check DAC/amp lead times too, since a fast ESP32 alone doesn't help if it waits on other parts |
| PCM5102A, TPA3116 boards | AliExpress. Not stocked at Jaycar under those names |
| PSUs (RCM-marked), enclosures, fuse holders, speaker wire, CS2459 pair | Jaycar |

**Buying strategy — revised 2026-08-16:**
- **Disposable layer (ESP32 + DAC): buy 10 of each**, not 6–7. Arithmetic: 7 planned
  zones + 1 possible lounge split (zone 6 is open-plan and explicitly undecided) + 1
  bench/dev unit that is never installed + 1 dead-board buffer (one *will* die — magic
  smoke, wrong pin, static). Three spare ESP32s cost ~$37 and three spare DACs ~$12
  against a **3-week resupply lead time**; that is not a close call
- **Split the order across both vendors.** 1× ESP32-S3 from **Phipps** (~$30.95, AU stock,
  2–3 day) + the remaining 9 and all 10 DACs from **AliExpress**. The extra ~$18 on that
  one fast unit converts the 3-week shipping window from dead time into the window where
  `common.yaml`, the naming convention and the wifi/API/OTA/diagnostics package get built
  — none of which need a DAC or amp. That is exactly the sequencing this doc already asks
  for ("settle `common.yaml` before zone 2")
- **Amps: buy ONE now, not the fleet.** Cheap TPA3116 boards are a lottery — input
  coupling caps, layout, gain wiring and output filters vary wildly between sellers using
  the same chip name. Buying seven before hearing one is how you end up with seven boards
  that hiss identically. Prove one in the kids' room at 20dB gain, *then* bulk-order that
  specific listing
- **Don't cheap out on the PSU.** Class D passes supply noise fairly directly to the
  output, so a nasty 24V plugpack is a real noise source. It's a shared-failure-mode part
  standardised across every zone, so quality here is amortised
- **Speakers: opportunistically/deliberately per room, never in bulk**

---

## Next Steps

Ordered as given, with the hub inserted at its real position on the critical path.

1. **Order 10× ESP32-S3 (N16R8/N8R8) + 10× PCM5102A**, split 1× Phipps (fast) / 9× +
   10 DACs AliExpress. The patio gets a normal DAC now, not a MAX98357A — see Sourcing
   and the Patio section. *Do this first; the ~3wk lead time is the long pole*
2. **Build HA + Music Assistant on the cluster** *(added — see the critical-path section;
   this does not currently exist and everything else depends on it)*. Do it during the
   shipping window
3. Source **ONE** TPA3116 2.0 board **with mute pin AND gain jumpers broken out**, prove
   it at 20dB gain in the kids' room, then bulk-order that exact listing (patio included)
4. Standardise on 24V PSUs for **every** zone including the patio, which uses the new
   5V/24V conduit run
5. **Build and tune the kids' room zone first** (canary for idle-noise/mute-pin tuning),
   plus one adjacent zone to test grouping/sync
6. **Settle ESPHome `common.yaml` + naming convention before zone 2**
7. Run patio conduit (5V + **24V** + spare conductor, drip loop, sealed IP-rated enclosure)
   and build that zone with PIR presence gating
8. Build cheap interim test zones in office and lounge/kitchen/dining despite eventual
   upgrade plans (WiiM Amp for lounge, studio monitors for office) — **the point is to get
   real usage signal now**
9. Decide on AWA purchase (leaning no) vs. cheaper bench-test pair vs. no bench pair
10. Build the basic HA dashboard early to validate zone/group structure
