module.exports.command = 'key'

module.exports.describe = 'Send a key event via ADB input.'

module.exports.builder = function(yargs) {
  var xrUtil = require('./util')

  return xrUtil.commonOptions(yargs)
    .strict()
    .option('keycode', {
      describe: 'Key code number or name (e.g. 224 or KEYCODE_WAKEUP).'
    , type: 'string'
    , demandOption: true
    })
}

module.exports.handler = function(argv) {
  var log = require('../../util/logger').createLogger('cli:xr:key')
  var xrUtil = require('./util')

  return xrUtil.run(argv, function() {
    return xrUtil.session(argv).keyevent(argv.keycode).then(function() {
      return {
        serial: argv.serial
      , action: 'key'
      , keycode: argv.keycode
      }
    })
  }, {
    log: log
  , print: function(result) {
      log.info('Sent key event %s to %s', result.keycode, result.serial)
    }
  })
}
