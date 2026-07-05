/* eslint-env mocha */

var chai = require('chai')
var Promise = require('bluebird')

var openxr = require('../../lib/xr/openxr')
var schemas = require('../../lib/xr/openxr/schemas')

var expect = chai.expect

describe('xr/openxr', function() {
  describe('schema constants', function() {
    it('exposes the artifact schema identifiers', function() {
      expect(schemas.EVENTS_SCHEMA).to.equal('stf.xr.openxr.events.v1')
      expect(schemas.INPUT_SCHEMA).to.equal('stf.xr.openxr.input.v1')
      expect(schemas.STEREO_SCHEMA).to.equal('stf.xr.openxr.stereo.v1')
      expect(schemas.SUMMARY_SCHEMA).to.equal('stf.xr.openxr.summary.v1')
      expect(schemas.TTMFR_RESULT_SCHEMA).to.equal('stf.xr.ttmfr.result.v1')
    })

    it('lists the lifecycle event types', function() {
      expect(schemas.EVENT_TYPES).to.contain('process_launched')
      expect(schemas.EVENT_TYPES).to.contain('xr_instance_created')
      expect(schemas.EVENT_TYPES).to.contain('first_frame_submitted')
      expect(schemas.EVENT_TYPES).to.contain('first_meaningful_frame')
      expect(schemas.EVENT_TYPES).to.contain('custom_marker')
      expect(schemas.EVENT_TYPES).to.have.length(13)
    })
  })

  describe('validators accept their own examples', function() {
    it('validates exampleEvents()', function() {
      var outcome = schemas.validateEvents(schemas.exampleEvents())
      expect(outcome.errors).to.deep.equal([])
      expect(outcome.valid).to.equal(true)
    })

    it('validates exampleInputRecording()', function() {
      var outcome = schemas.validateInputRecording(schemas.exampleInputRecording())
      expect(outcome.errors).to.deep.equal([])
      expect(outcome.valid).to.equal(true)
    })

    it('validates exampleStereoMetadata()', function() {
      var outcome = schemas.validateStereoMetadata(schemas.exampleStereoMetadata())
      expect(outcome.errors).to.deep.equal([])
      expect(outcome.valid).to.equal(true)
    })

    it('validates exampleSummary()', function() {
      var outcome = schemas.validateSummary(schemas.exampleSummary())
      expect(outcome.errors).to.deep.equal([])
      expect(outcome.valid).to.equal(true)
    })
  })

  describe('validators reject broken documents', function() {
    it('rejects a wrong schema string', function() {
      var doc = schemas.exampleEvents()
      doc.schema = 'stf.xr.openxr.events.v999'
      var outcome = schemas.validateEvents(doc)
      expect(outcome.valid).to.equal(false)
      expect(outcome.errors.join('\n')).to.contain('schema must be')
    })

    it('rejects unknown event types', function() {
      var doc = schemas.exampleEvents()
      doc.events.push({type: 'warp_drive_engaged', tsNs: 1})
      var outcome = schemas.validateEvents(doc)
      expect(outcome.valid).to.equal(false)
      expect(outcome.errors.join('\n')).to.contain('warp_drive_engaged')
    })

    it('rejects events without a numeric tsNs', function() {
      var doc = schemas.exampleEvents()
      doc.events.push({type: 'custom_marker', tsNs: 'yesterday', name: 'x'})
      var outcome = schemas.validateEvents(doc)
      expect(outcome.valid).to.equal(false)
      expect(outcome.errors.join('\n')).to.contain('tsNs')
    })

    it('rejects a bad controller pose length', function() {
      var doc = schemas.exampleInputRecording()
      doc.samples[0].controllers[0].pose.position = [1, 2]
      var outcome = schemas.validateInputRecording(doc)
      expect(outcome.valid).to.equal(false)
      expect(outcome.errors.join('\n')).to.contain('position must be an array of 3 numbers')
    })

    it('rejects samples with no input payload at all', function() {
      var doc = schemas.exampleInputRecording()
      doc.samples.push({tsNs: 1})
      var outcome = schemas.validateInputRecording(doc)
      expect(outcome.valid).to.equal(false)
      expect(outcome.errors.join('\n')).to.contain('at least one of')
    })

    it('rejects stereo metadata with a missing eye file', function() {
      var doc = schemas.exampleStereoMetadata()
      delete doc.eyes.left.file
      var outcome = schemas.validateStereoMetadata(doc)
      expect(outcome.valid).to.equal(false)
      expect(outcome.errors.join('\n')).to.contain('eyes.left.file')
    })

    it('rejects summaries without device/timings/artifacts', function() {
      var outcome = schemas.validateSummary({schema: schemas.SUMMARY_SCHEMA})
      expect(outcome.valid).to.equal(false)
      expect(outcome.errors).to.have.length(3)
    })

    it('rejects non-object documents', function() {
      expect(schemas.validateEvents(null).valid).to.equal(false)
      expect(schemas.validateSummary([]).valid).to.equal(false)
    })
  })

  describe('plan() and artifactLayout()', function() {
    it('returns a machine-readable roadmap', function() {
      var plan = openxr.plan()
      expect(plan.schema).to.equal('stf.xr.openxr.plan.v1')
      expect(plan.apiLayer.strategies).to.be.an('array')
      expect(plan.apiLayer.engineAgnostic).to.equal(true)
      expect(plan.ttmfr.resultSchema).to.equal('stf.xr.ttmfr.result.v1')
      expect(plan.stereoScreenshot.output).to.contain('stereo-left.png')
      expect(plan.inputReplay.replayOptions).to.be.an('array')
      expect(plan.artifacts.schema).to.equal('stf.xr.openxr.artifacts.v1')
    })

    it('describes the six planned artifact files', function() {
      var layout = openxr.artifactLayout()
      var names = layout.files.map(function(file) {
        return file.name
      })
      expect(names).to.deep.equal([
        'openxr-events.ndjson'
      , 'input-recording.ndjson'
      , 'stereo-left.png'
      , 'stereo-right.png'
      , 'stereo-metadata.json'
      , 'openxr-summary.json'
      ])
    })
  })

  describe('not-yet-implemented stubs', function() {
    function expectNotImplemented(promise) {
      return promise.then(function() {
        throw new Error('expected an XrNotImplementedError rejection')
      }, function(err) {
        expect(err).to.be.an.instanceof(openxr.XrNotImplementedError)
        expect(err).to.be.an.instanceof(Error)
        expect(err.name).to.equal('XrNotImplementedError')
        expect(err.roadmap).to.equal('lib/xr/openxr/README.md')
        expect(err.message).to.contain('not implemented yet')
      })
    }

    it('rejects installApiLayer()', function() {
      return expectNotImplemented(openxr.installApiLayer(null, {}))
    })

    it('rejects captureStereoScreenshot()', function() {
      return expectNotImplemented(openxr.captureStereoScreenshot(null, {}))
    })

    it('rejects recordInput()', function() {
      return expectNotImplemented(openxr.recordInput(null, {}))
    })

    it('rejects replayInput()', function() {
      return expectNotImplemented(openxr.replayInput(null, 'recording.ndjson', {}))
    })

    it('rejects collectArtifacts()', function() {
      return expectNotImplemented(openxr.collectArtifacts(null, '/tmp/out', {}))
    })

    it('keeps the stub rejections as bluebird promises', function() {
      var rejection = openxr.recordInput(null, {})
      expect(rejection).to.be.an.instanceof(Promise)
      return rejection.catch(function(err) {
        expect(err.feature).to.equal('recordInput')
      })
    })
  })
})
