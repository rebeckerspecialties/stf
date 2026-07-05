module.exports.command = 'open-url'

module.exports.describe = 'Open a URL in the device browser via a VIEW intent.'

module.exports.builder = function(yargs) {
  var xrUtil = require('./util')

  return xrUtil.providerOption(xrUtil.commonOptions(yargs))
    .strict()
    .option('url', {
      describe: 'The URL to open.'
    , type: 'string'
    , demandOption: true
    })
    .option('browser', {
      describe: 'Force a browser package instead of detecting one.'
    , type: 'string'
    })
}

module.exports.handler = function(argv) {
  var log = require('../../util/logger').createLogger('cli:xr:open-url')
  var xrUtil = require('./util')

  return xrUtil.run(argv, function() {
    return xrUtil.getProvider(argv).then(function(provider) {
      return provider.openUrl(argv.url)
    })
  }, {
    log: log
  , print: function(result) {
      log.info('Opened %s via %s', result.url, result.browserPackage || 'the system default')
      if (result.cdp === false) {
        log.warn('The browser is Gecko-based; CDP automation is not available')
      }
    }
  })
}
