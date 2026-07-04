'use strict'

var EventEmitter = require('events').EventEmitter
var http = require('http')
var https = require('https')
var util = require('util')
var WebSocket = require('ws')

function requestJson(url, timeout) {
  timeout = timeout || 5000
  return new Promise(function(resolve, reject) {
    var lib = /^https:/.test(url) ? https : http
    var req = lib.get(url, function(res) {
      var chunks = []
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

    req.setTimeout(timeout, function() {
      req.abort()
      reject(new Error('Timed out reading ' + url))
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
  host = host || '127.0.0.1'
  return requestJson('http://' + host + ':' + port + '/json/list')
}

CdpClient.version = function(port, host) {
  host = host || '127.0.0.1'
  return requestJson('http://' + host + ':' + port + '/json/version')
}

CdpClient.pickTarget = function(targets, options) {
  options = options || {}
  var predicate = options.predicate
  var urlPattern = options.urlPattern

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
  options = options || {}
  return CdpClient.targets(port, options.host).then(function(targets) {
    var target = CdpClient.pickTarget(targets, options)
    if (!target || !target.webSocketDebuggerUrl) {
      throw new Error('No debuggable Chrome page target found on port ' + port)
    }

    var client = new CdpClient(target.webSocketDebuggerUrl, options)
    client.target = target
    return client.connect().then(function() {
      return client
    })
  })
}

CdpClient.prototype.connect = function() {
  var self = this

  return new Promise(function(resolve, reject) {
    var ws = self.ws = new WebSocket(self.url)
    var settled = false

    function fail(err) {
      if (!settled) {
        settled = true
        reject(err)
      }
      else {
        self.emit('error', err)
      }
    }

    ws.on('open', function() {
      settled = true
      resolve(self)
    })

    ws.on('message', function(data) {
      self._handleMessage(data)
    })

    ws.on('error', fail)
    ws.on('close', function(code, reason) {
      self.emit('close', code, reason)
      Object.keys(self.pending).forEach(function(id) {
        self.pending[id].reject(new Error('CDP socket closed before response to #' + id))
        delete self.pending[id]
      })
    })
  })
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
  options = options || {}
  params = params || {}

  var self = this
  var id = this.nextId++
  var timeout = options.timeout || this.defaultTimeout

  if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('CDP socket is not open'))
  }

  return new Promise(function(resolve, reject) {
    var timer = setTimeout(function() {
      delete self.pending[id]
      reject(new Error('Timed out waiting for CDP ' + method + ' response'))
    }, timeout)

    self.pending[id] = {
      resolve: resolve,
      reject: reject,
      timer: timer,
      method: method
    }

    self.ws.send(JSON.stringify({
      id: id,
      method: method,
      params: params
    }), function(err) {
      if (err) {
        clearTimeout(timer)
        delete self.pending[id]
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
