module.exports.command = 'cdp-swipe'

module.exports.describe = 'Swipe inside the browser page via CDP touch events.'

module.exports.builder = function(yargs) {
  var xrUtil = require('./util')

  return xrUtil.providerOption(xrUtil.commonOptions(yargs))
    .strict()
    .option('browser', {
      describe: 'Force a browser package instead of detecting one.'
    , type: 'string'
    })
    .option('port', {
      describe: 'Host port for the DevTools forward (default: adb-assigned).'
    , type: 'number'
    })
    .option('x1', {
      describe: 'Start X coordinate in page CSS pixels.'
    , type: 'number'
    , demandOption: true
    })
    .option('y1', {
      describe: 'Start Y coordinate in page CSS pixels.'
    , type: 'number'
    , demandOption: true
    })
    .option('x2', {
      describe: 'End X coordinate in page CSS pixels.'
    , type: 'number'
    , demandOption: true
    })
    .option('y2', {
      describe: 'End Y coordinate in page CSS pixels.'
    , type: 'number'
    , demandOption: true
    })
    .option('duration', {
      describe: 'Swipe duration in milliseconds.'
    , type: 'number'
    , default: 300
    })
    .option('steps', {
      describe: 'Number of interpolated touch-move steps.'
    , type: 'number'
    , default: 8
    })
}

module.exports.handler = function(argv) {
  var log = require('../../util/logger').createLogger('cli:xr:cdp-swipe')
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
        return controller.swipe(argv.x1, argv.y1, argv.x2, argv.y2, {
          duration: argv.duration
        , steps: argv.steps
        })
      })
      .then(function(outcome) {
        return controller.close().then(function() {
          return {
            serial: argv.serial
          , action: 'cdp-swipe'
          , from: outcome.from
          , to: outcome.to
          , duration: outcome.duration
          , steps: outcome.steps
          }
        })
      })
      .catch(function(err) {
        if (err.unsupportedCdpMethod && err.message.indexOf('stf xr swipe') === -1) {
          err.message += '; use `stf xr swipe` (ADB input) instead'
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
      log.info(
        'Dispatched CDP swipe %d,%d -> %d,%d over %dms on %s'
      , result.from.x
      , result.from.y
      , result.to.x
      , result.to.y
      , result.duration
      , result.serial
      )
    }
  })
}
