/* eslint-env mocha */

var http = require('http')

var chai = require('chai')
var Promise = require('bluebird')
var WebSocket = require('ws')

var CdpClient = require('../../lib/xr/chrome/cdp-client')

var expect = chai.expect

// A tiny CDP endpoint: /json/version + /json/list over HTTP plus a
// WebSocket server that understands a few canned test methods.
function startCdpEndpoint() {
  var harness = {
    port: null
  , sockets: []
  }

  var server = http.createServer(function(req, res) {
    if (req.url === '/json/version') {
      res.writeHead(200, {'Content-Type': 'application/json'})
      res.end(JSON.stringify({
        Browser: 'Chrome/98.0.4758.107'
      , 'Protocol-Version': '1.3'
      }))
    }
    else if (req.url === '/json/list') {
      res.writeHead(200, {'Content-Type': 'application/json'})
      res.end(JSON.stringify([{
        id: 'page-1'
      , type: 'page'
      , url: 'https://example.com/xr'
      , webSocketDebuggerUrl: 'ws://127.0.0.1:' + harness.port + '/devtools/page/page-1'
      }]))
    }
    else {
      res.writeHead(404)
      res.end()
    }
  })

  var wss = new WebSocket.Server({server: server})

  wss.on('connection', function(ws) {
    harness.sockets.push(ws)
    ws.on('message', function(data) {
      var message = JSON.parse(data)
      if (message.method === 'Echo.echo') {
        ws.send(JSON.stringify({
          id: message.id
        , result: {method: message.method, params: message.params}
        }))
      }
      else if (message.method === 'Error.missing') {
        ws.send(JSON.stringify({
          id: message.id
        , error: {code: -32601, message: '\'Error.missing\' wasn\'t found', data: 'Error.missing'}
        }))
      }
      else if (message.method === 'Emit.custom') {
        ws.send(JSON.stringify({
          method: 'Custom.thing'
        , params: {hello: 'world'}
        }))
        ws.send(JSON.stringify({id: message.id, result: {}}))
      }
      else if (message.method === 'Emit.garbage') {
        ws.send('this is not JSON {')
        ws.send(JSON.stringify({id: message.id, result: {}}))
      }
      else if (message.method === 'Hang.close') {
        ws.close()
      }
      else if (message.method === 'Hang.badframe') {
        // Write a protocol-violating frame (RSV1 set without a negotiated
        // extension) straight to the raw socket so the CLIENT ws emits
        // 'error' after the connection is established.
        ws._socket.write(Buffer.from([0xc1, 0x00]))
      }
      else {
        ws.send(JSON.stringify({id: message.id, result: {}}))
      }
    })
  })

  harness.close = function() {
    return new Promise(function(resolve) {
      harness.sockets.forEach(function(socket) {
        socket.terminate()
      })
      wss.close(function() {
        server.close(function() {
          resolve(null)
        })
      })
    })
  }

  return new Promise(function(resolve) {
    server.listen(0, '127.0.0.1', function() {
      harness.port = server.address().port
      resolve(harness)
    })
  })
}

// A raw HTTP server answering every request with a fixed status and body,
// for the non-200 and invalid-JSON error paths.
function startRawServer(statusCode, body) {
  var server = http.createServer(function(req, res) {
    res.writeHead(statusCode, {'Content-Type': 'application/json'})
    res.end(body)
  })

  return new Promise(function(resolve) {
    server.listen(0, '127.0.0.1', function() {
      resolve({
        port: server.address().port
      , close: function() {
          return new Promise(function(done) {
            server.close(function() {
              done(null)
            })
          })
        }
      })
    })
  })
}

