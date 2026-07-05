module.exports.command = 'preflight'

module.exports.describe = 'Run XR automation health checks against a device.'

module.exports.builder = function(yargs) {
  var xrUtil = require('./util')

  return xrUtil.providerOption(xrUtil.commonOptions(yargs))
    .strict()
    .option('url', {
      describe: 'URL used for the browser launch and WebXR checks.'
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
    .option('skip-browser-launch', {
      describe: 'Skip the browser launch check.'
    , type: 'boolean'
    , default: false
    })
}

module.exports.handler = function(argv) {
  var log = require('../../util/logger').createLogger('cli:xr:preflight')
  var xrUtil = require('./util')

  function tagFor(check) {
    if (check.ok === true) {
      return 'PASS'
    }
    if (check.ok === false) {
      return 'FAIL'
    }
    return 'SKIP'
  }

  function printChecks(result) {
    result.checks.forEach(function(check) {
      var line = '[' + tagFor(check) + '] ' + check.name +
        (check.detail ? ' - ' + check.detail : '') +
        (check.error ? ' (' + check.error + ')' : '')
      if (check.ok === false) {
        log.error('%s', line)
      }
      else {
        log.info('%s', line)
      }
    })
    log.info(
      'preflight %s in %dms'
    , result.ok ? 'passed' : 'FAILED'
    , result.durationMs
    )
  }

  return xrUtil.run(argv, function() {
    return xrUtil.getProvider(argv).then(function(provider) {
      return provider.preflight({
        url: argv.url
      , skipBrowserLaunch: argv.skipBrowserLaunch
      , timeout: argv.timeout
      })
    })
  }, {
    log: log
  , print: printChecks
  , exitCode: function(result) {
      return result.ok === false ? 1 : 0
    }
  })
}
