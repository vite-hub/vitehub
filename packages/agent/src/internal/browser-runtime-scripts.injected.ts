// Source text that Node runs with `node -e` in a separate process, so its errors stay plain. The caller reports a failed run.

export const extractLinuxChromiumScript = `
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
const require = createRequire(join(process.argv[1], 'package.json'))
const modulePath = require.resolve('@sparticuz/chromium')
const Chromium = (await import(pathToFileURL(modulePath).href)).default
await Chromium.executablePath()
await mkdir(join(process.env.TMPDIR, 'fonts'), { recursive: true })
await writeFile(join(process.env.TMPDIR, 'fonts', 'fonts.conf'), '<fontconfig><dir prefix="relative">.</dir><cachedir prefix="xdg">fontconfig</cachedir></fontconfig>')
`

// Headless Shell exposes CDP but does not implement Chrome's --dump-dom command.
export const smokeLinuxChromiumScript = `
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const cancellation = new AbortController()
process.on('SIGTERM', () => cancellation.abort(new Error('Chromium smoke check cancelled')))
const profile = await mkdtemp(join(tmpdir(), 'vh-chrome-'))
const child = spawn(process.argv[1], ['--headless', '--disable-dev-shm-usage', '--remote-debugging-port=0', '--user-data-dir=' + profile, ...JSON.parse(process.argv[2]), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], detached: true })
const group = child.pid
const descendants = new Set([child.pid])
const collectDescendants = async () => {
  // Walk to a fixed point: Chromium commonly creates grandchildren after
  // the initial process has started, so one snapshot is insufficient.
  let changed = true
  while (changed) {
    changed = false
    const entries = await readdir('/proc').catch(error => {
      if (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'EPERM') return []
      throw error
    })
    const parents = new Set(descendants)
    for (const pid of entries) {
      if (!/^[0-9]+$/.test(pid)) continue
      const status = await readFile('/proc/' + pid + '/stat', 'utf8').catch(() => '')
      if (!status) continue
      const fields = status.slice(status.lastIndexOf(')') + 2).split(' ')
      const numericPid = Number(pid)
      if (parents.has(Number(fields[1])) && !descendants.has(numericPid)) {
        descendants.add(numericPid)
        changed = true
      }
    }
  }
}
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chromium CDP readiness timed out')), 15000)
    const abort = () => { clearTimeout(timer); reject(cancellation.signal.reason) }
    cancellation.signal.addEventListener('abort', abort, { once: true })
    if (cancellation.signal.aborted) abort()
    let stderr = ''
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Chromium exited: ' + code + ' ' + stderr)) })
    child.stderr.on('data', data => {
      stderr = (stderr + data).slice(-4000)
      if (stderr.includes("DevTools listening on ws://127.0.0.1:")) { clearTimeout(timer); resolve() }
    })
  })
} finally {
  await collectDescendants()
  if (child.pid) {
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
    try { process.kill(child.pid, 'SIGKILL') } catch {}
    for (const pid of descendants) if (pid !== process.pid) { try { process.kill(pid, 'SIGKILL') } catch {} }
  }
  await new Promise(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('close', resolve))
  // A direct-child close does not join helpers with independent stdio.
  // Zombies have exited and released their files; their reaping belongs to
  // the adopting parent, which may be PID 1 rather than this wrapper.
  if (child.pid) {
    const deadline = Date.now() + 1500
    while (true) {
      await collectDescendants()
      let running = false
      const procEntries = await readdir('/proc').catch(error => {
        if (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'EPERM') return []
        throw error
      })
      for (const pid of procEntries) {
        if (!/^[0-9]+$/.test(pid)) continue
        const status = await readFile('/proc/' + pid + '/stat', 'utf8').catch(error => {
          if (error.code === 'ENOENT' || error.code === 'ESRCH') return ''
          throw error
        })
        const fields = status.slice(status.lastIndexOf(')') + 2).split(' ')
        if ((descendants.has(Number(pid)) || Number(fields[1]) === child.pid || Number(fields[2]) === group) && !['Z', 'X'].includes(fields[0])) {
          running = true
          break
        }
      }
      if (!running) break
      if (Date.now() >= deadline) throw new Error('Chromium helpers did not exit; retaining profile ' + profile)
      await delay(10)
    }
  }
  await rm(profile, { recursive: true, force: true })
}
`
