#!/usr/bin/env node
'use strict'

// Minimal fake `adb` binary for the XR test suite. Dumb pattern matching
// over the argument shapes lib/xr/adb/session.js produces; behavior is
// driven by two environment variables:
//   STF_FAKE_ADB_LOG      append each invocation's argv as one JSON line
//   STF_FAKE_ADB_FIXTURE  path to a JSON config:
//     {props: {...}, packages: [...], dumpsys: {key: 'text'},
//      forwardPort: 41123, logcat: {delayMs, line}, sleepMs, exitCode}
// Unknown commands exit 0 with empty output.

var fs = require('fs')

var argv = process.argv.slice(2)

function output(text) {
  if (text) {
    process.stdout.write(text)
  }
}

function appendLog(done) {
  var file = process.env.STF_FAKE_ADB_LOG
  if (!file) {
    done()
  }
  else {
    fs.appendFile(file, JSON.stringify(argv) + '\n', function() {
      done()
    })
  }
}

function loadFixture(done) {
  var file = process.env.STF_FAKE_ADB_FIXTURE
  if (!file) {
    done({})
  }
  else {
    fs.readFile(file, function(err, data) {
      var fixture = {}
      if (!err) {
        try {
          fixture = JSON.parse(data.toString())
        }
        catch (parseErr) {
          fixture = {}
        }
      }
      done(fixture)
    })
  }
}

function stripSerial(args) {
  if (args[0] === '-s') {
    return args.slice(2)
  }
  return args
}

function propsDump(props) {
  return Object.keys(props).map(function(key) {
    return '[' + key + ']: [' + props[key] + ']'
  }).join('\n') + '\n'
}

function runShell(rest, fixture) {
  var cmd = rest[0]

  if (cmd === 'getprop') {
    var props = fixture.props || {}
    if (rest.length > 1) {
      output((props[rest[1]] || '') + '\n')
    }
    else {
      output(propsDump(props))
    }
  }
  else if (cmd === 'pm' && rest[1] === 'list' && rest[2] === 'packages') {
    var packages = fixture.packages || []
    output(packages.map(function(pkg) {
      return 'package:' + pkg
    }).join('\n') + '\n')
  }
  else if (cmd === 'dumpsys') {
    var dumpsys = fixture.dumpsys || {}
    var key = rest[1] === 'package' ? rest[2] : rest[1]
    output((dumpsys[key] || '') + '\n')
  }

  // Everything else (am, input, monkey, mkdir, rm, ...) succeeds silently.
}

function runLogcat(rest, fixture) {
  var spec = fixture.logcat

  if (rest[0] === '-c' || !spec) {
    return
  }

  setTimeout(function() {
    output((spec.line || '') + '\n')
  }, spec.delayMs || 0)

  // Stay alive like the real streaming logcat; the caller kills us.
  setTimeout(function() {}, 60000)
}

function dispatch(fixture) {
  var rest = stripSerial(argv)
  var cmd = rest[0]

  if (typeof fixture.exitCode === 'number' && fixture.exitCode !== 0) {
    process.stderr.write('fake-adb: forced failure\n')
    process.exitCode = fixture.exitCode
  }
  else if (cmd === 'shell') {
    runShell(rest.slice(1), fixture)
  }
  else if (cmd === 'exec-out') {
    runShell(rest.slice(1), fixture)
  }
  else if (cmd === 'forward') {
    if (rest[1] === 'tcp:0' && fixture.forwardPort) {
      output(String(fixture.forwardPort) + '\n')
    }
  }
  else if (cmd === 'logcat') {
    runLogcat(rest.slice(1), fixture)
  }

  // Anything else: exit 0 with empty output.
}

appendLog(function() {
  loadFixture(function(fixture) {
    setTimeout(function() {
      dispatch(fixture)
    }, fixture.sleepMs || 0)
  })
})
