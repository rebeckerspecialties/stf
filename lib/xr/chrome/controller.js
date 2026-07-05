'use strict'

// ChromeController drives a Chromium-based browser on an Android XR headset
// over the Chrome DevTools Protocol. Every CDP domain beyond Runtime is
// feature-detected so that old browser builds (e.g. the ~Chrome 66-era
// Oculus Go browser) degrade gracefully; unsupported input methods reject
// with an `.unsupportedCdpMethod` marker and a hint to use ADB input.

var Promise = require('bluebird')

var CdpClient = require('./cdp-client')

var DEFAULT_DEVTOOLS_SOCKET = 'localabstract:chrome_devtools_remote'
var DEFAULT_HOST = '127.0.0.1'
var DEFAULT_TIMEOUT = 15000
var DEFAULT_CONNECT_RETRIES = 10
var DEFAULT_CONNECT_RETRY_DELAY = 500
var DEFAULT_GATE_TIMEOUT = 30000
var DEFAULT_GATE_INTERVAL = 500

var ADB_FALLBACKS = {
  'Input.dispatchTouchEvent': 'use `stf xr tap`/`stf xr swipe` (ADB input) instead'
, 'Input.dispatchMouseEvent': 'use `stf xr tap` (ADB input) instead'
, 'Input.dispatchKeyEvent': 'use `stf xr key` (ADB input) instead'
, 'Input.insertText': 'use `stf xr text` (ADB input) instead'
, 'Page.navigate': 'navigate() falls back to a location.href assignment automatically'
}

// Only the core dispatch methods are used to infer the Input domain
// capability; Input.insertText is missing on some builds that still
// support key events.
var INPUT_CAPABILITY_METHODS = {
  'Input.dispatchTouchEvent': true
, 'Input.dispatchMouseEvent': true
, 'Input.dispatchKeyEvent': true
}

// Injected page JS must stay ES5 + plain promise chains; the oldest target
// is a ~Chrome 66-era WebView (no async/await, no arrows, no optional
// chaining).
var CHECK_WEBXR_JS = [
  '(function() {'
, '  if (typeof navigator === "undefined" || !navigator.xr) {'
, '    return {webxrAvailable: false, immersiveVrSupported: false,'
, '      reason: "navigator.xr missing"}'
, '  }'
, '  if (typeof navigator.xr.isSessionSupported !== "function") {'
, '    return {webxrAvailable: true, immersiveVrSupported: "unknown",'
, '      reason: "navigator.xr.isSessionSupported missing"}'
, '  }'
, '  return navigator.xr.isSessionSupported("immersive-vr").then(function(supported) {'
, '    return {webxrAvailable: true, immersiveVrSupported: supported === true,'
, '      reason: null}'
, '  }, function(err) {'
, '    return {webxrAvailable: true, immersiveVrSupported: "unknown",'
, '      reason: (err && err.message) ? String(err.message) : String(err)}'
, '  })'
, '})()'
].join('\n')

var INSTALL_RAF_JS = [
  '(function() {'
, '  var state = window.__stfXr = window.__stfXr || {}'
, '  if (typeof state.frames !== "number") {'
, '    state.frames = 0'
, '  }'
, '  if (!state.rafInstalled) {'
, '    state.rafInstalled = true'
, '    var rafLoop = function() {'
, '      state.frames += 1'
, '      window.requestAnimationFrame(rafLoop)'
, '    }'
, '    window.requestAnimationFrame(rafLoop)'
, '  }'
, '  return state.frames'
, '})()'
].join('\n')

var READ_RAF_JS = [
  '(window.__stfXr && typeof window.__stfXr.frames === "number") ?'
, '  window.__stfXr.frames : null'
].join('\n')

