module.exports.command = 'xr <command>'

module.exports.describe = 'XR headset commands (standalone Android VR/MR devices).'

module.exports.builder = function(yargs) {
  return yargs
    .strict()
    .command(require('./devices'))
    .command(require('./preflight'))
    .command(require('./open-url'))
    .command(require('./webxr-smoke'))
    .command(require('./tap'))
    .command(require('./swipe'))
    .command(require('./key'))
    .command(require('./text'))
    .command(require('./cdp-tap'))
    .command(require('./cdp-swipe'))
    .command(require('./screencap'))
    .command(require('./install-apk'))
    .command(require('./launch-apk'))
    .command(require('./ttmfr'))
    .demandCommand(1, 'Must provide a valid xr command.')
}

module.exports.handler = function() {}
