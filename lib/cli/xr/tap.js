module.exports.command = 'tap'

module.exports.describe = 'Tap the screen via ADB input.'

module.exports.builder = function(yargs) {
  var xrUtil = require('./util')

  return xrUtil.commonOptions(yargs)
    .env('STF_XR')
    .strict()
    .option('x', {
      describe: 'X coordinate in screen pixels.'
    , type: 'number'
    , demandOption: true
    })
    .option('y', {
      describe: 'Y coordinate in screen pixels.'
    , type: 'number'
    , demandOption: true
    })
}

module.exports.handler = function(argv) {
  var log = require('../../util/logger').createLogger('cli:xr:tap')
  var xrUtil = require('./util')

  return xrUtil.run(argv, function() {
    return xrUtil.session(argv).tap(argv.x, argv.y).then(function() {
      return {
        serial: argv.serial
      , action: 'tap'
      , x: argv.x
      , y: argv.y
      }
    })
  }, {
    log: log
  , print: function(result) {
      log.info('Tapped %d,%d on %s', result.x, result.y, result.serial)
    }
  })
}