var BENCH_HOOKS_JS = [
  '(function() {'
, '  var state = window.__stfXr = window.__stfXr || {}'
, '  if (typeof state.frames !== "number") {'
, '    state.frames = 0'
, '  }'
, '  state.ready = state.ready === true'
, '  state.sessionRequested = state.sessionRequested === true'
, '  state.sessionStarted = state.sessionStarted === true'
, '  state.markers = state.markers || []'
, '  if (!state.rafInstalled) {'
, '    state.rafInstalled = true'
, '    var rafLoop = function() {'
, '      state.frames += 1'
, '      window.requestAnimationFrame(rafLoop)'
, '    }'
, '    window.requestAnimationFrame(rafLoop)'
, '  }'
, '  window.__stfXrMark = function(name) {'
, '    state.markers.push({name: name, t: performance.now()})'
, '    console.log("STF_XR_MARK " + name)'
, '  }'
, '  if (!state.hooksInstalled) {'
, '    state.hooksInstalled = true'
, '    if (typeof navigator !== "undefined" && navigator.xr &&'
, '        typeof navigator.xr.requestSession === "function") {'
, '      var originalRequestSession = navigator.xr.requestSession'
, '      navigator.xr.requestSession = function() {'
, '        state.sessionRequested = true'
, '        return originalRequestSession.apply(navigator.xr, arguments)'
, '          .then(function(session) {'
, '            state.sessionStarted = true'
, '            state.markers.push({name: "xr_session_started", t: performance.now()})'
, '            console.log("STF_XR_SESSION_STARTED")'
, '            return session'
, '          })'
, '      }'
, '    }'
, '  }'
, '  console.log("STF_XR_HOOKS_INSTALLED")'
, '  return true'
, '})()'
].join('\n')

function isMethodNotFound(err) {
  if (!err) {
    return false
  }
  return err.code === -32601 || /wasn'?t found|not found/i.test(err.message || '')
}

function adbFallbackHint(method) {
  var hint = ADB_FALLBACKS[method]
  return hint ? '; ' + hint : ''
}

function unsupportedError(method) {
  var err = new Error(
    'CDP method ' + method + ' is not supported by this browser build' + adbFallbackHint(method))
  err.unsupportedCdpMethod = method
  return err
}

function evaluationError(details) {
  var exception = details.exception || {}
  var description = exception.description || details.text || 'Unknown evaluation error'
  return new Error('Evaluation failed: ' + description)
}

function parseChromeMajor(browser) {
  var match = /Chrome\/(\d+)/.exec(browser || '') || /Chromium\/(\d+)/.exec(browser || '')
  return match ? parseInt(match[1], 10) : null
}

function firstNumber(a, b, fallback) {
  if (typeof a === 'number') {
    return a
  }
  if (typeof b === 'number') {
    return b
  }
  return fallback
}

function keyEventParams(type, key, opts) {
  var params = {
    type: type
  , key: key
  }
  if (typeof opts.code === 'string') {
    params.code = opts.code
  }
  if (typeof opts.windowsVirtualKeyCode === 'number') {
    params.windowsVirtualKeyCode = opts.windowsVirtualKeyCode
  }
  return params
}

function interpolatePoints(x1, y1, x2, y2, steps) {
  var points = []
  for (var i = 1; i <= steps; ++i) {
    points.push({
      x: x1 + ((x2 - x1) * i) / steps
    , y: y1 + ((y2 - y1) * i) / steps
    })
  }
  return points
}

function consoleArgsMatch(args, token) {
  var list = args || []
  for (var i = 0; i < list.length; ++i) {
    var arg = list[i]
    if (arg && typeof arg.value !== 'undefined') {
      var text = String(arg.value)
      if (text.indexOf(token) !== -1) {
        return text
      }
    }
  }
  return null
}

function mergeOptions(base, extra) {
  var merged = {}
  var from = base || {}
  var over = extra || {}
  Object.keys(from).forEach(function(key) {
    merged[key] = from[key]
  })
  Object.keys(over).forEach(function(key) {
    if (key !== 'type') {
      merged[key] = over[key]
    }
  })
  return merged
}

