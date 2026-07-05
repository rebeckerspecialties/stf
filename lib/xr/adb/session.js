'use strict'

var cp = require('child_process')
var fs = require('fs')
var path = require('path')

var Promise = require('bluebird')

function normalizeArgs(args) {
  if (!Array.isArray(args)) {
    throw new TypeError('ADB arguments must be an array')
  }

  return args.map(function(arg) {
    if (arg === null || typeof arg === 'undefined') {
      return ''
    }
    return String(arg)
  })
}

var SAFE_SHELL_ARG = /^[A-Za-z0-9_.,:/=+@%-]+$/

// The adb client joins `shell` arguments into one string that the DEVICE
// shell re-parses, so metacharacters (&, ;, quotes, parens — common in
// URLs) must be quoted or they execute remotely. Single-quote anything
// that is not obviously safe.
function quoteShellArg(arg) {
  var value = arg === null || typeof arg === 'undefined' ? '' : String(arg)
  if (SAFE_SHELL_ARG.test(value)) {
    return value
  }
  return '\'' + value.replace(/'/g, '\'\\\'\'') + '\''
}

function AdbSession(serial, options) {
  var opts = options || {}

  if (!serial) {
    throw new Error('A device serial is required')
  }

  this.serial = serial
  this.adb = opts.adb || process.env.ADB || 'adb'
  this.defaultTimeout = opts.timeout || 30000
}

AdbSession.prototype.exec = function(args, options) {
  var opts = options || {}
  var argv = normalizeArgs(args)
  var fullArgs = ['-s', this.serial].concat(argv)
  var adb = this.adb
  var timeout = opts.timeout || this.defaultTimeout

  return new Promise(function(resolve, reject) {
    var proc = cp.spawn(adb, fullArgs, {
      cwd: opts.cwd || process.cwd()
    , env: opts.env || process.env
    })
    var stdout = []
    var stderr = []
    var timer = null

    if (timeout > 0) {
      timer = setTimeout(function() {
        proc.kill('SIGKILL')
        reject(new Error('adb ' + fullArgs.join(' ') + ' timed out after ' + timeout + 'ms'))
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
      reject(err)
    })

    proc.on('close', function(code, signal) {
      if (timer) {
        clearTimeout(timer)
      }

      var out = Buffer.concat(stdout).toString()
      var err = Buffer.concat(stderr).toString()

      if (code === 0 && !signal) {
        resolve({
          stdout: out
        , stderr: err
        , code: code
        })
      }
      else {
        var failure = new Error(
          'adb ' + fullArgs.join(' ') + ' failed with ' +
          (signal ? 'signal ' + signal : 'status ' + code) +
          (err ? ': ' + err.trim() : '')
        )
        failure.stdout = out
        failure.stderr = err
        failure.code = code
        failure.signal = signal
        reject(failure)
      }
    })
  })
}

AdbSession.prototype.execOutToFile = function(args, destination, options) {
  var opts = options || {}
  var argv = normalizeArgs(args)
  var fullArgs = ['-s', this.serial].concat(argv)
  var adb = this.adb
  var timeout = opts.timeout || this.defaultTimeout
  var outPath = path.resolve(destination)

  return new Promise(function(resolve, reject) {
    var proc = cp.spawn(adb, fullArgs)
    var stream = fs.createWriteStream(outPath)
    var stderr = []
    var timer = null
    var settled = false

    function done(err) {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearTimeout(timer)
      }

      // Stop feeding the stream first so late stdout flushes cannot cause
      // a write-after-end crash.
      proc.stdout.unpipe(stream)

      if (err) {
        stream.destroy()
        reject(err)
        return
      }

      // If the lazy file open failed, 'finish' never fires; the stream
      // error listener below settles the promise instead (settling a
      // promise twice is a harmless no-op).
      stream.end(function() {
        resolve(outPath)
      })
    }

    if (timeout > 0) {
      timer = setTimeout(function() {
        proc.kill('SIGKILL')
        done(new Error('adb ' + fullArgs.join(' ') + ' timed out after ' + timeout + 'ms'))
      }, timeout)
    }

    // Without this an ENOENT/EACCES/ENOSPC on the destination is an
    // unhandled 'error' event that kills the process instead of rejecting.
    stream.on('error', function(streamErr) {
      if (settled) {
        reject(streamErr)
      }
      else {
        done(streamErr)
      }
    })

    proc.stdout.pipe(stream)
    proc.stderr.on('data', function(data) {
      stderr.push(data)
    })
    proc.on('error', done)
    proc.on('close', function(code, signal) {
      if (code === 0 && !signal) {
        done()
      }
      else {
        done(new Error(
          'adb ' + fullArgs.join(' ') + ' failed: ' +
          (signal || code) + ' ' + Buffer.concat(stderr).toString().trim()
        ))
      }
    })
  })
}

