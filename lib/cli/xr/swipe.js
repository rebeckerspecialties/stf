module.exports.command = 'swipe'

module.exports.describe = 'Swipe on the screen via ADB input.'

module.exports.builder = function(yargs) {
  var xrUtil = require('./util')

  return xrUtil.commonOptions(yargs)
    .strict()
    .option('x1', {
      describe: 'Start X coordinate in screen pixels.'
    , type: 'number'
    , demandOption: true
    })
    .option('y1', {
      describe: 'Start Y coordinate in screen pixels.'
    , type: 'number'
    , demandOption: true
    })
    .option('x2', {
      describe: 'End X coordinate in screen pixels.'
    , type: 'number'
    , demandOption: true
    })
    .option('y2', {
      describe: 'End Y coordinate in screen pixels.'
    , type: 'number'
    , demandOption: true
    })
    .option('duration', {
      describe: 'Swipe duration in milliseconds.'
    , type: 'number'
    , default: 300
    })
}

module.exports.handler = function(argv) {
  var log = require('../../util/logger').createLogger('cli:xr:swipe')
  var xrUtil = require('./util')

  return xrUtil.run(argv, function() {
    return xrUtil.session(argv)
      .swipe(argv.x1, argv.y1, argv.x2, argv.y2, argv.duration)
      .then(function() {
        return {
          serial: argv.serial
        , action: 'swipe'
        , from: {x: argv.x1, y: argv.y1}
        , to: {x: argv.x2, y: argv.y2}
        , duration: argv.duration
        }
      })
  }, {
    log: log
  , print: function(result) {
      log.info(
        'Swiped %d,%d -> %d,%d over %dms on %s'
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
