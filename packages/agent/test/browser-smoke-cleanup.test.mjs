import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const source = await readFile(new URL('../src/internal/browser-runtime.ts', import.meta.url), 'utf8')
const script = source.split('const smokeLinuxChromiumScript = `')[1].split('\n`')[0]

for (const mode of ['ready', 'cancel', 'timeout']) {
  test(`joins Chromium helpers before profile cleanup on ${mode}`, { skip: process.platform !== 'linux' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'vh-smoke-test-'))
    const marker = join(root, 'processes.json')
    const executable = join(root, 'chrome')
    await writeFile(executable, `#!${process.execPath}
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  pid: process.pid, helper: helper.pid,
  profile: process.argv.find(arg => arg.startsWith('--user-data-dir=')).slice(16)
}))
if (${JSON.stringify(mode)} === 'ready') process.stderr.write('DevTools listening on ws://127.0.0.1:1234')
setInterval(() => {}, 1000)
`, { mode: 0o700 })
    const wrapper = spawn(process.execPath, ['--input-type=module', '-e', script, executable, '[]'], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    wrapper.stderr.on('data', chunk => { stderr += chunk })
    const closed = new Promise(resolve => wrapper.once('close', resolve))
    let processes
    try {
      for (let attempt = 0; attempt < 200; attempt++) {
        processes = await readFile(marker, 'utf8').then(JSON.parse).catch(() => undefined)
        if (processes) break
        await delay(10)
      }
      assert.ok(processes, 'browser fixture started')
      if (mode === 'cancel') wrapper.kill('SIGTERM')
      const code = await closed
      assert.equal(code === 0, mode === 'ready', stderr)
      for (const pid of [processes.pid, processes.helper]) {
        const status = await readFile('/proc/' + pid + '/stat', 'utf8').catch(() => '')
        assert.ok(!status || ['Z', 'X'].includes(status.slice(status.lastIndexOf(')') + 2).split(' ')[0]), 'process exited before wrapper completion')
      }
      await assert.rejects(stat(processes.profile), { code: 'ENOENT' })
    } finally {
      wrapper.kill('SIGKILL')
      if (processes) {
        try { process.kill(-processes.pid, 'SIGKILL') } catch {}
        await rm(processes.profile, { recursive: true, force: true })
      }
      await rm(root, { recursive: true, force: true })
    }
  })
}
