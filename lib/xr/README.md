# lib/xr — XR headset automation (contributor guide)

Automation layer for standalone Android XR headsets. User-facing docs (device matrix, CLI
reference, TTMFR semantics) live in [doc/XR.md](../../doc/XR.md); this file is the map for
people changing the code.

## Module layout

```
lib/xr/
├── device-profiles.js    Static vendor/model knowledge + classify(). Pure data and pure
│                         helpers; nothing here talks to a device.
├── adb/
│   ├── session.js        AdbSession: everything for one serial over adb — exec/shell,
│   │                     getprop, packages, install/launch, input, screencap (PNG + raw),
│   │                     port forwards, logcat markers.
│   └── devices.js        Serial-less discovery: `adb devices -l` parsing, summarizeProps()
│                         (raw getprop -> summary shape), describe()/detect().
├── chrome/
│   ├── cdp-client.js     CdpClient: raw DevTools transport — /json/version + /json/list
│   │                     over HTTP, one websocket connection, send() with CDP error
│   │                     passthrough, events re-emitted by method name. No policy.
│   └── controller.js     ChromeController: policy on top of CdpClient + an AdbSession —
│                         launchUrl, forward/unforward, connect (domain probing), evaluate,
│                         navigate fallback, input methods with ADB-fallback errors,
│                         readiness gates (waitFor*), bench hooks, checkWebXr.
├── providers/
│   ├── base.js           BaseProvider: the vendor-neutral device API — classify,
│   │                     detectBrowser, describe, capabilities, openUrl, chrome(),
│   │                     screenshot, preflight(), webxrSmoke().
│   ├── oculus.js         OculusProvider: proximity-sensor broadcasts, Go openxr=false.
│   ├── pico.js           PicoProvider: browser-detection hint on a miss.
│   ├── generic-adb.js    GenericAdbProvider: fallback; also serves vendors without a
│   │                     subclass (samsung, htc) via effectiveVendorId().
│   └── index.js          forName(name, ...) / forDevice(serial, ...) factories.
├── bench/
│   └── ttmfr.js          measure(provider, opts): logcat-marker / webxr-marker /
│                         image-diff / openxr-layer, one result schema.
└── openxr/
    ├── README.md         OpenXR API-layer design doc (nothing native exists yet).
    ├── index.js          XrNotImplementedError, plan(), artifactLayout(), rejecting stubs.
    └── schemas.js        Versioned artifact schema ids, examples, dependency-free
                          validators.
```

The CLI wrappers live in `lib/cli/xr/` (one yargs module per subcommand plus a shared
non-command `util.js`), registered as `stf xr` in `lib/cli/index.js`. Tests live in
`test/xr/` with the executable fake adb fixture at `test/fixt/fake-adb.js`.

## Layering

Strictly one direction; lower layers know nothing about higher ones:

```
AdbSession ──> ChromeController ──> providers ──> bench/ttmfr ──> lib/cli/xr
     └───────────── device-profiles (pure data, used by devices + providers)
```

- `AdbSession` and `CdpClient` are transports. They do not classify devices or make vendor
  decisions.
- `ChromeController` owns CDP policy: feature detection, unsupported-method caching,
  fallbacks, gates. It takes any AdbSession-like object (injectable for tests).
- Providers own vendor policy and are the public entry point: get one from
  `providers.forDevice(serial, options)` (classifies first) or
  `providers.forName('oculus', serial, options)`.
- `bench/ttmfr.js` and the CLI only talk to providers.

## Provider interface (summary)

`new BaseProvider(serial, {adb, timeout, session, browserPackage, port, host})`. All async
methods return bluebird promises. Key methods:

- `getProps()` / `classify()` — cached prop summary / `{vendorId, modelId, confidence, ...}`.
- `detectBrowser()` — `{candidates, installed, chosen, version, engine, devtoolsSocket,
  diagnostics}`; never throws on a miss (diagnostics list browser-like packages instead).
- `describe()` — full device description incl. classification, browser and capabilities.
- `capabilities(classification, browser)` — `{webxr, openxr, cdp, tracking, passthrough,
  chromiumHint, geckoHint}` where `null` means unknown.
