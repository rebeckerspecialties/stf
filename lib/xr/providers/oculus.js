'use strict'

// Provider for Meta/Oculus standalone headsets (Go, Quest 1/2/3). Adds the
// proximity-sensor workaround broadcasts and forces `openxr: false` for the
// Oculus Go, which never shipped an OpenXR runtime.

var util = require('util')

var profiles = require('../device-profiles')
var BaseProvider = require('./base')

function OculusProvider(serial, options) {
  BaseProvider.call(this, serial, options)
}

util.inherits(OculusProvider, BaseProvider)

OculusProvider.prototype.name = 'oculus'

OculusProvider.prototype.vendorId = 'oculus'

// Static mirror of the vendor profile quirks, handy for CLI output.
OculusProvider.quirks = profiles.vendors.oculus.quirks

OculusProvider.prototype._proximityBroadcast = function(action) {
  return this.session.shell(['am', 'broadcast', '-a', action])
    .then(function(result) {
      return {ok: true, stdout: result.stdout}
    })
    .catch(function(err) {
      return {ok: false, error: err.message}
    })
}

// Some firmwares put the headset to sleep as soon as the proximity sensor
// stops seeing a wearer; this best-effort broadcast keeps a headset that is
// sitting on a desk awake during automation.
OculusProvider.prototype.disableProximitySensor = function() {
  return this._proximityBroadcast('com.oculus.vrpowermanager.prox_close')
}

OculusProvider.prototype.enableProximitySensor = function() {
  return this._proximityBroadcast('com.oculus.vrpowermanager.prox_enable')
}

OculusProvider.prototype.capabilities = function(classification, browser) {
  var caps = BaseProvider.prototype.capabilities.call(this, classification, browser)

  // The Oculus Go has no OpenXR runtime regardless of what a profile or
  // future base heuristic might claim.
  if (classification && classification.modelId === 'oculus-go') {
    caps.openxr = false
  }
  return caps
}

module.exports = OculusProvider
