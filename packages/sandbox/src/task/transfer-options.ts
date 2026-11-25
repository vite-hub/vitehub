import { sandboxTaskErrorDiagnostics } from './error-diagnostics.ts'
import type { SandboxTaskTransferOptions } from './module-types'

const transferKeys = new Set(['maxInputBytes', 'maxOutputBytes', 'maxDepth', 'maxSidecars', 'maxSidecarBytes'])
const maxTransferLimit = 1_073_741_824

export function assertSandboxTaskTransferOptions(transfer: unknown): asserts transfer is SandboxTaskTransferOptions | undefined {
  if (transfer === undefined)
    return
  if (typeof transfer !== 'object' || transfer === null || Array.isArray(transfer))
    throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_TRANSFER_INVALID({ problem: 'must be an object' })
  const invalidKeys = Object.keys(transfer).filter(key => !transferKeys.has(key))
  if (invalidKeys.length > 0)
    throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_TRANSFER_INVALID({ problem: `supports only ${[...transferKeys].join(', ')}. Unsupported: ${invalidKeys.join(', ')}` })
  for (const [key, value] of Object.entries(transfer)) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > maxTransferLimit))
      throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_TRANSFER_INVALID({ problem: `sets ${key} to ${String(value)}. Each limit must be a whole number from 1 to ${maxTransferLimit}` })
  }
}
