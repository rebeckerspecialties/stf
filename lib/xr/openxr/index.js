'use strict'

// OpenXR instrumentation scaffolding. Everything here is design-only: the
// native API layer does not exist yet, so the async entry points reject with
// XrNotImplementedError while plan() and artifactLayout() describe what the
// implementation will look like. Full design: lib/xr/openxr/README.md.

var util = require('util')

var Promise = require('bluebird')

var schemas = require('./schemas')

var ROADMAP_PATH = 'lib/xr/openxr/README.md'

function XrNotImplementedError(message) {
  Error.call(this)
  Error.captureStackTrace(this, XrNotImplementedError)
  this.name = 'XrNotImplementedError'
  this.message = message ||
    'OpenXR instrumentation is not implemented yet; see ' + ROADMAP_PATH
  this.roadmap = ROADMAP_PATH
}

util.inherits(XrNotImplementedError, Error)

function artifactLayout() {
  return {
    schema: 'stf.xr.openxr.artifacts.v1'
  , files: [
      {
        name: 'openxr-events.ndjson'
      , schema: schemas.EVENTS_SCHEMA
      , format: 'ndjson'
      , description: 'Lifecycle and per-frame events emitted by the API layer, one JSON ' +
          'object per line after a header line'
      }
    , {
        name: 'input-recording.ndjson'
      , schema: schemas.INPUT_SCHEMA
      , format: 'ndjson'
      , description: 'Controller and hand-tracking samples captured once per xrWaitFrame'
      }
    , {
        name: 'stereo-left.png'
      , schema: null
      , format: 'png'
      , description: 'Left-eye swapchain image copied at xrEndFrame (true per-eye render, ' +
          'not the 2D mirror)'
      }
    , {
        name: 'stereo-right.png'
      , schema: null
      , format: 'png'
      , description: 'Right-eye swapchain image copied at xrEndFrame'
      }
    , {
        name: 'stereo-metadata.json'
      , schema: schemas.STEREO_SCHEMA
      , format: 'json'
      , description: 'Dimensions, color format, frame index and timestamp for the stereo pair'
      }
    , {
        name: 'openxr-summary.json'
      , schema: schemas.SUMMARY_SCHEMA
      , format: 'json'
      , description: 'Single-run rollup: device identity, timings (including TTMFR) and ' +
          'artifact index'
      }
    ]
  }
}

function plan() {
  return {
    schema: 'stf.xr.openxr.plan.v1'
  , status: 'design'
  , roadmap: ROADMAP_PATH
  , apiLayer: {
      approach: 'An OpenXR API layer interposes every call between the app and the vendor ' +
        'runtime at the OpenXR ABI, so it works with any engine and needs no engine hooks'
    , engineAgnostic: true
    , graphicsFocus: 'vulkan'
    , strategies: [
        {
          id: 'app-packaged'
        , description: 'Explicit layer shipped inside the target APK and enabled through ' +
            'enabledApiLayerNames or the loader environment; needs a repack or debuggable build'
        }
      , {
          id: 'system-implicit'
        , description: 'Implicit layer manifest and library pushed to the device layer path ' +
            'on developer-mode devices; covers unmodified apps, path varies per vendor'
        }
      , {
          id: 'vendor-toggle'
        , description: 'Vendor developer settings or loader broker flags that enable layer ' +
            'discovery for debuggable apps'
        }
      ]
    , vendorNotes: {
        oculus: 'Quest 1-3 run the Meta OpenXR runtime; apps often bundle the Meta loader. ' +
          'Oculus Go has no OpenXR runtime and is excluded'
      , pico: 'Pico 4 / 4 Ultra: implicit layer paths and toggles differ across firmware ' +
          'versions; probe per firmware'
      , samsung: 'Galaxy XR (Android XR) follows standard Khronos Android loader semantics'
      , htc: 'Vive XR Elite supports OpenXR; all automation is ADB-only on this device'
      }
    }
  , ttmfr: {
      definition: 'Time from launch (intent dispatch / process_launched) to the ' +
        'first_meaningful_frame event'
    , signal: 'App marker via an XR_EXT_debug_utils label or a logcat token; falls back to ' +
        'first_frame_submitted with lower confidence'
    , clock: 'CLOCK_MONOTONIC nanoseconds on device, correlated to host time through a ' +
        'logcat marker emitted at layer init'
    , resultSchema: schemas.TTMFR_RESULT_SCHEMA
    , interimMethods: 'lib/xr/bench/ttmfr.js implements logcat-marker, webxr-marker and ' +
        'image-diff until the layer ships'
    }
  , stereoScreenshot: {
      approach: 'Copy each eye\'s acquired swapchain image at xrEndFrame via a Vulkan copy ' +
        'into a host-visible staging buffer, then encode per-eye PNGs'
    , output: ['stereo-left.png', 'stereo-right.png', 'stereo-metadata.json']
    , metadataSchema: schemas.STEREO_SCHEMA
    }
  , inputReplay: {
      recordingSchema: schemas.INPUT_SCHEMA
    , record: 'Sample controller poses, action state and hand joints once per xrWaitFrame ' +
        'into NDJSON'
    , replayOptions: [
        'runtime injection extension where a vendor exposes one'
      , 'layer-level override of xrLocateSpace / xrGetActionState* with recorded values'
      , 'synthetic OpenXR runtime shim that replays recordings (heavyweight, long term)'
      ]
    , constraints: 'No portable OpenXR input-injection API exists; replay is deterministic ' +
        'only for apps driven by polled input'
    }
  , artifacts: artifactLayout()
  }
}

// Shared rejection helper for the not-yet-implemented entry points. The
// arguments the caller passed are echoed onto the error as .context so
// failures stay debuggable in logs.
function notImplemented(feature, hint, context) {
  var err = new XrNotImplementedError(
    feature + ' is not implemented yet: ' + hint + '. See ' + ROADMAP_PATH + '.')
  err.feature = feature
  err.context = context || null
  return Promise.reject(err)
}

function installApiLayer(session, options) {
  return notImplemented(
    'installApiLayer'
  , 'the OpenXR API layer has no native build; packaging and install strategies are design-only'
  , {hasSession: !!session, options: options || null})
}

function captureStereoScreenshot(session, options) {
  return notImplemented(
    'captureStereoScreenshot'
  , 'per-eye swapchain capture needs the API layer; session.screencap gives the 2D mirror view'
  , {hasSession: !!session, options: options || null})
}

function recordInput(session, options) {
  return notImplemented(
    'recordInput'
  , 'controller and hand recording needs the API layer'
  , {hasSession: !!session, options: options || null})
}

function replayInput(session, recordingPath, options) {
  return notImplemented(
    'replayInput'
  , 'input replay needs a runtime extension or a synthetic runtime shim'
  , {hasSession: !!session, recordingPath: recordingPath || null, options: options || null})
}

function collectArtifacts(session, destDir, options) {
  return notImplemented(
    'collectArtifacts'
  , 'no OpenXR artifacts are produced yet; artifactLayout() lists the planned files'
  , {hasSession: !!session, destDir: destDir || null, options: options || null})
}

module.exports.XrNotImplementedError = XrNotImplementedError
module.exports.plan = plan
module.exports.artifactLayout = artifactLayout
module.exports.installApiLayer = installApiLayer
module.exports.captureStereoScreenshot = captureStereoScreenshot
module.exports.recordInput = recordInput
module.exports.replayInput = replayInput
module.exports.collectArtifacts = collectArtifacts
