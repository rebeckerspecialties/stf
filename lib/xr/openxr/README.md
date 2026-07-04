# OpenXR instrumentation for STF XR (design)

Status: **design and scaffolding only**. This directory contains schemas,
machine-readable plans and rejecting stubs (`index.js`, `schemas.js`) — no
native code exists yet. Everything below describes how the eventual
implementation is intended to work so that other STF XR modules (providers,
`lib/xr/bench/ttmfr.js`, the CLI) can integrate against stable interfaces now.

## Goals

- Measure native OpenXR apps on standalone Android headsets (Quest 1-3,
  Pico 4 / 4 Ultra, Galaxy XR, Vive XR Elite) the same way the WebXR path
  measures browser content: launch, readiness, time-to-meaningful-frame,
  screenshots, input.
- Stay vendor-neutral and engine-agnostic. The instrumentation operates at
  the OpenXR ABI, so it requires no game-engine plugins or SDK hooks of any
  kind — an app built with Unity, Unreal, Godot or a hand-rolled renderer
  looks identical to the layer because they all speak the same OpenXR calls.
- Produce artifacts with fixed, versioned schemas (see `schemas.js`) that are
  pulled off the device over ADB and consumed by the bench/CLI layers.

## Why an OpenXR API layer

OpenXR, like Vulkan, supports *API layers*: shared libraries the loader
interposes between the application and the runtime. A layer sees every
`xr*` call with its arguments and return values, which is exactly the
observation point automation needs:

- lifecycle progress (instance/session creation, session begin),
- per-frame cadence (`xrWaitFrame` / `xrBeginFrame` / `xrEndFrame`),
- swapchain image traffic (what actually gets rendered),
- input state as the app itself polls it.

Alternatives were rejected: engine-specific plugins only cover one engine
(explicitly out of scope), runtime forks are per-vendor and unmaintainable,
and GPU-level tracing tools are not scriptable across all four vendors.

## Layer packaging and install strategies on Android

The Khronos Android loader discovers layers via app assets, system paths and
(on newer stacks) a loader broker. Three install strategies, in order of
preference per situation:

1. **App-packaged explicit layer** — the layer `.so` and manifest ship inside
   the target APK (`libs/` + assets) and are enabled through
   `XrInstanceCreateInfo.enabledApiLayerNames` or the loader's environment
   override. Works on locked-down retail devices, but requires a repack or a
   debuggable build of the app under test.
2. **System/implicit layer on developer-mode devices** — push the layer
   library and an implicit-layer manifest to the device's layer search path
   over ADB. Covers unmodified apps, but requires developer mode, and the
   exact path plus SELinux behavior varies per vendor and firmware.
3. **Vendor developer toggles** — some runtimes expose developer settings or
   broker flags that enable layer discovery for debuggable apps without
   filesystem access.

Discovery caveats to verify per device: some apps statically link a loader
build without layer support; some vendors ship their own loader inside the
app rather than using the system one; broker-based discovery (newer Android
XR stacks) has its own enablement flags.

Per-vendor notes:

| Vendor | Notes |
| ------ | ----- |
| Quest 1/2/3 | Meta OpenXR runtime; apps commonly bundle Meta's loader. Meta documents layer enablement for debuggable apps; system-wide install needs developer mode. |
| Oculus Go | **Excluded** — no OpenXR runtime at all (legacy Mobile SDK only). All OpenXR features stay unavailable there by design. |
| Pico 4 / 4 Ultra | PICO OpenXR runtime; implicit layer paths and toggles differ across firmware versions/regions, so probe per firmware rather than hardcoding. |
| Galaxy XR | Android XR platform; expected to follow standard Khronos Android loader semantics with a Play-delivered runtime. |
| Vive XR Elite | OpenXR supported via the Vive runtime; all automation on this device is ADB-only (its browser is Gecko-based, which is irrelevant to the native path). |

## Lifecycle hooks → emitted events

The layer intercepts these calls and appends events to
`openxr-events.ndjson` (`stf.xr.openxr.events.v1`):

| Intercepted OpenXR call | Emitted event type |
| ----------------------- | ------------------ |
| `xrCreateInstance` | `xr_instance_created` |
| `xrCreateSession` | `xr_session_created` |
| `xrBeginSession` | `xr_session_begun` |
| `xrWaitFrame` | `xr_wait_frame` |
| `xrBeginFrame` | `xr_begin_frame` |
| `xrEndFrame` | `xr_end_frame` |
| `xrAcquireSwapchainImage` | `swapchain_acquired` |
| `xrReleaseSwapchainImage` | `swapchain_released` |

Additional synthesized events: `process_launched` and `activity_started`
(host-side, from `am` dispatch and logcat), `first_frame_submitted` (first
successful `xrEndFrame`), `first_meaningful_frame` (app-signaled, see TTMFR
below) and `custom_marker` (arbitrary named app markers). Events carry
`type`, `tsNs` and optional `pid` / `frameIndex` / `name` / `data`.

## Timestamp model

Every device-side event carries `tsNs`: `CLOCK_MONOTONIC` in nanoseconds,
the same clock OpenXR runtimes use for `XrTime` on Android. Host
correlation: at initialization the layer logs a single logcat marker
containing its current `CLOCK_MONOTONIC` reading; the host reads that line
with `adb logcat -v epoch`, giving one (monotonic ns → host epoch ms) fix
per run. Clock drift over a single benchmark run is negligible compared to
frame periods. Host-side events (`process_launched`) are recorded in host
epoch time and mapped through the same fix.

