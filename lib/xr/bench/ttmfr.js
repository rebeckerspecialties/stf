'use strict'

// Time-to-meaningful-first-render (TTMFR) measurement. Four methods with
// very different confidence levels:
//   logcat-marker — app/page logs a token; timed via logcat epoch stamps.
//   webxr-marker  — page logs a console token observed over CDP.
//   image-diff    — poll raw mirror frames until one diverges from a
//                   pre-launch baseline (mirror-only, poll-quantized).
//   openxr-layer  — scaffold only; resolves ok:false with the roadmap.
// Every method resolves the same stf.xr.ttmfr.result.v1 shape and never
// rejects for measurement failures — errors land in result.error.

var fs = require('fs')
var os = require('os')
var path = require('path')

var Promise = require('bluebird')

var openxr = require('../openxr')

var readFileAsync = Promise.promisify(fs.readFile)
var unlinkAsync = Promise.promisify(fs.unlink)

var RESULT_SCHEMA = 'stf.xr.ttmfr.result.v1'
var DEFAULT_MARKER = 'STF_XR_READY'
var DEFAULT_TIMEOUT = 60000
var DEFAULT_INTERVAL = 1000
var DEFAULT_THRESHOLD = 0.02

// Cap on sampled bytes per frame comparison (~1M samples).
var MAX_DIFF_SAMPLES = 1048576
var DIFF_STRIDE = 16

// Bytes per pixel for the PixelFormat values screencap emits.
var BYTES_PER_PIXEL = {
  '1': 4 // RGBA_8888
, '2': 4 // RGBX_8888
, '3': 3 // RGB_888
, '4': 2 // RGB_565
, '5': 4 // BGRA_8888
}

function targetFor(opts) {
  if (opts.url) {
    return {url: opts.url}
  }
  if (opts.package) {
    var target = {package: opts.package}
    if (opts.activity) {
      target.activity = opts.activity
    }
    return target
  }
  return {}
}

function baseResult(provider, opts, method) {
  return {
    schema: RESULT_SCHEMA
  , serial: provider.serial
  , provider: provider.name
  , method: method
  , target: targetFor(opts)
  , ok: false
  , confidence: 'none'
  , timings: {
      launchedAtMs: null
    , markerAtMs: null
    , ttmfrMs: null
    }
  , evidence: {}
  , error: null
  }
}

function launchTarget(provider, opts) {
  if (opts.url) {
    return provider.openUrl(opts.url)
  }
  return provider.launchApk(opts.package, opts.activity || null)
}

// Pre-resolves cached provider state (browser detection) so its ADB round
// trips do not inflate the launch timestamp taken right before launching.
function prepareLaunch(provider, opts) {
  if (opts.url) {
    return provider.detectBrowser()
  }
  return Promise.resolve(null)
}

// Parses the header of an `adb exec-out screencap` raw dump. Older Android
// builds emit a 12-byte header (width, height, format as LE uint32); newer
// ones (P+) append a 4th uint32 with the dataspace. The exact-size checks
// decide when possible; otherwise a sane-looking format word prefers the
// 16-byte layout. Exported for tests.
function parseRawScreencap(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    throw new Error(
      'raw screencap buffer is too short (' +
      (Buffer.isBuffer(buffer) ? buffer.length + ' bytes' : typeof buffer) +
      '); expected at least a 12-byte header')
  }

  var width = buffer.readUInt32LE(0)
  var height = buffer.readUInt32LE(4)
  var format = buffer.readUInt32LE(8)
  var bytesPerPixel = BYTES_PER_PIXEL[format] || 4
  var expected = width * height * bytesPerPixel
  var offset = 12

  if (buffer.length >= 16) {
    if (buffer.length - 16 === expected) {
      offset = 16
    }
    else if (buffer.length - 12 === expected) {
      offset = 12
    }
    else if (format >= 1 && format <= 5 && (buffer.length - 16) % bytesPerPixel === 0) {
      // Sizes do not line up exactly (e.g. a truncated read); when the
      // header still looks like a known format, assume the modern layout.
      offset = 16
    }
  }

  return {
    width: width
  , height: height
  , format: format
  , bytesPerPixel: bytesPerPixel
  , headerSize: offset
  , data: buffer.slice(offset)
  }
}