function ChromeController(session, options) {
  var opts = options || {}

  if (!session) {
    throw new Error('An AdbSession-like session object is required')
  }

  this.session = session
  this.options = opts
  this.browserPackage = opts.browserPackage || null
  this.devtoolsSocket = opts.devtoolsSocket || DEFAULT_DEVTOOLS_SOCKET
  this.host = opts.host || DEFAULT_HOST
  this.timeout = opts.timeout || DEFAULT_TIMEOUT
  this.port = null
  this.forwarded = false
  this.client = null
  this.capabilities = null
  this._unsupported = Object.create(null)
}

ChromeController.isMethodNotFound = isMethodNotFound

ChromeController.prototype.isMethodNotFound = isMethodNotFound

ChromeController.prototype.launchUrl = function(url, options) {
  var that = this
  var opts = options || {}

  if (opts.requirePackage && !this.browserPackage) {
    return Promise.reject(new Error(
      'No browser package configured; pass {browserPackage} (or --browser), or drop ' +
      'requirePackage to open the URL with the system default handler'))
  }

  return Promise.resolve()
    .then(function() {
      if (opts.forceStop && that.browserPackage) {
        return that.session.forceStop(that.browserPackage)
      }
      return null
    })
    .then(function() {
      return that.session.openUrl(url, that.browserPackage)
    })
    .then(function() {
      return {
        url: url
      , browserPackage: that.browserPackage
      }
    })
}

ChromeController.prototype.forward = function() {
  var that = this

  if (this.port !== null) {
    return Promise.resolve(this.port)
  }

  var requested = this.options.port || 0

  return this.session.forward(requested, this.devtoolsSocket).then(function(result) {
    var port = requested

    if (!port) {
      var reported = String((result && result.stdout) || '').trim()
      port = parseInt(reported, 10)
      if (!reported || isNaN(port) || port <= 0) {
        throw new Error(
          'adb did not report the port it allocated for the DevTools forward (stdout: ' +
          JSON.stringify(reported) + '); older adb versions do not print it — ' +
          'pass an explicit port (--port) instead')
      }
    }

    that.port = port
    that.forwarded = true
    return port
  })
}

ChromeController.prototype.unforward = function() {
  var port = this.port
  var created = this.forwarded

  this.port = null
  this.forwarded = false

  if (!created || port === null) {
    return Promise.resolve(false)
  }

  return this.session.removeForward(port)
    .then(function() {
      return true
    })
    .catch(function() {
      // Best effort; the forward dies with the adb server anyway.
      return false
    })
}

ChromeController.prototype.version = function() {
  var that = this

  return this.forward()
    .then(function(port) {
      return CdpClient.version(port, that.host)
    })
    .then(function(raw) {
      return {
        raw: raw
      , browser: raw.Browser || null
      , protocolVersion: raw['Protocol-Version'] || null
      , chromeMajor: parseChromeMajor(raw.Browser)
      }
    })
}

ChromeController.prototype.targets = function() {
  var that = this

  return this.forward().then(function(port) {
    return CdpClient.targets(port, that.host)
  })
}

ChromeController.prototype.connect = function(options) {
  var that = this
  var opts = options || {}
  var retries = firstNumber(opts.retries, this.options.connectRetries, DEFAULT_CONNECT_RETRIES)
  var retryDelay = firstNumber(opts.retryDelay
    , this.options.connectRetryDelay
    , DEFAULT_CONNECT_RETRY_DELAY)

  if (this.client && this.client.isConnected()) {
    return Promise.resolve(this)
  }

  return this.forward()
    .then(function() {
      return that._pollTarget({
        urlPattern: opts.urlPattern
      , predicate: opts.predicate
      }, retries, retryDelay)
    })
    .then(function(target) {
      var client = new CdpClient(target.webSocketDebuggerUrl, {timeout: that.timeout})
      client.target = target
      return client.connect()
    })
    .then(function(client) {
      that.client = client
      return that._enableDomains().catch(function(err) {
        that.client = null
        client.close()
        throw err
      })
    })
    .then(function() {
      return that
    })
}

