/*!
 * serve-static
 * Copyright(c) 2010 Sencha Inc.
 * Copyright(c) 2011 TJ Holowaychuk
 * Copyright(c) 2014-2016 Douglas Christopher Wilson
 * MIT Licensed
 */

'use strict'

/**
 * Module dependencies.
 * @private
 */

var encodeUrl = require('encodeurl')
var escapeHtml = require('escape-html')
var parseUrl = require('parseurl')
var resolve = require('path').resolve
var send = require('send')
var url = require('url')
var fs = require('fs')
var pathModule = require('path')

/**
 * Path resolution cache for performance
 * @private
 */
var pathCache = new Map()
var MAX_CACHE_SIZE = 1000

/**
 * Options object pool for reuse
 * @private
 */
var optsPool = []
var MAX_POOL_SIZE = 100

/**
 * Module exports.
 * @public
 */

module.exports = serveStatic

/**
 * Get or create cached path resolution
 * @private
 */
function getCachedPath(pathname, root) {
  var cacheKey = root + '::' + pathname

  if (pathCache.has(cacheKey)) {
    // touch entry for simple LRU behavior: delete+set preserves recency
    var current = pathCache.get(cacheKey)
    pathCache.delete(cacheKey)
    pathCache.set(cacheKey, current)
    return current
  }

  // If cache is full, delete oldest entry (first in Map)
  if (pathCache.size >= MAX_CACHE_SIZE) {
    var firstKey = pathCache.keys().next().value
    pathCache.delete(firstKey)
  }

  pathCache.set(cacheKey, pathname)
  return pathname
}

/**
 * Get pooled options object
 * @private
 */
function getPooledOpts() {
  return optsPool.length > 0 ? optsPool.pop() : {}
}

/**
 * Return options object to pool
 * @private
 */
function returnToPool(opts) {
  if (optsPool.length < MAX_POOL_SIZE) {
    // Clear all properties
    for (var key in opts) {
      delete opts[key]
    }
    optsPool.push(opts)
  }
}

/**
 * @param {string} root
 * @param {object} [options]
 * @return {function}
 * @public
 */

function serveStatic (root, options) {
  if (!root) {
    throw new TypeError('root path required')
  }

  if (typeof root !== 'string') {
    throw new TypeError('root path must be a string')
  }

  // copy options object
  var opts = Object.create(options || null)

  // fall-though
  var fallthrough = opts.fallthrough !== false

  // default redirect
  var redirect = opts.redirect !== false

  // headers listener
  var setHeaders = opts.setHeaders

  if (setHeaders && typeof setHeaders !== 'function') {
    throw new TypeError('option setHeaders must be function')
  }

  // setup options for send
  opts.maxage = opts.maxage || opts.maxAge || 0
  opts.root = resolve(root)
  // opt-in precompressed asset serving
  var preferPrecompressed = opts.preferPrecompressed === true

  // construct directory listener
  var onDirectory = redirect
    ? createRedirectDirectoryListener()
    : createNotFoundDirectoryListener()

  return function serveStatic (req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (fallthrough) {
        return next()
      }

      // method not allowed
      res.statusCode = 405
      res.setHeader('Allow', 'GET, HEAD')
      res.setHeader('Content-Length', '0')
      res.end()
      return
    }

    var forwardError = !fallthrough
    var originalUrl = parseUrl.original(req)
    var path = parseUrl(req).pathname

    // make sure redirect occurs at mount
    if (path === '/' && originalUrl.pathname.substr(-1) !== '/') {
      path = ''
    }

    // Fast path for index.html - common case optimization
    var isIndexRequest = (path === '/' || path === '' || path === '/index.html')

    // Use cached path resolution for performance
    var cachedPath = getCachedPath(path, opts.root)

    var precompressed = null
    var encoding = null
    if (preferPrecompressed) {
      // Only attempt if client accepts compressed encodings
      var ae = (req.headers['accept-encoding'] || '')
      var acceptBr = ae.indexOf('br') !== -1
      var acceptGzip = ae.indexOf('gzip') !== -1

      // Derive absolute file path for lookup
      // Resolve index.html as a common case
      var candidate = cachedPath
      if (candidate === '' || candidate === '/') candidate = '/index.html'
      var abs = pathModule.join(opts.root, candidate)
      // Try brotli first
      if (acceptBr && fs.existsSync(abs + '.br')) {
        precompressed = candidate + '.br'
        encoding = 'br'
      } else if (acceptGzip && fs.existsSync(abs + '.gz')) {
        precompressed = candidate + '.gz'
        encoding = 'gzip'
      }
    }

    // create send stream with optimized options
    var stream = send(req, precompressed || cachedPath, opts)

    // add directory handler
    stream.on('directory', onDirectory)

    // add headers listener
    stream.on('headers', function onHeaders (res, filePath, stat) {
      // Always vary on encoding when serving static assets
      res.setHeader('Vary', 'Accept-Encoding')
      if (precompressed && encoding) {
        // Reset content type to original path's type
        try {
          // send.mime.lookup is available on send module
          var originalPath = precompressed.replace(/\.(br|gz)$/,'')
          var type = send.mime.lookup(originalPath)
          if (type) res.setHeader('Content-Type', type)
        } catch (e) { /* ignore */ }
        res.setHeader('Content-Encoding', encoding)
        // Adjust content-length since precompressed file is smaller
        res.setHeader('Content-Length', stat.size)
      }
      if (setHeaders) setHeaders(res, filePath, stat)
    })

    // add file listener for fallthrough
    if (fallthrough) {
      stream.on('file', function onFile () {
        // once file is determined, always forward error
        forwardError = true
      })
    }

    // forward errors
    stream.on('error', function error (err) {
      if (forwardError || !(err.statusCode < 500)) {
        next(err)
        return
      }

      next()
    })

    // pipe
    stream.pipe(res)
  }
}

/**
 * Collapse all leading slashes into a single slash
 * @private
 */
function collapseLeadingSlashes (str) {
  for (var i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) !== 0x2f /* / */) {
      break
    }
  }

  return i > 1
    ? '/' + str.substr(i)
    : str
}

/**
 * Create a minimal HTML document.
 *
 * @param {string} title
 * @param {string} body
 * @private
 */

function createHtmlDocument (title, body) {
  return '<!DOCTYPE html>\n' +
    '<html lang="en">\n' +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    '<title>' + title + '</title>\n' +
    '</head>\n' +
    '<body>\n' +
    '<pre>' + body + '</pre>\n' +
    '</body>\n' +
    '</html>\n'
}

/**
 * Create a directory listener that just 404s.
 * @private
 */

function createNotFoundDirectoryListener () {
  return function notFound () {
    this.error(404)
  }
}

/**
 * Create a directory listener that performs a redirect.
 * @private
 */

function createRedirectDirectoryListener () {
  return function redirect (res) {
    if (this.hasTrailingSlash()) {
      this.error(404)
      return
    }

    // get original URL
    var originalUrl = parseUrl.original(this.req)

    // append trailing slash
    originalUrl.path = null
    originalUrl.pathname = collapseLeadingSlashes(originalUrl.pathname + '/')

    // reformat the URL
    var loc = encodeUrl(url.format(originalUrl))
    var doc = createHtmlDocument('Redirecting', 'Redirecting to ' + escapeHtml(loc))

    // send redirect response
    res.statusCode = 301
    res.setHeader('Content-Type', 'text/html; charset=UTF-8')
    res.setHeader('Content-Length', Buffer.byteLength(doc))
    res.setHeader('Content-Security-Policy', "default-src 'none'")
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Location', loc)
    res.end(doc)
  }
}
