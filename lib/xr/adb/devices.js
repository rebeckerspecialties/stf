'use strict'

var cp = require('child_process')

var Promise = require('bluebird')

var profiles = require('../device-profiles')
var AdbSession = require('./session')

var DETAIL_KEYS = ['usb', 'product', 'model', 'device']

function parseDeviceLine(line) {
  var parts = line.trim().split(/\s+/)
  if (parts.length < 2) {
    return null
  }

  var entry = {
    serial: parts[0]
  , state: parts[1]
  }

  parts.slice(2).forEach(function(pair) {
    var sep = pair.indexOf(':')
    if (sep <= 0) {
      return
    }
    var key = pair.slice(0, sep)
    var value = pair.slice(sep + 1)
    if (key === 'transport_id') {
      entry.transportId = value
    }
    else if (DETAIL_KEYS.indexOf(key) !== -1) {
      entry[key] = value
    }
  })

  return entry
}

function parseDeviceList(output) {
  var lines = output.split(/\r?\n/)
  var headerAt = -1

  lines.forEach(function(line, index) {
    if (headerAt === -1 && /^List of devices attached/.test(line.trim())) {
      headerAt = index
    }
  })

  return lines.slice(headerAt + 1)
    .filter(function(line) {
      return line.trim() !== '' && line.charAt(0) !== '*'
    })
    .map(parseDeviceLine)
    .filter(Boolean)
}

// Lists devices as reported by `adb devices -l` without touching any of them.
// Resolves [{serial, state, usb?, product?, model?, device?, transportId?}].
function listRaw(options) {
  var opts = options || {}
  var adb = opts.adb || process.env.ADB || 'adb'
  var timeout = opts.timeout || 10000

  return new Promise(function(resolve, reject) {
    var proc = cp.spawn(adb, ['devices', '-l'])
    var stdout = []
    var stderr = []
    var timer = null

    if (timeout > 0) {
      timer = setTimeout(function() {
        proc.kill('SIGKILL')
        reject(new Error('adb devices -l timed out after ' + timeout + 'ms'))
      }, timeout)
    }

    proc.stdout.on('data', function(data) {
      stdout.push(data)
    })

    proc.stderr.on('data', function(data) {
      stderr.push(data)
    })

    proc.on('error', function(err) {
      if (timer) {
        clearTimeout(timer)
      }
      if (err.code === 'ENOENT') {
        reject(new Error(
          'adb binary not found (tried "' + adb +
          '"); install Android platform-tools, pass options.adb or set $ADB'
        ))
      }
      else {
        reject(err)
      }
    })

    proc.on('close', function(code, signal) {
      if (timer) {
        clearTimeout(timer)
      }
      if (code === 0 && !signal) {
        resolve(parseDeviceList(Buffer.concat(stdout).toString()))
      }
      else {
        var detail = Buffer.concat(stderr).toString().trim()
        reject(new Error(
          'adb devices -l failed with ' +
          (signal ? 'signal ' + signal : 'status ' + code) +
          (detail ? ': ' + detail : '')
        ))
      }
    })
  })
}

// Maps a raw getprop dump to the summary shape shared with the providers.
// Missing properties become empty strings.
function summarizeProps(rawProps) {
  var raw = rawProps || {}

  function prop(name) {
    return raw[name] || ''
  }

  return {
    manufacturer: prop('ro.product.manufacturer')
  , brand: prop('ro.product.brand')
  , model: prop('ro.product.model')
  , product: prop('ro.build.product') || prop('ro.product.name')
  , device: prop('ro.product.device')
  , name: prop('ro.product.name')
  , androidVersion: prop('ro.build.version.release')
  , sdk: prop('ro.build.version.sdk')
  , characteristics: prop('ro.build.characteristics')
  , fingerprint: prop('ro.build.fingerprint')
  , abi: prop('ro.product.cpu.abi')
  }
}

function sessionFor(serial, options) {
  var opts = options || {}
  if (opts.session) {
    return opts.session
  }
  return new AdbSession(serial, {
    adb: opts.adb
  , timeout: opts.timeout
  })
}

function readProps(serial, options) {
  return sessionFor(serial, options).getAllProps().then(summarizeProps)
}

function displayNameFor(classification) {
  var model = classification.model
  if (model && model.names && model.names.length > 0) {
    return model.names[0]
  }
  return classification.vendor.displayName
}

// Describes a single device that is assumed to be online.
function describe(serial, options) {
  return readProps(serial, options).then(function(props) {
    var classification = profiles.classify(props)
    return {
      serial: serial
    , state: 'device'
    , props: props
    , classification: {
        vendorId: classification.vendorId
      , modelId: classification.modelId
      , confidence: classification.confidence
      , displayName: displayNameFor(classification)
      }
    , isXrHeadset: profiles.isLikelyXr(props, classification)
    }
  })
}

// Discovers and describes every connected device. Devices that are not
// online, or whose description fails, are reported as {serial, state, error}
// instead of rejecting the whole detection. With options.xrOnly only devices
// classified as XR headsets are returned.
function detect(options) {
  var opts = options || {}
  return listRaw(opts).then(function(entries) {
    return Promise.all(entries.map(function(entry) {
      if (entry.state !== 'device') {
        return {
          serial: entry.serial
        , state: entry.state
        , error: 'device not online'
        }
      }
      return describe(entry.serial, opts).catch(function(err) {
        return {
          serial: entry.serial
        , state: entry.state
        , error: err.message
        }
      })
    }))
  }).then(function(devices) {
    if (opts.xrOnly) {
      return devices.filter(function(device) {
        return device.isXrHeadset === true
      })
    }
    return devices
  })
}

module.exports.listRaw = listRaw
module.exports.readProps = readProps
module.exports.summarizeProps = summarizeProps
module.exports.describe = describe
module.exports.detect = detect
