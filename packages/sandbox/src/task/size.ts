import { sandboxTaskErrorDiagnostics } from './error-diagnostics.ts'

/** The size of the machine that runs every Sandbox Task. Both values are minimums. */
export interface SandboxTaskSizeOptions {
  /** Minimum vCPUs. ViteHub picks the smallest provider size that gives at least this many. */
  cpu?: number
  /** Minimum memory in MiB. ViteHub picks the smallest provider size that gives at least this much. */
  memory?: number
}

/** A Wrangler custom instance type. */
export interface CloudflareCustomInstanceType {
  vcpu: number
  memory_mib: number
  disk_mb?: number
}

export type CloudflareInstanceType = string | CloudflareCustomInstanceType

// https://developers.cloudflare.com/containers/platform-details/limits/
const cloudflareInstanceTypes = [
  { name: 'lite', vcpu: 1 / 16, memoryMib: 256 },
  { name: 'basic', vcpu: 1 / 4, memoryMib: 1024 },
  { name: 'standard-1', vcpu: 1 / 2, memoryMib: 4096 },
  { name: 'standard-2', vcpu: 1, memoryMib: 6144 },
  { name: 'standard-3', vcpu: 2, memoryMib: 8192 },
  { name: 'standard-4', vcpu: 4, memoryMib: 12288 },
] as const

/** Same memory as the 2 vCPU default of Vercel. `lite` has too little memory for a package install. */
export const defaultCloudflareInstanceType = 'standard-1'

// Vercel gives 2048 MiB of memory for each vCPU. https://vercel.com/docs/vercel-sandbox/pricing
const vercelMemoryPerVcpu = 2048
const vercelMaxVcpus = 32

function readPositiveNumber(options: SandboxTaskSizeOptions & { maxInstances?: number }, key: 'cpu' | 'memory' | 'maxInstances', integer = false) {
  // Config files are not type-checked, so the value can be any JSON value.
  const value: unknown = options[key]
  if (value === undefined)
    return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value)))
    throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_SIZE_INVALID({ key, value: String(value) })
  return value
}

/** Reads `cpu`, `memory`, and `maxInstances`, and rejects values that are not positive numbers. */
export function readSandboxTaskSize(options: SandboxTaskSizeOptions & { maxInstances?: number }) {
  return {
    cpu: readPositiveNumber(options, 'cpu'),
    memory: readPositiveNumber(options, 'memory'),
    maxInstances: readPositiveNumber(options, 'maxInstances', true),
  }
}

function formatVcpu(vcpu: number) {
  return vcpu >= 1 ? String(vcpu) : `1/${Math.round(1 / vcpu)}`
}

/** The vCPUs and memory of a Wrangler instance type. Undefined for a name that ViteHub does not know. */
export function describeCloudflareInstanceType(instanceType: CloudflareInstanceType) {
  if (typeof instanceType === 'object')
    return { label: `custom (${formatVcpu(instanceType.vcpu)} vCPU, ${instanceType.memory_mib} MiB memory)`, vcpu: instanceType.vcpu, memoryMib: instanceType.memory_mib }
  const named = cloudflareInstanceTypes.find(entry => entry.name === instanceType)
  return named && { label: `${named.name} (${formatVcpu(named.vcpu)} vCPU, ${named.memoryMib} MiB memory)`, vcpu: named.vcpu, memoryMib: named.memoryMib }
}

/** The smallest Cloudflare instance type that gives at least `cpu` vCPUs and `memory` MiB. */
export function resolveCloudflareSandboxTaskInstanceType(options: SandboxTaskSizeOptions & { maxInstances?: number }): string {
  const { cpu, memory } = readSandboxTaskSize(options)
  if (cpu === undefined && memory === undefined)
    return defaultCloudflareInstanceType
  const fit = cloudflareInstanceTypes.find(entry => entry.vcpu >= (cpu ?? 0) && entry.memoryMib >= (memory ?? 0))
  if (!fit)
    throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_SIZE_TOO_LARGE({ provider: 'Cloudflare', size: formatRequest(cpu, memory), max: 'standard-4 (4 vCPU, 12288 MiB memory)' })
  return fit.name
}

/** Throws when an app-owned Wrangler instance type gives less than the requested `cpu` or `memory`. */
export function assertCloudflareInstanceTypeFits(instanceType: CloudflareInstanceType, options: SandboxTaskSizeOptions, className: string) {
  const { cpu, memory } = readSandboxTaskSize(options)
  const size = describeCloudflareInstanceType(instanceType)
  // Wrangler validates names it knows. ViteHub cannot compare a name it does not know.
  if (!size || (size.vcpu >= (cpu ?? 0) && size.memoryMib >= (memory ?? 0)))
    return
  throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_CLOUDFLARE_INSTANCE_TYPE_TOO_SMALL({ className, instanceType: size.label, size: formatRequest(cpu, memory) })
}

/** The Vercel vCPU count for `cpu` and `memory`: 1 or an even number up to 32. Undefined keeps the Vercel default. */
export function resolveVercelSandboxTaskVcpus(options: SandboxTaskSizeOptions): number | undefined {
  const { cpu, memory } = readSandboxTaskSize(options)
  if (cpu === undefined && memory === undefined)
    return undefined
  const needed = Math.max(Math.ceil(cpu ?? 0), Math.ceil((memory ?? 0) / vercelMemoryPerVcpu), 1)
  const vcpus = needed === 1 ? 1 : needed + (needed % 2)
  if (vcpus > vercelMaxVcpus)
    throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_SIZE_TOO_LARGE({ provider: 'Vercel', size: formatRequest(cpu, memory), max: `${vercelMaxVcpus} vCPU (${vercelMaxVcpus * vercelMemoryPerVcpu} MiB memory)` })
  return vcpus
}

function formatRequest(cpu: number | undefined, memory: number | undefined) {
  return [cpu === undefined ? '' : `cpu: ${cpu}`, memory === undefined ? '' : `memory: ${memory}`].filter(Boolean).join(', ')
}
