import { toResponse, type ViteHubError } from '@vite-hub/runtime'

/** Convert a sandbox value to the native Web Response contract. */
export async function ok(value: unknown): Promise<Response> { return toResponse(value) }

function statusFor(error: ViteHubError<`SANDBOX_TASK_${string}`>) {
  const status = error.details?.httpStatus
  if (Number.isInteger(status) && Number(status) >= 400 && Number(status) <= 599)
    return Number(status)
  if (error.code === 'SANDBOX_TASK_TIMEOUT') return 504
  if (error.code.includes('NOT_FOUND')) return 404
  if (error.code.includes('VALIDATION')) return 400
  return 500
}

// These details can hold source paths, environment values, or user data from the Sandbox process.
const developmentOnlyDetails = new Set(['args', 'cause', 'cwd', 'output', 'outputPreview', 'stack', 'stderr', 'stderrPreview', 'stdout', 'stdoutPreview'])

function publicDetails(details: ViteHubError['details'], development: boolean) {
  if (development || !details)
    return details
  return Object.fromEntries(Object.entries(details).filter(([key]) => !developmentOnlyDetails.has(key)))
}

/** Outside `vite dev`, the body keeps the code, message, and details without stack or process output. */
export function err(error: ViteHubError<`SANDBOX_TASK_${string}`>, development = false): Response {
  const body = JSON.stringify({
    error: { code: error.code, message: error.message, details: publicDetails(error.details, development) },
  })
  return new Response(body, {
    status: statusFor(error),
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
