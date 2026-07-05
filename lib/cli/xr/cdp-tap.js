module.exports.command = 'cdp-tap'

module.exports.describe = 'Tap inside the browser page via CDP touch events.'

module.exports.builder = function(yargs) {
  var xrUtil = require('./util')

  return xrUtil.providerOption(xrUtil.commonOptions(yargs))
    .env('STF_XR')
    .strict()
    .option('browser', {
      describe: 'Force a browser package instead of detecting one.'
    , type: 'string'
    })
    .option('port', {
      describe: 'Host port for the DevTools forward (default: adb-assigned).'
    , type: 'number'
    })
    .option('x', {
      describe: 'X coordinate in page CSS pixels.'
    , type: 'number'
    , demandOption: true
    })
    .option('y', {
      describe: 'Y coordinate in page CSS pixels.'
    , type: 'number'
    , demandOption: true
    })
}

module.exports.handler = function(argv) {
  var log = require('../../util/logger').createLogger('cli:xr:cdp-tap')
  var xrUtil = require('./util')

  return xrUtil.run(argv, function() {
    var controller = null

    return xrUtil.getProvider(argv)
      .then(function(provider) {
        return provider.chrome()
      })
      .then(function(resolved) {
        controller = resolved
        return controller.connect()
      })
      .then(function() {
        return controller.tap(argv.x, argv.y)
      })
      .then(function() {
        return controller.close().then(function() {
          return {
            serial: argv.serial
          , action: 'cdp-tap'
          , x: argv.x
          , y: argv.y
          }
        })
      })
      .catch(function(err) {
        if (err.unsupportedCdpMethod && err.message.indexOf('stf xr tap') === -1) {
          err.message += '; use `stf xr tap` (ADB input) instead'
        }
        if (controller) {
          return controller.close().then(function() {
            throw err
          })
        }
        throw err
      })
  }, {
    log: log
  , print: function(result) {
      log.info('Dispatched CDP tap at %d,%d on %s', result.x, result.y, result.serial)
    }
  })
}
