'use strict'

// Static knowledge about standalone Android XR headsets: vendor profiles,
// model fingerprints and browser/devtools hints. Everything in this module
// is plain data plus pure helpers; nothing here talks to a device.

var DEFAULT_DEVTOOLS_SOCKET = 'localabstract:chrome_devtools_remote'

var genericModel = {
  id: 'generic-android-xr'
, names: ['Generic Android XR']
, match: []
, chromiumHint: null
, tracking: 'unknown'
, webxr: null
, openxr: null
}

var vendors = {
  oculus: {
    id: 'oculus'
  , displayName: 'Meta/Oculus standalone headsets'
  , manufacturerMatch: [/oculus/i, /meta/i]
  , browserCandidates: ['com.oculus.browser']
  , devtoolsSocket: DEFAULT_DEVTOOLS_SOCKET
  , quirks: {
      proximitySleep: 'Sleeps when the proximity sensor sees no wearer'
    , proximityWorkaround: 'Broadcast com.oculus.vrpowermanager.prox_close to keep it awake'
    , screencap: 'The 2D mirror screencap is a flat single-eye view, not stereo output'
    , oculusGo: 'Oculus Go has no OpenXR runtime'
    }
  , models: [
      {
        id: 'oculus-go'
      , names: ['Oculus Go', 'Pacific']
      , match: [/oculus\s*go/i, /pacific/i]
      , chromiumHint: 98
      , tracking: '3dof'
      , webxr: true
      , openxr: false
      , notes: 'Legacy 3DoF headset; no OpenXR runtime, WebXR via the legacy browser only'
      }
    , {
        id: 'quest-1'
      , names: ['Quest', 'Oculus Quest']
      , match: [/oculus\s*quest$/i, /^quest$/i, /monterey/i]
      , chromiumHint: 112
      , tracking: '6dof'
      , webxr: true
      , openxr: true
      }
    , {
        id: 'quest-2'
      , names: ['Quest 2', 'Meta Quest 2', 'Oculus Quest 2']
      , match: [/quest\s*2/i, /hollywood/i]
      , chromiumHint: 144
      , tracking: '6dof'
      , webxr: true
      , openxr: true
      }
    , {
        id: 'quest-3'
      , names: ['Quest 3', 'Meta Quest 3']
      , match: [/quest\s*3/i, /eureka/i]
      , chromiumHint: 144
      , tracking: '6dof'
      , webxr: true
      , openxr: true
      , passthrough: true
      }
    ]
  }
, pico: {
    id: 'pico'
  , displayName: 'PICO standalone headsets'
  , manufacturerMatch: [/pico/i, /bytedance/i]
  , browserCandidates: [
      'com.picovr.browser'
    , 'com.pvr.browser'
    , 'com.bytedance.picobrowser'
    , 'com.android.browser'
    , 'com.google.android.apps.chrome'
    ]
  , devtoolsSocket: DEFAULT_DEVTOOLS_SOCKET
  , quirks: {
      browserPackage: 'Browser package varies by firmware region and version'
    , browserDetection: 'Detect the installed browser dynamically; never hard-fail on a miss'
    }
  , models: [
      // The more specific Ultra fingerprint must come before the plain
      // PICO 4 fingerprint, which would otherwise match "PICO 4 Ultra" too.
      {
        id: 'pico-4-ultra'
      , names: ['PICO 4 Ultra', 'Pico 4 Ultra']
      , match: [/pico\s*4\s*ultra/i, /pico4\s*ultra/i]
      , chromiumHint: null
      , tracking: '6dof'
      , webxr: true
      , openxr: true
      , passthrough: true
      }
    , {
        id: 'pico-4'
      , names: ['PICO 4', 'Pico 4']
      , match: [/pico\s*4/i, /pico4/i]
      , chromiumHint: 105
      , tracking: '6dof'
      , webxr: true
      , openxr: true
      }
    ]
  }
, samsung: {
    id: 'samsung'
  , displayName: 'Samsung Android XR headsets'
  , manufacturerMatch: [/samsung/i]

    // Samsung mostly ships phones; a manufacturer hit alone must not mark
    // a device as an XR headset (see isLikelyXr).
  , manufacturerOnlyIsWeak: true
  , browserCandidates: [
      'com.android.chrome'
    , 'com.sec.android.app.sbrowser'
    , 'com.chrome.beta'
    , 'com.google.android.apps.chrome'
    ]
  , devtoolsSocket: DEFAULT_DEVTOOLS_SOCKET
  , quirks: {
      platform: 'Android XR platform; Chrome is the system browser'
    }
  , models: [
      {
        id: 'galaxy-xr'
      , names: ['Galaxy XR', 'Project Moohan']
      , match: [/galaxy[\s_-]*xr/i, /moohan/i]
      , chromiumHint: 144
      , tracking: '6dof'
      , webxr: true
      , openxr: true
      , passthrough: true
      }
    ]
  }
, htc: {
    id: 'htc'
  , displayName: 'HTC Vive standalone headsets'
  , manufacturerMatch: [/htc/i]

    // HTC also ships phones; require corroboration beyond the
    // manufacturer string (see isLikelyXr).
  , manufacturerOnlyIsWeak: true
  , browserCandidates: ['com.igalia.wolvic', 'org.mozilla.vrbrowser']

    // Wolvic is Gecko-based and exposes no Chrome DevTools socket.
  , devtoolsSocket: null
  , quirks: {
      browserEngine: 'Wolvic is Gecko-based, so there is no CDP; automation is ADB-only'
    }
  , models: [
      {
        id: 'vive-xr-elite'
      , names: ['Vive XR Elite', 'HTC Vive XR Elite']
      , match: [/vive[\s_-]*xr/i, /xr[\s_-]*elite/i]
      , chromiumHint: null
      , geckoHint: 120
      , tracking: '6dof'
      , webxr: true
      , openxr: true
      }
    ]
  }
, generic: {
    id: 'generic'
  , displayName: 'Generic Android XR device'
  , manufacturerMatch: []
  , browserCandidates: [
      'com.android.chrome'
    , 'com.google.android.apps.chrome'
    , 'com.android.browser'
    , 'com.igalia.wolvic'
    ]
  , devtoolsSocket: DEFAULT_DEVTOOLS_SOCKET
  , quirks: {}
  , models: []
  }
}

