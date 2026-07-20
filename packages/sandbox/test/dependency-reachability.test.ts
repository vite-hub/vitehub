import { build } from 'esbuild'
import { resolve } from 'node:path'

import { expect, it } from 'vitest'

it('keeps Workspace MCP clients out of the Sandbox Worker runtime', async () => {
  const result = await build({
    bundle: true,
    entryPoints: [resolve(import.meta.dirname, '../src/runtime/execution-files.ts')],
    format: 'esm',
    logLevel: 'silent',
    metafile: true,
    platform: 'node',
    write: false,
  })
  const inputs = Object.keys(result.metafile.inputs).map(input => input.replaceAll('\\', '/'))
  const forbiddenInputs = inputs.filter(input => [
    /(?:^|\/)mcp-resources(?:[/.]|$)/,
    /(?:^|\/)@modelcontextprotocol\/sdk\//,
    /(?:^|\/)pkce-challenge(?:[/.]|$)/,
  ].some(pattern => pattern.test(input)))

  expect(forbiddenInputs).toEqual([])
})
