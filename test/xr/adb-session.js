/* eslint-env mocha */

var fs = require('fs')
var os = require('os')
var path = require('path')

var chai = require('chai')
var Promise = require('bluebird')

var AdbSession = require('../../lib/xr/adb/session')

var expect = chai.expect

var writeFileAsync = Promise.promisify(fs.writeFile)
var readFileAsync = Promise.promisify(fs.readFile)
var mkdtempAsync = Promise.promisify(fs.mkdtemp)

var FAKE_ADB = path.join(__dirname, '..', 'fixt', 'fake-adb.js')

describe('xr/adb/session against fake-adb', function() {
  var tmpDir, logPath, savedFixtureEnv, savedLogEnv
  var counter = 0

  before(function() {
    savedFixtureEnv = process.env.STF_FAKE_ADB_FIXTURE
    savedLogEnv = process.env.STF_FAKE_ADB_LOG
    return mkdtempAsync(path.join(os.tmpdir(), 'stf-xr-fake-adb-')).then(function(dir) {
      tmpDir = dir
    })
  })

  after(function() {
    if (typeof savedFixtureEnv === 'string') {
      process.env.STF_FAKE_ADB_FIXTURE = savedFixtureEnv
    }
    else {
      delete process.env.STF_FAKE_ADB_FIXTURE
    }
    if (typeof savedLogEnv === 'string') {
      process.env.STF_FAKE_ADB_LOG = savedLogEnv
    }
    else {
      delete process.env.STF_FAKE_ADB_LOG
    }
  })

  function useFixture(config) {
    counter += 1
    var fixturePath = path.join(tmpDir, 'fixture-' + counter + '.json')
    logPath = path.join(tmpDir, 'log-' + counter + '.ndjson')
    process.env.STF_FAKE_ADB_FIXTURE = fixturePath
    process.env.STF_FAKE_ADB_LOG = logPath
    return writeFileAsync(fixturePath, JSON.stringify(config))
  }

  function readLog() {
    return readFileAsync(logPath).then(function(data) {
      return data.toString().split('\n').filter(Boolean).map(function(line) {
        return JSON.parse(line)
      })
    })
  }

  function newSession() {
    return new AdbSession('FAKE1', {adb: FAKE_ADB, timeout: 10000})
  }

  it('parses getprop output into a plain object', function() {
    return useFixture({
      props: {
        'ro.product.manufacturer': 'Oculus'
      , 'ro.product.model': 'Quest 2'
      , 'ro.build.characteristics': 'vr'
      , 'ro.build.version.release': '12'
      }
    })
      .then(function() {
        return newSession().getAllProps()
      })
      .then(function(props) {
        expect(props['ro.product.manufacturer']).to.equal('Oculus')
        expect(props['ro.product.model']).to.equal('Quest 2')
        expect(props['ro.build.characteristics']).to.equal('vr')
        expect(props['ro.build.version.release']).to.equal('12')
      })
  })

  it('reads a single prop trimmed', function() {
    return useFixture({props: {'ro.product.model': 'Quest 3'}})
      .then(function() {
        return newSession().getProp('ro.product.model')
      })
      .then(function(value) {
        expect(value).to.equal('Quest 3')
      })
  })

  it('lists installed packages', function() {
    return useFixture({packages: ['com.oculus.browser', 'com.android.settings']})
      .then(function() {
        return newSession().listPackages()
      })
      .then(function(packages) {
        expect(packages).to.deep.equal(['com.oculus.browser', 'com.android.settings'])
      })
  })

  it('finds the first installed package among candidates', function() {
    return useFixture({packages: ['com.pvr.browser', 'com.android.settings']})
      .then(function() {
        return newSession().firstInstalledPackage([
          'com.picovr.browser'
        , 'com.pvr.browser'
        , 'com.bytedance.picobrowser'
        ])
      })
      .then(function(pkg) {
        expect(pkg).to.equal('com.pvr.browser')
      })
  })

  it('resolves null when no candidate is installed, without guessing', function() {
    return useFixture({packages: ['com.android.settings']})
      .then(function() {
        return newSession().firstInstalledPackage(['com.picovr.browser', 'com.pvr.browser'])
      })
      .then(function(pkg) {
        expect(pkg).to.equal(null)
      })
  })

  it('parses versionName from dumpsys package output', function() {
    return useFixture({
      dumpsys: {
        'com.oculus.browser': 'Packages:\n    versionCode=1201 minSdk=29\n    versionName=22.1.0.3'
      }
    })
      .then(function() {
        return newSession().packageVersion('com.oculus.browser')
      })
      .then(function(version) {
        expect(version).to.equal('22.1.0.3')
      })
  })

  it('resolves null when dumpsys has no versionName', function() {
    return useFixture({})
      .then(function() {
        return newSession().packageVersion('com.absent.pkg')
      })
      .then(function(version) {
        expect(version).to.equal(null)
      })
  })

  it('builds the expected am start VIEW invocation for openUrl', function() {
    return useFixture({})
      .then(function() {
        return newSession().openUrl('https://example.com/xr', 'com.oculus.browser')
      })
      .then(readLog)
      .then(function(invocations) {
        expect(invocations).to.have.length(1)
        expect(invocations[0]).to.deep.equal([
          '-s', 'FAKE1', 'shell', 'am', 'start'
        , '-a', 'android.intent.action.VIEW'
        , '-d', 'https://example.com/xr'
        , 'com.oculus.browser'
        ])
      })
  })

  it('omits the package argument when openUrl gets none', function() {
    return useFixture({})
      .then(function() {
        return newSession().openUrl('https://example.com', null)
      })
      .then(readLog)
      .then(function(invocations) {
        var args = invocations[0]
        expect(args[args.length - 1]).to.equal('https://example.com')
      })
  })

  it('uses monkey LAUNCHER resolution when startPackage has no activity', function() {
    return useFixture({})
      .then(function() {
        return newSession().startPackage('com.example.xrapp', null)
      })
      .then(readLog)
      .then(function(invocations) {
        expect(invocations[0]).to.deep.equal([
          '-s', 'FAKE1', 'shell', 'monkey', '-p', 'com.example.xrapp'
        , '-c', 'android.intent.category.LAUNCHER', '1'
        ])
      })
  })

  it('uses am start -n with a package/activity component', function() {
    return useFixture({})
      .then(function() {
        return newSession().startPackage('com.example.xrapp', '.MainActivity')
      })
      .then(readLog)
      .then(function(invocations) {
        expect(invocations[0]).to.deep.equal([
          '-s', 'FAKE1', 'shell', 'am', 'start'
        , '-n', 'com.example.xrapp/.MainActivity'
        ])
      })
  })

  it('reports the adb-allocated port on stdout for forward tcp:0', function() {
    return useFixture({forwardPort: 41123})
      .then(function() {
        return newSession().forward(0, 'localabstract:chrome_devtools_remote')
      })
      .then(function(result) {
        expect(result.stdout.trim()).to.equal('41123')
        return readLog()
      })
      .then(function(invocations) {
        expect(invocations[0]).to.deep.equal([
          '-s', 'FAKE1', 'forward', 'tcp:0', 'localabstract:chrome_devtools_remote'
        ])
      })
  })

  it('waits for a logcat marker and parses the epoch timestamp', function() {
    var line = '1720000000.123  1500  1523 I STF_XR  : STF_XR_READY page loaded'
    return useFixture({logcat: {delayMs: 100, line: line}})
      .then(function() {
        return newSession().waitForLogcatMarker('STF_XR_READY', {timeout: 5000})
      })
      .then(function(hit) {
        expect(hit.marker).to.equal('STF_XR_READY')
        expect(hit.line).to.contain('STF_XR_READY')
        expect(hit.epochMs).to.equal(1720000000123)
        expect(hit.elapsedMs).to.be.a('number')
        expect(hit.elapsedMs).to.be.at.least(50)
      })
  })

  it('resolves epochMs null for lines without an epoch prefix', function() {
    var line = '07-04 12:00:00.000  1500  1523 I STF_XR  : STF_XR_READY'
    return useFixture({logcat: {delayMs: 20, line: line}})
      .then(function() {
        return newSession().waitForLogcatMarker('STF_XR_READY', {
          timeout: 5000
        , filterArgs: ['-v', 'time']
        })
      })
      .then(function(hit) {
        expect(hit.epochMs).to.equal(null)
      })
  })

  it('rejects when a command exceeds its timeout', function() {
    return useFixture({sleepMs: 3000})
      .then(function() {
        return newSession().exec(['shell', 'echo', 'hi'], {timeout: 300})
      })
      .then(function() {
        throw new Error('expected the exec to time out')
      }, function(err) {
        expect(err.message).to.match(/timed out after 300ms/)
      })
  })

  it('rejects on a nonzero exit with the status and stderr', function() {
    return useFixture({exitCode: 7})
      .then(function() {
        return newSession().shell(['pm', 'list', 'packages'])
      })
      .then(function() {
        throw new Error('expected the shell call to fail')
      }, function(err) {
        expect(err.code).to.equal(7)
        expect(err.message).to.contain('status 7')
        expect(err.message).to.contain('fake-adb: forced failure')
      })
  })
})
