'use strict'

// BaseProvider is the vendor-neutral automation entry point for a single
// XR headset. Vendor subclasses (OculusProvider, PicoProvider) override
// `name`/`vendorId` and add quirk helpers; GenericAdbProvider keeps the
// defaults. IMPORTANT: the generic provider also serves vendors that have
// no dedicated subclass (Samsung Galaxy XR, HTC Vive XR Elite). Once
// classify() has run, a provider whose own vendorId is 'generic' prefers
// the classified vendor's profile — see effectiveVendorId() — so that e.g.
// a Galaxy XR probes the samsung browser candidates and devtools socket
// instead of the generic list. Fixed-vendor providers ignore that.

var fs = require('fs')
var os = require('os')
var path = require('path')

var Promise = require('bluebird')

var profiles = require('../device-profiles')
var devices = require('../adb/devices')
var AdbSession = require('../adb/session')
var ChromeController = require('../chrome/controller')

var statAsync = Promise.promisify(fs.stat)
var unlinkAsync = Promise.promisify(fs.unlink)

// KEYCODE_WAKEUP; harmless when the screen is already on.
var WAKEUP_KEYCODE = 224

var DEFAULT_SMOKE_TIMEOUT = 60000
var PREFLIGHT_DEFAULT_URL = 'https://example.com'

var BROWSER_LIKE = /browser|chrome|chromium|wolvic|webview/i

function assign(target, source) {
  Object.keys(source || {}).forEach(function(key) {
    target[key] = source[key]
  })
  return target
}

function modelValue(model, key) {
  if (model && typeof model[key] !== 'undefined') {
    return model[key]
  }
  return null
}

function displayNameFor(classification) {
  var model = classification.model
  if (model && model.names && model.names.length > 0) {
    return model.names[0]
  }
  return classification.vendor.displayName
}

function isBlinkPackage(pkg) {
  return profiles.browserEngine(pkg) === 'blink'
}