ChromeController.prototype._pollTarget = function(pickOptions, retries, retryDelay) {
  var that = this

  return this.targets()
    .then(function(targets) {
      var target = CdpClient.pickTarget(targets, pickOptions)
      if (target && target.webSocketDebuggerUrl) {
        return target
      }
      throw new Error('No debuggable page target found on port ' + that.port)
    })
    .catch(function(err) {
      if (retries <= 0) {
        err.message += '; is ' + (that.browserPackage || 'the browser') +
          ' running with an open page? Open one first (CLI: `stf xr open-url`)' +
          ' or narrow target matching with a URL pattern'
        throw err
      }
      return Promise.delay(retryDelay).then(function() {
        return that._pollTarget(pickOptions, retries - 1, retryDelay)
      })
    })
}

// Sends an enable-style command purely to find out whether the browser
// build supports the domain. Optional domains resolve false on failure;
// required ones rethrow.
ChromeController.prototype._probe = function(method, params, required) {
  var that = this

  return this.client.send(method, params || {})
    .then(function() {
      return true
    })
    .catch(function(err) {
      if (isMethodNotFound(err)) {
        that._unsupported[method] = true
      }
      if (required) {
        err.message = method + ' failed; cannot drive this browser over CDP (' +
          err.message + ')'
        throw err
      }
      return false
    })
}

ChromeController.prototype._enableDomains = function() {
  var that = this

  return this._probe('Runtime.enable', null, true)
    .then(function() {
      return that._probe('Page.enable')
    })
    .then(function(pageEnabled) {
      return that._probe('Log.enable').then(function(logEnabled) {
        that.capabilities = {
          runtime: true
        , page: pageEnabled
        , log: logEnabled
        , input: null
        }
        return that.capabilities
      })
    })
}

ChromeController.prototype.disconnect = function() {
  var client = this.client

  this.client = null
  this.capabilities = null

  if (client) {
    client.close()
  }

  return Promise.resolve()
}

ChromeController.prototype.close = function(options) {
  var that = this
  var opts = options || {}

  return this.disconnect()
    .then(function() {
      if (opts.removeForward === false) {
        return false
      }
      return that.unforward()
    })
    .catch(function() {
      return false
    })
}

ChromeController.prototype._noteInputCapability = function(method, supported) {
  if (!INPUT_CAPABILITY_METHODS[method] || !this.capabilities) {
    return
  }
  if (!supported) {
    this.capabilities.input = false
  }
  else if (this.capabilities.input === null) {
    this.capabilities.input = true
  }
}

ChromeController.prototype.send = function(method, params, options) {
  var that = this

  if (!this.client || !this.client.isConnected()) {
    return Promise.reject(new Error(
      'Not connected to the browser DevTools socket; call connect() first'))
  }

  if (this._unsupported[method]) {
    return Promise.reject(unsupportedError(method))
  }

  return this.client.send(method, params, options)
    .then(function(result) {
      that._noteInputCapability(method, true)
      return result
    })
    .catch(function(err) {
      if (isMethodNotFound(err)) {
        that._unsupported[method] = true
        that._noteInputCapability(method, false)
        err.unsupportedCdpMethod = method
        err.message = 'CDP method ' + method + ' is not supported by this browser build (' +
          err.message + ')' + adbFallbackHint(method)
      }
      throw err
    })
}

ChromeController.prototype.evaluate = function(expression, options) {
  var opts = options || {}
  var params = {
    expression: expression
  , awaitPromise: opts.awaitPromise !== false
  , returnByValue: opts.returnByValue !== false
  }

  return this.send('Runtime.evaluate', params, {timeout: opts.timeout})
    .then(function(result) {
      if (result.exceptionDetails) {
        throw evaluationError(result.exceptionDetails)
      }
      if (opts.raw) {
        return result
      }
      return result.result && result.result.value
    })
}