AdbSession.prototype.shell = function(args, options) {
  if (Array.isArray(args)) {
    return this.exec(['shell'].concat(args.map(quoteShellArg)), options)
  }

  // The string form is a raw escape hatch: the caller does its own quoting.
  return this.exec(['shell', String(args)], options)
}

AdbSession.prototype.getProp = function(prop) {
  return this.shell(['getprop', prop]).then(function(result) {
    return result.stdout.trim()
  })
}

AdbSession.prototype.getAllProps = function() {
  return this.shell(['getprop']).then(function(result) {
    var props = Object.create(null)
    var re = /^\[([^\]]+)\]:\s*\[([^\]]*)\]/
    result.stdout.split(/\r?\n/).forEach(function(line) {
      var match = re.exec(line.trim())
      if (match) {
        props[match[1]] = match[2]
      }
    })
    return props
  })
}

AdbSession.prototype.listPackages = function() {
  return this.shell(['pm', 'list', 'packages']).then(function(result) {
    return result.stdout.split(/\r?\n/)
      .map(function(line) {
        return line.replace(/^package:/, '').trim()
      })
      .filter(Boolean)
  })
}

AdbSession.prototype.packageExists = function(packageName) {
  var wanted = String(packageName)
  return this.listPackages().then(function(packages) {
    return packages.indexOf(wanted) !== -1
  })
}

AdbSession.prototype.firstInstalledPackage = function(candidates) {
  var wanted = candidates || []
  return this.listPackages().then(function(packages) {
    for (var i = 0; i < wanted.length; ++i) {
      if (packages.indexOf(wanted[i]) !== -1) {
        return wanted[i]
      }
    }
    return null
  })
}

AdbSession.prototype.packageVersion = function(packageName) {
  return this.shell(['dumpsys', 'package', packageName]).then(function(result) {
    var match = /versionName=([^\s]+)/.exec(result.stdout)
    return match ? match[1] : null
  })
}

AdbSession.prototype.install = function(apkPath, options) {
  var opts = options || {}
  var args = ['install']
  if (opts.replace !== false) {
    args.push('-r')
  }
  if (opts.allowDowngrade) {
    args.push('-d')
  }
  if (opts.grantRuntimePermissions) {
    args.push('-g')
  }
  args.push(apkPath)
  return this.exec(args, {timeout: opts.timeout || 120000})
}

AdbSession.prototype.uninstall = function(packageName, options) {
  var opts = options || {}
  var args = ['uninstall']
  if (opts.keepData) {
    args.push('-k')
  }
  args.push(packageName)
  return this.exec(args, opts)
}

function pushExtras(args, extras) {
  Object.keys(extras).forEach(function(key) {
    var value = extras[key]
    if (typeof value === 'boolean') {
      args.push('--ez', key, String(value))
    }
    else if (typeof value === 'number' && Math.floor(value) === value) {
      args.push('--ei', key, String(value))
    }
    else if (typeof value === 'number') {
      args.push('--ef', key, String(value))
    }
    else {
      args.push('--es', key, String(value))
    }
  })
}

AdbSession.prototype.startPackage = function(packageName, activity, options) {
  var opts = options || {}

  if (!activity && !opts.action && !opts.data && !opts.extras) {
    // No activity known; let monkey resolve the default LAUNCHER activity.
    return this.shell([
      'monkey', '-p', packageName
    , '-c', 'android.intent.category.LAUNCHER', '1'
    ], opts)
  }

  var args = ['am', 'start']

  if (opts.action) {
    args.push('-a', opts.action)
  }

  if (opts.data) {
    args.push('-d', opts.data)
  }

  if (opts.extras) {
    pushExtras(args, opts.extras)
  }

  if (activity) {
    args.push('-n', activity.indexOf('/') === -1 ?
      packageName + '/' + activity : activity)
  }
  else {
    args.push(packageName)
  }

  return this.shell(args, opts)
}