## Stereo screenshot format

`adb exec-out screencap` on a headset returns the flat 2D mirror of a single
eye — useful for liveness checks, useless for stereo verification. The layer
instead captures the real per-eye render:

- At `xrEndFrame` the layer walks the submitted projection layer views to
  find each eye's swapchain image (and array slice, for texture arrays).
- Vulkan path: `vkCmdCopyImage`/`vkCmdBlitImage` into a host-visible staging
  buffer, fenced, then read back and encoded off the render thread.
- Output: `stereo-left.png`, `stereo-right.png`, plus `stereo-metadata.json`
  (`stf.xr.openxr.stereo.v1`) recording per-eye file/width/height, the color
  format, frame index and capture timestamp.

## TTMFR model

**TTMFR = time to meaningful first rendered frame**: from launch (intent
dispatch, refined to `process_launched` when the pid is known) until the
`first_meaningful_frame` event.

"Meaningful" needs app cooperation, because the first submitted frame is
usually a splash or loading frame:

1. Preferred: the app labels the frame with a reserved `XR_EXT_debug_utils`
   label (e.g. `stf-xr:meaningful-frame`), which the layer intercepts and
   converts to `first_meaningful_frame` with `data.source =
   'debug_utils_label'`.
2. Fallback: the app logs a logcat token (default `STF_XR_READY`); the host
   correlates it into the event stream.
3. Last resort: `first_frame_submitted` stands in, reported with lower
   confidence.

Results feed the existing `stf.xr.ttmfr.result.v1` schema as method
`openxr-layer` with confidence `high`. Until the layer exists,
`lib/xr/bench/ttmfr.js` resolves that method as `ok: false` and points here;
its `logcat-marker`, `webxr-marker` and `image-diff` methods are the interim
measurements.

## Input record and replay

**Record**: once per `xrWaitFrame` the layer samples controller grip/aim
poses (`xrLocateSpace`), boolean/float action state as the app syncs it
(`xrSyncActions` interception) and hand joints when `XR_EXT_hand_tracking`
is active. Samples append to `input-recording.ndjson`
(`stf.xr.openxr.input.v1`): each sample has `tsNs` and at least one of
`controllers` (pose = position[3] + orientation quaternion[4]), `hands`, or
`roomMesh`.

**Replay** options, honestly constrained — there is no portable OpenXR
input-injection API today:

1. Runtime injection extensions where a vendor exposes one (rare, mostly
   non-public).
2. Layer-level override: the same layer answers `xrLocateSpace` /
   `xrGetActionState*` with recorded values instead of live ones,
   interpolating to the nearest recorded sample. Engine-agnostic and works
   everywhere the layer installs, but can only affect state the app polls.
3. A synthetic OpenXR runtime shim that replays recordings end-to-end —
   maximum control, heavyweight (needs a compositor stub), long-term option.

Replay is deterministic only for apps whose logic is driven by polled input;
apps with internal randomness or network dependencies will diverge.

## Artifacts

Collected per run under `<artifactsDir>/<serial>/<runId>/` and pulled via
`adb pull` (see `artifactLayout()` in `index.js`):

| File | Schema | Purpose |
| ---- | ------ | ------- |
| `openxr-events.ndjson` | `stf.xr.openxr.events.v1` | Lifecycle + frame events |
| `input-recording.ndjson` | `stf.xr.openxr.input.v1` | Controller/hand samples |
| `stereo-left.png` | — | Left-eye swapchain capture |
| `stereo-right.png` | — | Right-eye swapchain capture |
| `stereo-metadata.json` | `stf.xr.openxr.stereo.v1` | Stereo pair metadata |
| `openxr-summary.json` | `stf.xr.openxr.summary.v1` | Run rollup: device, timings, artifact index |

## Integration points

- `lib/xr/openxr/index.js` is the module boundary: `plan()`,
  `artifactLayout()` and the five async entry points
  (`installApiLayer`, `captureStereoScreenshot`, `recordInput`,
  `replayInput`, `collectArtifacts`) — all currently rejecting with
  `XrNotImplementedError`.
- Future CLI surface: `stf xr openxr-install-layer`, `stf xr openxr-ttmfr`,
  `stf xr openxr-screenshot`, `stf xr openxr-record-input`,
  `stf xr openxr-replay-input`, `stf xr openxr-collect`.
- Providers gain nothing new until then; their `capabilities().openxr` flag
  already says whether a device can ever support this path.

## Graphics API scope: Vulkan first

All supported runtimes with OpenXR (Quest 1-3, Pico 4 / 4 Ultra, Galaxy XR,
Vive XR Elite) render predominantly through Vulkan, and web-derived native
stacks (WebGPU implementations, Babylon Native-style shells) also bottom out
in Vulkan on these devices. Capture and metrics therefore target Vulkan
swapchains first; a GLES fallback is possible later but not planned. This is
a graphics-API decision, not an engine one — there are still no
engine-specific hooks anywhere in the design.

## Future artifact sources (not in scope)

Vendor performance counters — Adreno GPU counters, Meta's OVR Metrics-style
stats (FPS, ASW state), Pico's equivalents — are natural future additions,
sourced via perfetto or vendor logcat channels. They would land as extra
NDJSON artifacts with their own schema ids; the existing schemas above do
not change for them.
