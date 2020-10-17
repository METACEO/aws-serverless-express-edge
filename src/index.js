/*
 * Copyright 2016-2016 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 * You may not use this file except in compliance with the License.
 * A copy of the License is located at
 *
 *     http://aws.amazon.com/apache2.0/
 *
 * or in the "license" file accompanying this file.
 * This file is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either
 * express or implied. See the License for the specific language governing
 * permissions and limitations under the License.
 */
'use strict'
const http = require('http')
const url = require('url')
const isType = require('type-is')
const qs = require('qs')
const zlib = require('zlib')
const { stringify } = require('flatted/cjs')

function getPathWithQueryStringParams(request) {
  return url.format({
    pathname: request.uri,
    query: qs.parse(request.querystring)
  })
}

function clone(json) {
  return JSON.parse(JSON.stringify(json))
}

function getContentType(params) {
  // only compare mime type; ignore encoding part
  return params.contentTypeHeader ? params.contentTypeHeader.split(';')[0] : ''
}

function isContentTypeBinaryMimeType(params) {
  return (
    params.binaryMimeTypes.length > 0 &&
    !!isType.is(params.contentType, params.binaryMimeTypes)
  )
}

function mapEdgeEventToHttpRequest(event, context, socketPath) {
  const request = event.Records[0].cf.request
  const headers = Object.keys(request.headers || {}).reduce((acc, name) => {
    acc[request.headers[name][0].key] = request.headers[name][0].value
    return acc
  }, {})
  const eventWithoutBody = clone({
    ...event,
    Records: [
      {
        ...event.Records[0],
        cf: {
          ...event.Records[0].cf,
          request: {
            ...event.Records[0].cf.request,
            body: undefined
          }
        }
      }
    ]
  })

  headers['x-edge-event'] = encodeURIComponent(stringify(eventWithoutBody))
  headers['x-edge-context'] = encodeURIComponent(stringify(context))

  return {
    method: request.method,
    path: getPathWithQueryStringParams(request),
    headers,
    socketPath
  }
}

function forwardResponseToEdge(server, response, resolver) {
  let buf = []

  response.on('data', chunk => buf.push(chunk)).on('end', () => {
    const bodyBuffer = Buffer.concat(buf)
    const { headers, statusCode: status } = response

    // chunked transfer not currently supported by API Gateway
    if (headers['transfer-encoding'] === 'chunked') {
      delete headers['transfer-encoding']
    }

    // Blacklisted / read-only headers
    if (headers.hasOwnProperty('connection')) {
      delete headers['connection']
    }
    if (headers.hasOwnProperty('content-length')) {
      delete headers['content-length']
    }

    const contentType = getContentType({
      contentTypeHeader: headers['content-type']
    })
    let isBase64Encoded = isContentTypeBinaryMimeType({
      contentType,
      binaryMimeTypes: server._binaryTypes
    })
    let body
    switch (contentType) {
      case 'text/html':
        body = zlib.gzipSync(bodyBuffer).toString('base64')
        isBase64Encoded = true
        headers['content-encoding'] = 'gzip'
        break
      default:
        body = bodyBuffer.toString(isBase64Encoded ? 'base64' : 'utf8')
    }

    Object.keys(headers).forEach(h => {
      headers[h] = [
        {
          key: h,
          value: headers[h]
        }
      ]
    })

    const successResponse = { status, body, headers }
    if (isBase64Encoded) {
      successResponse.bodyEncoding = 'base64'
    }

    resolver.succeed({
      response: successResponse
    })
  })
}

function forwardConnectionErrorResponseToEdge(error, resolver) {
  console.log('ERROR: aws-serverless-express-edge connection error')
  console.error(error)
  const errorResponse = {
    status: '502', // "DNS resolution, TCP level errors, or actual HTTP parse errors" - https://nodejs.org/api/http.html#http_http_request_options_callback
    body: '',
    headers: {}
  }

  resolver.succeed({ response: errorResponse })
}

function forwardLibraryErrorResponseToEdge(error, resolver) {
  console.log('ERROR: aws-serverless-express-edge error')
  console.error(error)
  const errorResponse = {
    status: '500',
    body: '',
    headers: {}
  }

  resolver.succeed({ response: errorResponse })
}

