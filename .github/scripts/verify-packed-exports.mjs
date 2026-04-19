import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = process.cwd()
const tmpRoot = mkdtempSync(join(tmpdir(), 'vitehub-pack-smoke-'))

function run(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`)
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function discoverPackages() {
  return readdirSync(resolve(repoRoot, 'packages'), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => resolve(repoRoot, 'packages', entry.name))
    .filter(packageDir => {
      const manifestPath = join(packageDir, 'package.json')
      try {
        const manifest = readJson(manifestPath)
        return Array.isArray(manifest.files) && manifest.files.includes('dist')
      }
      catch {
        return false
      }
    })
    .sort()
}

function readExportTarget(target) {
  if (typeof target === 'string')
    return target

  if (!target || typeof target !== 'object')
    return null

  return target.default || target.import || target.require || null
}

function toSpecifiers(manifest) {
  return Object.entries(manifest.exports || {})
    .flatMap(([key, target]) => {
      if (key === './package.json')
        return []

      const runtimeTarget = readExportTarget(target)
      if (!runtimeTarget || typeof runtimeTarget !== 'string' || !runtimeTarget.endsWith('.js'))
        return []

      return [key === '.' ? manifest.name : `${manifest.name}/${key.slice(2)}`]
    })
}

function latestTarball(directory) {
  return readdirSync(directory)
    .filter(file => file.endsWith('.tgz'))
    .sort()
    .at(-1)
}

try {
  for (const packageDir of discoverPackages()) {
    const manifest = readJson(join(packageDir, 'package.json'))
    const specifiers = toSpecifiers(manifest)
    if (specifiers.length === 0)
      continue

    const packDir = join(tmpRoot, 'packs')
    const consumerDir = join(tmpRoot, manifest.name.replaceAll('/', '-'))
    mkdirSync(packDir, { recursive: true })
    mkdirSync(consumerDir, { recursive: true })
    run('pnpm', ['--dir', packageDir, 'pack', '--pack-destination', packDir])

    const tarball = latestTarball(packDir)
    if (!tarball)
      throw new Error(`No tarball created for ${manifest.name}.`)

    writeFileSync(join(consumerDir, 'package.json'), JSON.stringify({
      name: `${manifest.name.replaceAll('/', '-')}-smoke`,
      private: true,
      type: 'module',
    }, null, 2))

    run('pnpm', ['add', join(packDir, tarball)], consumerDir)
    writeFileSync(join(consumerDir, 'verify.mjs'), [
      ...specifiers.map(specifier => `await import.meta.resolve(${JSON.stringify(specifier)})`),
      `console.log(${JSON.stringify(`verified ${manifest.name}`)})`,
      '',
    ].join('\n'))
    run('node', ['verify.mjs'], consumerDir)
  }
}
finally {
  rmSync(tmpRoot, { recursive: true, force: true })
}
