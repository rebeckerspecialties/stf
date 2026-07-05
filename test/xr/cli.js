/* eslint-env mocha */

var cp = require('child_process')
var path = require('path')

var chai = require('chai')
var Promise = require('bluebird')

var expect = chai.expect

var CLI = path.join(__dirname, '..', '..', 'lib', 'cli', 'index.js')
var FAKE_ADB = path.join(__dirname, '..', 'fixt', 'fake-adb.js')

function runCli(args, env) {
  return new Promise(function(resolve) {
    var merged = {}
    Object.keys(process.env).forEach(function(key) {
      merged[key] = process.env[key]
    })
    Object.keys(env || {}).forEach(function(key) {
      merged[key] = env[key]
    })

    cp.execFile(process.execPath, [CLI].concat(args), {env: merged},
      function(err, stdout, stderr) {
        resolve({
          code: err && typeof err.code === 'number' ? err.code : 0
        , stdout: String(stdout)
        , stderr: String(stderr)
        })
      })
  })
}

describe('stf xr CLI parsing', function() {
  this.timeout(20000)

  it('lists the xr subcommand family', function() {
    return runCli(['xr', '--help']).then(function(result) {
      expect(result.code).to.equal(0)
      expect(result.stdout).to.contain('devices')
      expect(result.stdout).to.contain('preflight')
      expect(result.stdout).to.contain('webxr-smoke')
      expect(result.stdout).to.contain('ttmfr')
    })
  })

  it('ignores unrelated STF_XR_* environment variables in strict mode', function() {
    // Before the fix, any exported STF_XR_* variable for one subcommand
    // (e.g. STF_XR_URL) made every other subcommand fail with
    // "Unknown argument".
    return runCli(['xr', 'screencap', '--help'], {
      STF_XR_URL: 'https://example.com/xr'
    , STF_XR_SERIAL: 'ENVSERIAL'
    , STF_XR_METHOD: 'logcat-marker'
    }).then(function(result) {
      expect(result.code).to.equal(0)
      expect(result.stdout).to.contain('--out')
      expect(result.stdout + result.stderr).to.not.contain('Unknown argument')
    })
  })

  it('takes the shared serial from STF_XR_SERIAL', function() {
    return runCli(['xr', 'tap', '--x', '10', '--y', '20', '--json'], {
      STF_XR_SERIAL: 'ENVSERIAL'
    , STF_XR_ADB: FAKE_ADB
    }).then(function(result) {
      expect(result.code).to.equal(0)
      var parsed = JSON.parse(result.stdout)
      expect(parsed).to.deep.equal({
        serial: 'ENVSERIAL'
      , action: 'tap'
      , x: 10
      , y: 20
      })
    })
  })
})
