'use strict'

var EventEmitter = require('events').EventEmitter
var http = require('http')
var https = require('https')
var util = require('util')

var Promise = require('bluebird')
var WebSocket = require('ws')

function requestJson(url, timeout) {
  var ms = timeout || 5000
  return new Promise(function(resolve, reject) {
    var lib = /^https:/.test(url) ? https : http
    var req = lib.get(url, function(res) {
      var chunks = []

      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error('HTTP ' + res.statusCode + ' from ' + url))
        return
      }

      res.on('data', function(chunk) {
        chunks.push(chunk)
      })
      res.on('end', function() {
        var body = Buffer.concat(chunks).toString()
        try {
          resolve(JSON.parse(body))
        }
        catch (err) {
          err.message = 'Invalid JSON from ' + url + ': ' + err.message
          reject(err)
        }
      })
    })

    req.setTimeout(ms, function() {
      req.destroy(new Error('Timed out reading ' + url))
    })
    req.on('error', reject)
  })
}

function CdpClient(webSocketDebuggerUrl, options) {
  EventEmitter.call(this)
  this.url = webSocketDebuggerUrl
  this.options = options || {}
  this.ws = null
  this.nextId = 1
  this.pending = Object.create(null)
  this.defaultTimeout = this.options.timeout || 15000
}

util.inherits(CdpClient, EventEmitter)

CdpClient.targets = function(port, host) {
  return requestJson('http://' + (host || '127.0.0.1') + ':' + port + '/json/list')
}

CdpClient.version = function(port, host) {
  return requestJson('http://' + (host || '127.0.0.1') + ':' + port + '/json/version')
}

CdpClient.pickTarget = function(targets, options) {
  var opts = options || {}
  var predicate = opts.predicate
  var urlPattern = opts.urlPattern

  if (predicate) {
    var custom = targets.filter(predicate)[0]
    if (custom) {
      return custom
    }
  }

  if (urlPattern) {
    var re = typeof urlPattern === 'string' ? new RegExp(urlPattern) : urlPattern
    var matched = targets.filter(function(target) {
      return re.test(target.url || '')
    })[0]
    if (matched) {
      return matched
    }
  }

  return targets.filter(function(target) {
    return target.type === 'page' && target.webSocketDebuggerUrl
  })[0] || targets.filter(function(target) {
    return target.webSocketDebuggerUrl
  })[0]
}

CdpClient.connectToPort = function(port, options) {
  var opts = options || {}
  return CdpClient.targets(port, opts.host).then(function(targets) {
    var target = CdpClient.pickTarget(targets, opts)
    if (!target || !target.webSocketDebuggerUrl) {
      throw new Error('No debuggable Chrome page target found on port ' + port)
    }

    var client = new CdpClient(target.webSocketDebuggerUrl, opts)
    client.target = target
    return client.connect().then(function() {
      return client
    })
  })
}

CdpClient.prototype.connect = function() {
  var that = this

  return new Promise(function(resolve, reject) {
    var ws = that.ws = new WebSocket(that.url, {
      handshakeTimeout: that.defaultTimeout
    })
    var settled = false

    function fail(err) {
      if (!settled) {
        settled = true
        reject(err)
        return
      }

      // A socket error after connect must not become an unhandled 'error'
      // event (that would crash the process). Reject in-flight commands;
      // ws emits 'close' right after this, tearing the rest down.
      that._rejectPending(err.message)
      if (that.listenerCount('error') > 0) {
        that.emit('error', err)
      }
    }

    ws.on('open', function() {
      settled = true
      resolve(that)
    })

    ws.on('message', function(data) {
      that._handleMessage(data)
    })

    ws.on('error', fail)
    ws.on('close', function(code, reason) {
      that.emit('close', code, reason)
      that._rejectPending('CDP socket closed')
    })
  })
}

CdpClient.prototype._rejectPending = function(reason) {
  var that = this
  Object.keys(this.pending).forEach(function(id) {
    var pending = that.pending[id]
    delete that.pending[id]
    clearTimeout(pending.timer)
    pending.reject(new Error(reason + ' before response to #' + id))
  })
}

CdpClient.prototype.isConnected = function() {
  return !!this.ws && this.ws.readyState === WebSocket.OPEN
}

CdpClient.prototype._handleMessage = function(data) {
  var message
  try {
    message = JSON.parse(data)
  }
  catch (err) {
    this.emit('malformed', data)
    return
  }

  if (message.id && this.pending[message.id]) {
    var pending = this.pending[message.id]
    clearTimeout(pending.timer)
    delete this.pending[message.id]

    if (message.error) {
      var error = new Error(message.error.message || 'CDP error')
      error.data = message.error.data
      error.code = message.error.code
      pending.reject(error)
    }
    else {
      pending.resolve(message.result || {})
    }
  }
  else if (message.method) {
    this.emit(message.method, message.params || {})
    this.emit('event', message.method, message.params || {})
  }
}

CdpClient.prototype.send = function(method, params, options) {
  var opts = options || {}
  var that = this
  var id = this.nextId++
  var timeout = opts.timeout || this.defaultTimeout

  if (!this.isConnected()) {
    return Promise.reject(new Error('CDP socket is not open'))
  }

  return new Promise(function(resolve, reject) {
    var timer = setTimeout(function() {
      delete that.pending[id]
      reject(new Error('Timed out waiting for CDP ' + method + ' response'))
    }, timeout)

    that.pending[id] = {
      resolve: resolve
    , reject: reject
    , timer: timer
    , method: method
    }

    that.ws.send(JSON.stringify({
      id: id
    , method: method
    , params: params || {}
    }), function(err) {
      if (err) {
        clearTimeout(timer)
        delete that.pending[id]
        reject(err)
      }
    })
  })
}

CdpClient.prototype.close = function() {
  if (this.ws) {
    this.ws.close()
  }
}

module.exports = CdpClient
