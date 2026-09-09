import { toResponse, type ViteHubError } from '@vite-hub/runtime'

/** Convert a sandbox value to the native Web Response contract. */
export async function ok(value: unknown): Promise<Response> { return toResponse(value) }

function statusFor(error: ViteHubError<`SANDBOX_${string}`>) {
  const status = error.details?.httpStatus
  if (Number.isInteger(status) && Number(status) >= 400 && Number(status) <= 599)
    return Number(status)
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