function forwardRequestToNodeServer(server, event, context, resolver) {
  try {
    const request = event.Records[0].cf.request
    const requestOptions = mapEdgeEventToHttpRequest(
      event,
      context,
      getSocketPath(server._socketPathSuffix)
    )
    const req = http.request(requestOptions, response =>
      forwardResponseToEdge(server, response, resolver)
    )
    if (request.body) {
      if (request.body.encoding === 'base64') {
        request.body.data = Buffer.from(request.body.data, 'base64')
      }

      req.write(request.body.data)
    }

    req
      .on('error', error =>
        forwardConnectionErrorResponseToEdge(error, resolver)
      )
      .end()
  } catch (error) {
    forwardLibraryErrorResponseToEdge(error, resolver)
    return server
  }
}

function startServer(server) {
  return server.listen(getSocketPath(server._socketPathSuffix))
}

function getSocketPath(socketPathSuffix) {
  /* istanbul ignore if */ /* only running tests on Linux; Window support is for local dev only */
  if (/^win/.test(process.platform)) {
    const path = require('path')
    return path.join('\\\\?\\pipe', process.cwd(), `server-${socketPathSuffix}`)
  } else {
    return `/tmp/server-${socketPathSuffix}.sock`
  }
}

function getRandomString() {
  return Math.random()
    .toString(36)
    .substring(2, 15)
}

function createServer(requestListener, serverListenCallback, binaryTypes) {
  const server = http.createServer(requestListener)

  server._socketPathSuffix = getRandomString()
  server._binaryTypes = binaryTypes ? binaryTypes.slice() : []
  server.on('listening', () => {
    server._isListening = true

    if (serverListenCallback) serverListenCallback()
  })
  server
    .on('close', () => {
      server._isListening = false
    })
    .on('error', error => {
      /* istanbul ignore else */
      if (error.code === 'EADDRINUSE') {
        console.warn(
          `WARNING: Attempting to listen on socket ${getSocketPath(
            server._socketPathSuffix
          )}, but it is already in use. This is likely as a result of a previous invocation error or timeout. Check the logs for the invocation(s) immediately prior to this for root cause, and consider increasing the timeout and/or cpu/memory allocation if this is purely as a result of a timeout. aws-serverless-express will restart the Node.js server listening on a new port and continue with this request.`
        )
        server._socketPathSuffix = getRandomString()
        return server.close(() => startServer(server))
      } else {
        console.log('ERROR: server error')
        console.error(error)
      }
    })

  return server
}

function proxy(server, event, context, resolutionMode, callback) {
  // DEPRECATED: Legacy support
  if (!resolutionMode) {
    const resolver = makeResolver({
      context,
      resolutionMode: 'CONTEXT_SUCCEED'
    })
    if (server._isListening) {
      forwardRequestToNodeServer(server, event, context, resolver)
      return server
    } else {
      return startServer(server).on('listening', () =>
        proxy(server, event, context)
      )
    }
  }

  return {
    promise: new Promise((resolve, reject) => {
      const promise = {
        resolve,
        reject
      }
      const resolver = makeResolver({
        context,
        callback,
        promise,
        resolutionMode
      })

      if (server._isListening) {
        forwardRequestToNodeServer(server, event, context, resolver)
      } else {
        startServer(server).on('listening', () =>
          forwardRequestToNodeServer(server, event, context, resolver)
        )
      }
    })
  }
}

function makeResolver(
  params /* {
  context,
  callback,
  promise,
  resolutionMode
} */
) {
  return {
    succeed: (params2 /* {
      response
    } */) => {
      if (params.resolutionMode === 'CONTEXT_SUCCEED') {
        return params.context.succeed(params2.response)
      }
      if (params.resolutionMode === 'CALLBACK') {
        return params.callback(null, params2.response)
      }
      if (params.resolutionMode === 'PROMISE') {
        return params.promise.resolve(params2.response)
      }
    }
  }
}

exports.createServer = createServer
exports.proxy = proxy

/* istanbul ignore else */
if (process.env.NODE_ENV === 'test') {
  exports.getPathWithQueryStringParams = getPathWithQueryStringParams
  exports.mapEdgeEventToHttpRequest = mapEdgeEventToHttpRequest
  exports.forwardResponseToEdge = forwardResponseToEdge
  exports.forwardConnectionErrorResponseToEdge = forwardConnectionErrorResponseToEdge
  exports.forwardLibraryErrorResponseToEdge = forwardLibraryErrorResponseToEdge
  exports.forwardRequestToNodeServer = forwardRequestToNodeServer
  exports.startServer = startServer
  exports.getSocketPath = getSocketPath
  exports.makeResolver = makeResolver
}