ChromeController.prototype.navigate = function(url) {
  var that = this

  if (this._unsupported['Page.navigate'] ||
      (this.capabilities && this.capabilities.page === false)) {
    return this._navigateViaEvaluate(url)
  }

  return this.send('Page.navigate', {url: url})
    .then(function(result) {
      return {
        url: url
      , via: 'cdp'
      , frameId: result.frameId || null
      }
    })
    .catch(function(err) {
      if (err.unsupportedCdpMethod) {
        return that._navigateViaEvaluate(url)
      }
      throw err
    })
}

ChromeController.prototype._navigateViaEvaluate = function(url) {
  return this.evaluate('window.location.href = ' + JSON.stringify(url), {awaitPromise: false})
    .then(function() {
      return {
        url: url
      , via: 'evaluate'
      , frameId: null
      }
    })
}

ChromeController.prototype.checkWebXr = function(options) {
  var opts = options || {}
  return this.evaluate(CHECK_WEBXR_JS, {awaitPromise: true, timeout: opts.timeout})
}

ChromeController.prototype.tap = function(x, y, options) {
  var that = this
  var opts = options || {}

  return this.send('Input.dispatchTouchEvent', {
    type: 'touchStart'
  , touchPoints: [{x: x, y: y}]
  }, {timeout: opts.timeout})
    .then(function() {
      return that.send('Input.dispatchTouchEvent', {
        type: 'touchEnd'
      , touchPoints: []
      }, {timeout: opts.timeout})
    })
    .then(function() {
      return {x: x, y: y}
    })
}

ChromeController.prototype.swipe = function(x1, y1, x2, y2, options) {
  var that = this
  var opts = options || {}
  var duration = firstNumber(opts.duration, null, 300)
  var steps = firstNumber(opts.steps, null, 8)
  var points

  if (steps < 1) {
    steps = 1
  }
  points = interpolatePoints(x1, y1, x2, y2, steps)

  return this.send('Input.dispatchTouchEvent', {
    type: 'touchStart'
  , touchPoints: [{x: x1, y: y1}]
  })
    .then(function() {
      return Promise.each(points, function(point) {
        return Promise.delay(duration / steps).then(function() {
          return that.send('Input.dispatchTouchEvent', {
            type: 'touchMove'
          , touchPoints: [{x: point.x, y: point.y}]
          })
        })
      })
    })
    .then(function() {
      return that.send('Input.dispatchTouchEvent', {
        type: 'touchEnd'
      , touchPoints: []
      })
    })
    .then(function() {
      return {
        from: {x: x1, y: y1}
      , to: {x: x2, y: y2}
      , duration: duration
      , steps: steps
      }
    })
}

ChromeController.prototype.click = function(x, y, options) {
  var that = this
  var opts = options || {}
  var button = opts.button || 'left'

  return this.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved'
  , x: x
  , y: y
  , button: 'none'
  })
    .then(function() {
      return that.send('Input.dispatchMouseEvent', {
        type: 'mousePressed'
      , x: x
      , y: y
      , button: button
      , clickCount: 1
      })
    })
    .then(function() {
      return that.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased'
      , x: x
      , y: y
      , button: button
      , clickCount: 1
      })
    })
    .then(function() {
      return {x: x, y: y, button: button}
    })
}

ChromeController.prototype.keyPress = function(key, options) {
  var that = this
  var opts = options || {}

  return this.send('Input.dispatchKeyEvent', keyEventParams('rawKeyDown', key, opts))
    .then(function() {
      return that.send('Input.dispatchKeyEvent', keyEventParams('keyUp', key, opts))
    })
    .then(function() {
      return {key: key}
    })
}

ChromeController.prototype.insertText = function(text) {
  var that = this
  var value = String(text)

  return this.send('Input.insertText', {text: value})
    .then(function() {
      return {text: value, via: 'insertText'}
    })
    .catch(function(err) {
      if (err.unsupportedCdpMethod === 'Input.insertText') {
        return that._insertTextPerChar(value)
      }
      throw err
    })
}

