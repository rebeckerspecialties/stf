module.exports.command = 'ttmfr'

module.exports.describe = 'Measure time to meaningful first render for a URL or app.'

module.exports.builder = function(yargs) {
  var xrUtil = require('./util')

  return xrUtil.providerOption(xrUtil.commonOptions(yargs))
    .strict()
    .default('timeout', 60000)
    .option('url', {
      describe: 'The URL to measure (WebXR targets).'
    , type: 'string'
    })
    .option('package', {
      describe: 'The app package to measure (native targets).'
    , type: 'string'
    })
    .option('activity', {
      describe: 'The activity to launch with --package.'
    , type: 'string'
    })
    .option('method', {
      describe: 'Measurement method.'
    , type: 'string'
    , choices: ['logcat-marker', 'webxr-marker', 'image-diff', 'openxr-layer']
    , demandOption: true
    })
    .option('marker', {
      describe: 'Logcat or console token that marks the meaningful frame.'
    , type: 'string'
    , default: 'STF_XR_READY'
    })
    .option('threshold', {
      describe: 'Changed-byte fraction that counts as a new frame (image-diff).'
    , type: 'number'
    , default: 0.02
    })
    .option('interval', {
      describe: 'Poll interval in milliseconds (image-diff).'
    , type: 'number'
    })
    .option('artifacts-dir', {
      describe: 'Directory for temporary frame dumps (image-diff).'
    , type: 'string'
    })
    .option('browser', {
      describe: 'Force a browser package instead of detecting one.'
    , type: 'string'
    })
    .option('port', {
      describe: 'Host port for the DevTools forward (default: adb-assigned).'
    , type: 'number'
    })
}

module.exports.handler = function(argv) {
  var log = require('../../util/logger').createLogger('cli:xr:ttmfr')
  var xrUtil = require('./util')

  function printResult(result) {
    if (result.ok) {
      log.info(
        'TTMFR %dms (method %s, confidence %s)'
      , result.timings.ttmfrMs
      , result.method
      , result.confidence
      )
    }
    else if (result.method === 'openxr-layer') {
      log.warn('%s', result.error)
    }
    else {
      log.error(
        'TTMFR measurement failed (method %s): %s'
      , result.method
      , result.error || 'unknown error'
      )
    }
  }

  return xrUtil.run(argv, function() {
    return xrUtil.getProvider(argv).then(function(provider) {
      var ttmfr = require('../../xr/bench/ttmfr')
      return ttmfr.measure(provider, {
        method: argv.method
      , url: argv.url
      , package: argv.package
      , activity: argv.activity
      , marker: argv.marker
      , threshold: argv.threshold
      , interval: argv.interval
      , timeout: argv.timeout
      , artifactsDir: argv.artifactsDir
      })
    })
  }, {
    log: log
  , print: printResult
  , exitCode: function(result) {
      return result.ok === false && result.method !== 'openxr-layer' ? 1 : 0
    }
  })
}
