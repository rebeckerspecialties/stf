/* eslint-env mocha */

var chai = require('chai')
var Promise = require('bluebird')

var ttmfr = require('../../lib/xr/bench/ttmfr')

var expect = chai.expect

function makeRawBuffer(headerWords, dataLength, fill) {
  var header = Buffer.alloc(headerWords.length * 4)
  headerWords.forEach(function(word, index) {
    header.writeUInt32LE(word, index * 4)
  })
  return Buffer.concat([header, Buffer.alloc(dataLength, fill)])
}

// Fake provider + session pair for the logcat/webxr method tests. `hit`
// configures what waitForLogcatMarker resolves; epochMs may be a function
// evaluated at marker time.
function fakeProvider(config) {
  var cfg = config || {}
  var session = {
    calls: []
  }

  session.logcatClear = function() {
    session.calls.push(['logcatClear'])
    return Promise.resolve({stdout: '', stderr: '', code: 0})
  }

  session.waitForLogcatMarker = function(marker, options) {
    session.calls.push(['waitForLogcatMarker', marker, options])
    var hit = cfg.hit || {}
    if (cfg.markerTimesOut) {
      return Promise.reject(new Error('Timed out waiting for logcat marker ' + marker))
    }
    return Promise.resolve({
      marker: marker
    , line: hit.line || 'fake logcat line with ' + marker
    , elapsedMs: hit.elapsedMs || 50
    , epochMs: typeof hit.epochMs === 'function' ? hit.epochMs() : (hit.epochMs || null)
    })
  }

  var provider = {
    serial: 'FAKE1'
  , name: cfg.name || 'oculus'
  , session: session
  }

  provider.detectBrowser = function() {
    session.calls.push(['detectBrowser'])
    return Promise.resolve(cfg.browser || {chosen: 'com.oculus.browser', engine: 'blink'})
  }

  provider.supportsCdp = function(browser) {
    return !!browser && browser.engine === 'blink'
  }

  provider.openUrl = function(url) {
    session.calls.push(['openUrl', url])
    return Promise.resolve({url: url, browserPackage: 'com.oculus.browser'})
  }

  provider.launchApk = function(packageName, activity) {
    session.calls.push(['launchApk', packageName, activity])
    return Promise.resolve({stdout: '', stderr: '', code: 0})
  }

  return provider
}