ChromeController.prototype._insertTextPerChar = function(text) {
  var that = this

  return Promise.each(text.split(''), function(ch) {
    return that.send('Input.dispatchKeyEvent', {
      type: 'char'
    , text: ch
    })
  }).then(function() {
    return {text: text, via: 'char-events'}
  })
}

// Generic poll loop: `check` resolves a truthy result to finish, or a falsy
// value to keep polling until `timeout`.
ChromeController.prototype._pollUntil = function(check, options, description) {
  var opts = options || {}
  var timeout = firstNumber(opts.timeout, null, DEFAULT_GATE_TIMEOUT)
  var interval = firstNumber(opts.interval, null, DEFAULT_GATE_INTERVAL)
  var start = Date.now()

  function attempt() {
    return Promise.resolve()
      .then(check)
      .then(function(result) {
        if (result) {
          return {result: result, elapsedMs: Date.now() - start}
        }
        if (Date.now() - start >= timeout) {
          throw new Error('Timed out after ' + timeout + 'ms waiting for ' + description)
        }
        return Promise.delay(interval).then(attempt)
      })
  }

  return attempt()
}

// NOTE: attach this gate BEFORE calling navigate() so that tokens logged
// during the page load are not missed.
ChromeController.prototype.waitForConsoleToken = function(token, options) {
  var opts = options || {}
  var timeout = firstNumber(opts.timeout, null, DEFAULT_GATE_TIMEOUT)
  var client = this.client
  var useLog = this.capabilities && this.capabilities.log === true

  if (!client || !client.isConnected() || !this.capabilities || !this.capabilities.runtime) {
    return Promise.reject(new Error(
      'Runtime domain is not enabled; call connect() before waitForConsoleToken()'))
  }

  var start = Date.now()

  return new Promise(function(resolve, reject) {
    var timer = null
    var onConsole, onLogEntry, onClose

    function cleanup() {
      clearTimeout(timer)
      client.removeListener('Runtime.consoleAPICalled', onConsole)
      client.removeListener('Log.entryAdded', onLogEntry)
      client.removeListener('close', onClose)
    }

    function finish(matchedText) {
      cleanup()
      resolve({
        token: token
      , matchedText: matchedText
      , elapsedMs: Date.now() - start
      })
    }

    onConsole = function(params) {
      var matched = consoleArgsMatch(params && params.args, token)
      if (matched !== null) {
        finish(matched)
      }
    }

    onLogEntry = function(params) {
      var text = params && params.entry && params.entry.text
      if (typeof text === 'string' && text.indexOf(token) !== -1) {
        finish(text)
      }
    }

    // Fail fast when the browser/tab dies instead of blocking on the
    // full gate timeout for a token that can never arrive.
    onClose = function() {
      cleanup()
      reject(new Error(
        'CDP socket closed while waiting for console token ' + JSON.stringify(token)))
    }

    client.on('Runtime.consoleAPICalled', onConsole)
    if (useLog) {
      client.on('Log.entryAdded', onLogEntry)
    }
    client.on('close', onClose)

    timer = setTimeout(function() {
      cleanup()
      reject(new Error(
        'Timed out after ' + timeout + 'ms waiting for console token ' + JSON.stringify(token)))
    }, timeout)
  })
}

ChromeController.prototype.waitForExpression = function(expression, options) {
  var that = this

  return this._pollUntil(function() {
    return that.evaluate('!!(' + expression + ')', {awaitPromise: false})
      .catch(function() {
        // The page may be mid-navigation; keep polling until the timeout.
        return false
      })
  }, options, 'expression ' + expression)
    .then(function(outcome) {
      return {expression: expression, elapsedMs: outcome.elapsedMs}
    })
}

ChromeController.prototype.waitForSelector = function(selector, options) {
  var that = this
  var expression = '!!document.querySelector(' + JSON.stringify(selector) + ')'

  return this._pollUntil(function() {
    return that.evaluate(expression, {awaitPromise: false})
      .catch(function() {
        return false
      })
  }, options, 'selector ' + selector)
    .then(function(outcome) {
      return {selector: selector, elapsedMs: outcome.elapsedMs}
    })
}

