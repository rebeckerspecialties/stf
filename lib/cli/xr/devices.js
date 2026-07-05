module.exports.command = 'devices'

module.exports.describe = 'List connected devices with their XR classification.'

module.exports.builder = function(yargs) {
  return yargs
    .env('STF_XR')
    .strict()
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
    .option('xr-only', {
      describe: 'Only list devices classified as XR headsets.'
    , type: 'boolean'
    , default: false
    })
    .option('browser', {
      describe: 'Probe installed browser packages on each device.'
    , type: 'boolean'
    , default: true
    })
}

module.exports.handler = function(argv) {
  var Promise = require('bluebird')

  var log = require('../../util/logger').createLogger('cli:xr:devices')
  var xrUtil = require('./util')

  function enrich(entry) {
    if (!argv.browser || entry.state !== 'device' || entry.error) {
      return Promise.resolve(entry)
    }

    var providers = require('../../xr/providers')
    return providers.forDevice(entry.serial, {adb: argv.adb, timeout: argv.timeout})
      .then(function(provider) {
        return provider.describe()
      })
      .then(function(description) {
        entry.provider = description.provider
        entry.browser = description.browser
        entry.capabilities = description.capabilities
        return entry
      })
      .catch(function(err) {
        entry.browser = null
        entry.browserError = err.message
        return entry
      })
  }

  function browserSummary(entry) {
    if (!entry.browser) {
      return entry.browserError ? 'browser: error (' + entry.browserError + ')' : ''
    }
    if (!entry.browser.chosen) {
      return 'browser: none detected'
    }
    return 'browser: ' + entry.browser.chosen +
      (entry.browser.version ? ' ' + entry.browser.version : '')
  }

  function formatLine(entry) {
    if (entry.error) {
      return entry.serial + ' ' + entry.state + ' error: ' + entry.error
    }
    return [
      entry.serial
    , entry.state
    , entry.classification.displayName
    , 'android=' + (entry.props.androidVersion || '?')
    , browserSummary(entry)
    , 'confidence=' + entry.classification.confidence
    ].filter(Boolean).join(' ')
  }

  return xrUtil.run(argv, function() {
    var devices = require('../../xr/adb/devices')
    return devices.detect({
      adb: argv.adb
    , timeout: argv.timeout
    , xrOnly: argv.xrOnly
    })
    .then(function(entries) {
      return Promise.all(entries.map(enrich))
    })
  }, {
    log: log
  , print: function(entries) {
      if (entries.length === 0) {
        log.info('No devices found')
        return
      }
      entries.forEach(function(entry) {
        log.info('%s', formatLine(entry))
      })
    }
  })
}