describe('xr/chrome/cdp-client', function() {
  var harness

  before(function() {
    return startCdpEndpoint().then(function(started) {
      harness = started
    })
  })

  after(function() {
    return harness.close()
  })

  describe('HTTP endpoints', function() {
    it('fetches and parses /json/version', function() {
      return CdpClient.version(harness.port).then(function(version) {
        expect(version.Browser).to.match(/^Chrome\/98\./)
        expect(version['Protocol-Version']).to.equal('1.3')
      })
    })

    it('fetches and parses /json/list', function() {
      return CdpClient.targets(harness.port).then(function(targets) {
        expect(targets).to.have.length(1)
        expect(targets[0].type).to.equal('page')
        expect(targets[0].webSocketDebuggerUrl).to.contain(String(harness.port))
      })
    })

    it('rejects on a non-200 response', function() {
      var raw
      return startRawServer(500, '{}')
        .then(function(started) {
          raw = started
          return CdpClient.version(raw.port)
        })
        .then(function() {
          throw new Error('expected a rejection')
        }, function(err) {
          expect(err.message).to.contain('HTTP 500')
          return raw.close()
        })
    })

    it('rejects on invalid JSON', function() {
      var raw
      return startRawServer(200, 'definitely not json')
        .then(function(started) {
          raw = started
          return CdpClient.targets(raw.port)
        })
        .then(function() {
          throw new Error('expected a rejection')
        }, function(err) {
          expect(err.message).to.contain('Invalid JSON')
          return raw.close()
        })
    })
  })

  describe('pickTarget()', function() {
    var page = {type: 'page', url: 'https://a.test/', webSocketDebuggerUrl: 'ws://x/a'}
    var iframe = {type: 'iframe', url: 'https://b.test/', webSocketDebuggerUrl: 'ws://x/b'}
    var noSocket = {type: 'page', url: 'https://c.test/'}

    it('prefers debuggable page targets', function() {
      expect(CdpClient.pickTarget([iframe, page])).to.equal(page)
    })

    it('falls back to any target with a debugger url', function() {
      expect(CdpClient.pickTarget([noSocket, iframe])).to.equal(iframe)
    })

    it('honors a urlPattern', function() {
      expect(CdpClient.pickTarget([page, iframe], {urlPattern: 'b\\.test'})).to.equal(iframe)
    })

    it('honors a predicate over everything else', function() {
      var picked = CdpClient.pickTarget([page, iframe], {
        predicate: function(target) {
          return target.type === 'iframe'
        }
      })
      expect(picked).to.equal(iframe)
    })

    it('returns undefined for an empty list', function() {
      expect(typeof CdpClient.pickTarget([])).to.equal('undefined')
    })
  })

  describe('WebSocket protocol', function() {
    var client

    beforeEach(function() {
      return CdpClient.connectToPort(harness.port).then(function(connected) {
        client = connected
      })
    })

    afterEach(function() {
      if (client) {
        client.close()
        client = null
      }
    })

    it('connects to the picked target and reports it', function() {
      expect(client.isConnected()).to.equal(true)
      expect(client.target.id).to.equal('page-1')
      expect(client.target.url).to.equal('https://example.com/xr')
    })

    it('sends a command and resolves the result', function() {
      return client.send('Echo.echo', {x: 1, nested: {y: 2}}).then(function(result) {
        expect(result).to.deep.equal({
          method: 'Echo.echo'
        , params: {x: 1, nested: {y: 2}}
        })
      })
    })

    it('rejects CDP protocol errors with code and data', function() {
      return client.send('Error.missing').then(function() {
        throw new Error('expected a rejection')
      }, function(err) {
        expect(err.code).to.equal(-32601)
        expect(err.data).to.equal('Error.missing')
        expect(err.message).to.contain('wasn\'t found')
      })
    })

    it('emits CDP events by method name and via the event channel', function() {
      var byName = new Promise(function(resolve) {
        client.once('Custom.thing', resolve)
      })
      var generic = new Promise(function(resolve) {
        client.once('event', function(method, params) {
          resolve({method: method, params: params})
        })
      })

      return client.send('Emit.custom')
        .then(function() {
          return Promise.all([byName, generic])
        })
        .then(function(seen) {
          expect(seen[0]).to.deep.equal({hello: 'world'})
          expect(seen[1].method).to.equal('Custom.thing')
          expect(seen[1].params).to.deep.equal({hello: 'world'})
        })
    })

    it('emits malformed for non-JSON frames', function() {
      var malformed = new Promise(function(resolve) {
        client.once('malformed', function(data) {
          resolve(String(data))
        })
      })

      return client.send('Emit.garbage')
        .then(function() {
          return malformed
        })
        .then(function(data) {
          expect(data).to.contain('not JSON')
        })
    })

    it('rejects pending commands when the socket closes', function() {
      var closed = new Promise(function(resolve) {
        client.once('close', function() {
          resolve(null)
        })
      })

      return client.send('Hang.close', {}, {timeout: 5000})
        .then(function() {
          throw new Error('expected a rejection')
        }, function(err) {
          expect(err.message).to.match(/socket closed before response/)
          return closed
        })
    })

    it('rejects in-flight commands on a post-connect socket error ' +
        'instead of crashing the process', function() {
      // No 'error' listener is attached on purpose: before the fix this
      // scenario threw an unhandled 'error' event and killed the process.
      return client.send('Hang.badframe', {}, {timeout: 5000})
        .then(function() {
          throw new Error('expected a rejection')
        }, function(err) {
          expect(err.message).to.match(/before response to #/)
          expect(client.isConnected()).to.equal(false)
        })
    })
  })
})
