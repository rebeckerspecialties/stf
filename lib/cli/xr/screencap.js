module.exports.command = 'screencap'

module.exports.describe = 'Save a screenshot of the 2D mirror view (not per-eye stereo).'

module.exports.builder = function(yargs) {
  var xrUtil = require('./util')

  return xrUtil.commonOptions(yargs)
    .strict()
    .option('out', {
      describe: 'Destination file for the PNG screenshot.'
    , type: 'string'
    , default: './xr-screencap.png'
    })
}

module.exports.handler = function(argv) {
  var log = require('../../util/logger').createLogger('cli:xr:screencap')
  var xrUtil = require('./util')

  return xrUtil.run(argv, function() {
    return xrUtil.session(argv).screencap(argv.out).then(function(dest) {
      return {
        serial: argv.serial
      , path: dest
      , note: 'This is the flat 2D mirror view, not the per-eye stereo output ' +
          'the wearer sees.'
      }
    })
  }, {
    log: log
  , print: function(result) {
      log.info('Saved screenshot to %s', result.path)
      log.warn('%s', result.note)
    }
  })
}