// Fraction of sampled bytes that differ between two parsed frames. Frames
// of different dimensions count as fully changed.
function frameDelta(a, b) {
  if (a.width !== b.width || a.height !== b.height || a.data.length !== b.data.length) {
    return 1
  }

  var length = a.data.length
  if (length === 0) {
    return 0
  }

  var stride = DIFF_STRIDE
  if (length / stride > MAX_DIFF_SAMPLES) {
    stride = Math.ceil(length / MAX_DIFF_SAMPLES)
  }

  var changed = 0
  var total = 0
  for (var i = 0; i < length; i += stride) {
    total += 1
    if (a.data[i] !== b.data[i]) {
      changed += 1
    }
  }
  return changed / total
}

function captureFrame(session, dir, tag, keepArtifacts) {
  var dest = path.join(
    dir, 'stf-xr-ttmfr-' + process.pid + '-' + Date.now() + '-' + tag + '.raw')

  return session.screencapRaw(dest)
    .then(function() {
      return readFileAsync(dest)
    })
    .then(function(buffer) {
      var frame = parseRawScreencap(buffer)
      frame.path = keepArtifacts ? dest : null
      if (keepArtifacts) {
        return frame
      }
      return unlinkAsync(dest)
        .catch(function() {
          return null
        })
        .then(function() {
          return frame
        })
    })
    .catch(function(err) {
      // Raw frames run tens of MB; never leave one behind on a failed
      // capture/read/parse unless the caller asked to keep artifacts.
      if (keepArtifacts) {
        throw err
      }
      return unlinkAsync(dest)
        .catch(function() {
          return null
        })
        .then(function() {
          throw err
        })
    })
}

function diffEvidence(polls, threshold, baseline) {
  return {
    polls: polls
  , threshold: threshold
  , width: baseline ? baseline.width : null
  , height: baseline ? baseline.height : null
  }
}

function measureLogcatMarker(provider, opts) {
  var result = baseResult(provider, opts, 'logcat-marker')
  var session = provider.session
  var marker = opts.marker || DEFAULT_MARKER
  var timeout = opts.timeout || DEFAULT_TIMEOUT

  if (!opts.url && !opts.package) {
    result.error = 'logcat-marker needs {url} or {package} to launch a target'
    return Promise.resolve(result)
  }

  return prepareLaunch(provider, opts)
    .then(function() {
      return session.logcatClear()
    })
    .then(function() {
      result.timings.launchedAtMs = Date.now()
      return launchTarget(provider, opts)
    })
    .then(function() {
      return session.waitForLogcatMarker(marker, {timeout: timeout})
    })
    .then(function(hit) {
      // epochMs comes from the device clock while launchedAtMs is host
      // time, so the mixed-clock result is only medium confidence; with no
      // epoch stamp at all we fall back to host time and drop to low.
      var markerAtMs = hit.epochMs === null ? Date.now() : hit.epochMs
      result.ok = true
      result.confidence = hit.epochMs === null ? 'low' : 'medium'
      result.timings.markerAtMs = markerAtMs
      result.timings.ttmfrMs = markerAtMs - result.timings.launchedAtMs
      result.evidence = {
        marker: marker
      , line: hit.line
      , epochMs: hit.epochMs
      , elapsedMs: hit.elapsedMs
      }
      return result
    })
    .catch(function(err) {
      result.error = err.message
      return result
    })
}

function runWebxrMarker(provider, opts, result, marker, timeout) {
  var controller = null
  var tokenWait = null

  return provider.chrome()
    .then(function(resolved) {
      controller = resolved
      return controller.launchUrl(opts.url, {forceStop: true})
    })
    .then(function() {
      return controller.connect()
    })
    .then(function() {
      return controller.installBenchHooks()
    })
    .then(function() {
      // Attach the console listener before re-navigating so tokens logged
      // during the page load are not missed.
      tokenWait = controller.waitForConsoleToken(marker, {timeout: timeout})
      tokenWait.catch(function() {
        return null
      })
      return controller.navigate(opts.url)
    })
    .then(function() {
      result.timings.launchedAtMs = Date.now()
      return tokenWait
    })
    .then(function(hit) {
      var markerAtMs = Date.now()
      result.ok = true
      result.confidence = 'medium'
      result.timings.markerAtMs = markerAtMs
      result.timings.ttmfrMs = markerAtMs - result.timings.launchedAtMs
      return controller.readBenchState()
        .catch(function() {
          return null
        })
        .then(function(benchState) {
          result.evidence = {
            marker: marker
          , matchedText: hit.matchedText
          , benchState: benchState
          }
          return null
        })
    })
    .catch(function(err) {
      result.error = err.message
      return null
    })
    .then(function() {
      if (controller) {
        return controller.close().then(function() {
          return result
        })
      }
      return result
    })
}

