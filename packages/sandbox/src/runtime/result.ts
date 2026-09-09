import { toResponse, type ViteHubError } from '@vite-hub/runtime'

/** Convert a sandbox value to the native Web Response contract. */
export async function ok(value: unknown): Promise<Response> { return toResponse(value) }

function statusFor(error: ViteHubError<`SANDBOX_${string}`>) {
  const details = error.details as Record<string, unknown> | undefined
  if (typeof details?.httpStatus === 'number' && details.httpStatus >= 400 && details.httpStatus <= 599)
    return details.httpStatus
  if (error.code.includes('TIMEOUT')) return 504
  if (error.code.includes('NOT_FOUND')) return 404
  if (error.code.includes('VALIDATION')) return 400
  return 500
}

export function err(error: ViteHubError<`SANDBOX_${string}`>): Response {
  const body = JSON.stringify({
    error: { code: error.code, message: error.message, details: error.details },
  })
  return new Response(body, {
    status: statusFor(error),
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
