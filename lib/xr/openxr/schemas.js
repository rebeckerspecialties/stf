'use strict'

// Schema identifiers and lightweight validators for the artifacts the future
// OpenXR API layer will produce. See lib/xr/openxr/README.md for the design.
// The NDJSON artifacts serialize as one JSON object per line with a leading
// header line ({schema: ...}); the documents validated here are the parsed,
// aggregated form ({schema: ..., events: [...]} etc).

var EVENTS_SCHEMA = 'stf.xr.openxr.events.v1'
var INPUT_SCHEMA = 'stf.xr.openxr.input.v1'
var STEREO_SCHEMA = 'stf.xr.openxr.stereo.v1'
var SUMMARY_SCHEMA = 'stf.xr.openxr.summary.v1'
var TTMFR_RESULT_SCHEMA = 'stf.xr.ttmfr.result.v1'

var EVENT_TYPES = [
  'process_launched'
, 'activity_started'
, 'xr_instance_created'
, 'xr_session_created'
, 'xr_session_begun'
, 'xr_wait_frame'
, 'xr_begin_frame'
, 'xr_end_frame'
, 'swapchain_acquired'
, 'swapchain_released'
, 'first_frame_submitted'
, 'first_meaningful_frame'
, 'custom_marker'
]

function isFiniteNumber(value) {
  return typeof value === 'number' && isFinite(value)
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function isNumberArray(value, length) {
  return Array.isArray(value) &&
    value.length === length &&
    value.every(isFiniteNumber)
}

function result(errors) {
  return {
    valid: errors.length === 0
  , errors: errors
  }
}

function checkSchemaField(doc, expected, errors) {
  if (doc.schema !== expected) {
    errors.push('schema must be ' + JSON.stringify(expected) +
      ', got ' + JSON.stringify(doc.schema))
  }
}

function checkEvent(event, where, errors) {
  if (!isPlainObject(event)) {
    errors.push(where + ' must be an object')
    return
  }
  if (EVENT_TYPES.indexOf(event.type) === -1) {
    errors.push(where + '.type ' + JSON.stringify(event.type) + ' is not a known event type')
  }
  if (!isFiniteNumber(event.tsNs)) {
    errors.push(where + '.tsNs must be a number')
  }
  if ('pid' in event && !isFiniteNumber(event.pid)) {
    errors.push(where + '.pid must be a number when present')
  }
  if ('frameIndex' in event && !isFiniteNumber(event.frameIndex)) {
    errors.push(where + '.frameIndex must be a number when present')
  }
  if ('name' in event && !isNonEmptyString(event.name)) {
    errors.push(where + '.name must be a non-empty string when present')
  }
  if ('data' in event && !isPlainObject(event.data)) {
    errors.push(where + '.data must be an object when present')
  }
}

function checkPose(pose, where, errors) {
  if (!isPlainObject(pose)) {
    errors.push(where + ' must be an object with position and orientation')
    return
  }
  if (!isNumberArray(pose.position, 3)) {
    errors.push(where + '.position must be an array of 3 numbers')
  }
  if (!isNumberArray(pose.orientation, 4)) {
    errors.push(where + '.orientation must be an array of 4 numbers (quaternion)')
  }
}

function checkControllers(controllers, where, errors) {
  if (!Array.isArray(controllers)) {
    errors.push(where + ' must be an array')
    return
  }
  controllers.forEach(function(controller, index) {
    var slot = where + '[' + index + ']'
    if (!isPlainObject(controller)) {
      errors.push(slot + ' must be an object')
      return
    }
    checkPose(controller.pose, slot + '.pose', errors)
  })
}

function checkSample(sample, where, errors) {
  if (!isPlainObject(sample)) {
    errors.push(where + ' must be an object')
    return
  }
  if (!isFiniteNumber(sample.tsNs)) {
    errors.push(where + '.tsNs must be a number')
  }
  if (!('controllers' in sample) && !('hands' in sample) && !('roomMesh' in sample)) {
    errors.push(where + ' must contain at least one of controllers, hands or roomMesh')
  }
  if ('controllers' in sample) {
    checkControllers(sample.controllers, where + '.controllers', errors)
  }
  if ('hands' in sample && !isPlainObject(sample.hands)) {
    errors.push(where + '.hands must be an object when present')
  }
  if ('roomMesh' in sample && !isPlainObject(sample.roomMesh)) {
    errors.push(where + '.roomMesh must be an object when present')
  }
}

function checkEye(eye, where, errors) {
  if (!isPlainObject(eye)) {
    errors.push(where + ' must be an object')
    return
  }
  if (!isNonEmptyString(eye.file)) {
    errors.push(where + '.file must be a non-empty string')
  }
  if (!isFiniteNumber(eye.width)) {
    errors.push(where + '.width must be a number')
  }
  if (!isFiniteNumber(eye.height)) {
    errors.push(where + '.height must be a number')
  }
}

function validateEvents(doc) {
  var errors = []
  if (!isPlainObject(doc)) {
    return result(['events document must be an object'])
  }
  checkSchemaField(doc, EVENTS_SCHEMA, errors)
  if (!Array.isArray(doc.events)) {
    errors.push('events must be an array')
    return result(errors)
  }
  doc.events.forEach(function(event, index) {
    checkEvent(event, 'events[' + index + ']', errors)
  })
  return result(errors)
}

function validateInputRecording(doc) {
  var errors = []
  if (!isPlainObject(doc)) {
    return result(['input recording document must be an object'])
  }
  checkSchemaField(doc, INPUT_SCHEMA, errors)
  if (!Array.isArray(doc.samples)) {
    errors.push('samples must be an array')
    return result(errors)
  }
  doc.samples.forEach(function(sample, index) {
    checkSample(sample, 'samples[' + index + ']', errors)
  })
  return result(errors)
}

function validateStereoMetadata(doc) {
  var errors = []
  if (!isPlainObject(doc)) {
    return result(['stereo metadata document must be an object'])
  }
  checkSchemaField(doc, STEREO_SCHEMA, errors)
  if (!isPlainObject(doc.eyes)) {
    errors.push('eyes must be an object with left and right entries')
    return result(errors)
  }
  checkEye(doc.eyes.left, 'eyes.left', errors)
  checkEye(doc.eyes.right, 'eyes.right', errors)
  return result(errors)
}

function validateSummary(doc) {
  var errors = []
  if (!isPlainObject(doc)) {
    return result(['summary document must be an object'])
  }
  checkSchemaField(doc, SUMMARY_SCHEMA, errors)
  if (!isPlainObject(doc.device)) {
    errors.push('device must be an object')
  }
  if (!isPlainObject(doc.timings)) {
    errors.push('timings must be an object')
  }
  if (!Array.isArray(doc.artifacts)) {
    errors.push('artifacts must be an array')
  }
  return result(errors)
}

function exampleEvents() {
  return {
    schema: EVENTS_SCHEMA
  , events: [
      {type: 'process_launched', tsNs: 81000000000, pid: 12345}
    , {
        type: 'activity_started'
      , tsNs: 81250000000
      , pid: 12345
      , name: 'com.example.xrapp/.MainActivity'
      }
    , {type: 'xr_instance_created', tsNs: 81400000000, pid: 12345}
    , {type: 'xr_session_created', tsNs: 81600000000, pid: 12345}
    , {type: 'xr_session_begun', tsNs: 81700000000, pid: 12345}
    , {type: 'xr_wait_frame', tsNs: 81720000000, pid: 12345, frameIndex: 0}
    , {type: 'xr_begin_frame', tsNs: 81721000000, pid: 12345, frameIndex: 0}
    , {
        type: 'swapchain_acquired'
      , tsNs: 81722000000
      , pid: 12345
      , frameIndex: 0
      , data: {swapchainIndex: 0, imageIndex: 1}
      }
    , {type: 'swapchain_released', tsNs: 81730000000, pid: 12345, frameIndex: 0}
    , {type: 'xr_end_frame', tsNs: 81731000000, pid: 12345, frameIndex: 0}
    , {type: 'first_frame_submitted', tsNs: 81731000000, pid: 12345, frameIndex: 0}
    , {
        type: 'first_meaningful_frame'
      , tsNs: 82000000000
      , pid: 12345
      , frameIndex: 16
      , data: {source: 'debug_utils_label'}
      }
    , {type: 'custom_marker', tsNs: 82500000000, pid: 12345, name: 'level_loaded'}
    ]
  }
}

function exampleInputRecording() {
  return {
    schema: INPUT_SCHEMA
  , serial: 'EXAMPLE1'
  , sampleRateHz: 72
  , samples: [
      {
        tsNs: 81800000000
      , controllers: [
          {
            hand: 'left'
          , pose: {position: [-0.2, 1.3, -0.4], orientation: [0, 0, 0, 1]}
          , buttons: {trigger: 0, grip: 0.5, primary: false}
          }
        , {
            hand: 'right'
          , pose: {position: [0.2, 1.3, -0.4], orientation: [0, 0, 0.7071, 0.7071]}
          , buttons: {trigger: 1, grip: 0, primary: true}
          }
        ]
      }
    , {
        tsNs: 81813888888
      , hands: {
          left: {tracked: true, jointCount: 26}
        , right: {tracked: false, jointCount: 0}
        }
      }
    ]
  }
}

function exampleStereoMetadata() {
  return {
    schema: STEREO_SCHEMA
  , capturedAtNs: 82100000000
  , frameIndex: 24
  , colorFormat: 'VK_FORMAT_R8G8B8A8_SRGB'
  , eyes: {
      left: {file: 'stereo-left.png', width: 1832, height: 1920}
    , right: {file: 'stereo-right.png', width: 1832, height: 1920}
    }
  }
}

function exampleSummary() {
  return {
    schema: SUMMARY_SCHEMA
  , device: {serial: 'EXAMPLE1', vendorId: 'oculus', modelId: 'quest-3'}
  , target: {package: 'com.example.xrapp', activity: '.MainActivity'}
  , timings: {
      launchedAtNs: 81000000000
    , firstFrameSubmittedAtNs: 81731000000
    , firstMeaningfulFrameAtNs: 82000000000
    , ttmfrNs: 1000000000
    }
  , artifacts: [
      'openxr-events.ndjson'
    , 'input-recording.ndjson'
    , 'stereo-left.png'
    , 'stereo-right.png'
    , 'stereo-metadata.json'
    , 'openxr-summary.json'
    ]
  }
}

module.exports.EVENTS_SCHEMA = EVENTS_SCHEMA
module.exports.INPUT_SCHEMA = INPUT_SCHEMA
module.exports.STEREO_SCHEMA = STEREO_SCHEMA
module.exports.SUMMARY_SCHEMA = SUMMARY_SCHEMA
module.exports.TTMFR_RESULT_SCHEMA = TTMFR_RESULT_SCHEMA
module.exports.EVENT_TYPES = EVENT_TYPES
module.exports.validateEvents = validateEvents
module.exports.validateInputRecording = validateInputRecording
module.exports.validateStereoMetadata = validateStereoMetadata
module.exports.validateSummary = validateSummary
module.exports.exampleEvents = exampleEvents
module.exports.exampleInputRecording = exampleInputRecording
module.exports.exampleStereoMetadata = exampleStereoMetadata
module.exports.exampleSummary = exampleSummary
