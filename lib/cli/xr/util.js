//
// Shared helpers for the `stf xr` command family. This is NOT a yargs
// command module; do not register it in lib/cli/xr/index.js.
//

// Adds the options every device-bound xr subcommand shares.
module.exports.commonOptions = function(yargs) {
  return yargs
    .option('serial', {
      alias: 's'
    , describe: 'The serial number of the target device.'
    , type: 'string'
    , demandOption: true
    })
    .option('adb', {
      describe: 'Path to the ADB binary (defaults to $ADB or `adb`).'
    , type: 'string'
    })
    .option('timeout', {
      describe: 'Timeout in milliseconds for device operations.'
    , type: 'number'
    , default: 30000
    })
    .option('json', {
      describe: 'Print machine-readable JSON on stdout.'
    , type: 'boolean'
    , default: false
    })
}

// Adds the vendor provider selector; `auto` classifies the device first.
module.exports.providerOption = function(yargs) {
  return yargs
    .option('provider', {
      describe: 'The vendor provider to use; `auto` classifies the device.'
    , type: 'string'
    , choices: ['auto', 'oculus', 'pico', 'generic']
    , default: 'auto'
    })
}

// Creates a bare AdbSession for subcommands that need no provider logic.
module.exports.session = function(argv) {
  var AdbSession = require('../../xr/adb/session')
  return new AdbSession(argv.serial, {
    adb: argv.adb
  , timeout: argv.timeout
  })
}

// Resolves a provider instance from argv; forDevice() when --provider auto.
module.exports.getProvider = function(argv) {
  var Promise = require('bluebird')
  var providers = require('../../xr/providers')
  var options = {
    adb: argv.adb
  , timeout: argv.timeout
  , browserPackage: argv.browser
  , port: argv.port
  }

  if (!argv.provider || argv.provider === 'auto') {
    return providers.forDevice(argv.serial, options)
  }

  return Promise.try(function() {
    return providers.forName(argv.provider, argv.serial, options)
  })
}

// Standard handler wrapper: runs promiseFactory(), prints the result as
// JSON (--json) or through options.print / a log.info fallback, and exits
// non-zero via options.exitCode(result) or on any error.
module.exports.run = function(argv, promiseFactory, options) {
  var Promise = require('bluebird')
  var opts = options || {}
  var log = opts.log || require('../../util/logger').createLogger('cli:xr')

  return Promise.try(promiseFactory)
    .then(function(result) {
      if (argv.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n')
      }
      else if (opts.print) {
        opts.print(result)
      }
      else {
        log.info('%s', JSON.stringify(result))
      }

      var code = opts.exitCode ? opts.exitCode(result) : 0
      if (code) {
        process.exit(code)
      }
      return result
    })
    .catch(function(err) {
      if (argv.json) {
        process.stdout.write(JSON.stringify({error: err.message}, null, 2) + '\n')
      }
      else {
        log.fatal('%s', err.message)
      }
      process.exit(1)
    })
}
