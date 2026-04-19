import { describe, expect, it, vi } from 'vitest'

import { readExecOutputWithRecovery } from '../src/runtime/execute-cloudflare'
import { EXEC_STDIO_OUTPUT_MARKER, extractSandboxOutputFromExecution, tryParseSandboxOutput } from '../src/runtime/execute-output'
import { SandboxError } from '../src/sandbox/errors'

describe('sandbox runtime execution helpers', () => {
  it('extracts marked stdout payloads', () => {
    const output = extractSandboxOutputFromExecution({
      stdout: `log line\n${EXEC_STDIO_OUTPUT_MARKER}{"ok":true,"result":{"id":1}}\n`,
    })

    expect(tryParseSandboxOutput<{ id: number }>(output || '')).toEqual({
      ok: true,
      result: { id: 1 },
    })
  })

  it('falls back to reading the Cloudflare output file when exec output is missing', async () => {
    const sandbox = {
      provider: 'cloudflare',
      readFile: vi.fn()
        .mockRejectedValueOnce(new Error('not ready'))
        .mockResolvedValueOnce('{"ok":true,"result":{"status":"recovered"}}'),
    }

    await expect(readExecOutputWithRecovery(
      sandbox as never,
      '/tmp/output.json',
      new SandboxError('Cloudflare sandbox exec timed out.', {
        code: 'TIMEOUT',
        provider: 'cloudflare',
      }),
      25_000,
      { stdout: '', stderr: '', code: 1 },
    )).resolves.toBe('{"ok":true,"result":{"status":"recovered"}}')

    expect(sandbox.readFile).toHaveBeenCalledTimes(2)
  })
})
