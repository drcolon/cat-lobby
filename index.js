var http = require('http')

var HttpHashRouter = require('http-hash-router')
var catNames = require('cat-names')
var concat = require('concat-stream')
var pumpify = require('pumpify')
var ssejson = require('ssejson')
var duplex = require('duplexify')
var corsify = require('corsify')
var debug = require('debug')('cat-lobby')

var limitStream = require('./limit-stream.js')

module.exports = function create (lobbyOpts) {
  if (!lobbyOpts) lobbyOpts = {}

  var router = HttpHashRouter()
  
  var pings = {}
  var pongs = {}
  var timeouts = []

  router.set('/ping', function ping (req, res, opts, cb) {
    if (req.method !== 'POST') {
      var err = new Error('Only POST is allowed')
      err.statusCode = 405
      return cb(err)
    }
  
    var uploader = uploadStream(function uploaded (buff) {
      var ping = makeName()
      debug('ping upload', {length: buff.length, name: ping})
      pings[ping] = buff
      pongs[ping] = ssejson.serialize({})
      var tId = setTimeout(function expire () {
        delete pings[ping]
        delete pongs[ping]
      }, 1000 * 60 * 30) // 30 mins
      timeouts.push(tId)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({name: ping}))
    })
  

    pumpify(req, uploader).on('error', cb)
  })

  router.set('/pong/:name', function ping (req, res, opts, cb) {
    if (req.method !== 'POST') {
      var err = new Error('Only POST is allowed')
      err.statusCode = 405
      return cb(err)
    }
  
    var pong = opts.params.name
  
    if (!pongs[pong]) {
      var err = new Error('Doesnt exist or expired')
      err.statusCode = 404
      return cb(err)
    }
  
    var uploader = uploadStream(function uploaded (buff) {
      debug('pong upload', {length: buff.length, name: pong})
      pongs[pong].write(buff.toString())
      pongs[pong].end()
      res.setHeader('content-type', 'application/json')
      res.end()
    })
  
    pumpify(req, uploader).on('error', cb)
  })

  router.set('/ping/:name', function room (req, res, opts, cb) {
    var ping = pings[opts.params.name]
    if (!ping) {
      var err = new Error('Doesnt exist or expired')
      err.statusCode = 404
      return cb(err)
    }
    debug('ping get', {name: opts.params.name})
    pongs[ping].write({pingAccessed: true})
    res.end(ping)
    cb()
  })

  router.set('/pongs/:name', function room (req, res, opts, cb) {
    var pong = pongs[opts.params.name]
    if (!pong) {
      var err = new Error('Doesnt exist or expired')
      err.statusCode = 404
      return cb(err)
    }
    res.setHeader('content-type', 'text/event-stream')
    var readable = duplex()
    readable.setReadable(pong)
    pumpify(readable, res).on('error', cb)
    debug('pong subscribe', {name: opts.params.name})
  })

  var cors = corsify({
    "Access-Control-Allow-Methods": "POST, GET"
  })
  
  var server = http.createServer(corsify(handler))
  
  function handler (req, res) {
    router(req, res, {}, onError)

    function onError (err) {
      if (err) {
        debug('error', {path: req.url, message: err.message})
        res.statusCode = err.statusCode || 500
        res.end(err.message)
      }
    }
  }

  server.on('close', function closed () {
    // to prevent process from hanging open
    timeouts.forEach(function each (t) {
      clearTimeout(t)
    })
  })
  
  return server
  
  function uploadStream (cb) {
    var limiter = limitStream(1024 * 5) // 5kb max

    var concatter = concat(function concatted (buff) {
      cb(buff)
    })
  
    return pumpify(limiter, concatter)
  }

  function makeName () {
    var n = [rnd(), rnd(), rnd()].join('-')
    if (pings[n]) return makeName()
    return n
  }

  function rnd () {
    return catNames.random().toLowerCase().replace(/\s/g, '-')
  }  
}
