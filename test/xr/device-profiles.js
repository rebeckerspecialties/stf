/* eslint-env mocha */

var chai = require('chai')

var profiles = require('../../lib/xr/device-profiles')

var expect = chai.expect

describe('xr/device-profiles', function() {
  describe('classify()', function() {
    it('classifies a Quest 2 by manufacturer and model', function() {
      var result = profiles.classify({manufacturer: 'Oculus', model: 'Quest 2'})
      expect(result.vendorId).to.equal('oculus')
      expect(result.modelId).to.equal('quest-2')
      expect(result.confidence).to.equal('high')
      expect(result.model.tracking).to.equal('6dof')
      expect(result.vendor.id).to.equal('oculus')
    })

    it('classifies a Quest 3 by the eureka device codename', function() {
      var result = profiles.classify({manufacturer: 'Oculus', device: 'eureka'})
      expect(result.vendorId).to.equal('oculus')
      expect(result.modelId).to.equal('quest-3')
      expect(result.confidence).to.equal('high')
    })

    it('classifies an Oculus Go by the pacific codename', function() {
      var result = profiles.classify({device: 'pacific'})
      expect(result.vendorId).to.equal('oculus')
      expect(result.modelId).to.equal('oculus-go')
      expect(result.model.openxr).to.equal(false)
    })

    it('classifies a PICO 4', function() {
      var result = profiles.classify({manufacturer: 'Pico', model: 'PICO 4'})
      expect(result.vendorId).to.equal('pico')
      expect(result.modelId).to.equal('pico-4')
      expect(result.model.chromiumHint).to.equal(105)
    })

    it('classifies a PICO 4 Ultra before the plain PICO 4', function() {
      var result = profiles.classify({manufacturer: 'Pico', model: 'PICO 4 Ultra'})
      expect(result.vendorId).to.equal('pico')
      expect(result.modelId).to.equal('pico-4-ultra')
    })

    it('classifies a Galaxy XR', function() {
      var result = profiles.classify({manufacturer: 'samsung', model: 'Galaxy XR'})
      expect(result.vendorId).to.equal('samsung')
      expect(result.modelId).to.equal('galaxy-xr')
      expect(result.confidence).to.equal('high')
      expect(result.model.chromiumHint).to.equal(144)
    })

    it('classifies a Galaxy XR by the moohan codename', function() {
      var result = profiles.classify({manufacturer: 'samsung', device: 'moohan'})
      expect(result.modelId).to.equal('galaxy-xr')
    })

    it('classifies a Vive XR Elite', function() {
      var result = profiles.classify({manufacturer: 'HTC', model: 'VIVE XR Elite'})
      expect(result.vendorId).to.equal('htc')
      expect(result.modelId).to.equal('vive-xr-elite')
      expect(result.model.geckoHint).to.equal(120)
      expect(result.model.chromiumHint).to.equal(null)
    })

    it('falls back to a vendor match when only the manufacturer is known', function() {
      var result = profiles.classify({manufacturer: 'Meta', model: 'Some Future Headset'})
      expect(result.vendorId).to.equal('oculus')
      expect(result.modelId).to.equal(null)
      expect(result.confidence).to.equal('medium')
      expect(result.model.webxr).to.equal(null)
    })

    it('classifies an unknown phone as generic with no confidence', function() {
      var props = {manufacturer: 'Google', model: 'Pixel 7', characteristics: 'nosdcard'}
      var result = profiles.classify(props)
      expect(result.vendorId).to.equal('generic')
      expect(result.modelId).to.equal('generic-android-xr')
      expect(result.confidence).to.equal('none')
      expect(result.model).to.equal(profiles.genericModel)
      expect(profiles.isLikelyXr(props, result)).to.equal(false)
    })

    it('handles missing props entirely', function() {
      var result = profiles.classify()
      expect(result.vendorId).to.equal('generic')
      expect(result.confidence).to.equal('none')
    })
  })

  describe('isLikelyXr()', function() {
    it('is true for high and medium confidence classifications', function() {
      expect(profiles.isLikelyXr({manufacturer: 'Oculus', model: 'Quest 2'})).to.equal(true)
      expect(profiles.isLikelyXr({manufacturer: 'Pico', model: 'Mystery'})).to.equal(true)
    })

    it('is true for unknown devices whose characteristics declare vr', function() {
      var props = {manufacturer: 'WeirdCo', model: 'HMD-1', characteristics: 'default,vr'}
      expect(profiles.classify(props).confidence).to.equal('none')
      expect(profiles.isLikelyXr(props)).to.equal(true)
    })

    it('matches xr as a word, not as a substring', function() {
      expect(profiles.isLikelyXr({characteristics: 'nosdcard,xr'})).to.equal(true)
      expect(profiles.isLikelyXr({characteristics: 'boxrocket'})).to.equal(false)
    })

    it('does not flag ordinary Samsung/HTC phones on the manufacturer alone', function() {
      var phone = {manufacturer: 'samsung', model: 'SM-S928B', characteristics: 'nosdcard'}
      expect(profiles.classify(phone).vendorId).to.equal('samsung')
      expect(profiles.classify(phone).confidence).to.equal('medium')
      expect(profiles.isLikelyXr(phone)).to.equal(false)
      expect(profiles.isLikelyXr({manufacturer: 'HTC', model: 'HTC U23'})).to.equal(false)
    })

    it('accepts weak manufacturer matches with vr characteristics or XR-ish names', function() {
      expect(profiles.isLikelyXr({
        manufacturer: 'samsung'
      , model: 'SM-I610'
      , characteristics: 'xr'
      })).to.equal(true)

      // Unlisted headset model from a phone-dominated brand.
      expect(profiles.isLikelyXr({
        manufacturer: 'HTC'
      , model: 'VIVE Focus 3'
      })).to.equal(true)
    })
  })

  describe('browserEngine()', function() {
    it('maps Wolvic and the Mozilla VR browser to gecko', function() {
      expect(profiles.browserEngine('com.igalia.wolvic')).to.equal('gecko')
      expect(profiles.browserEngine('org.mozilla.vrbrowser')).to.equal('gecko')
    })

    it('defaults everything else to blink', function() {
      expect(profiles.browserEngine('com.oculus.browser')).to.equal('blink')
      expect(profiles.browserEngine('com.unheard.of.pkg')).to.equal('blink')
    })

    it('returns null for a missing package', function() {
      expect(profiles.browserEngine(null)).to.equal(null)
      expect(profiles.browserEngine('')).to.equal(null)
    })
  })

  describe('devtoolsSocketFor()', function() {
    it('returns null for gecko packages', function() {
      expect(profiles.devtoolsSocketFor('com.igalia.wolvic', 'htc')).to.equal(null)
    })

    it('returns the vendor socket for blink packages', function() {
      expect(profiles.devtoolsSocketFor('com.oculus.browser', 'oculus'))
        .to.equal('localabstract:chrome_devtools_remote')
    })

    it('falls back to the default socket for unknown vendors', function() {
      expect(profiles.devtoolsSocketFor('com.android.chrome', 'nope'))
        .to.equal('localabstract:chrome_devtools_remote')
    })
  })

  describe('vendor data', function() {
    it('lists the vendor ids with generic last', function() {
      expect(profiles.vendorIds).to.contain('oculus')
      expect(profiles.vendorIds).to.contain('pico')
      expect(profiles.vendorIds).to.contain('samsung')
      expect(profiles.vendorIds).to.contain('htc')
      expect(profiles.vendorIds[profiles.vendorIds.length - 1]).to.equal('generic')
    })

    it('finds vendors by id and returns null for unknowns', function() {
      expect(profiles.findVendor('pico').id).to.equal('pico')
      expect(profiles.findVendor('acme')).to.equal(null)
    })

    it('keeps the exact pico browser candidate order', function() {
      expect(profiles.vendors.pico.browserCandidates).to.deep.equal([
        'com.picovr.browser'
      , 'com.pvr.browser'
      , 'com.bytedance.picobrowser'
      , 'com.android.browser'
      , 'com.google.android.apps.chrome'
      ])
    })

    it('flattens all models with their vendor ids', function() {
      var all = profiles.allModels()
      var ids = all.map(function(entry) {
        return entry.vendorId + '/' + entry.model.id
      })
      expect(all).to.have.length(8)
      expect(ids).to.contain('oculus/quest-1')
      expect(ids).to.contain('samsung/galaxy-xr')
      expect(ids).to.contain('htc/vive-xr-elite')
    })
  })
})