AdbSession.prototype.openUrl = function(url, packageName, options) {
  var opts = options || {}
  var args = ['am', 'start', '-a', 'android.intent.action.VIEW', '-d', url]
  if (packageName) {
    args.push(packageName)
  }
  return this.shell(args, opts)
}

AdbSession.prototype.forceStop = function(packageName) {
  return this.shell(['am', 'force-stop', packageName])
}

AdbSession.prototype.tap = function(x, y, options) {
  return this.shell(['input', 'tap', Math.round(x), Math.round(y)], options)
}

AdbSession.prototype.swipe = function(x1, y1, x2, y2, durationMs, options) {
  return this.shell([
    'input', 'swipe'
  , Math.round(x1), Math.round(y1)
  , Math.round(x2), Math.round(y2)
  , Math.max(0, Math.round(durationMs || 300))
  ], options)
}

AdbSession.prototype.keyevent = function(keyCode, options) {
  return this.shell(['input', 'keyevent', keyCode], options)
}

AdbSession.prototype.text = function(text, options) {
  return this.shell(['input', 'text', String(text).replace(/\s/g, '%s')], options)
}

AdbSession.prototype.screencap = function(destination, options) {
  return this.execOutToFile(['exec-out', 'screencap', '-p'], destination, options)
}

AdbSession.prototype.screencapRaw = function(destination, options) {
  return this.execOutToFile(['exec-out', 'screencap'], destination, options)
}

AdbSession.prototype.forward = function(hostPort, remote) {
  return this.exec(['forward', 'tcp:' + hostPort, remote])
}

AdbSession.prototype.removeForward = function(hostPort) {
  return this.exec(['forward', '--remove', 'tcp:' + hostPort])
}

AdbSession.prototype.push = function(local, remote, options) {
  return this.exec(['push', local, remote], options)
}

AdbSession.prototype.pull = function(remote, local, options) {
  return this.exec(['pull', remote, local], options)
}

AdbSession.prototype.mkdirp = function(remotePath, options) {
  return this.shell(['mkdir', '-p', remotePath], options)
}

AdbSession.prototype.rm = function(remotePath, options) {
  return this.shell(['rm', '-rf', remotePath], options)
}

AdbSession.prototype.logcatClear = function() {
  return this.exec(['logcat', '-c'])
}

AdbSession.prototype.waitForLogcatMarker = function(marker, options) {
  var opts = options || {}
  var adb = this.adb
  var serial = this.serial
  var timeout = opts.timeout || 30000
  var filterArgs = opts.filterArgs || ['-v', 'epoch']
  var fullArgs = ['-s', serial, 'logcat'].concat(filterArgs)

  return new Promise(function(resolve, reject) {
    var proc = cp.spawn(adb, fullArgs)
    var timer = null
    var buffer = ''
    var start = Date.now()
    var finished = false

    function finish(err, value) {
      if (finished) {
        return
      }
      finished = true
      if (timer) {
        clearTimeout(timer)
      }
      proc.kill('SIGTERM')
      if (err) {
        reject(err)
      }
      else {
        resolve(value)
      }
    }

    timer = setTimeout(function() {
      finish(new Error('Timed out waiting for logcat marker ' + marker))
    }, timeout)

    proc.stdout.on('data', function(data) {
      buffer += data.toString()
      var lines = buffer.split(/\r?\n/)
      buffer = lines.pop()
      lines.some(function(line) {
        if (line.indexOf(marker) !== -1) {
          // With `-v epoch` the line starts with the epoch time in seconds.
          var epochMatch = /^\s*(\d+)\.(\d{3})/.exec(line)
          finish(null, {
            marker: marker
          , line: line
          , elapsedMs: Date.now() - start
          , epochMs: epochMatch ?
              parseInt(epochMatch[1], 10) * 1000 + parseInt(epochMatch[2], 10) : null
          })
          return true
        }
        return false
      })
    })

    proc.on('error', finish)
    proc.on('close', function(code) {
      if (!finished && code !== 0) {
        finish(new Error('logcat exited with status ' + code))
      }
    })
  })
}

module.exports = AdbSession
