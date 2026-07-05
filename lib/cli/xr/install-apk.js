module.exports.command = 'install-apk'

module.exports.describe = 'Install an APK, optionally launching it afterwards.'

module.exports.builder = function(yargs) {
  var xrUtil = require('./util')

  return xrUtil.commonOptions(yargs)
    .env('STF_XR')
    .strict()
    .option('apk', {
      describe: 'Path to the APK file to install.'
    , type: 'string'
    , demandOption: true
    })
    .option('launch', {
      describe: 'Launch the app after installing; requires --package.'
    , type: 'boolean'
    , default: false
    })
    .option('package', {
      describe: 'The package name of the installed app.'
    , type: 'string'
    })
    .option('activity', {
      describe: 'The activity to launch (defaults to the LAUNCHER activity).'
    , type: 'string'
    })
    .option('grant', {
      describe: 'Grant all runtime permissions at install time (adb install -g).'
    , type: 'boolean'
    , default: false
    })
}

module.exports.handler = function(argv) {
  var Promise = require('bluebird')

  var log = require('../../util/logger').createLogger('cli:xr:install-apk')
  var xrUtil = require('./util')

  // Installs can take a while on slow USB links; keep the session's 120s
  // install default as a floor and let a larger --timeout raise it.
  var installTimeout = Math.max(argv.timeout || 0, 120000)

  return xrUtil.run(argv, function() {
    var session = xrUtil.session(argv)

    if (argv.launch && !argv.package) {
      return Promise.reject(new Error(
        '--launch requires --package so the installed app can be started'))
    }

    return session.install(argv.apk, {
      grantRuntimePermissions: argv.grant
    , timeout: installTimeout
    })
    .then(function() {
      if (!argv.launch) {
        return {
          serial: argv.serial
        , apk: argv.apk
        , installed: true
        , launched: false
        , package: argv.package || null
        }
      }
      return session.startPackage(argv.package, argv.activity || null).then(function() {
        return {
          serial: argv.serial
        , apk: argv.apk
        , installed: true
        , launched: true
        , package: argv.package
        }
      })
    })
  }, {
    log: log
  , print: function(result) {
      log.info('Installed %s on %s', result.apk, result.serial)
      if (result.launched) {
        log.info('Launched %s', result.package)
      }
    }
  })
}
