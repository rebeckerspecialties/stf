module.exports.command = 'launch-apk'

module.exports.describe = 'Launch an installed app by package name.'

module.exports.builder = function(yargs) {
  var xrUtil = require('./util')

  return xrUtil.commonOptions(yargs)
    .env('STF_XR')
    .strict()
    .option('package', {
      describe: 'The package name of the app to launch.'
    , type: 'string'
    , demandOption: true
    })
    .option('activity', {
      describe: 'The activity to launch (defaults to the LAUNCHER activity).'
    , type: 'string'
    })
    .option('action', {
      describe: 'Intent action for `am start` (e.g. android.intent.action.VIEW).'
    , type: 'string'
    })
    .option('data', {
      describe: 'Intent data URI for `am start`.'
    , type: 'string'
    })
}

module.exports.handler = function(argv) {
  var log = require('../../util/logger').createLogger('cli:xr:launch-apk')
  var xrUtil = require('./util')

  return xrUtil.run(argv, function() {
    return xrUtil.session(argv)
      .startPackage(argv.package, argv.activity || null, {
        action: argv.action
      , data: argv.data
      })
      .then(function() {
        return {
          serial: argv.serial
        , package: argv.package
        , activity: argv.activity || null
        , action: argv.action || null
        , data: argv.data || null
        }
      })
  }, {
    log: log
  , print: function(result) {
      log.info(
        'Launched %s%s on %s'
      , result.package
      , result.activity ? '/' + result.activity : ''
      , result.serial
      )
    }
  })
}
