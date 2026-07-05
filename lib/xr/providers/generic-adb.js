'use strict'

// Fallback provider for any Android XR device without a dedicated subclass.
// This includes the Samsung Galaxy XR and the HTC Vive XR Elite: after
// classify() runs, BaseProvider.effectiveVendorId() upgrades browser
// detection and capabilities to the classified vendor's profile (samsung
// candidates and full CDP for Galaxy XR; Wolvic/ADB-only for Vive XR Elite)
// even though the provider itself stays 'generic'.

var util = require('util')

var BaseProvider = require('./base')

function GenericAdbProvider(serial, options) {
  BaseProvider.call(this, serial, options)
}

util.inherits(GenericAdbProvider, BaseProvider)

GenericAdbProvider.prototype.name = 'generic'

GenericAdbProvider.prototype.vendorId = 'generic'

module.exports = GenericAdbProvider
