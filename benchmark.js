/*!
 * serve-static benchmark
 * Comprehensive benchmark for static file serving performance
 */

'use strict'

var http = require('http')
var serveStatic = require('./index.js')
var path = require('path')
var fs = require('fs')

// Create test directory and files
var testDir = path.join(__dirname, 'benchmark-files')
if (!fs.existsSync(testDir)) {
  fs.mkdirSync(testDir)
  // Create test files
  fs.writeFileSync(path.join(testDir, 'index.html'), '<html><body>Index</body></html>')
  fs.writeFileSync(path.join(testDir, 'test.txt'), 'Test file content')
  fs.writeFileSync(path.join(testDir, 'large.html'), new Array(10000).join('x'))
}

// Setup server
var serve = serveStatic(testDir)
var server = http.createServer(function(req, res) {
  serve(req, res, function(err) {
    res.statusCode = err ? (err.status || 500) : 404
    res.end(err ? err.message : 'Not Found')
  })
})

// Benchmark configuration
var WARMUP_REQUESTS = 1000
var BENCHMARK_REQUESTS = 10000
var CONCURRENT_CONNECTIONS = 10

// Test URLs
var testUrls = [
  '/index.html',
  '/test.txt',
  '/large.html',
  '/nonexistent.html'
]

/**
 * Make a single HTTP request
 */
function makeRequest(url, callback) {
  var options = {
    hostname: 'localhost',
    port: 3000,
    path: url,
    method: 'GET'
  }

  var req = http.request(options, function(res) {
    var data = ''
    res.on('data', function(chunk) {
      data += chunk
    })
    res.on('end', function() {
      callback(null, res.statusCode)
    })
  })

  req.on('error', callback)
  req.end()
}

/**
 * Run benchmark for a specific URL
 */
function benchmarkUrl(url, totalRequests, callback) {
  var completed = 0
  var errors = 0
  var startTime = Date.now()
  var active = 0
  var maxConcurrent = CONCURRENT_CONNECTIONS

  function runNext() {
    if (completed >= totalRequests) {
      return
    }

    if (active >= maxConcurrent) {
      return
    }

    active++
    makeRequest(url, function(err, statusCode) {
      active--
      completed++

      if (err) {
        errors++
      }

      if (completed < totalRequests) {
        setImmediate(runNext)
      } else if (active === 0) {
        var endTime = Date.now()
        var duration = (endTime - startTime) / 1000
        var reqPerSec = totalRequests / duration

        callback({
          url: url,
          totalRequests: totalRequests,
          duration: duration.toFixed(2),
          reqPerSec: Math.round(reqPerSec),
          errors: errors
        })
      }
    })
  }

  // Start initial concurrent requests
  for (var i = 0; i < maxConcurrent; i++) {
    runNext()
  }
}

/**
 * Run all benchmarks
 */
function runBenchmarks() {
  console.log('serve-static Performance Benchmark')
  console.log('==================================')
  console.log('')
  console.log('Configuration:')
  console.log('  Warmup requests: ' + WARMUP_REQUESTS)
  console.log('  Benchmark requests: ' + BENCHMARK_REQUESTS)
  console.log('  Concurrent connections: ' + CONCURRENT_CONNECTIONS)
  console.log('')
  console.log('Running warmup...')

  var urlIndex = 0

  function warmup() {
    benchmarkUrl(testUrls[0], WARMUP_REQUESTS, function() {
      console.log('Warmup complete. Starting benchmarks...\n')
      runNextBenchmark()
    })
  }

  function runNextBenchmark() {
    if (urlIndex >= testUrls.length) {
      console.log('\nBenchmark complete!')
      server.close()
      cleanup()
      return
    }

    var url = testUrls[urlIndex++]
    benchmarkUrl(url, BENCHMARK_REQUESTS, function(result) {
      console.log('URL: ' + result.url)
      console.log('  Total requests: ' + result.totalRequests)
      console.log('  Duration: ' + result.duration + 's')
      console.log('  Requests/sec: ' + result.reqPerSec)
      console.log('  Errors: ' + result.errors)
      console.log('')

      setImmediate(runNextBenchmark)
    })
  }

  warmup()
}

/**
 * Cleanup test files
 */
function cleanup() {
  if (fs.existsSync(testDir)) {
    var files = fs.readdirSync(testDir)
    files.forEach(function(file) {
      fs.unlinkSync(path.join(testDir, file))
    })
    fs.rmdirSync(testDir)
  }
}

// Start server and run benchmarks
server.listen(3000, function() {
  console.log('Benchmark server listening on port 3000\n')
  runBenchmarks()
})
