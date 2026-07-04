'use strict'

var cp = require('child_process')
var fs = require('fs')
var path = require('path')

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

function AdbSession(serial, options) {
  options = options || {}

  if (!serial) {
    throw new Error('A device serial is required')
  }

  this.serial = serial
  this.adb = options.adb || process.env.ADB || 'adb'
  this.defaultTimeout = options.timeout || 30000
}

AdbSession.prototype.exec = function(args, options) {
  options = options || {}
  args = normalizeArgs(args)

  var fullArgs = ['-s', this.serial].concat(args)
  var adb = this.adb
  var timeout = options.timeout || this.defaultTimeout

  return new Promise(function(resolve, reject) {
    var proc = cp.spawn(adb, fullArgs, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env
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
          stdout: out,
          stderr: err,
          code: code
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
  options = options || {}
  args = normalizeArgs(args)

  var fullArgs = ['-s', this.serial].concat(args)
  var adb = this.adb
  var timeout = options.timeout || this.defaultTimeout
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
      stream.end(function() {
        if (err) {
          reject(err)
        }
        else {
          resolve(outPath)
        }
      })
    }

    if (timeout > 0) {
      timer = setTimeout(function() {
        proc.kill('SIGKILL')
        done(new Error('adb ' + fullArgs.join(' ') + ' timed out after ' + timeout + 'ms'))
      }, timeout)
    }

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
    return this.exec(['shell'].concat(args), options)
  }

  return this.exec(['shell', String(args)], options)
}

AdbSession.prototype.getProp = function(prop) {
  return this.shell(['getprop', prop]).then(function(result) {
    return result.stdout.trim()
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
  candidates = candidates || []

  return this.listPackages().then(function(packages) {
    for (var i = 0; i < candidates.length; ++i) {
      if (packages.indexOf(candidates[i]) !== -1) {
        return candidates[i]
      }
    }

    if (candidates.length) {
      return candidates[0]
    }

    throw new Error('No package candidates supplied')
  }).catch(function(err) {
    if (candidates.length) {
      return candidates[0]
    }
    throw err
  })
}

AdbSession.prototype.packageVersion = function(packageName) {
  return this.shell(['dumpsys', 'package', packageName]).then(function(result) {
    var match = /versionName=([^\s]+)/.exec(result.stdout)
    return match ? match[1] : null
  })
}

AdbSession.prototype.install = function(apkPath, options) {
  options = options || {}
  var args = ['install']
  if (options.replace !== false) {
    args.push('-r')
  }
  if (options.allowDowngrade) {
    args.push('-d')
  }
  if (options.grantRuntimePermissions) {
    args.push('-g')
  }
  args.push(apkPath)
  return this.exec(args, {timeout: options.timeout || 120000})
}

AdbSession.prototype.uninstall = function(packageName, options) {
  options = options || {}
  var args = ['uninstall']
  if (options.keepData) {
    args.push('-k')
  }
  args.push(packageName)
  return this.exec(args, options)
}

AdbSession.prototype.startPackage = function(packageName, activity, options) {
  options = options || {}
  var args = ['shell', 'am', 'start']

  if (options.action) {
    args.push('-a', options.action)
  }

  if (options.data) {
    args.push('-d', options.data)
  }

  if (activity) {
    args.push('-n', packageName + '/' + activity)
  }
  else {
    args.push('-p', packageName)
  }

  if (options.extras) {
    Object.keys(options.extras).forEach(function(key) {
      var value = options.extras[key]
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

  return this.exec(args, options)
}

AdbSession.prototype.openUrl = function(url, packageName, options) {
  options = options || {}
  var args = ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url]
  if (packageName) {
    args.push('-p', packageName)
  }
  return this.exec(args, options)
}

AdbSession.prototype.forceStop = function(packageName) {
  return this.shell(['am', 'force-stop', packageName])
}

AdbSession.prototype.tap = function(x, y, options) {
  return this.shell(['input', 'tap', Math.round(x), Math.round(y)], options)
}

AdbSession.prototype.swipe = function(x1, y1, x2, y2, durationMs, options) {
  return this.shell([
    'input', 'swipe',
    Math.round(x1), Math.round(y1),
    Math.round(x2), Math.round(y2),
    Math.max(0, Math.round(durationMs || 300))
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
  options = options || {}
  var adb = this.adb
  var serial = this.serial
  var timeout = options.timeout || 30000
  var filterArgs = options.filterArgs || ['-v', 'epoch']
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
          finish(null, {
            marker: marker,
            line: line,
            elapsedMs: Date.now() - start
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
