import { build } from 'esbuild'
import { resolve } from 'node:path'

import { expect, it, vi } from 'vitest'

import { writeSandboxDefinitionBundle } from '../src/runtime/execution-files'

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


it('stages Sandbox bundles directly into a replacement Box file tree', async () => {
  const operations: string[] = []
  const remove = vi.fn(async (path: string) => { operations.push(`remove:${path}`) })
  const mkdir = vi.fn(async (path: string) => { operations.push(`mkdir:${path}`) })
  const write = vi.fn(async (path: string, _contents: Uint8Array) => { operations.push(`write:${path}`) })
  const exec = vi.fn(async (command: string, args: readonly string[] = []) => {
    operations.push(`exec:${command}:${args.join(':')}`)
    return { code: 0, ok: true, stderr: '', stdout: '' }
  })
  const sandbox = { exec, files: { mkdir, remove, write } } as never
  const binary = Uint8Array.from([0, 255, 10])

  await writeSandboxDefinitionBundle(sandbox, '/tmp/bundle', {
    entry: 'nested/runtime.js',
    modules: {
      'collision.txt': 'module wins',
      'nested/runtime.js': 'export default true',
    },
    project: {
      digest: 'digest',
      files: {
        'bin/tool': { contents: Buffer.from(binary).toString('base64'), encoding: 'base64', mode: 0o755 },
        'collision.txt': { contents: Buffer.from('project loses').toString('base64'), encoding: 'base64' },
      },
      install: { args: ['install'], command: 'npm', cwd: '.' },
      packagePath: '.',
    },
  })

  expect(operations.slice(0, 2)).toEqual(['remove:/tmp/bundle', 'mkdir:/tmp/bundle'])
  expect(mkdir).toHaveBeenCalledWith('/tmp/bundle/nested', { recursive: true })
  expect(mkdir).toHaveBeenCalledWith('/tmp/bundle/bin', { recursive: true })
  const writes = Object.fromEntries(write.mock.calls.map(([path, contents]) => [path, [...contents]]))
  expect(writes['/tmp/bundle/bin/tool']).toEqual([...binary])
  expect(new TextDecoder().decode(Uint8Array.from(writes['/tmp/bundle/collision.txt']))).toBe('module wins')
  expect(exec).toHaveBeenCalledWith('chmod', ['755', '/tmp/bundle/bin/tool'])
  expect(exec.mock.invocationCallOrder[0]).toBeGreaterThan(Math.max(...write.mock.invocationCallOrder))
})

it.each(['', '/escape.js', '\\escape.js', 'C:\\escape.js', '.', '..', 'nested/../escape.js'])('rejects unsafe Sandbox bundle path %j before replacing the file tree', async (path) => {
  const remove = vi.fn(async () => {})
  const sandbox = {
    exec: vi.fn(),
    files: { mkdir: vi.fn(), remove, write: vi.fn() },
  } as never

  await expect(writeSandboxDefinitionBundle(sandbox, '/tmp/bundle', {
    entry: path,
    modules: { [path]: 'unsafe' },
  })).rejects.toThrow('must stay inside the project')
  expect(remove).not.toHaveBeenCalled()
})
