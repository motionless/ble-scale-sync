# Local HA test — Renpho R-MSC02

**Local only. Drop this file, `.github/workflows/docker.yml` and
`ble-scale-sync-addon/build.yaml` before opening an upstream PR** — they are the
`chore:` commit on this branch.

Target: Home Assistant OS on a Raspberry Pi 4 (`aarch64`).

## 0. Enable Actions on the fork (one click, once)

`github.com/motionless/ble-scale-sync/actions` → **"I understand my workflows,
go ahead and enable them"**.

GitHub keeps workflows dormant on a fork until this is confirmed by hand. Until
then `actions/workflows` reports zero registered workflows even though
`.github/workflows/docker.yml` is present on `main`, and `gh workflow run` fails
with `HTTP 404: workflow docker.yml not found on the default branch`. There is no
API for it.

## 1. Build the image

The branch is already pushed. After step 0:

```bash
gh workflow run docker.yml --repo motionless/ble-scale-sync \
  --ref feat/renpho-msc02 -f tag=msc02
gh run watch --repo motionless/ble-scale-sync
```

Builds `ghcr.io/motionless/ble-scale-sync:msc02`, arm64 only. Expect ~10 min;
upstream's own runs of this workflow median 10.1 min for three architectures, and
the fork starts with a cold GHA cache.

### Alternative: build locally

This Mac is arm64, so `linux/arm64` builds natively with no emulation — likely
faster than Actions. Needs Docker, which is not currently installed
(`brew install --cask docker`), plus a GHCR token with `write:packages`:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u motionless --password-stdin
docker buildx build --platform linux/arm64 \
  -t ghcr.io/motionless/ble-scale-sync:msc02 --push .
```

Same image name, so steps 2 onward are unchanged.

## 2. Make the package public

`github.com/users/motionless/packages/container/ble-scale-sync/settings` →
Danger Zone → Change visibility → Public.

Packages pushed with `GITHUB_TOKEN` default to **private**, and the HA Supervisor
has no registry credentials. Skipping this gives a pull error that reads like a
missing image.

## 3. Install the add-on

Settings → Add-ons → Add-on Store → ⋮ → Repositories → add
`https://github.com/motionless/ble-scale-sync`, then install
**BLE Scale Sync (R-MSC02)** under the section
*BLE Scale Sync (motionless fork)*.

The add-on ships no application code; its Dockerfile layers `run.sh` onto
whatever `build_from` resolves to, which is now the image from step 1.

### The add-on config MUST be on the default branch

Home Assistant fetches an add-on repository's **default branch** and gives no way
to choose another. `repository.yaml`, `ble-scale-sync-addon/config.yaml` and
`build.yaml` therefore have to be on `main`, not only on a feature branch --
otherwise HA serves upstream's manifest and pulls
`ghcr.io/kristianp26/ble-scale-sync:latest`, and the giveaway in the log is an
adapter list containing `Renpho R-MSC04` but no `Renpho R-MSC02`, followed by
`Matched adapter: ES-CS20M`.

This `chore:` commit is cherry-picked onto `main` for that reason. The adapter
code itself does not need to be there: the add-on ships no application code, it
only pulls the image.

### If it shows up as the original repository

HA labels a store section from `repository.yaml` in the repo root, not from the
URL you typed. Upstream's copy of that file names KristianP26 and his URL, so an
unmodified fork announces itself *as* upstream. This branch rewrites it, and also
changes the add-on `slug` to `ble_scale_sync_msc02` and its name to
**BLE Scale Sync (R-MSC02)**, because HA keys an installed add-on by repository +
slug: sharing upstream's slug makes the two indistinguishable in the UI.

If you added the repository before this change, HA has the old manifest cached.
Remove the repository (⋮ → Repositories → the ⋯ next to it → Remove) and re-add
it, or use ⋮ → **Reload**. A plain page refresh is not enough.

### Bumping the version for a rebuild