function measureWebxrMarker(provider, opts) {
  var result = baseResult(provider, opts, 'webxr-marker')
  var marker = opts.marker || DEFAULT_MARKER
  var timeout = opts.timeout || DEFAULT_TIMEOUT

  if (!opts.url) {
    result.error = 'webxr-marker needs {url}'
    return Promise.resolve(result)
  }

  return provider.detectBrowser().then(function(browser) {
    if (!provider.supportsCdp(browser)) {
      result.error = 'webxr-marker needs a CDP-capable (Blink) browser; ' +
        (browser.chosen ?
          browser.chosen + ' is ' + (browser.engine || 'unknown') + '-based' :
          'no browser was detected') +
        ' — use the logcat-marker or image-diff method instead'
      return result
    }
    return runWebxrMarker(provider, opts, result, marker, timeout)
  })
}

function measureImageDiff(provider, opts) {
  var result = baseResult(provider, opts, 'image-diff')
  var session = provider.session
  var interval = opts.interval || DEFAULT_INTERVAL
  var timeout = opts.timeout || DEFAULT_TIMEOUT
  var threshold = typeof opts.threshold === 'number' ? opts.threshold : DEFAULT_THRESHOLD
  var artifactsDir = opts.artifactsDir || os.tmpdir()
  var keepArtifacts = opts.keepArtifacts === true
  var polls = []
  var baseline = null
  var launchedAtMs = null

  if (!opts.url && !opts.package) {
    result.error = 'image-diff needs {url} or {package} to launch a target'
    return Promise.resolve(result)
  }

  // Resolves the marker host time, or null when the timeout ran out first.
  function poll(index) {
    return Promise.delay(interval)
      .then(function() {
        return captureFrame(session, artifactsDir, 'poll-' + index, keepArtifacts)
      })
      .then(function(frame) {
        var now = Date.now()
        var delta = frameDelta(baseline, frame)
        polls.push({tMs: now - launchedAtMs, delta: delta})
        if (delta > threshold) {
          return now
        }
        if (now - launchedAtMs >= timeout) {
          return null
        }
        return poll(index + 1)
      })
  }

  return prepareLaunch(provider, opts)
    .then(function() {
      // The baseline is captured BEFORE launching; the first polled frame
      // whose delta vs this baseline exceeds the threshold is the marker.
      return captureFrame(session, artifactsDir, 'baseline', keepArtifacts)
    })
    .then(function(frame) {
      baseline = frame
      launchedAtMs = Date.now()
      result.timings.launchedAtMs = launchedAtMs
      return launchTarget(provider, opts)
    })
    .then(function() {
      return poll(1)
    })
    .then(function(markerAtMs) {
      result.evidence = diffEvidence(polls, threshold, baseline)
      if (markerAtMs === null) {
        result.error = 'no mirror frame changed more than ' + threshold +
          ' vs the pre-launch baseline within ' + timeout + 'ms; ' +
          'lower the threshold or raise the timeout'
      }
      else {
        // Mirror-only signal, quantized by the poll interval.
        result.ok = true
        result.confidence = 'low'
        result.timings.markerAtMs = markerAtMs
        result.timings.ttmfrMs = markerAtMs - launchedAtMs
      }
      return result
    })
    .catch(function(err) {
      result.evidence = diffEvidence(polls, threshold, baseline)
      result.error = err.message
      return result
    })
}

function measureOpenxrLayer(provider, opts) {
  var result = baseResult(provider, opts, 'openxr-layer')
  result.error = 'openxr-layer method is not implemented yet; see lib/xr/openxr/README.md'
  result.evidence = {roadmap: openxr.plan().ttmfr}
  return Promise.resolve(result)
}

function measure(provider, options) {
  var opts = options || {}

  if (!provider || !provider.session) {
    return Promise.reject(new Error(
      'A provider instance is required; get one via lib/xr/providers forName()/forDevice()'))
  }

  switch (opts.method) {
  case 'logcat-marker':
    return measureLogcatMarker(provider, opts)
  case 'webxr-marker':
    return measureWebxrMarker(provider, opts)
  case 'image-diff':
    return measureImageDiff(provider, opts)
  case 'openxr-layer':
    return measureOpenxrLayer(provider, opts)
  default:
    return Promise.reject(new Error(
      'Unknown TTMFR method ' + JSON.stringify(opts.method) +
      '; expected logcat-marker, webxr-marker, image-diff or openxr-layer'))
  }
}

module.exports.measure = measure
module.exports.parseRawScreencap = parseRawScreencap