ChromeController.prototype.waitForWebXr = function(options) {
  var that = this
  var opts = options || {}
  var requireImmersive = opts.requireImmersive !== false
  var description = requireImmersive ? 'WebXR immersive-vr support' : 'WebXR availability'

  return this._pollUntil(function() {
    return that.checkWebXr()
      .then(function(status) {
        if (!status || status.webxrAvailable !== true) {
          return null
        }
        if (requireImmersive && status.immersiveVrSupported !== true) {
          return null
        }
        return status
      })
      .catch(function() {
        return null
      })
  }, opts, description)
    .then(function(outcome) {
      var status = outcome.result
      status.elapsedMs = outcome.elapsedMs
      return status
    })
}

ChromeController.prototype.installRafCounter = function(options) {
  var opts = options || {}
  return this.evaluate(INSTALL_RAF_JS, {awaitPromise: false, timeout: opts.timeout})
}

ChromeController.prototype.readRafCount = function(options) {
  var opts = options || {}
  return this.evaluate(READ_RAF_JS, {awaitPromise: false, timeout: opts.timeout})
}

ChromeController.prototype.waitForNewFrames = function(minFrames, options) {
  var that = this
  var wanted = firstNumber(minFrames, null, 1)

  if (wanted < 1) {
    wanted = 1
  }

  return this.readRafCount()
    .then(function(count) {
      if (typeof count === 'number') {
        return count
      }
      return that.installRafCounter()
    })
    .then(function(startFrames) {
      return that._pollUntil(function() {
        return that.readRafCount()
          .then(function(current) {
            if (typeof current === 'number' && current - startFrames >= wanted) {
              return current
            }
            return null
          })
          .catch(function() {
            return null
          })
      }, options, wanted + ' new requestAnimationFrame frame(s)')
        .then(function(outcome) {
          return {
            startFrames: startFrames
          , endFrames: outcome.result
          , deltaFrames: outcome.result - startFrames
          , elapsedMs: outcome.elapsedMs
          }
        })
    })
}

ChromeController.prototype.waitFor = function(gate, options) {
  var spec = gate || {}
  var opts = mergeOptions(options, spec)

  switch (spec.type) {
  case 'console-token':
    return this.waitForConsoleToken(spec.token, opts)
  case 'expression':
    return this.waitForExpression(spec.expression, opts)
  case 'selector':
    return this.waitForSelector(spec.selector, opts)
  case 'webxr':
    return this.waitForWebXr(opts)
  case 'raf-delta':
    return this.waitForNewFrames(spec.minFrames, opts)
  default:
    return Promise.reject(new Error(
      'Unknown readiness gate type ' + JSON.stringify(spec.type) +
      '; expected console-token, expression, selector, webxr or raf-delta'))
  }
}

ChromeController.prototype.installBenchHooks = function(options) {
  var that = this
  var opts = options || {}

  return this._installPersistentHooks()
    .then(function(persistent) {
      // Always also evaluate directly so the currently loaded page gets
      // the hooks even when the persistent injection is unavailable.
      return that.evaluate(BENCH_HOOKS_JS, {awaitPromise: false, timeout: opts.timeout})
        .then(function() {
          return {persistent: persistent}
        })
    })
}

ChromeController.prototype._installPersistentHooks = function() {
  return this.send('Page.addScriptToEvaluateOnNewDocument', {source: BENCH_HOOKS_JS})
    .then(function() {
      return true
    })
    .catch(function(err) {
      if (err.unsupportedCdpMethod) {
        return false
      }
      throw err
    })
}

ChromeController.prototype.readBenchState = function(options) {
  var opts = options || {}
  return this.evaluate('window.__stfXr || null', {awaitPromise: false, timeout: opts.timeout})
}

module.exports = ChromeController