- `openUrl(url)` — VIEW intent via the chosen browser (works for Gecko too).
- `chrome(opts)` — cached `ChromeController`; rejects with actionable guidance for Gecko.
- `screenshot(dest)` — 2D mirror PNG (NOT stereo).
- `installApk` / `launchApk` / `stopApp` — session passthroughs.
- `preflight(opts)` — `{checks: [{name, ok, detail, error}], ok, ...}`; check failures never
  reject, `ok: null` means skipped.
- `webxrSmoke(opts)` — structured smoke result; optional-step failures are recorded in the
  result, not thrown; hard failures reject with `.partialResult` attached.

Subclasses override the `name`/`vendorId` prototype properties and add quirk methods; they
should not change result shapes.

One subtlety: `GenericAdbProvider` serves classified vendors that have no subclass. After
`classify()` caches a result, `effectiveVendorId()` upgrades browser detection and
capabilities to the classified vendor's profile (samsung candidates and full CDP for a
Galaxy XR; Wolvic/ADB-only handling for a Vive XR Elite) while the provider `name` stays
`'generic'`. Fixed-vendor providers ignore this.

## How to add a vendor

1. **Profile** — add a vendor entry to `device-profiles.js`: `id`, `displayName`,
   `manufacturerMatch` regexes, ordered `browserCandidates`, `devtoolsSocket` (or `null` for
   Gecko-only vendors), `quirks` (plain data) and `models` with `match` regexes tested
   against model/product/device/name props. Put more specific model fingerprints before the
   generic ones (see the PICO 4 Ultra vs PICO 4 ordering). If the browser is Gecko-based,
   also add its package to `browserEngines`.
2. **Provider** — only if the vendor needs behavior (quirk broadcasts, capability overrides,
   detection hints): subclass `BaseProvider` in `providers/<vendor>.js`
   (`util.inherits`-style, see `oculus.js`), register it in `providers/index.js`
   (`providers` map + `providerNames`) and add the name to the `--provider` choices in
   `lib/cli/xr/util.js`. If it needs no behavior, skip this step —
   `GenericAdbProvider` + `effectiveVendorId()` already picks up the profile.
3. **Tests** — extend `test/xr/device-profiles.js` (classification fixtures for the new
   fingerprints) and `test/xr/providers.js` (browser detection / capabilities with a fake
   session). Run `npx mocha test/xr/` — no device or adb needed.
4. **Docs** — add the device to the matrix in `doc/XR.md`.

## Design principles

- **Feature-detect, never version-gate.** Browser builds span ~Chrome 66-era WebViews to
  current Chromium. Probe CDP domains at connect, cache `-32601` method-not-found per
  method, and decorate errors with `.unsupportedCdpMethod` plus an actionable hint.
- **Degrade to ADB.** Every CDP capability has an ADB story (input, screencap, VIEW-intent
  launching). Gecko browsers (Wolvic) get no CDP at all and must still be usable.
- **Never hard-fail detection.** Unknown firmware is normal; return diagnostics
  (`browserLikePackages`, hints) instead of throwing, and let callers force `--browser`.
- **No engine-specific hooks.** Pages are observed via standard browser APIs; native apps
  will be observed at the OpenXR ABI (see `openxr/README.md`). Nothing may depend on how the
  content was built.
- **Results are data.** `lib/xr` modules return structured objects and never write to the
  console; only the CLI layer prints. Measurement failures resolve into result fields
  (`ok`/`error`/`confidence`) rather than rejecting, so callers can aggregate runs.
- **Injected page JS is ES5 + promise chains** — no `async`/`await`, arrows, template
  literals or optional chaining.
- **Repo style.** CommonJS, `var` only, no semicolons, comma-first multiline literals,
  bluebird (`var Promise = require('bluebird')`) for every promise, no new dependencies.
  `gulp lint` enforces this; `lib/cli/xr` files follow the existing CLI style (lazy requires
  inside handlers, no `'use strict'`).