describe('xr/bench/ttmfr', function() {
  describe('parseRawScreencap()', function() {
    it('parses a legacy 12-byte header dump', function() {
      var buffer = makeRawBuffer([2, 2, 1], 16, 0x7f)
      var frame = ttmfr.parseRawScreencap(buffer)
      expect(frame.width).to.equal(2)
      expect(frame.height).to.equal(2)
      expect(frame.format).to.equal(1)
      expect(frame.bytesPerPixel).to.equal(4)
      expect(frame.headerSize).to.equal(12)
      expect(frame.data.length).to.equal(16)
      expect(frame.data[0]).to.equal(0x7f)
    })

    it('parses a modern 16-byte header dump', function() {
      var buffer = makeRawBuffer([2, 2, 1, 0], 16, 0x11)
      var frame = ttmfr.parseRawScreencap(buffer)
      expect(frame.headerSize).to.equal(16)
      expect(frame.width).to.equal(2)
      expect(frame.height).to.equal(2)
      expect(frame.data.length).to.equal(16)
      expect(frame.data[0]).to.equal(0x11)
    })

    it('handles RGB_565 dumps with 2 bytes per pixel', function() {
      var buffer = makeRawBuffer([4, 2, 4], 16, 0)
      var frame = ttmfr.parseRawScreencap(buffer)
      expect(frame.bytesPerPixel).to.equal(2)
      expect(frame.headerSize).to.equal(12)
      expect(frame.data.length).to.equal(16)
    })

    it('throws on buffers shorter than the minimum header', function() {
      expect(function() {
        ttmfr.parseRawScreencap(Buffer.alloc(8))
      }).to.throw(/too short/)
    })
  })

  describe('measure() dispatch', function() {
    it('rejects without a provider instance', function() {
      return ttmfr.measure(null, {method: 'logcat-marker'}).then(function() {
        throw new Error('expected a rejection')
      }, function(err) {
        expect(err.message).to.contain('provider instance')
      })
    })

    it('rejects unknown methods listing the valid ones', function() {
      return ttmfr.measure(fakeProvider(), {method: 'crystal-ball'}).then(function() {
        throw new Error('expected a rejection')
      }, function(err) {
        expect(err.message).to.contain('crystal-ball')
        expect(err.message).to.contain('logcat-marker')
      })
    })
  })

  describe('openxr-layer method', function() {
    it('resolves ok:false with the roadmap instead of rejecting', function() {
      return ttmfr.measure(fakeProvider(), {method: 'openxr-layer', url: 'https://example.com'})
        .then(function(result) {
          expect(result.schema).to.equal('stf.xr.ttmfr.result.v1')
          expect(result.method).to.equal('openxr-layer')
          expect(result.ok).to.equal(false)
          expect(result.confidence).to.equal('none')
          expect(result.error).to.contain('lib/xr/openxr/README.md')
          expect(result.evidence.roadmap).to.be.an('object')
          expect(result.evidence.roadmap.resultSchema).to.equal('stf.xr.ttmfr.result.v1')
        })
    })
  })

  describe('logcat-marker method', function() {
    it('computes ttmfrMs from the device epoch stamp with medium confidence', function() {
      var provider = fakeProvider({
        hit: {
          epochMs: function() {
            return Date.now() + 500
          }
        , line: '1720000000.123 I STF_XR : STF_XR_READY'
        , elapsedMs: 42
        }
      })

      return ttmfr.measure(provider, {
        method: 'logcat-marker'
      , url: 'https://example.com/xr'
      , timeout: 5000
      }).then(function(result) {
        expect(result.schema).to.equal('stf.xr.ttmfr.result.v1')
        expect(result.serial).to.equal('FAKE1')
        expect(result.method).to.equal('logcat-marker')
        expect(result.target).to.deep.equal({url: 'https://example.com/xr'})
        expect(result.ok).to.equal(true)
        expect(result.confidence).to.equal('medium')
        expect(result.error).to.equal(null)

        // launchedAtMs is host time taken just before the launch, and the
        // fake marker lands 500ms after it resolves.
        expect(result.timings.ttmfrMs).to.be.a('number')
        expect(result.timings.ttmfrMs).to.be.at.least(500)
        expect(result.timings.ttmfrMs).to.be.below(10000)
        expect(result.timings.markerAtMs - result.timings.launchedAtMs)
          .to.equal(result.timings.ttmfrMs)
        expect(result.evidence.line).to.contain('STF_XR_READY')
        expect(result.evidence.elapsedMs).to.equal(42)

        // The default marker was used and the URL launched via openUrl.
        var sessionCalls = provider.session.calls.map(function(call) {
          return call[0]
        })
        expect(sessionCalls).to.contain('logcatClear')
        expect(sessionCalls).to.contain('openUrl')
        var wait = provider.session.calls.filter(function(call) {
          return call[0] === 'waitForLogcatMarker'
        })[0]
        expect(wait[1]).to.equal('STF_XR_READY')
      })
    })

    it('drops to low confidence when the line has no epoch stamp', function() {
      var provider = fakeProvider({hit: {epochMs: null}})

      return ttmfr.measure(provider, {
        method: 'logcat-marker'
      , package: 'com.example.xrapp'
      , marker: 'APP_READY'
      , timeout: 5000
      }).then(function(result) {
        expect(result.ok).to.equal(true)
        expect(result.confidence).to.equal('low')
        expect(result.target).to.deep.equal({package: 'com.example.xrapp'})
        expect(result.timings.ttmfrMs).to.be.a('number')
        expect(result.timings.ttmfrMs).to.be.at.least(0)
        expect(result.evidence.epochMs).to.equal(null)

        // Package targets launch through launchApk, not openUrl.
        var launches = provider.session.calls.filter(function(call) {
          return call[0] === 'launchApk'
        })
        expect(launches).to.deep.equal([['launchApk', 'com.example.xrapp', null]])
        var wait = provider.session.calls.filter(function(call) {
          return call[0] === 'waitForLogcatMarker'
        })[0]
        expect(wait[1]).to.equal('APP_READY')
      })
    })

    it('resolves ok:false with an explanation when no target is given', function() {
      return ttmfr.measure(fakeProvider(), {method: 'logcat-marker'}).then(function(result) {
        expect(result.ok).to.equal(false)
        expect(result.confidence).to.equal('none')
        expect(result.error).to.match(/\{url\} or \{package\}/)
      })
    })

    it('captures marker timeouts in result.error instead of rejecting', function() {
      var provider = fakeProvider({markerTimesOut: true})

      return ttmfr.measure(provider, {
        method: 'logcat-marker'
      , url: 'https://example.com'
      , timeout: 100
      }).then(function(result) {
        expect(result.ok).to.equal(false)
        expect(result.error).to.contain('Timed out waiting for logcat marker')
        expect(result.timings.ttmfrMs).to.equal(null)
      })
    })
  })

  describe('webxr-marker method', function() {
    it('resolves ok:false for non-CDP (gecko) browsers with guidance', function() {
      var provider = fakeProvider({
        browser: {chosen: 'com.igalia.wolvic', engine: 'gecko'}
      })

      return ttmfr.measure(provider, {
        method: 'webxr-marker'
      , url: 'https://example.com/xr'
      }).then(function(result) {
        expect(result.ok).to.equal(false)
        expect(result.confidence).to.equal('none')
        expect(result.error).to.contain('com.igalia.wolvic')
        expect(result.error).to.contain('logcat-marker')
      })
    })

    it('resolves ok:false when no url is supplied', function() {
      return ttmfr.measure(fakeProvider(), {method: 'webxr-marker'}).then(function(result) {
        expect(result.ok).to.equal(false)
        expect(result.error).to.contain('webxr-marker needs {url}')
      })
    })
  })
})
