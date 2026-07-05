'use strict'

var OculusProvider = require('./oculus')
var PicoProvider = require('./pico')
var GenericAdbProvider = require('./generic-adb')

var providers = {
  oculus: OculusProvider
, pico: PicoProvider
, generic: GenericAdbProvider
}

var providerNames = ['oculus', 'pico', 'generic']

function forName(name, serial, options) {
  if (!Object.prototype.hasOwnProperty.call(providers, name)) {
    throw new Error(
      'Unknown provider ' + JSON.stringify(name) +
      '; valid providers are: ' + providerNames.join(', '))
  }

  var Provider = providers[name]
  return new Provider(serial, options)
}

// Classifies the device and picks the matching provider. Vendors without a
// dedicated provider (samsung, htc) stay on GenericAdbProvider, which then
// resolves their real vendor profile via effectiveVendorId(). The probe's
// session and cached props/classification are handed to the chosen instance
// so no second getprop round trip happens.
function forDevice(serial, options) {
  var opts = options || {}
  var generic = new GenericAdbProvider(serial, opts)

  return generic.classify().then(function(classification) {
    var Provider = providers[classification.vendorId]
    if (!Provider || Provider === GenericAdbProvider) {
      return generic
    }

    var instanceOptions = {}
    Object.keys(opts).forEach(function(key) {
      instanceOptions[key] = opts[key]
    })
    instanceOptions.session = generic.session

    var instance = new Provider(serial, instanceOptions)
    instance._props = generic._props
    instance._classification = generic._classification
    return instance
  })
}

module.exports.providers = providers
module.exports.providerNames = providerNames
module.exports.forName = forName
module.exports.forDevice = forDevice
