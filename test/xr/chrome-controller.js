/* eslint-env mocha */

var http = require('http')

var chai = require('chai')
var Promise = require('bluebird')
var WebSocket = require('ws')

var ChromeController = require('../../lib/xr/chrome/controller')

var expect = chai.expect

// Rule-based CDP server: tests register per-method handlers; everything
// else is acked with an empty result. Handlers get the params and return
// either {result: ...} or {error: {code, message}}.
function startCdpServer() {
  var harness = {
    port: null
  , calls: []
  , handlers: {}
  , sockets: []
  }

  harness.onMethod = function(method, handler) {
    harness.handlers[method] = handler
  }

  harness.callsFor = function(method) {
    return harness.calls.filter(function(call) {
      return call.method === method
    })
  }

  harness.broadcast = function(method, params) {
    harness.sockets.forEach(function(socket) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({method: method, params: params}))
      }
    })
  }

  var server = http.createServer(function(req, res) {
    if (req.url === '/json/version') {
      res.writeHead(200, {'Content-Type': 'application/json'})
      res.end(JSON.stringify({
        Browser: 'Chrome/105.0.5195.68'
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
      harness.calls.push({method: message.method, params: message.params})

      var handler = harness.handlers[message.method]
      var outcome = handler ? handler(message.params) : {result: {}}
      if (outcome && outcome.error) {
        ws.send(JSON.stringify({id: message.id, error: outcome.error}))
      }
      else {
        ws.send(JSON.stringify({id: message.id, result: (outcome && outcome.result) || {}}))
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

function methodNotFound(method) {
  return {
    error: {code: -32601, message: '\'' + method + '\' wasn\'t found'}
  }
}

// AdbSession stand-in: only the methods ChromeController touches, all
// returning bluebird promises and recording their calls.
function fakeSession(forwardStdout) {
  var session = {
    calls: []
  }

  session.forward = function(hostPort, remote) {
    session.calls.push(['forward', hostPort, remote])
    return Promise.resolve({stdout: forwardStdout, stderr: '', code: 0})
  }

  session.removeForward = function(hostPort) {
    session.calls.push(['removeForward', hostPort])
    return Promise.resolve({stdout: '', stderr: '', code: 0})
  }

  session.openUrl = function(url, packageName) {
    session.calls.push(['openUrl', url, packageName])
    return Promise.resolve({stdout: '', stderr: '', code: 0})
  }

  session.forceStop = function(packageName) {
    session.calls.push(['forceStop', packageName])
    return Promise.resolve({stdout: '', stderr: '', code: 0})
  }

  return session
}

describe('xr/chrome/controller', function() {
  describe('forward()', function() {
    it('parses the adb-allocated port and caches it', function() {
      var session = fakeSession('41123\n')
      var controller = new ChromeController(session, {})

      return controller.forward()
        .then(function(port) {
          expect(port).to.equal(41123)
          expect(controller.port).to.equal(41123)
          expect(session.calls).to.deep.equal([
            ['forward', 0, 'localabstract:chrome_devtools_remote']
          ])
          return controller.forward()
        })
        .then(function(port) {
          expect(port).to.equal(41123)
          expect(session.calls).to.have.length(1)
        })
    })

    it('uses an explicit port option without parsing stdout', function() {
      var session = fakeSession('')
      var controller = new ChromeController(session, {port: 9333})

      return controller.forward().then(function(port) {
        expect(port).to.equal(9333)
        expect(session.calls[0][1]).to.equal(9333)
      })
    })

    it('rejects with a --port hint when adb does not print the port', function() {
      var session = fakeSession('')
      var controller = new ChromeController(session, {})

      return controller.forward().then(function() {
        throw new Error('expected a rejection')
      }, function(err) {
        expect(err.message).to.contain('--port')
        expect(controller.port).to.equal(null)
      })
    })

    it('removes the forward again on unforward()', function() {
      var session = fakeSession('41123\n')
      var controller = new ChromeController(session, {})

      return controller.forward()
        .then(function() {
          return controller.unforward()
        })
        .then(function(removed) {
          expect(removed).to.equal(true)
          expect(session.calls[1]).to.deep.equal(['removeForward', 41123])
          expect(controller.port).to.equal(null)
        })
    })
  })

  describe('against a fake CDP endpoint', function() {
    var harness, session, controller

    beforeEach(function() {
      return startCdpServer().then(function(started) {
        harness = started
        session = fakeSession(harness.port + '\n')
        controller = new ChromeController(session, {})
      })
    })

    afterEach(function() {
      return controller.close().then(function() {
        return harness.close()
      })
    })

    it('reads /json/version and parses the Chrome major', function() {
      return controller.version().then(function(version) {
        expect(version.browser).to.equal('Chrome/105.0.5195.68')
        expect(version.chromeMajor).to.equal(105)
        expect(version.protocolVersion).to.equal('1.3')
      })
    })

    it('connects, requires Runtime and feature-detects Page', function() {
      harness.onMethod('Page.enable', function() {
        return methodNotFound('Page.enable')
      })

      return controller.connect().then(function(connected) {
        expect(connected).to.equal(controller)
        expect(controller.capabilities).to.deep.equal({
          runtime: true
        , page: false
        , log: true
        , input: null
        })
        expect(controller.client.target.id).to.equal('page-1')
      })
    })

    it('rejects connect() when Runtime.enable is unsupported', function() {
      harness.onMethod('Runtime.enable', function() {
        return methodNotFound('Runtime.enable')
      })

      return controller.connect({retries: 0}).then(function() {
        throw new Error('expected a rejection')
      }, function(err) {
        expect(err.message).to.contain('Runtime.enable failed')
        expect(controller.client).to.equal(null)
      })
    })

    it('evaluates expressions and resolves the value', function() {
      harness.onMethod('Runtime.evaluate', function() {
        return {result: {result: {type: 'number', value: 42}}}
      })

      return controller.connect()
        .then(function() {
          return controller.evaluate('6 * 7')
        })
        .then(function(value) {
          expect(value).to.equal(42)
          var call = harness.callsFor('Runtime.evaluate')[0]
          expect(call.params.expression).to.equal('6 * 7')
          expect(call.params.awaitPromise).to.equal(true)
          expect(call.params.returnByValue).to.equal(true)
        })
    })

    it('rejects evaluations that raise exceptions', function() {
      harness.onMethod('Runtime.evaluate', function() {
        return {
          result: {
            exceptionDetails: {
              text: 'Uncaught'
            , exception: {description: 'ReferenceError: boom is not defined'}
            }
          }
        }
      })

      return controller.connect()
        .then(function() {
          return controller.evaluate('boom')
        })
        .then(function() {
          throw new Error('expected a rejection')
        }, function(err) {
          expect(err.message).to.contain('Evaluation failed: ReferenceError: boom')
        })
    })

    it('dispatches touchStart + touchEnd for tap()', function() {
      return controller.connect()
        .then(function() {
          return controller.tap(10, 20)
        })
        .then(function() {
          var touches = harness.callsFor('Input.dispatchTouchEvent')
          expect(touches).to.have.length(2)
          expect(touches[0].params.type).to.equal('touchStart')
          expect(touches[0].params.touchPoints).to.deep.equal([{x: 10, y: 20}])
          expect(touches[1].params.type).to.equal('touchEnd')
          expect(touches[1].params.touchPoints).to.deep.equal([])
          expect(controller.capabilities.input).to.equal(true)
        })
    })

    it('marks method-not-found input methods and suggests the ADB fallback', function() {
      harness.onMethod('Input.dispatchTouchEvent', function() {
        return methodNotFound('Input.dispatchTouchEvent')
      })

      return controller.connect()
        .then(function() {
          return controller.tap(10, 20).then(function() {
            throw new Error('expected a rejection')
          }, function(err) {
            expect(err.unsupportedCdpMethod).to.equal('Input.dispatchTouchEvent')
            expect(err.message).to.contain('stf xr tap')
            expect(controller.capabilities.input).to.equal(false)
          })
        })
        .then(function() {
          // A second attempt short-circuits on the unsupported cache
          // without hitting the server again.
          return controller.tap(1, 2).then(function() {
            throw new Error('expected a rejection')
          }, function(err) {
            expect(err.unsupportedCdpMethod).to.equal('Input.dispatchTouchEvent')
            expect(harness.callsFor('Input.dispatchTouchEvent')).to.have.length(1)
          })
        })
    })

    it('falls back to per-char key events when Input.insertText is missing', function() {
      harness.onMethod('Input.insertText', function() {
        return methodNotFound('Input.insertText')
      })

      return controller.connect()
        .then(function() {
          return controller.insertText('hi')
        })
        .then(function(outcome) {
          expect(outcome).to.deep.equal({text: 'hi', via: 'char-events'})
          var chars = harness.callsFor('Input.dispatchKeyEvent')
          expect(chars).to.have.length(2)
          expect(chars[0].params).to.deep.equal({type: 'char', text: 'h'})
          expect(chars[1].params).to.deep.equal({type: 'char', text: 'i'})
        })
    })

    it('navigates via evaluate when Page.navigate is unsupported', function() {
      harness.onMethod('Page.navigate', function() {
        return methodNotFound('Page.navigate')
      })

      return controller.connect()
        .then(function() {
          return controller.navigate('https://example.com/scene')
        })
        .then(function(outcome) {
          expect(outcome.via).to.equal('evaluate')
          expect(outcome.url).to.equal('https://example.com/scene')
          var evaluates = harness.callsFor('Runtime.evaluate')
          expect(evaluates).to.have.length(1)
          expect(evaluates[0].params.expression)
            .to.contain('window.location.href = "https://example.com/scene"')
        })
    })

    it('polls waitForExpression until the expression is truthy', function() {
      var polls = 0
      harness.onMethod('Runtime.evaluate', function(params) {
        if (params.expression.indexOf('window.sceneReady') !== -1) {
          polls += 1
          return {result: {result: {type: 'boolean', value: polls >= 3}}}
        }
        return {result: {result: {type: 'undefined'}}}
      })

      return controller.connect()
        .then(function() {
          return controller.waitForExpression('window.sceneReady', {
            interval: 25
          , timeout: 5000
          })
        })
        .then(function(outcome) {
          expect(outcome.expression).to.equal('window.sceneReady')
          expect(outcome.elapsedMs).to.be.a('number')
          expect(polls).to.be.at.least(3)
        })
    })

    it('resolves waitForConsoleToken from Runtime.consoleAPICalled', function() {
      return controller.connect()
        .then(function() {
          var wait = controller.waitForConsoleToken('STF_XR_READY', {timeout: 5000})
          Promise.delay(50).then(function() {
            harness.broadcast('Runtime.consoleAPICalled', {
              type: 'log'
            , args: [{type: 'string', value: 'boot STF_XR_READY done'}]
            })
          })
          return wait
        })
        .then(function(outcome) {
          expect(outcome.token).to.equal('STF_XR_READY')
          expect(outcome.matchedText).to.equal('boot STF_XR_READY done')
          expect(outcome.elapsedMs).to.be.a('number')
        })
    })

    it('rejects waitForConsoleToken before connect()', function() {
      return controller.waitForConsoleToken('X').then(function() {
        throw new Error('expected a rejection')
      }, function(err) {
        expect(err.message).to.contain('connect()')
      })
    })

    it('parses the checkWebXr() page result', function() {
      harness.onMethod('Runtime.evaluate', function(params) {
        if (params.expression.indexOf('navigator.xr') !== -1) {
          return {
            result: {
              result: {
                type: 'object'
              , value: {webxrAvailable: true, immersiveVrSupported: true, reason: null}
              }
            }
          }
        }
        return {result: {result: {type: 'undefined'}}}
      })

      return controller.connect()
        .then(function() {
          return controller.checkWebXr()
        })
        .then(function(status) {
          expect(status).to.deep.equal({
            webxrAvailable: true
          , immersiveVrSupported: true
          , reason: null
          })
        })
    })

    it('launches a URL with an optional forceStop first', function() {
      var stopper = new ChromeController(session, {browserPackage: 'com.oculus.browser'})

      return stopper.launchUrl('https://example.com/xr', {forceStop: true}).then(function() {
        expect(session.calls).to.deep.equal([
          ['forceStop', 'com.oculus.browser']
        , ['openUrl', 'https://example.com/xr', 'com.oculus.browser']
        ])
      })
    })
  })
})
