'use strict'

// Provider for PICO standalone headsets (PICO 4, PICO 4 Ultra). Identical to
// the base behavior except for a browser-detection hint: PICO firmware ships
// different browser packages per region/version, so a miss deserves help.

var util = require('util')

var BaseProvider = require('./base')

var BROWSER_HINT = 'PICO firmware ships different browser packages per ' +
  'region/version; check browserLikePackages and pass --browser'

function PicoProvider(serial, options) {
  BaseProvider.call(this, serial, options)
}

util.inherits(PicoProvider, BaseProvider)

PicoProvider.prototype.name = 'pico'

PicoProvider.prototype.vendorId = 'pico'

PicoProvider.prototype.detectBrowser = function() {
  return BaseProvider.prototype.detectBrowser.call(this).then(function(browser) {
    if (browser.chosen === null && browser.diagnostics) {
      browser.diagnostics.hint = BROWSER_HINT
    }
    return browser
  })
}

module.exports = PicoProvider
