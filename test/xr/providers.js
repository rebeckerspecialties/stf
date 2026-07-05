/* eslint-env mocha */

var chai = require('chai')
var Promise = require('bluebird')

var providers = require('../../lib/xr/providers')
var OculusProvider = require('../../lib/xr/providers/oculus')
var PicoProvider = require('../../lib/xr/providers/pico')
var GenericAdbProvider = require('../../lib/xr/providers/generic-adb')

var expect = chai.expect

var QUEST2_PROPS = {
  'ro.product.manufacturer': 'Oculus'
, 'ro.product.model': 'Quest 2'
, 'ro.product.device': 'hollywood'
, 'ro.build.characteristics': 'vr'
}

var GO_PROPS = {
  'ro.product.manufacturer': 'Oculus'
, 'ro.product.model': 'Pacific'
, 'ro.product.device': 'pacific'
, 'ro.build.characteristics': 'vr'
}

var PICO4_PROPS = {
  'ro.product.manufacturer': 'Pico'
, 'ro.product.model': 'PICO 4'
, 'ro.build.characteristics': 'vr'
}

var VIVE_PROPS = {
  'ro.product.manufacturer': 'HTC'
, 'ro.product.model': 'VIVE XR Elite'
, 'ro.build.characteristics': 'vr'
}

var GALAXY_PROPS = {
  'ro.product.manufacturer': 'samsung'
, 'ro.product.model': 'Galaxy XR'
, 'ro.build.characteristics': 'xr'
}

var PHONE_PROPS = {
  'ro.product.manufacturer': 'Google'
, 'ro.product.model': 'Pixel 7'
, 'ro.build.characteristics': 'nosdcard'
}

// AdbSession stand-in covering everything BaseProvider and its subclasses
// touch, with recorded calls for interaction assertions.
function fakeSession(config) {
  var cfg = config || {}
  var session = {
    calls: []
  }

  session.getAllProps = function() {
    session.calls.push(['getAllProps'])
    return Promise.resolve(cfg.props || {})
  }

  session.listPackages = function() {
    session.calls.push(['listPackages'])
    return Promise.resolve(cfg.packages || [])
  }

  session.packageVersion = function(packageName) {
    session.calls.push(['packageVersion', packageName])
    var versions = cfg.versions || {}
    return Promise.resolve(versions[packageName] || null)
  }

  session.openUrl = function(url, packageName) {
    session.calls.push(['openUrl', url, packageName])
    return Promise.resolve({stdout: '', stderr: '', code: 0})
  }

  session.shell = function(args) {
    session.calls.push(['shell', args])
    return Promise.resolve({stdout: cfg.shellStdout || '', stderr: '', code: 0})
  }

  session.keyevent = function(keyCode) {
    session.calls.push(['keyevent', keyCode])
    if (cfg.keyeventFails) {
      return Promise.reject(new Error('input service not ready'))
    }
    return Promise.resolve({stdout: '', stderr: '', code: 0})
  }

  session.forceStop = function(packageName) {
    session.calls.push(['forceStop', packageName])
    return Promise.resolve({stdout: '', stderr: '', code: 0})
  }

  return session
}

function countCalls(session, name) {
  return session.calls.filter(function(call) {
    return call[0] === name
  }).length
}

