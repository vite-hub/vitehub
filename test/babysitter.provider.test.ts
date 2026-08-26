import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'
import {
  createProviderResourceEnvironment,
  providerNodeHeapLimitMb,
} from '../server/babysitter.provider.ts'

const exec = promisify(execFile)
const mebibyte = 1024 * 1024

test('bounds concurrent provider Node heaps independently of the service heap limit', async () => {
  const serviceEnvironment = {
    ...process.env,
    NODE_OPTIONS: '--max-old-space-size=4096',
  }
  const providerEnvironment = {
    ...serviceEnvironment,
    ...createProviderResourceEnvironment(),
  }
  assert.equal(providerEnvironment.NODE_OPTIONS, `--max-old-space-size=${providerNodeHeapLimitMb}`)

  const inspectHeapLimit = async () => Number((await exec(process.execPath, [
    '-e',
    'process.stdout.write(String(require("node:v8").getHeapStatistics().heap_size_limit))',
  ], { env: providerEnvironment })).stdout)
  const limits = await Promise.all([inspectHeapLimit(), inspectHeapLimit()])

  for (const limit of limits) {
    assert.ok(limit >= providerNodeHeapLimitMb * mebibyte)
    assert.ok(limit < 1280 * mebibyte, `provider heap limit was ${limit} bytes`)
  }
})