`ble-scale-sync-addon/CHANGELOG.md` is generated from the root `CHANGELOG.md`, and
`tests/addon-changelog-sync.test.ts` (#294) fails if `config.yaml`'s version has no
entry there. So a bump is two steps, not one:

```bash
# add an entry to the root CHANGELOG.md for the new version, then
npm run sync:addon-changelog
```

Editing the add-on changelog by hand is the wrong fix -- the header says so.

### Picking up a rebuilt image

HA only rebuilds a local add-on when its **version** changes, so pushing a new
`:msc02` image under the same version leaves the old one running. After each
rebuild, raise the suffix in `ble-scale-sync-addon/config.yaml`
(`1.22.1-msc02.1` → `-msc02.2`), push, then ⋮ → Reload and Update in HA.

## 4. Configure

```yaml
user_height: 180        # your real height, NOT the 185 the scale was last told
user_age: 45
user_gender: male
user_is_athlete: false  # not transmitted; only moves physique rating now
garmin_enabled: false   # leave OFF for the first measurement
mqtt_enabled: true
log_level: debug        # needed for the two lines in step 6
```

`user_height` matters: the transmitted BMI is computed from whatever height the
scale was last told, and body fat with it. Records taken at 185 cm are not
comparable with records taken at 180 cm.

## 5. Measure

Start the add-on, watch the log, step on the scale **barefoot** and stay on it.
The impedance record lands about 13.5 s after the weight settles, so do not step
off early — the adapter holds the connection open for it.

## 6. What to look for

Two debug lines confirm the decode:

```
Renpho R-MSC02 segmental impedance (Ohm): trunk=… leftArm=… … @20kHz | … @100kHz
Renpho R-MSC02 scale-computed: slot=1 fat=…% bmi=… skeletalMuscle=…% (… kg) visceralFat=…
```

Then `Reading complete: NN.NN kg / NNN.N Ohm`.

Cross-check the ten impedances against the Bioelectrical Impedance table of a
report exported from the Renpho app for the same weigh-in. They should match
exactly — the app orders them Right Arm / Left Arm / Trunk / Right Leg / Left Leg,
the log orders them trunk / leftArm / rightArm / leftLeg / rightLeg.

Reference values from the two adult reports already verified:

| | 180 cm, 82.40 kg | 185 cm, 83.00 kg |
|---|---|---|
| body fat | 23.0 % | 19.2 % |
| BMI | 25.4 | 24.3 |
| visceral | 7 | 5 |
| bone mass | 4.20 kg | 4.50 kg |
| water | 46.47 kg | 49.22 kg |
| muscle mass | 59.16 kg | 62.58 kg |
| BMR | 1739 kcal | 1819 kcal |
| leg-to-leg 20 kHz | 548.1 Ω | 538.6 Ω |

## 7. Then enable Garmin

Only once step 6 looks right. Nine of the ten uploaded fields match the app
within 0.1 kg; **metabolic age will read your chronological age (45) against the
app's 44**, because the scale does not transmit one and the shared derivation is a
function of age alone.

Garmin body-composition entries are tedious to delete individually, which is why
the first measurement runs with `garmin_enabled: false`.

## Troubleshooting

**Matched as ES-CS20M, or connects with no data.** The name did not match. The
adapter matches the advertised name `r-msc02` exactly and deliberately does not
claim service `0x1A10`, so a scale advertising a different name falls through to
ES-CS20M, whose frame router discards every `55AA` frame. Check the advertised
name in the log.

**Weight only, no impedance.** The record never arrived. The adapter writes
nothing to the scale, on the evidence that the captures show no unlock command —
but whether the app's `0xB2` profile push is *required* before a record is emitted
is unproven. If this happens repeatedly, replaying `0xB2` + `0xB3` in
`onConnected` is the next thing to try.

**Composition looks estimated rather than measured.** Look for
`no usable body fat in the record trailer` (the trailer failed its range checks)
or `partial trailer` (normal for a profile under 18 — the scale omits skeletal
muscle and visceral fat there).

**Nothing under 18 gets a bone mass or metabolic age worth reading.** Expected.
The vendor app prints `--` for both, so the calibrated bone ratio is not
extrapolated below 18 and metabolic age falls back to the floor of 12.

## Rollback

Point `build_from` in `ble-scale-sync-addon/build.yaml` back at
`ghcr.io/kristianp26/ble-scale-sync:latest` and rebuild the add-on.