describe('xr/providers', function() {
  describe('forName()', function() {
    it('constructs the matching provider class', function() {
      expect(providers.forName('oculus', 'SER1', {session: fakeSession()}))
        .to.be.an.instanceof(OculusProvider)
      expect(providers.forName('pico', 'SER1', {session: fakeSession()}))
        .to.be.an.instanceof(PicoProvider)
      expect(providers.forName('generic', 'SER1', {session: fakeSession()}))
        .to.be.an.instanceof(GenericAdbProvider)
    })

    it('throws for unknown names, listing the valid ones', function() {
      expect(function() {
        providers.forName('acme', 'SER1', {session: fakeSession()})
      }).to.throw(/oculus, pico, generic/)
    })
  })

  describe('forDevice()', function() {
    it('selects OculusProvider for Quest props and reuses the session', function() {
      var session = fakeSession({props: QUEST2_PROPS})

      return providers.forDevice('SER1', {session: session}).then(function(provider) {
        expect(provider).to.be.an.instanceof(OculusProvider)
        expect(provider.name).to.equal('oculus')
        expect(provider.session).to.equal(session)

        // The probe's cached classification is handed over, so no second
        // getprop round trip happens.
        expect(countCalls(session, 'getAllProps')).to.equal(1)
        return provider.classify()
      }).then(function(classification) {
        expect(classification.modelId).to.equal('quest-2')
      })
    })

    it('selects PicoProvider for PICO props', function() {
      var session = fakeSession({props: PICO4_PROPS})

      return providers.forDevice('SER1', {session: session}).then(function(provider) {
        expect(provider).to.be.an.instanceof(PicoProvider)
        expect(countCalls(session, 'getAllProps')).to.equal(1)
      })
    })

    it('falls back to GenericAdbProvider for unknown devices', function() {
      var session = fakeSession({props: PHONE_PROPS})

      return providers.forDevice('SER1', {session: session}).then(function(provider) {
        expect(provider).to.be.an.instanceof(GenericAdbProvider)
        expect(provider.name).to.equal('generic')
      })
    })

    it('keeps samsung and htc devices on the generic provider', function() {
      var session = fakeSession({props: GALAXY_PROPS})

      return providers.forDevice('SER1', {session: session}).then(function(provider) {
        expect(provider).to.be.an.instanceof(GenericAdbProvider)
      })
    })
  })

  describe('detectBrowser()', function() {
    it('chooses the first installed pico candidate and reads its version', function() {
      var session = fakeSession({
        props: PICO4_PROPS
      , packages: ['com.android.settings', 'com.pvr.browser']
      , versions: {'com.pvr.browser': '2.5.0'}
      })
      var provider = providers.forName('pico', 'SER1', {session: session})

      return provider.detectBrowser().then(function(browser) {
        expect(browser.chosen).to.equal('com.pvr.browser')
        expect(browser.installed).to.deep.equal(['com.pvr.browser'])
        expect(browser.version).to.equal('2.5.0')
        expect(browser.engine).to.equal('blink')
        expect(browser.devtoolsSocket).to.equal('localabstract:chrome_devtools_remote')
      })
    })

    it('reports browser-like packages and a pico hint on a miss', function() {
      var session = fakeSession({
        props: PICO4_PROPS
      , packages: ['com.android.settings', 'com.regional.webviewshell', 'com.oem.browserlite']
      })
      var provider = providers.forName('pico', 'SER1', {session: session})

      return provider.detectBrowser().then(function(browser) {
        expect(browser.chosen).to.equal(null)
        expect(browser.version).to.equal(null)
        expect(browser.diagnostics.browserLikePackages).to.deep.equal([
          'com.regional.webviewshell'
        , 'com.oem.browserlite'
        ])
        expect(browser.diagnostics.hint).to.match(/--browser/)
      })
    })

    it('honors a forced browserPackage option', function() {
      var session = fakeSession({
        props: QUEST2_PROPS
      , packages: ['com.custom.browser']
      })
      var provider = providers.forName('oculus', 'SER1', {
        session: session
      , browserPackage: 'com.custom.browser'
      })

      expect(provider.browserCandidates()).to.deep.equal(['com.custom.browser'])
      return provider.detectBrowser().then(function(browser) {
        expect(browser.chosen).to.equal('com.custom.browser')
      })
    })

    it('uses the samsung candidate list for a Galaxy XR on the generic provider', function() {
      var session = fakeSession({
        props: GALAXY_PROPS
      , packages: ['com.sec.android.app.sbrowser']
      })

      return providers.forDevice('SER1', {session: session})
        .then(function(provider) {
          return provider.detectBrowser()
        })
        .then(function(browser) {
          expect(browser.candidates).to.deep.equal([
            'com.android.chrome'
          , 'com.sec.android.app.sbrowser'
          , 'com.chrome.beta'
          , 'com.google.android.apps.chrome'
          ])
          expect(browser.chosen).to.equal('com.sec.android.app.sbrowser')
          expect(browser.engine).to.equal('blink')
        })
    })
  })

  describe('describe() and capabilities()', function() {
    it('describes a Quest 2 with full CDP capabilities', function() {
      var session = fakeSession({
        props: QUEST2_PROPS
      , packages: ['com.oculus.browser']
      , versions: {'com.oculus.browser': '33.0'}
      })

      return providers.forDevice('SER1', {session: session})
        .then(function(provider) {
          return provider.describe()
        })
        .then(function(description) {
          expect(description.serial).to.equal('SER1')
          expect(description.provider).to.equal('oculus')
          expect(description.classification.displayName).to.equal('Quest 2')
          expect(description.classification.confidence).to.equal('high')
          expect(description.isXrHeadset).to.equal(true)
          expect(description.browser.chosen).to.equal('com.oculus.browser')
          expect(description.capabilities.webxr).to.equal(true)
          expect(description.capabilities.openxr).to.equal(true)
          expect(description.capabilities.cdp).to.equal(true)
          expect(description.capabilities.tracking).to.equal('6dof')
        })
    })

    it('forces openxr false for the Oculus Go', function() {
      var session = fakeSession({
        props: GO_PROPS
      , packages: ['com.oculus.browser']
      })

      return providers.forDevice('SER1', {session: session})
        .then(function(provider) {
          expect(provider).to.be.an.instanceof(OculusProvider)
          return provider.describe()
        })
        .then(function(description) {
          expect(description.classification.modelId).to.equal('oculus-go')
          expect(description.capabilities.openxr).to.equal(false)
          expect(description.capabilities.webxr).to.equal(true)
          expect(description.capabilities.cdp).to.equal(true)
        })
    })

    it('reports gecko/no-CDP capabilities for a Vive XR Elite', function() {
      var session = fakeSession({
        props: VIVE_PROPS
      , packages: ['com.igalia.wolvic']
      })

      return providers.forDevice('SER1', {session: session})
        .then(function(provider) {
          expect(provider.name).to.equal('generic')
          return provider.describe()
        })
        .then(function(description) {
          expect(description.classification.vendorId).to.equal('htc')
          expect(description.classification.modelId).to.equal('vive-xr-elite')
          expect(description.browser.chosen).to.equal('com.igalia.wolvic')
          expect(description.browser.engine).to.equal('gecko')
          expect(description.browser.devtoolsSocket).to.equal(null)
          expect(description.capabilities.cdp).to.equal(false)
          expect(description.capabilities.geckoHint).to.equal(120)
        })
    })
  })

  describe('chrome()', function() {
    it('rejects for Gecko-based browsers with an ADB hint', function() {
      var session = fakeSession({
        props: VIVE_PROPS
      , packages: ['com.igalia.wolvic']
      })

      return providers.forDevice('SER1', {session: session})
        .then(function(provider) {
          return provider.chrome()
        })
        .then(function() {
          throw new Error('expected a rejection')
        }, function(err) {
          expect(err.message).to.contain('Gecko-based')
          expect(err.message).to.contain('stf xr tap')
        })
    })

    it('builds a controller against the detected blink browser', function() {
      var session = fakeSession({
        props: QUEST2_PROPS
      , packages: ['com.oculus.browser']
      })
      var provider = providers.forName('oculus', 'SER1', {session: session})

      return provider.chrome().then(function(controller) {
        expect(controller.browserPackage).to.equal('com.oculus.browser')
        expect(controller.devtoolsSocket).to.equal('localabstract:chrome_devtools_remote')
        expect(controller.session).to.equal(session)
      })
    })
  })

  describe('misc provider behavior', function() {
    it('resolves ensureAwake() even when the keyevent fails', function() {
      var session = fakeSession({props: QUEST2_PROPS, keyeventFails: true})
      var provider = providers.forName('oculus', 'SER1', {session: session})

      return provider.ensureAwake().then(function(outcome) {
        expect(outcome.ok).to.equal(false)
        expect(outcome.error).to.contain('input service not ready')
      })
    })

    it('flags cdp: false in openUrl results for gecko browsers', function() {
      var session = fakeSession({
        props: VIVE_PROPS
      , packages: ['com.igalia.wolvic']
      })

      return providers.forDevice('SER1', {session: session})
        .then(function(provider) {
          return provider.openUrl('https://example.com')
        })
        .then(function(outcome) {
          expect(outcome.browserPackage).to.equal('com.igalia.wolvic')
          expect(outcome.cdp).to.equal(false)
        })
    })

    it('broadcasts the oculus proximity sensor workaround', function() {
      var session = fakeSession({props: QUEST2_PROPS})
      var provider = providers.forName('oculus', 'SER1', {session: session})

      return provider.disableProximitySensor().then(function(outcome) {
        expect(outcome.ok).to.equal(true)
        expect(session.calls[0]).to.deep.equal([
          'shell', ['am', 'broadcast', '-a', 'com.oculus.vrpowermanager.prox_close']
        ])
      })
    })
  })
})