// Insertion order keeps 'generic' last, which classification relies on.
var vendorIds = Object.keys(vendors)

// Packages known to run Gecko; every other browser package defaults to Blink.
var browserEngines = {
  'com.igalia.wolvic': 'gecko'
, 'org.mozilla.vrbrowser': 'gecko'
}

// Word-ish match for 'vr'/'xr' inside a ro.build.characteristics value.
var XR_CHARACTERISTIC = /(^|,)(vr|xr)(,|$)/i

// XR-ish token inside a model/product/device/name string; used to
// corroborate weak manufacturer-only matches (Samsung/HTC phones).
var XR_NAME_HINT = /\b(xr|vr|vive|moohan)\b/i

function findVendor(vendorId) {
  if (vendorId && Object.prototype.hasOwnProperty.call(vendors, vendorId)) {
    return vendors[vendorId]
  }
  return null
}

function browserEngine(pkg) {
  if (!pkg) {
    return null
  }
  if (Object.prototype.hasOwnProperty.call(browserEngines, pkg)) {
    return browserEngines[pkg]
  }
  return 'blink'
}

function devtoolsSocketFor(pkg, vendorId) {
  if (browserEngine(pkg) === 'gecko') {
    return null
  }

  var vendor = findVendor(vendorId)
  if (vendor && vendor.devtoolsSocket) {
    return vendor.devtoolsSocket
  }
  return DEFAULT_DEVTOOLS_SOCKET
}

// Placeholder model profile used when only the vendor could be identified.
function unknownModel() {
  return {
    id: null
  , names: []
  , match: []
  , chromiumHint: null
  , geckoHint: null
  , tracking: 'unknown'
  , webxr: null
  , openxr: null
  }
}

function matchesAny(regexes, values) {
  return (regexes || []).some(function(re) {
    return values.some(function(value) {
      return re.test(value)
    })
  })
}

function modelCandidates(source) {
  return [source.model, source.product, source.device, source.name].filter(Boolean)
}

function manufacturerCandidates(source) {
  return [source.manufacturer, source.brand].filter(Boolean)
}

function findModelMatch(values) {
  var found = null
  vendorIds.some(function(vendorId) {
    var vendor = vendors[vendorId]
    vendor.models.some(function(model) {
      if (matchesAny(model.match, values)) {
        found = {vendor: vendor, model: model}
        return true
      }
      return false
    })
    return found !== null
  })
  return found
}

function findManufacturerMatch(values) {
  var found = null
  vendorIds.some(function(vendorId) {
    var vendor = vendors[vendorId]
    if (matchesAny(vendor.manufacturerMatch, values)) {
      found = vendor
      return true
    }
    return false
  })
  return found
}

// Classifies a prop summary ({manufacturer, brand, model, product, device,
// name, characteristics}; all optional strings). Model fingerprints win over
// manufacturer matches, which win over the generic fallback.
function classify(props) {
  var source = props || {}

  var modelHit = findModelMatch(modelCandidates(source))
  if (modelHit) {
    return {
      vendorId: modelHit.vendor.id
    , modelId: modelHit.model.id
    , model: modelHit.model
    , vendor: modelHit.vendor
    , confidence: 'high'
    }
  }

  var vendorHit = findManufacturerMatch(manufacturerCandidates(source))
  if (vendorHit) {
    return {
      vendorId: vendorHit.id
    , modelId: null
    , model: unknownModel()
    , vendor: vendorHit
    , confidence: 'medium'
    }
  }

  return {
    vendorId: 'generic'
  , modelId: genericModel.id
  , model: genericModel
  , vendor: vendors.generic
  , confidence: 'none'
  }
}

// True when the classification is confident enough, or when the build
// characteristics declare a vr/xr form factor. `classification` is optional
// and is computed from `props` when missing. Manufacturer-only matches on
// phone-dominated brands (manufacturerOnlyIsWeak) need corroboration, or
// every ordinary Samsung/HTC phone on the rack would list as a headset.
function isLikelyXr(props, classification) {
  var source = props || {}
  var known = classification || classify(source)

  if (known.confidence === 'high') {
    return true
  }
  if (known.confidence === 'medium' &&
      known.vendor && known.vendor.manufacturerOnlyIsWeak !== true) {
    return true
  }
  if (XR_CHARACTERISTIC.test(source.characteristics || '')) {
    return true
  }
  if (known.confidence === 'medium') {
    return modelCandidates(source).some(function(value) {
      return XR_NAME_HINT.test(value)
    })
  }
  return false
}

function allModels() {
  var flat = []
  vendorIds.forEach(function(vendorId) {
    vendors[vendorId].models.forEach(function(model) {
      flat.push({vendorId: vendorId, model: model})
    })
  })
  return flat
}

module.exports.vendors = vendors
module.exports.genericModel = genericModel
module.exports.browserEngines = browserEngines
module.exports.browserEngine = browserEngine
module.exports.devtoolsSocketFor = devtoolsSocketFor
module.exports.findVendor = findVendor
module.exports.vendorIds = vendorIds
module.exports.classify = classify
module.exports.isLikelyXr = isLikelyXr
module.exports.allModels = allModels
