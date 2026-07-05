module.exports.command = 'text'

module.exports.describe = 'Type text via ADB input.'

module.exports.builder = function(yargs) {
  var xrUtil = require('./util')

  return xrUtil.commonOptions(yargs)
    .env('STF_XR')
    .strict()
    .option('text', {
      describe: 'The text to type.'
    , type: 'string'
    , demandOption: true
    })
}

module.exports.handler = function(argv) {
  var log = require('../../util/logger').createLogger('cli:xr:text')
  var xrUtil = require('./util')

  return xrUtil.run(argv, function() {
    return xrUtil.session(argv).text(argv.text).then(function() {
      return {
        serial: argv.serial
      , action: 'text'
      , text: argv.text
      }
    })
  }, {
    log: log
  , print: function(result) {
      log.info('Typed %d characters on %s', result.text.length, result.serial)
    }
  })
}
