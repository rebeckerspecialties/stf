module.exports.command = 'webxr-smoke'

module.exports.describe = 'Launch a WebXR page and verify it can start an immersive session.'

module.exports.builder = function(yargs) {
  var xrUtil = require('./util')

  return xrUtil.providerOption(xrUtil.commonOptions(yargs))
    .env('STF_XR')
    .strict()
    .default('timeout', 60000)
    .option('url', {
      describe: 'The WebXR page to test.'
    , type: 'string'
    , demandOption: true
    })
    .option('browser', {
      describe: 'Force a browser package instead of detecting one.'
    , type: 'string'
    })
    .option('port', {
      describe: 'Host port for the DevTools forward (default: adb-assigned).'
    , type: 'number'
    })
    .option('console-token', {
      describe: 'Wait for this console.log token before checking WebXR.'
    , type: 'string'
    })
    .option('ready-expression', {
      describe: 'Wait until this page expression evaluates truthy.'
    , type: 'string'
    })
    .option('ready-selector', {
      describe: 'Wait until this CSS selector matches an element.'
    , type: 'string'
    })
    .option('enter-vr-selector', {
      describe: 'CSS selector of the enter-VR button to click.'
    , type: 'string'
    })
    .option('enter-vr-x', {
      describe: 'X coordinate to tap to enter VR.'
    , type: 'number'
    })
    .option('enter-vr-y', {
      describe: 'Y coordinate to tap to enter VR.'
    , type: 'number'
    })
    .option('input', {
      describe: 'Input backend for the enter-VR tap.'
    , type: 'string'
    , choices: ['cdp', 'adb']
    , default: 'cdp'
    })
    .option('wait-frames', {
      describe: 'Wait for this many new requestAnimationFrame frames.'
    , type: 'number'
    , default: 0
    })
    .option('bench-hooks', {
      describe: 'Install the __stfXr bench hooks into the page.'
    , type: 'boolean'
    , default: true
    })
    .option('require-immersive', {
      describe: 'Keep polling until immersive-vr support is confirmed.'
    , type: 'boolean'
    , default: false
    })
    .option('strict', {
      describe: 'Also exit non-zero when the result is `unknown`.'
    , type: 'boolean'
    , default: false
    })
}

module.exports.handler = function(argv) {
  var log = require('../../util/logger').createLogger('cli:xr:webxr-smoke')
  var xrUtil = require('./util')

  function enterVrSpec() {
    if (argv.enterVrSelector) {
      return {selector: argv.enterVrSelector, input: argv.input}
    }
    if (typeof argv.enterVrX === 'number' || typeof argv.enterVrY === 'number') {
      return {x: argv.enterVrX, y: argv.enterVrY, input: argv.input}
    }
    return null
  }

  function printGate(name, gate) {
    if (!gate) {
      return
    }
    if (gate.met) {
      log.info('Readiness gate %s met after %dms', name, gate.elapsedMs || 0)
    }
    else {
      log.warn('Readiness gate %s NOT met: %s', name, gate.error)
    }
  }

  function printVerdict(result) {
    if (result.pass === true) {
      log.info('PASS: WebXR immersive-vr is supported (%dms)', result.durationMs)
    }
    else if (result.pass === false) {
      log.error('FAIL: WebXR is unavailable or a readiness gate failed')
    }
    else {
      log.warn(
        'UNKNOWN: could not confirm WebXR support%s'
      , argv.strict ? ' (failing because of --strict)' : ''
      )
    }
  }

  function printResult(result) {
    log.info(
      'Browser: %s %s (%s)'
    , result.browser.package || 'unknown'
    , result.browser.version || ''
    , result.browser.engine || 'unknown engine'
    )
    log.info(
      'CDP: available=%s connected=%s chromeMajor=%s'
    , result.cdp.available
    , result.cdp.connected
    , result.cdp.chromeMajor === null ? 'unknown' : result.cdp.chromeMajor
    )
    log.info(
      'WebXR: available=%s immersiveVrSupported=%s%s'
    , result.webxr.available
    , result.webxr.immersiveVrSupported
    , result.webxr.reason ? ' (' + result.webxr.reason + ')' : ''
    )
    printGate('console-token', result.readiness.consoleToken)
    printGate('expression', result.readiness.expression)
    printGate('selector', result.readiness.selector)
    if (result.enterVr) {
      log.info(
        'Enter VR: dispatched=%s via=%s (%s)'
      , result.enterVr.dispatched
      , result.enterVr.via
      , result.enterVr.detail
      )
    }
    if (result.frames) {
      log.info('Frames: %s new frames observed', result.frames.deltaFrames)
    }
    printVerdict(result)
  }

  return xrUtil.run(argv, function() {
    return xrUtil.getProvider(argv).then(function(provider) {
      return provider.webxrSmoke({
        url: argv.url
      , readiness: {
          consoleToken: argv.consoleToken
        , expression: argv.readyExpression
        , selector: argv.readySelector
        }
      , enterVr: enterVrSpec()
      , benchHooks: argv.benchHooks
      , waitFrames: argv.waitFrames
      , requireImmersive: argv.requireImmersive
      , timeout: argv.timeout
      })
    })
  }, {
    log: log
  , print: printResult
  , exitCode: function(result) {
      if (result.pass === false) {
        return 1
      }
      if (result.pass !== true && argv.strict) {
        return 1
      }
      return 0
    }
  })
}
