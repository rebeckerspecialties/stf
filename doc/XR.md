# XR Headset Automation

This STF fork includes an automation layer for standalone Android XR headsets (VR/MR devices
such as the Meta Quest line, PICO 4 family, Samsung Galaxy XR and HTC Vive XR Elite). It is
built for WebXR benchmarking and smoke testing today, with native OpenXR instrumentation on the
roadmap (see [OpenXR roadmap](#openxr-roadmap)).

Everything works over plain ADB, plus the Chrome DevTools Protocol (CDP) when the device
browser is Chromium-based. There are two entry points:

- a CLI: `stf xr <command>` (documented below), and
- a Node API under `lib/xr/` (see [lib/xr/README.md](../lib/xr/README.md) for the
  architecture and contributor guide).

No engine-specific hooks are used anywhere: pages are observed through standard browser APIs
and native apps will be observed at the OpenXR ABI, so the tooling is engine-agnostic.

## Supported devices

Device classification is fingerprint-based (`ro.product.*` / `ro.build.*` properties) with
three confidence levels: `high` (model fingerprint matched), `medium` (only the manufacturer
matched) and `none` (generic fallback). Devices whose `ro.build.characteristics` contains a
`vr`/`xr` entry are treated as XR headsets even when classification fails.

| Device            | Model id        | Default browser      | Engine (approx.) | CDP | OpenXR |
|-------------------|-----------------|----------------------|------------------|-----|--------|
| Oculus Go         | `oculus-go`     | `com.oculus.browser` | Chromium ~98     | yes | no     |
| Meta Quest        | `quest-1`       | `com.oculus.browser` | Chromium ~112    | yes | yes    |
| Meta Quest 2      | `quest-2`       | `com.oculus.browser` | Chromium ~144    | yes | yes    |
| Meta Quest 3      | `quest-3`       | `com.oculus.browser` | Chromium ~144    | yes | yes    |
| PICO 4            | `pico-4`        | varies by firmware   | Chromium ~105    | yes | yes    |
| PICO 4 Ultra      | `pico-4-ultra`  | varies by firmware   | Chromium (n/a)   | yes | yes    |
| Samsung Galaxy XR | `galaxy-xr`     | `com.android.chrome` | Chromium ~144    | yes | yes    |
| HTC Vive XR Elite | `vive-xr-elite` | Wolvic               | Gecko ~120       | no  | yes    |

All of these support WebXR. Tracking is 6DoF everywhere except the Oculus Go (3DoF). Engine
versions are hints from the device profiles, not guarantees — see
[CDP version skew](#cdp-version-skew-and-feature-detection) for how the code deals with the
spread.

Vendor notes:

- **Meta/Oculus** — some firmwares put the headset to sleep as soon as the proximity sensor
  stops seeing a wearer. The `OculusProvider` API exposes best-effort
  `disableProximitySensor()` / `enableProximitySensor()` broadcasts
  (`com.oculus.vrpowermanager.prox_close` / `prox_enable`) to keep a desk-mounted headset
  awake. The Oculus Go has no OpenXR runtime.
- **PICO** — the browser package differs per firmware region and version
  (`com.picovr.browser`, `com.pvr.browser`, `com.bytedance.picobrowser`, ...). Detection is
  dynamic and never hard-fails; on a miss the result lists browser-like packages found on the
  device so you can pass `--browser` explicitly.
- **Samsung Galaxy XR** — Android XR platform; Chrome is the system browser, so the full CDP
  path works.
- **HTC Vive XR Elite** — Wolvic is Gecko-based, so there is no CDP at all. URL launching,
  input and screenshots still work over ADB; CDP-only commands fail with a pointer to the ADB
  fallback.

Unknown devices fall back to a generic profile (Chrome/Chromium/Wolvic candidates), so most
Android XR devices work at reduced confidence without any code changes.

## Quickstart

1. Enable developer mode and USB debugging on the headset (see the vendor's developer
   documentation for details):
   - *Meta Quest / Go*: enable Developer Mode from the Meta Horizon phone app (requires a
     developer account), then accept the USB debugging prompt in the headset.
   - *PICO*: Settings → General → About, tap the software version repeatedly to unlock
     Developer options, then enable USB debugging.
   - *Samsung Galaxy XR*: standard Android developer options (tap the build number), then
     enable USB or wireless debugging.
   - *HTC Vive XR Elite*: enable developer mode via the Vive Manager app, then enable USB
     debugging.
2. Connect the device over USB (or `adb connect` over Wi-Fi) and verify `adb devices` sees it.
3. Discover and classify it:

   ```console
   $ stf xr devices
   1WMHH812345678 device Quest 2 android=12 browser: com.oculus.browser 35.4.0 confidence=high
   ```

4. Run the health checks:

   ```console
   $ stf xr preflight -s 1WMHH812345678 --url https://immersive-web.github.io/webxr-samples/
   ```

5. Smoke-test a WebXR page:

   ```console
   $ stf xr webxr-smoke -s 1WMHH812345678 --url https://example.com/my-webxr-scene/
   ```

The shared options read environment fallbacks when the flag is omitted: `$STF_XR_SERIAL`
for `--serial`, `$STF_XR_ADB` for `--adb` and `$STF_XR_TIMEOUT` for `--timeout`. Other
options are flag-only. The ADB binary is resolved from `--adb`, `$STF_XR_ADB`, `$ADB` or
plain `adb` in that order.

## Command reference

All device-bound commands share these options:

| Option           | Description                                                    |
|------------------|----------------------------------------------------------------|
| `--serial`, `-s` | Serial number of the target device (required).                 |
| `--adb`          | Path to the ADB binary (defaults to `$ADB` or `adb`).          |
| `--timeout`      | Timeout in ms (default 30000; 60000 for `webxr-smoke`/`ttmfr`). |
| `--json`         | Print machine-readable JSON on stdout.                         |

Commands that talk to the browser additionally accept:

| Option       | Description                                                            |
|--------------|------------------------------------------------------------------------|
| `--provider` | `auto` (default, classifies the device first), `oculus`, `pico`, `generic`. |
| `--browser`  | Force a browser package instead of detecting one.                      |
| `--port`     | Host port for the DevTools forward (default: adb-assigned).            |

On failure every command exits 1; with `--json` the error is printed on stdout as
`{"error": "<message>"}`.

### `stf xr devices`

Lists connected devices with their XR classification. No `--serial`; extra flags:
`--xr-only` (only devices classified as XR headsets, default false) and `--probe-browser`
(probe installed browser packages on each device, default true; disable with
`--no-probe-browser`).

```console
$ stf xr devices --json
```

```json
[
  {
    "serial": "1WMHH812345678",
    "state": "device",
    "props": {
      "manufacturer": "Oculus",
      "brand": "oculus",
      "model": "Quest 2",
      "product": "hollywood",
      "device": "hollywood",
      "name": "hollywood",
      "androidVersion": "12",
      "sdk": "32",
      "characteristics": "vr",
      "fingerprint": "oculus/hollywood/hollywood:12/...",
      "abi": "arm64-v8a"
    },
    "classification": {
      "vendorId": "oculus",
      "modelId": "quest-2",
      "confidence": "high",
      "displayName": "Quest 2"
    },
    "isXrHeadset": true,
    "provider": "oculus",
    "browser": {
      "candidates": ["com.oculus.browser"],
      "installed": ["com.oculus.browser"],
      "chosen": "com.oculus.browser",
      "version": "35.4.0.286.337",
      "engine": "blink",
      "devtoolsSocket": "localabstract:chrome_devtools_remote",
      "diagnostics": {}
    },
    "capabilities": {
      "webxr": true,
      "openxr": true,
      "cdp": true,
      "tracking": "6dof",
      "passthrough": null,
      "chromiumHint": 144,
      "geckoHint": null
    }
  }
]
```

Devices that are not online (or fail description) appear as
`{"serial": "...", "state": "offline", "error": "device not online"}`. When no browser
candidate is installed, `browser.chosen` is `null` and `browser.diagnostics` lists
`browserLikePackages` found on the device (PICO adds a `hint` too).

### `stf xr preflight`

Runs a sequence of health checks and exits 1 when any check fails (`ok: false`). Skipped
checks (`ok: null`, printed as `[SKIP]`) do not fail the run. Flags: `--url` (used for the
browser launch and WebXR checks), `--skip-browser-launch`.

The checks run in this order: `adb-online`, `screen-awake`, `packages-readable`,
`browser-detected`, `browser-launched`, `devtools-forward`, `cdp-version`, `cdp-target`,
`webxr` (only when `--url` is given and CDP connected), `screencap`.

```console
$ stf xr preflight -s 1WMHH812345678 --url https://example.com/scene/ --json
```

```json
{
  "serial": "1WMHH812345678",
  "provider": "oculus",
  "startedAt": "2026-07-04T12:00:00.000Z",
  "durationMs": 8412,
  "checks": [
    {"name": "adb-online", "ok": true, "detail": "sys.boot_completed=1", "error": null},
    {"name": "screen-awake", "ok": true, "detail": "mWakefulness=Awake", "error": null},
    {"name": "packages-readable", "ok": true, "detail": "214 packages", "error": null},
    {"name": "browser-detected", "ok": true,
     "detail": "com.oculus.browser 35.4.0.286.337 (blink)", "error": null},
    {"name": "browser-launched", "ok": true,
     "detail": "https://example.com/scene/ via com.oculus.browser", "error": null},
    {"name": "devtools-forward", "ok": true,
     "detail": "tcp:41123 -> localabstract:chrome_devtools_remote", "error": null},
    {"name": "cdp-version", "ok": true,
     "detail": "Chrome/144.0.7204.63 (Chrome major 144)", "error": null},
    {"name": "cdp-target", "ok": true, "detail": "https://example.com/scene/", "error": null},
    {"name": "webxr", "ok": true,
     "detail": "webxrAvailable=true immersiveVrSupported=true", "error": null},
    {"name": "screencap", "ok": true, "detail": "1272108 bytes (2D mirror view)", "error": null}
  ],
  "ok": true
}
```

On a Gecko device (Vive XR Elite) the CDP checks are `[SKIP]`ped with an explanation instead
of failing.

### `stf xr open-url`

Opens a URL via an Android VIEW intent, targeting the detected (or `--browser`-forced)
browser package. Works on every device, including Gecko-based browsers (where the JSON result
adds `"cdp": false` and the human output warns that CDP automation is unavailable). Flags:
`--url` (required), `--provider`, `--browser`.

### `stf xr webxr-smoke`

Launches a WebXR page, connects over CDP, optionally waits for readiness gates, checks
`navigator.xr` support, optionally clicks/taps an enter-VR control and counts new
`requestAnimationFrame` frames.

Flags beyond the common/browser sets: `--console-token`, `--ready-expression`,
`--ready-selector` (readiness gates, see [Readiness gates](#readiness-gates)),
`--enter-vr-selector` or `--enter-vr-x`/`--enter-vr-y` with `--input cdp|adb`,
`--wait-frames N`, `--bench-hooks` (default true, installs the `window.__stfXr` hooks),
`--require-immersive` (poll until immersive-vr support is confirmed) and `--strict`.

Verdict and exit code: `pass` is `true` when WebXR is available, `immersive-vr` is supported
and all supplied readiness gates were met; `false` (exit 1) when WebXR is definitively
unavailable or a gate failed; `"unknown"` when CDP is unavailable or support could not be
confirmed. `unknown` exits 0 unless `--strict` is set.

```console
$ stf xr webxr-smoke -s 1WMHH812345678 --url https://example.com/scene/ \
    --console-token SCENE_READY --wait-frames 60 --json
```

```json
{
  "serial": "1WMHH812345678",
  "provider": "oculus",
  "url": "https://example.com/scene/",
  "browser": {
    "package": "com.oculus.browser",
    "version": "35.4.0.286.337",
    "engine": "blink"
  },
  "cdp": {
    "available": true,
    "connected": true,
    "browserVersion": "Chrome/144.0.7204.63",
    "chromeMajor": 144,
    "target": "https://example.com/scene/"
  },
  "webxr": {
    "available": true,
    "immersiveVrSupported": true,
    "reason": null
  },
  "readiness": {
    "consoleToken": {
      "token": "SCENE_READY",
      "matchedText": "SCENE_READY",
      "elapsedMs": 1873,
      "met": true
    },
    "expression": null,
    "selector": null
  },
  "enterVr": null,
  "frames": {
    "startFrames": 112,
    "endFrames": 173,
    "deltaFrames": 61
  },
  "pass": true,
  "durationMs": 9412
}
```

On a device without CDP (Wolvic) the page is still launched via ADB and the result comes back
with `"cdp": {"available": false, ...}`, `webxr` values `"unknown"` and `pass: "unknown"`.

### `stf xr tap` / `stf xr swipe` / `stf xr key` / `stf xr text`

ADB input primitives (`adb shell input ...`); they work on every device, including Gecko-based
browsers, and are the fallback whenever a CDP input method is unsupported.

- `tap`: `-x`, `-y` (screen pixels, required).
- `swipe`: `--x1 --y1 --x2 --y2` (required), `--duration` (ms, default 300).
- `key`: `--keycode` (number or name, e.g. `224` or `KEYCODE_WAKEUP`).
- `text`: `--text`.

### `stf xr cdp-tap` / `stf xr cdp-swipe`

Touch input injected inside the browser page over CDP (`Input.dispatchTouchEvent`), in page
CSS pixel coordinates. `cdp-tap` takes `-x`/`-y`; `cdp-swipe` takes `--x1 --y1 --x2 --y2`,
`--duration` (default 300) and `--steps` (interpolated touch moves, default 8). When the
browser build does not support the Input domain the command exits 1 with a message telling
you to use `stf xr tap` (ADB input) instead.

### `stf xr screencap`

Saves a PNG screenshot to `--out` (default `./xr-screencap.png`; the JSON result reports the
resolved absolute path). **On a headset this is the
flat 2D mirror view, not the per-eye stereo output the wearer sees** — see
[Mirror screenshot caveat](#mirror-screenshot-caveat). The JSON result carries the same
warning in a `note` field:

```json
{
  "serial": "1WMHH812345678",
  "path": "/home/me/xr-screencap.png",
  "note": "This is the flat 2D mirror view, not the per-eye stereo output the wearer sees."
}
```

### `stf xr install-apk` / `stf xr launch-apk`

APK sideloading and launching, e.g. for a WebXR-adjacent test harness or a native benchmark
app:

- `install-apk`: `--apk` (required), `--grant` (grant all runtime permissions, `adb install
  -g`), `--launch` with `--package` (and optional `--activity`) to start the app afterwards.
- `launch-apk`: `--package` (required), optional `--activity` (defaults to the LAUNCHER
  activity), `--action` and `--data` (intent action / data URI for `am start`).

### `stf xr ttmfr`

Measures time to meaningful first render; see
[TTMFR methods and confidence](#ttmfr-methods-and-confidence). Flags: `--method` (required:
`logcat-marker`, `webxr-marker`, `image-diff` or `openxr-layer`), `--url` or
`--package`/`--activity` as the target, `--marker` (default `STF_XR_READY`), `--threshold`
(default 0.02), `--interval`, `--artifacts-dir`, plus `--browser`/`--port` for the
CDP-based `webxr-marker` method.

The result always uses the `stf.xr.ttmfr.result.v1` schema and the command never rejects for
measurement failures — failures land in `error` with `ok: false` (exit 1, except for the
`openxr-layer` scaffold which exits 0):

```console
$ stf xr ttmfr -s 1WMHH812345678 --method logcat-marker \
    --url https://example.com/scene/ --marker SCENE_READY --json
```

```json
{
  "schema": "stf.xr.ttmfr.result.v1",
  "serial": "1WMHH812345678",
  "provider": "oculus",
  "method": "logcat-marker",
  "target": {"url": "https://example.com/scene/"},
  "ok": true,
  "confidence": "medium",
  "timings": {
    "launchedAtMs": 1783502400123,
    "markerAtMs": 1783502403841,
    "ttmfrMs": 3718
  },
  "evidence": {
    "marker": "SCENE_READY",
    "line": "1783502403.841  1234  1234 I chromium: SCENE_READY",
    "epochMs": 1783502403841,
    "elapsedMs": 3730
  },
  "error": null
}
```

## Readiness gates

Benchmarking a WebXR page the moment it loads produces garbage numbers: assets stream in,
shaders compile, and the scene often needs a user gesture. Readiness gates let you define
"the page is actually ready" and have `webxr-smoke` (or the `ChromeController` API) wait for
it. Available gate types:

| Gate            | Waits for                                                                |
|-----------------|--------------------------------------------------------------------------|
| `console-token` | A `console.log` (or Log entry) containing a substring token.             |
| `expression`    | A page JS expression to evaluate truthy (polled).                        |
| `selector`      | `document.querySelector(selector)` to match an element (polled).         |
| `webxr`         | `navigator.xr` availability (and immersive-vr support) to be confirmed.  |
| `raf-delta`     | N new `requestAnimationFrame` ticks (real rendering progress).           |

The controller API defaults to a 30 s gate timeout with 500 ms poll intervals; the CLI passes
its `--timeout` instead. In `webxr-smoke` the gates supplied via `--console-token`,
`--ready-expression` and `--ready-selector` run sequentially in that order; an unmet gate is recorded with `met: false` in the result and fails the run. The
console-token listener is attached *before* navigation so tokens logged during page load are
not missed — API users driving `ChromeController.waitForConsoleToken()` directly should do
the same.

With `--bench-hooks` (default), a script injected into the page exposes:

- `window.__stfXr` — `{frames, ready, sessionRequested, sessionStarted, markers}` state, with
  a `requestAnimationFrame` counter running,
- a wrapped `navigator.xr.requestSession` that logs `STF_XR_SESSION_STARTED` and records an
  `xr_session_started` marker when a session actually starts,
- `window.__stfXrMark(name)` for custom page-side markers (logs `STF_XR_MARK <name>`).

These console tokens are usable as `--console-token` gates and as `webxr-marker` TTMFR
markers.

## CDP version skew and feature detection

The browser builds on these headsets span roughly eight years of Chromium (and one Gecko
browser), so the code never version-gates — it feature-detects everything:

- **Version hints, not guarantees.** The device profiles carry `chromiumHint` values (Go ~98,
  Quest 1 ~112, Quest 2/3 and Galaxy XR ~144, PICO 4 ~105, PICO 4 Ultra unknown) and a
  `geckoHint` (~120 for Wolvic). The actual version is read at runtime from the DevTools
  `/json/version` endpoint (`cdp-version` preflight check, `cdp.chromeMajor` in results).
- **Domain probing at connect.** `Runtime.enable` is required (connection fails without it);
  `Page.enable` and `Log.enable` are optional and their absence is recorded in the
  controller's `capabilities`. The Input domain has no cheap probe, so it is detected lazily
  on first use.
- **Method-not-found handling.** A CDP error with code `-32601` (or a "method not found"
  message) marks that method as unsupported for the rest of the session. The rejection is
  decorated with `.unsupportedCdpMethod` and an actionable hint: `Input.*` failures point to
  the `stf xr tap`/`swipe`/`key`/`text` ADB fallbacks.
- **Automatic fallbacks.** `navigate()` falls back to a `location.href` assignment when
  `Page.navigate` is missing; `insertText()` falls back to per-character key events when
  `Input.insertText` is missing.
- **Old-page-JS discipline.** Everything injected into pages (WebXR checks, bench hooks, rAF
  counters) is ES5 with plain promise chains — no `async`/`await`, arrows or optional
  chaining — so it runs even on WebView builds far older than the profile hints.
- **Gecko is not CDP.** Wolvic (Vive XR Elite, and anywhere else it is the chosen browser)
  exposes no DevTools socket. `chrome()`-based operations reject with a message pointing at
  the ADB path; `open-url`, ADB input and `screencap` all still work.
- **Port forwarding.** The DevTools socket (`localabstract:chrome_devtools_remote`) is
  forwarded with `adb forward tcp:0 ...` and the allocated port is parsed from adb's output.
  Very old adb builds do not print it; pass an explicit `--port` in that case (the error
  message says so).

## Mirror screenshot caveat

`stf xr screencap` (and the providers' `screenshot()` API) use Android's `screencap`, which
captures the *flat 2D mirror view* — a single-eye, undistorted composition that headsets show
to cast/mirror consumers. It is **not** the stereo, lens-corrected output the wearer sees,
and depending on firmware and app it may lag or differ from the in-headset frame. It is good
for "is something rendering" checks and for the `image-diff` TTMFR method (which is marked
low-confidence for exactly this reason), not for pixel-accurate visual validation. True
per-eye capture is planned through the OpenXR layer (see the roadmap below).

## TTMFR methods and confidence

`stf xr ttmfr` measures **time to meaningful first render**: the time from launching a target
(URL or app) to the first evidence that a meaningful frame was presented. Four methods with
different trust levels:

| Method          | Signal                                                    | Confidence      |
|-----------------|-----------------------------------------------------------|-----------------|
| `logcat-marker` | Target logs a token; timed via `logcat -v epoch` stamps.  | medium (or low) |
| `webxr-marker`  | Page logs a console token, observed over CDP.             | medium          |
| `image-diff`    | First mirror frame that diverges from a pre-launch baseline. | low          |
| `openxr-layer`  | Not implemented yet (design scaffold).                    | none            |

Confidence semantics: `high` is reserved for single-clock, device-side measurements (the
future OpenXR layer); `medium` means the signal is event-driven but crosses clocks or runs
through the browser event loop; `low` means the signal is indirect and/or quantized by a poll
interval; `none` means no measurement was produced.

- **`logcat-marker`** — clears logcat, records host launch time, launches the target
  (`--url` or `--package`), then waits for `--marker` in logcat. When the log line carries an
  epoch timestamp the marker time is device-clock (`confidence: "medium"` — mixed host/device
  clocks); without one it falls back to host arrival time (`"low"`). Works for both web and
  native targets; the target must log the marker itself.
- **`webxr-marker`** — requires `--url` and a CDP-capable (Blink) browser; otherwise it
  resolves `ok: false` with guidance to use another method. Launches the page, installs the
  bench hooks, re-navigates, and measures from navigation to the `--marker` console token.
  Pages can emit the token via `window.__stfXrMark(...)` or plain `console.log`; the
  hook-generated `STF_XR_SESSION_STARTED` token is a convenient marker for "immersive session
  actually started". Evidence includes the final `window.__stfXr` state.
- **`image-diff`** — captures a raw mirror frame *before* launching, then polls raw frames
  every `--interval` ms (default 1000). The first frame whose sampled-byte delta versus the
  baseline exceeds `--threshold` (default 0.02) is the marker. No cooperation from the target
  is needed, but the signal is mirror-only and poll-quantized, hence `low`. Temporary raw
  dumps go to `--artifacts-dir` (default: the system temp dir) and are cleaned up. Evidence
  records every poll's `{tMs, delta}` for inspection.
- **`openxr-layer`** — scaffold: resolves `ok: false`, `confidence: "none"`, with an error
  pointing at the roadmap and the machine-readable plan in `evidence.roadmap`. The CLI exits
  0 for this method since the outcome is by design.

## Testing

The XR modules have a device-free test suite (fake adb binary fixture plus an in-process
DevTools server):

```console
$ npx mocha test/xr/
```

Lint (the repo's ESLint config applies to `lib/xr/**` and `lib/cli/xr/**`):

```console
$ gulp lint
```

## OpenXR roadmap

Native OpenXR instrumentation — lifecycle events, layer-based TTMFR, per-eye stereo
screenshots and input record/replay via an engine-agnostic OpenXR API layer — is designed but
not yet implemented. The design doc lives at
[`lib/xr/openxr/README.md`](../lib/xr/openxr/README.md); `lib/xr/openxr/index.js` exposes the
machine-readable `plan()` and `artifactLayout()`, and `lib/xr/openxr/schemas.js` ships the
versioned artifact schemas and validators that the implementation will target.