// Derives a host-based urlPattern for CdpClient.pickTarget from a URL.
// Returns null when the URL has no host part (e.g. about:blank).
function urlPatternFor(url) {
  var match = /^[a-zA-Z][\w+.-]*:\/\/([^/?#]+)/.exec(url || '')
  if (!match) {
    return null
  }

  // Escape the host so it is usable as a RegExp pattern.
  return match[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function initialSmokeResult(provider, opts, browser) {
  return {
    serial: provider.serial
  , provider: provider.name
  , url: opts.url
  , browser: {
      package: browser.chosen || null
    , version: browser.version || null
    , engine: browser.engine || null
    }
  , cdp: {
      available: false
    , connected: false
    , browserVersion: null
    , chromeMajor: null
    , target: null
    }
  , webxr: {
      available: 'unknown'
    , immersiveVrSupported: 'unknown'
    , reason: null
    }
  , readiness: {
      consoleToken: null
    , expression: null
    , selector: null
    }
  , enterVr: null
  , frames: null
  , pass: 'unknown'
  , durationMs: null
  }
}

function smokeWebXrStatus(status) {
  var known = status || {}
  var available = 'unknown'
  if (known.webxrAvailable === true) {
    available = true
  }
  else if (known.webxrAvailable === false) {
    available = false
  }
  return {
    available: available
  , immersiveVrSupported: typeof known.immersiveVrSupported === 'undefined' ?
      'unknown' : known.immersiveVrSupported
  , reason: known.reason || null
  }
}

function smokePass(result) {
  var gateNames = ['consoleToken', 'expression', 'selector']
  var gateFailed = gateNames.some(function(name) {
    var gate = result.readiness[name]
    return gate !== null && gate.met === false
  })

  if (gateFailed || result.webxr.available === false) {
    return false
  }
  if (result.webxr.available === true && result.webxr.immersiveVrSupported === true) {
    return true
  }
  return 'unknown'
}

function selectorClickJs(selector) {
  return [
    '(function() {'
  , '  var el = document.querySelector(' + JSON.stringify(selector) + ')'
  , '  if (!el) {'
  , '    return {clicked: false, reason: "not-found"}'
  , '  }'
  , '  el.click()'
  , '  return {clicked: true}'
  , '})()'
  ].join('\n')
}

function selectorCenterJs(selector) {
  return [
    '(function() {'
  , '  var el = document.querySelector(' + JSON.stringify(selector) + ')'
  , '  if (!el) {'
  , '    return null'
  , '  }'
  , '  var rect = el.getBoundingClientRect()'
  , '  return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2}'
  , '})()'
  ].join('\n')
}

function BaseProvider(serial, options) {
  var opts = options || {}

  if (!serial) {
    throw new Error('A device serial is required')
  }

  this.serial = serial
  this.options = opts
  this.session = opts.session || new AdbSession(serial, {
    adb: opts.adb
  , timeout: opts.timeout
  })
  this._props = null
  this._classification = null
  this._browser = null
  this._chrome = null
}

BaseProvider.prototype.name = 'generic'

BaseProvider.prototype.vendorId = 'generic'

// Resolves which vendor profile should drive browser detection. Providers
// with a fixed vendorId always use it; the generic provider upgrades to the
// classified vendor once classify() has cached a result, so Galaxy XR /
// Vive XR Elite devices get their real candidate lists.
BaseProvider.prototype.effectiveVendorId = function() {
  if (this.vendorId === 'generic' &&
      this._classification &&
      this._classification.vendorId !== 'generic') {
    return this._classification.vendorId
  }
  return this.vendorId
}

BaseProvider.prototype.vendorProfile = function() {
  return profiles.findVendor(this.effectiveVendorId()) || profiles.vendors.generic
}

BaseProvider.prototype.browserCandidates = function() {
  if (this.options.browserPackage) {
    return [this.options.browserPackage]
  }
  return this.vendorProfile().browserCandidates.slice()
}

BaseProvider.prototype.getProps = function() {
  var that = this

  if (this._props) {
    return Promise.resolve(this._props)
  }

  return this.session.getAllProps().then(function(rawProps) {
    that._props = devices.summarizeProps(rawProps)
    return that._props
  })
}

BaseProvider.prototype.classify = function() {
  var that = this

  if (this._classification) {
    return Promise.resolve(this._classification)
  }

  return this.getProps().then(function(props) {
    that._classification = profiles.classify(props)
    return that._classification
  })
}

BaseProvider.prototype.detectBrowser = function() {
  var that = this

  if (this._browser) {
    return Promise.resolve(this._browser)
  }

  return Promise.resolve()
    .then(function() {
      if (that.vendorId === 'generic') {
        // Classify first so effectiveVendorId() can pick the real vendor's
        // browser candidates (e.g. samsung for a Galaxy XR).
        return that.classify()
      }
      return null
    })
    .then(function() {
      return that.session.listPackages()
    })
    .then(function(packages) {
      return that._buildBrowserInfo(packages)
    })
    .then(function(info) {
      that._browser = info
      return info
    })
}

BaseProvider.prototype._buildBrowserInfo = function(packages) {
  var candidates = this.browserCandidates()
  var installed = candidates.filter(function(pkg) {
    return packages.indexOf(pkg) !== -1
  })
  var chosen = installed.length > 0 ? installed[0] : null
  var info = {
    candidates: candidates
  , installed: installed
  , chosen: chosen
  , version: null
  , engine: chosen ? profiles.browserEngine(chosen) : null
  , devtoolsSocket: chosen ? profiles.devtoolsSocketFor(chosen, this.effectiveVendorId()) : null
  , diagnostics: {}
  }

  if (!chosen) {
    // Help identify the real package on unknown firmware.
    info.diagnostics.browserLikePackages = packages.filter(function(pkg) {
      return BROWSER_LIKE.test(pkg)
    })
    return Promise.resolve(info)
  }

  return this.session.packageVersion(chosen)
    .catch(function() {
      return null
    })
    .then(function(version) {
      info.version = version
      return info
    })
}

BaseProvider.prototype.describe = function() {
  var that = this
  var props, classification

  return this.getProps()
    .then(function(resolvedProps) {
      props = resolvedProps
      return that.classify()
    })
    .then(function(resolvedClassification) {
      classification = resolvedClassification
      return that.detectBrowser()
    })
    .then(function(browser) {
      return {
        serial: that.serial
      , provider: that.name
      , props: props
      , classification: {
          vendorId: classification.vendorId
        , modelId: classification.modelId
        , confidence: classification.confidence
        , displayName: displayNameFor(classification)
        }
      , isXrHeadset: profiles.isLikelyXr(props, classification)
      , browser: browser
      , capabilities: that.capabilities(classification, browser)
      }
    })
}

BaseProvider.prototype.capabilities = function(classification, browser) {
  var model = (classification && classification.model) || null
  var tracking = modelValue(model, 'tracking')

  return {
    webxr: modelValue(model, 'webxr')
  , openxr: modelValue(model, 'openxr')
  , cdp: this._cdpCapability(browser)
  , tracking: tracking === null ? 'unknown' : tracking
  , passthrough: modelValue(model, 'passthrough')
  , chromiumHint: modelValue(model, 'chromiumHint')
  , geckoHint: modelValue(model, 'geckoHint')
  }
}

BaseProvider.prototype._cdpCapability = function(browser) {
  var info = browser || {}

  if (info.engine === 'gecko') {
    return false
  }
  if (info.engine === 'blink') {
    return true
  }

  // No chosen browser: a Blink candidate might still be installed under a
  // name we do not know, so treat blink-based vendors as unknown.
  var candidates = info.candidates || this.browserCandidates()
  if (candidates.some(isBlinkPackage)) {
    return null
  }
  return false
}

BaseProvider.prototype.supportsCdp = function(browserInfo) {
  return !!browserInfo && browserInfo.engine === 'blink'
}

BaseProvider.prototype.ensureAwake = function() {
  return this.session.keyevent(WAKEUP_KEYCODE)
    .then(function() {
      return {ok: true}
    })
    .catch(function(err) {
      return {ok: false, error: err.message}
    })
}

BaseProvider.prototype.openUrl = function(url, options) {
  var that = this
  var opts = options || {}

  return this.detectBrowser().then(function(browser) {
    return that.session.openUrl(url, browser.chosen || null, opts).then(function() {
      var result = {
        url: url
      , browserPackage: browser.chosen || null
      }
      if (browser.engine === 'gecko') {
        // The VIEW intent works fine, but there is no CDP to attach to.
        result.cdp = false
      }
      return result
    })
  })
}

BaseProvider.prototype.chrome = function(options) {
  var that = this
  var opts = options || {}

  if (this._chrome && opts.fresh !== true) {
    return Promise.resolve(this._chrome)
  }

  return this.detectBrowser().then(function(browser) {
    if (that.options.browserPackage && !browser.chosen) {
      var alike = (browser.diagnostics && browser.diagnostics.browserLikePackages) || []
      throw new Error(
        that.options.browserPackage + ' (forced via --browser) is not installed ' +
        'on this device' +
        (alike.length > 0 ? '; browser-like packages: ' + alike.join(', ') : ''))
    }
    if (browser.engine === 'gecko') {
      throw new Error(
        browser.chosen + ' is Gecko-based (Wolvic); CDP automation is not available — ' +
        'use ADB input (`stf xr tap`) and screencap instead')
    }
    if (!browser.devtoolsSocket) {
      throw new Error(
        'No DevTools socket is known for ' + (browser.chosen || 'this device') +
        '; no Blink browser was detected — pass --browser to force a browser package')
    }

    var controllerOptions = assign({
      browserPackage: browser.chosen
    , devtoolsSocket: browser.devtoolsSocket
    , port: that.options.port
    , host: that.options.host
    }, opts)
    delete controllerOptions.fresh

    var controller = new ChromeController(that.session, controllerOptions)
    if (opts.fresh !== true) {
      that._chrome = controller
    }
    return controller
  })
}

// Captures the flat 2D mirror view via `screencap -p`. On a headset this is
// NOT the stereo output the wearer sees, just a single-eye mirror frame.
BaseProvider.prototype.screenshot = function(destination, options) {
  return this.session.screencap(destination, options)
}

BaseProvider.prototype.installApk = function(apkPath, options) {
  return this.session.install(apkPath, options)
}

BaseProvider.prototype.launchApk = function(packageName, activity, options) {
  return this.session.startPackage(packageName, activity || null, options)
}

BaseProvider.prototype.stopApp = function(packageName) {
  return this.session.forceStop(packageName)
}

// ---------------------------------------------------------------------------
// Preflight: a sequence of health checks that never rejects for check
// failures. Each check is {name, ok: true|false|null, detail, error}; ok
// null means the check was skipped / not applicable.
// ---------------------------------------------------------------------------

BaseProvider.prototype.preflight = function(options) {
  var that = this
  var opts = options || {}
  var startedMs = Date.now()
  var state = {
    checks: []
  , browser: null
  , controller: null
  , forwarded: false
  , connected: false
  }

  return this._preflightChecks(state, opts)
    .then(function() {
      return that._preflightCleanup(state)
    })
    .then(function() {
      return {
        serial: that.serial
      , provider: that.name
      , startedAt: new Date(startedMs).toISOString()
      , durationMs: Date.now() - startedMs
      , checks: state.checks
      , ok: state.checks.every(function(check) {
          return check.ok !== false
        })
      }
    })
}

BaseProvider.prototype._runCheck = function(state, name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(function(outcome) {
      var result = outcome || {}
      state.checks.push({
        name: name
      , ok: typeof result.ok === 'undefined' ? true : result.ok
      , detail: typeof result.detail === 'undefined' ? null : result.detail
      , error: result.error || null
      })
      return null
    })
    .catch(function(err) {
      state.checks.push({name: name, ok: false, detail: null, error: err.message})
      return null
    })
}

BaseProvider.prototype._preflightChecks = function(state, opts) {
  var that = this
  var steps = [
    ['adb-online', function() {
      return that._checkAdbOnline()
    }]
  , ['screen-awake', function() {
      return that._checkScreenAwake()
    }]
  , ['packages-readable', function() {
      return that._checkPackagesReadable()
    }]
  , ['browser-detected', function() {
      return that._checkBrowserDetected(state)
    }]
  , ['browser-launched', function() {
      return that._checkBrowserLaunched(state, opts)
    }]
  , ['devtools-forward', function() {
      return that._checkDevtoolsForward(state)
    }]
  , ['cdp-version', function() {
      return that._checkCdpVersion(state)
    }]
  , ['cdp-target', function() {
      return that._checkCdpTarget(state)
    }]
  , ['webxr', function() {
      return that._checkPreflightWebXr(state, opts)
    }]
  , ['screencap', function() {
      return that._checkScreencap()
    }]
  ]

  return Promise.each(steps, function(step) {
    return that._runCheck(state, step[0], step[1])
  })
}

BaseProvider.prototype._preflightCleanup = function(state) {
  if (state.controller) {
    return state.controller.close().catch(function() {
      return null
    })
  }
  return Promise.resolve(null)
}

BaseProvider.prototype._checkAdbOnline = function() {
  var that = this

  return this.session.getProp('sys.boot_completed').then(function(value) {
    if (value === '1') {
      return {ok: true, detail: 'sys.boot_completed=1'}
    }
    return that.getProps().then(function() {
      return {
        ok: true
      , detail: 'sys.boot_completed=' + JSON.stringify(value) + ', but getprop responds'
      }
    })
  })
}

BaseProvider.prototype._checkScreenAwake = function() {
  return this.session.shell(['dumpsys', 'power']).then(function(result) {
    var match = /mWakefulness=(\w+)/.exec(result.stdout)
    if (!match) {
      return {ok: null, detail: 'skipped: dumpsys power does not report mWakefulness'}
    }
    return {
      ok: match[1] === 'Awake'
    , detail: 'mWakefulness=' + match[1]
    , error: match[1] === 'Awake' ?
        null : 'screen is not awake; wake it via ensureAwake() or adb input keyevent 224'
    }
  })
}

BaseProvider.prototype._checkPackagesReadable = function() {
  return this.session.listPackages().then(function(packages) {
    return {
      ok: packages.length > 0
    , detail: packages.length + ' packages'
    , error: packages.length > 0 ? null : 'pm list packages returned nothing'
    }
  })
}

BaseProvider.prototype._checkBrowserDetected = function(state) {
  return this.detectBrowser().then(function(browser) {
    state.browser = browser
    if (browser.chosen) {
      return {
        ok: true
      , detail: browser.chosen + (browser.version ? ' ' + browser.version : '') +
          ' (' + browser.engine + ')'
      }
    }

    var alike = (browser.diagnostics && browser.diagnostics.browserLikePackages) || []
    return {
      ok: false
    , detail: 'no candidate installed (tried ' + browser.candidates.join(', ') + ')' +
        (alike.length > 0 ? '; browser-like packages: ' + alike.join(', ') : '')
    , error: 'no browser candidate installed; pass --browser to force a package'
    }
  })
}

BaseProvider.prototype._checkBrowserLaunched = function(state, opts) {
  if (opts.skipBrowserLaunch) {
    return Promise.resolve({ok: null, detail: 'skipped (skipBrowserLaunch)'})
  }
  if (!state.browser || !state.browser.chosen) {
    return Promise.resolve({ok: null, detail: 'skipped: no browser detected'})
  }

  var url = opts.url || PREFLIGHT_DEFAULT_URL
  var chosen = state.browser.chosen

  return this.session.openUrl(url, chosen).then(function() {
    return {ok: true, detail: url + ' via ' + chosen}
  })
}

BaseProvider.prototype._checkDevtoolsForward = function(state) {
  if (!state.browser || !state.browser.chosen) {
    return Promise.resolve({ok: null, detail: 'skipped: no browser detected'})
  }
  if (state.browser.engine === 'gecko') {
    return Promise.resolve({
      ok: null
    , detail: 'skipped: ' + state.browser.chosen + ' is Gecko-based (no CDP)'
    })
  }

  return this.chrome().then(function(controller) {
    state.controller = controller
    return controller.forward().then(function(port) {
      state.forwarded = true
      return {ok: true, detail: 'tcp:' + port + ' -> ' + controller.devtoolsSocket}
    })
  })
}

BaseProvider.prototype._checkCdpVersion = function(state) {
  if (!state.forwarded || !state.controller) {
    return Promise.resolve({ok: null, detail: 'skipped: DevTools forward unavailable'})
  }

  return state.controller.version().then(function(version) {
    return {
      ok: true
    , detail: (version.browser || 'unknown browser') + ' (Chrome major ' +
        (version.chromeMajor === null ? 'unknown' : version.chromeMajor) + ')'
    }
  })
}

BaseProvider.prototype._checkCdpTarget = function(state) {
  if (!state.forwarded || !state.controller) {
    return Promise.resolve({ok: null, detail: 'skipped: DevTools forward unavailable'})
  }

  return state.controller.connect().then(function(controller) {
    state.connected = true
    var target = controller.client && controller.client.target
    return {ok: true, detail: target ? target.url || target.id : 'connected'}
  })
}

BaseProvider.prototype._checkPreflightWebXr = function(state, opts) {
  if (!opts.url) {
    return Promise.resolve({ok: null, detail: 'skipped: no url supplied'})
  }
  if (!state.connected || !state.controller) {
    return Promise.resolve({ok: null, detail: 'skipped: no CDP connection'})
  }

  return state.controller.checkWebXr().then(function(status) {
    return {
      ok: status.webxrAvailable === true
    , detail: 'webxrAvailable=' + status.webxrAvailable +
        ' immersiveVrSupported=' + status.immersiveVrSupported +
        (status.reason ? ' (' + status.reason + ')' : '')
    , error: status.webxrAvailable === true ? null : status.reason
    }
  })
}

BaseProvider.prototype._checkScreencap = function() {
  var dest = path.join(
    os.tmpdir(), 'stf-xr-preflight-' + process.pid + '-' + Date.now() + '.png')

  return this.session.screencap(dest)
    .then(function() {
      return statAsync(dest)
    })
    .then(function(stats) {
      return unlinkAsync(dest)
        .catch(function() {
          return null
        })
        .then(function() {
          return {ok: stats.size > 0, detail: stats.size + ' bytes (2D mirror view)'}
        })
    })
    .catch(function(err) {
      return unlinkAsync(dest)
        .catch(function() {
          return null
        })
        .then(function() {
          throw err
        })
    })
}

// ---------------------------------------------------------------------------
// WebXR smoke test: launch a page, verify WebXR availability over CDP and
// optionally drive readiness gates, an enter-VR interaction and a rAF frame
// check. Optional step failures are recorded in the result, not thrown;
// hard failures (cannot launch/connect when CDP is expected) reject with
// `.partialResult` attached.
// ---------------------------------------------------------------------------

BaseProvider.prototype.webxrSmoke = function(options) {
  var that = this
  var opts = options || {}
  var startedMs = Date.now()

  if (!opts.url) {
    return Promise.reject(new Error('webxrSmoke requires {url: ...}'))
  }

  return this.detectBrowser().then(function(browser) {
    var result = initialSmokeResult(that, opts, browser)
    if (!that.supportsCdp(browser)) {
      return that._smokeWithoutCdp(opts, result, startedMs)
    }
    result.cdp.available = true
    return that._smokeWithCdp(opts, result, startedMs)
  })
}

BaseProvider.prototype._smokeWithoutCdp = function(opts, result, startedMs) {
  return this.openUrl(opts.url).then(function() {
    result.webxr.reason =
      'CDP is not available for this browser; launched via ADB VIEW intent only'
    result.pass = 'unknown'
    result.durationMs = Date.now() - startedMs
    return result
  })
}

BaseProvider.prototype._smokeWithCdp = function(opts, result, startedMs) {
  var that = this
  var controller = null

  return this.chrome()
    .then(function(resolved) {
      controller = resolved
      return that._smokeDrive(controller, opts, result)
    })
    .then(function() {
      result.pass = smokePass(result)
      result.durationMs = Date.now() - startedMs
      return controller.close().then(function() {
        return result
      })
    })
    .catch(function(err) {
      result.durationMs = Date.now() - startedMs
      err.partialResult = result
      if (!controller) {
        throw err
      }
      return controller.close().then(function() {
        throw err
      })
    })
}

BaseProvider.prototype._smokeDrive = function(controller, opts, result) {
  var that = this
  var readiness = opts.readiness || {}
  var timeout = opts.timeout || DEFAULT_SMOKE_TIMEOUT
  var tokenWait = null

  return controller.launchUrl(opts.url, {forceStop: true})
    .then(function() {
      var pattern = urlPatternFor(opts.url)
      return controller.connect(pattern ? {urlPattern: pattern} : {})
    })
    .then(function() {
      result.cdp.connected = true
      result.cdp.target = controller.client.target ?
        controller.client.target.url || null : null
      return controller.version()
        .then(function(version) {
          result.cdp.browserVersion = version.browser
          result.cdp.chromeMajor = version.chromeMajor
          return null
        })
        .catch(function() {
          return null
        })
    })
    .then(function() {
      if (opts.benchHooks === false) {
        return null
      }
      return controller.installBenchHooks().catch(function() {
        return null
      })
    })
    .then(function() {
      if (readiness.consoleToken) {
        // Attach the listener BEFORE navigating so tokens logged during the
        // page load are not missed.
        tokenWait = controller.waitForConsoleToken(readiness.consoleToken, {timeout: timeout})

        // Observe rejections even if navigation fails first.
        tokenWait.catch(function() {
          return null
        })
      }
      return controller.navigate(opts.url)
    })
    .then(function() {
      return that._smokeGates(controller, readiness, tokenWait, result, timeout)
    })
    .then(function() {
      return that._smokeWebXr(controller, opts, result, timeout)
    })
    .then(function() {
      return that._smokeEnterVr(controller, opts, result)
    })
    .then(function() {
      return that._smokeFrames(controller, opts, result, timeout)
    })
}

BaseProvider.prototype._smokeGates = function(controller, readiness, tokenWait, result, timeout) {
  return Promise.resolve()
    .then(function() {
      if (!tokenWait) {
        return null
      }
      return tokenWait.then(function(outcome) {
        outcome.met = true
        result.readiness.consoleToken = outcome
        return null
      }, function(err) {
        result.readiness.consoleToken = {met: false, error: err.message}
        return null
      })
    })
    .then(function() {
      if (!readiness.expression) {
        return null
      }
      return controller.waitForExpression(readiness.expression, {timeout: timeout})
        .then(function(outcome) {
          outcome.met = true
          result.readiness.expression = outcome
          return null
        }, function(err) {
          result.readiness.expression = {met: false, error: err.message}
          return null
        })
    })
    .then(function() {
      if (!readiness.selector) {
        return null
      }
      return controller.waitForSelector(readiness.selector, {timeout: timeout})
        .then(function(outcome) {
          outcome.met = true
          result.readiness.selector = outcome
          return null
        }, function(err) {
          result.readiness.selector = {met: false, error: err.message}
          return null
        })
    })
}

BaseProvider.prototype._smokeWebXr = function(controller, opts, result, timeout) {
  var initial = opts.requireImmersive ?
    controller.waitForWebXr({timeout: timeout}) :
    controller.checkWebXr()

  return initial
    .then(function(status) {
      result.webxr = smokeWebXrStatus(status)
      return null
    })
    .catch(function(err) {
      // waitForWebXr timed out (or the evaluate failed); capture the last
      // observable state so the caller still sees why.
      return controller.checkWebXr()
        .then(function(status) {
          result.webxr = smokeWebXrStatus(status)
          result.webxr.reason = result.webxr.reason || err.message
          return null
        })
        .catch(function() {
          result.webxr = {
            available: 'unknown'
          , immersiveVrSupported: 'unknown'
          , reason: err.message
          }
          return null
        })
    })
}

BaseProvider.prototype._smokeEnterVr = function(controller, opts, result) {
  var spec = opts.enterVr
  var attempt

  if (!spec) {
    return Promise.resolve(null)
  }

  if (spec.selector) {
    attempt = this._enterVrBySelector(controller, spec.selector)
  }
  else if (typeof spec.x === 'number' && typeof spec.y === 'number') {
    attempt = this._enterVrByPoint(controller, spec)
  }
  else {
    attempt = Promise.resolve({
      dispatched: false
    , via: null
    , detail: 'enterVr needs {selector} or numeric {x, y}'
    })
  }

  return attempt
    .then(function(outcome) {
      result.enterVr = outcome
      return null
    })
    .catch(function(err) {
      result.enterVr = {dispatched: false, via: null, detail: err.message}
      return null
    })
}

BaseProvider.prototype._enterVrBySelector = function(controller, selector) {
  var that = this

  return controller.evaluate(selectorClickJs(selector), {awaitPromise: false})
    .then(function(outcome) {
      if (outcome && outcome.clicked === true) {
        return {dispatched: true, via: 'click', detail: selector}
      }
      if (outcome && outcome.reason === 'not-found') {
        return {
          dispatched: false
        , via: 'click'
        , detail: 'no element matches selector ' + selector
        }
      }
      return that._tapSelectorCenter(controller, selector)
    })
    .catch(function() {
      return that._tapSelectorCenter(controller, selector)
    })
}

BaseProvider.prototype._tapSelectorCenter = function(controller, selector) {
  return controller.evaluate(selectorCenterJs(selector), {awaitPromise: false})
    .then(function(center) {
      if (!center) {
        return {
          dispatched: false
        , via: 'cdp-tap'
        , detail: 'no element matches selector ' + selector
        }
      }
      return controller.tap(center.x, center.y).then(function() {
        return {dispatched: true, via: 'cdp-tap', detail: selector + ' center'}
      })
    })
}

BaseProvider.prototype._enterVrByPoint = function(controller, spec) {
  if (spec.input === 'adb') {
    return this.session.tap(spec.x, spec.y).then(function() {
      return {dispatched: true, via: 'adb-tap', detail: spec.x + ',' + spec.y}
    })
  }
  return controller.tap(spec.x, spec.y).then(function() {
    return {dispatched: true, via: 'cdp-tap', detail: spec.x + ',' + spec.y}
  })
}

BaseProvider.prototype._smokeFrames = function(controller, opts, result, timeout) {
  var wanted = opts.waitFrames || 0

  if (wanted <= 0) {
    return Promise.resolve(null)
  }

  return controller.waitForNewFrames(wanted, {timeout: timeout})
    .then(function(outcome) {
      result.frames = {
        startFrames: outcome.startFrames
      , endFrames: outcome.endFrames
      , deltaFrames: outcome.deltaFrames
      }
      return null
    })
    .catch(function(err) {
      result.frames = {
        startFrames: null
      , endFrames: null
      , deltaFrames: null
      , error: err.message
      }
      return null
    })
}

module.exports = BaseProvider
