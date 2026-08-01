import type { VercelRequest, VercelResponse } from '@vercel/node'
import { LicensingError, type ErrorResponse } from './contracts.js'
import { getLicensingService } from './runtime.js'

type Route = 'challenge' | 'redeem' | 'refresh' | 'health'

function remoteSubject(request: VercelRequest): string {
  const forwarded = request.headers['x-forwarded-for']
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded
  return value?.split(',')[0]?.trim() || request.socket.remoteAddress || 'unknown'
}

function applySecurityHeaders(request: VercelRequest, response: VercelResponse): void {
  response.setHeader('Cache-Control', 'no-store, max-age=0')
  response.setHeader('Pragma', 'no-cache')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  const allowedOrigin = process.env.LICENSING_ALLOWED_ORIGIN?.trim()
  const origin = request.headers.origin
  if (allowedOrigin && origin === allowedOrigin) {
    response.setHeader('Access-Control-Allow-Origin', allowedOrigin)
    response.setHeader('Vary', 'Origin')
  }
}

function assertOrigin(request: VercelRequest): void {
  const allowedOrigin = process.env.LICENSING_ALLOWED_ORIGIN?.trim()
  const origin = request.headers.origin
  if (origin && (!allowedOrigin || origin !== allowedOrigin)) {
    throw new LicensingError('origin-forbidden', 'Browser-origin requests are not permitted.', 403)
  }
}

function sendError(response: VercelResponse, error: unknown): void {
  const known = error instanceof LicensingError
    ? error
    : new LicensingError('service-unavailable', 'The licensing service is temporarily unavailable.', 503, true)
  const body: ErrorResponse = {
    error: {
      code: known.code,
      message: known.message,
      retryable: known.retryable,
      ...(known.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: known.retryAfterSeconds }),
    },
  }
  if (known.retryAfterSeconds !== undefined) response.setHeader('Retry-After', String(known.retryAfterSeconds))
  response.status(known.status).json(body)
}

export async function handleRoute(route: Route, request: VercelRequest, response: VercelResponse): Promise<void> {
  applySecurityHeaders(request, response)
  try {
    assertOrigin(request)
    if (route === 'health') {
      if (request.method !== 'GET') throw new LicensingError('method-not-allowed', 'Use GET.', 405)
      response.status(200).json(getLicensingService().health())
      return
    }
    if (request.method !== 'POST') throw new LicensingError('method-not-allowed', 'Use POST.', 405)
    const encodedLength = Buffer.byteLength(JSON.stringify(request.body ?? null), 'utf8')
    if (encodedLength > 16_384) throw new LicensingError('invalid-request', 'Request body is too large.', 413)
    const service = getLicensingService()
    const subject = remoteSubject(request)
    if (route === 'challenge') {
      response.status(201).json(await service.createChallenge(request.body, subject))
    } else if (route === 'redeem') {
      response.status(200).json(await service.redeem(request.body, subject))
    } else {
      response.status(200).json(await service.refresh(request.body, subject))
    }
  } catch (error) {
    sendError(response, error)
  }
}
