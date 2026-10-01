import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { createLocalWorkspaceStore } from "../src/storage/local.ts"

const failedGateRemovals = new Map<string, number>()
const gateAttempts = new Map<string, number>()
const pausedProbes = new Map<string, { entered: () => void, resume: Promise<void> }>()
const pausedReads = new Map<string, { entered: () => void, resume: Promise<void> }>()
const pausedGateRemovals = new Map<string, { entered: () => void, resume: Promise<void> }>()
const failedHeartbeats = new Set<string>()
const pausedStats = new Map<string, { entered: () => void, resume: Promise<void> }>()
const failedStats = new Set<string>()

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  const mkdir = async (...args: Parameters<typeof actual.mkdir>) => {
    const path = String(args[0])
    if (path.endsWith(".gate")) gateAttempts.set(path, (gateAttempts.get(path) ?? 0) + 1)
    return await actual.mkdir(...args)
  }
  const lstat = async (...args: Parameters<typeof actual.lstat>) => {
    const result = await actual.lstat(...args).catch((error) => error as NodeJS.ErrnoException)
    const paused = pausedProbes.get(String(args[0]))
    if (paused) {
      pausedProbes.delete(String(args[0]))
      paused.entered()
      await paused.resume
    }
    if ("code" in result) throw result
    return result
  }
  const rm = async (...args: Parameters<typeof actual.rm>) => {
    const path = String(args[0])
    const paused = pausedGateRemovals.get(path)
    if (paused) {
      pausedGateRemovals.delete(path)
      paused.entered()
      await paused.resume
    }
    const failures = failedGateRemovals.get(path) ?? 0
    if (failures) {
      if (failures === 1) failedGateRemovals.delete(path)
      else failedGateRemovals.set(path, failures - 1)
      throw Object.assign(new Error("Admission gate removal failed"), { code: "EACCES" })
    }
    return await actual.rm(...args)
  }
  const readFile = async (...args: Parameters<typeof actual.readFile>) => {
    const paused = pausedReads.get(String(args[0]))
    if (paused) {
      pausedReads.delete(String(args[0]))
      paused.entered()
      await paused.resume
    }
    return await actual.readFile(...args)
  }
  const open = async (...args: Parameters<typeof actual.open>) => {
    const file = await actual.open(...args)
    if (failedHeartbeats.has(String(args[0]).replace(/\/[^/]+$/, ""))) {
      vi.spyOn(file, "utimes").mockRejectedValue(new Error("Shared reader heartbeat failed"))
    }
    return file
  }
  const stat = async (...args: Parameters<typeof actual.stat>) => {
    if (failedStats.delete(String(args[0]))) throw Object.assign(new Error("Writer intent permission setup failed"), { code: "EIO" })
    const paused = pausedStats.get(String(args[0]))
    if (paused) {
      pausedStats.delete(String(args[0]))
      paused.entered()
      await paused.resume
    }
    return await actual.stat(...args)
  }
  return { ...actual, default: { ...actual, mkdir, open, readFile, lstat, rm, stat }, mkdir, open, readFile, lstat, rm, stat }
})

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function storeWithFiles(count: number) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-lock-contention-"))
  roots.push(root)
  const store = createLocalWorkspaceStore(root)
  const paths = Array.from({ length: count }, (_, index) => `docs/guide/page-${index}.md`)
  for (const path of paths) await store.writeFile(path, { path, content: path })
  const gate = (path: string) => join(root, ".vitehub/locks", `${createHash("sha256").update(path).digest("hex")}.gate`)
  return { gate, paths, root, store }
}

it.skipIf(process.platform === "win32")("retries writer intent when its parent disappears during permission setup", async () => {
  const { gate, paths, store } = await storeWithFiles(1)
  const intents = gate(paths[0]!).replace(/\.gate$/, ".writers")
  let entered!: () => void, resume!: () => void
  const reached = new Promise<void>((resolve) => { entered = resolve })
  const resumed = new Promise<void>((resolve) => { resume = resolve })
  pausedStats.set(intents, { entered, resume: resumed })
  const writing = store.writeFile(paths[0]!, { path: paths[0]!, content: "updated" })
  try {
    await reached
    await rm(intents, { recursive: true })
    resume()
    await writing
    await expect(store.readFile(paths[0]!)).resolves.toMatchObject({ content: new TextEncoder().encode("updated") })
  }
  finally {
    resume()
    await Promise.allSettled([writing])
    pausedStats.delete(intents)
  }
})

it.skipIf(process.platform === "win32")("removes empty writer intent after permission setup fails", async () => {
  const { gate, paths, store } = await storeWithFiles(1)
  const intents = gate(paths[0]!).replace(/\.gate$/, ".writers")
  failedStats.add(intents)
  try {
    await expect(store.writeFile(paths[0]!, { path: paths[0]!, content: "updated" })).rejects.toThrow("Writer intent permission setup failed")
    await expect(readdir(intents)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(store.readFile(paths[0]!)).resolves.toMatchObject({ content: new TextEncoder().encode(paths[0]!) })
  }
  finally {
    failedStats.delete(intents)
  }
})

it.each(["probe", "gate release"])("rejects admission delayed past its deadline during %s", async (stage) => {
  const { gate, paths, root, store } = await storeWithFiles(1)
  const started = Date.now()
  const clock = vi.spyOn(Date, "now").mockReturnValue(started)
  let entered!: () => void
  let resume!: () => void
  const paused = new Promise<void>((resolve) => { entered = resolve })
  const resumed = new Promise<void>((resolve) => { resume = resolve })
  const pauses = stage === "probe" ? pausedProbes : pausedGateRemovals
  pauses.set(gate("docs"), { entered, resume: resumed })
  let result: Promise<unknown> | undefined
  try {
    result = store.readFile(paths[0]!).catch(error => error as Error)
    await paused
    clock.mockReturnValue(started + 10_001)
    resume()
    expect(await result).toMatchObject({ message: expect.stringContaining("Timed out waiting to read Workspace path: docs.") })
    const locks = await readdir(join(root, ".vitehub/locks"))
    expect(locks.filter(name => name.endsWith(".gate"))).toEqual([])
    for (const readers of locks.filter(name => name.endsWith(".readers")))
      expect(await readdir(join(root, ".vitehub/locks", readers))).toEqual([])
  }
  finally {
    clock.mockRestore()
    resume()
    await result
  }
  await expect(store.readFile(paths[0]!)).resolves.toMatchObject({ path: paths[0] })
})

it("reports shared heartbeat failure to every reader after its protected I/O settles", async () => {
  const { gate, paths, root, store } = await storeWithFiles(2)
  const readersDirectory = gate("docs").replace(/\.gate$/, ".readers")
  failedHeartbeats.add(readersDirectory)
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  const resumes: (() => void)[] = []
  const readers: Promise<unknown>[] = []
  try {
    for (const path of paths) {
      let entered!: () => void
      let resume!: () => void
      const reading = new Promise<void>((resolve) => { entered = resolve })
      const resumed = new Promise<void>((resolve) => { resume = resolve })
      resumes.push(resume)
      pausedReads.set(join(root, path), { entered, resume: resumed })
      readers.push(store.readFile(path).catch(error => error as Error))
      await reading
    }
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await readdir(readersDirectory)).toHaveLength(1)
    resumes[0]!()
    expect(await readers[0]).toMatchObject({ message: "Shared reader heartbeat failed" })
    expect(await readdir(readersDirectory)).toHaveLength(1)
    resumes[1]!()
    expect(await readers[1]).toMatchObject({ message: "Shared reader heartbeat failed" })
    expect(await readdir(readersDirectory).catch(() => [])).toEqual([])
  }
  finally {
    for (const resume of resumes) resume()
    await Promise.all(readers)
    failedHeartbeats.clear()
    vi.useRealTimers()
  }
  await expect(store.readFile(paths[0]!)).resolves.toMatchObject({ path: paths[0] })
})

it("times out readers behind an open local writer and recovers after release", async () => {
  const { paths, store } = await storeWithFiles(1)
  const path = paths[0]!
  let entered!: () => void
  let resume!: () => void
  const writing = new Promise<void>((resolve) => { entered = resolve })
  const resumed = new Promise<void>((resolve) => { resume = resolve })
  const writer = store.writeFileStream!(path, {
    path,
    content: (async function* () {
      entered()
      await resumed
      yield new TextEncoder().encode("updated")
    })(),
  })
  await writing
  let watchdog!: ReturnType<typeof setTimeout>
  try {
    const started = Date.now()
    const readers = Promise.all([
      expect(store.readFile(path)).rejects.toThrow(`Timed out waiting to read Workspace path: ${path}.`),
      expect(store.stat(path)).rejects.toThrow(`Timed out waiting to read Workspace path: ${path}.`),
    ])
    await Promise.race([
      readers,
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("Readers did not respect the lock deadline")), 11_500)
      }),
    ])
    expect(Date.now() - started).toBeGreaterThanOrEqual(10_000)
  }
  finally {
    clearTimeout(watchdog)
    resume()
    await writer
  }
  await expect(store.readFile(path)).resolves.toMatchObject({ content: new TextEncoder().encode("updated") })
  await expect(store.stat(path)).resolves.toMatchObject({ path })
}, 20_000)

it.each([false, true])("preserves the read deadline during admission, joining an existing batch: %s", async (joinBatch) => {
  const { gate, paths, store } = await storeWithFiles(1)
  const writerGate = gate("docs")
  const started = Date.now()
  const clock = vi.spyOn(Date, "now").mockReturnValue(started)
  const readers: Promise<unknown>[] = []
  const resumes: (() => void)[] = []
  const pausedReader = async () => {
    let entered!: () => void
    let resume!: () => void
    const probed = new Promise<void>((resolve) => { entered = resolve })
    const continued = new Promise<void>((resolve) => { resume = resolve })
    resumes.push(resume)
    pausedProbes.set(writerGate, { entered, resume: continued })
    const result = store.readFile(paths[0]!).catch(error => error as Error)
    readers.push(result)
    await probed
    return { result, resume }
  }
  let watchdog!: ReturnType<typeof setTimeout>
  try {
    const older = await pausedReader()
    clock.mockReturnValue(started + 9_000)
    const younger = joinBatch ? await pausedReader() : undefined
    await mkdir(writerGate)
    gateAttempts.clear()
    younger?.resume()
    if (younger) {
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(gateAttempts.get(writerGate)).toBeGreaterThan(0)
    }
    older.resume()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(gateAttempts.get(writerGate)).toBeGreaterThan(0)
    clock.mockReturnValue(started + 10_001)
    const results = await Promise.race([
      Promise.all(readers),
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("Reader admission restarted the lock deadline")), 1_000)
      }),
    ])
    for (const result of results) {
      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).toContain("Timed out waiting to read Workspace path: docs.")
    }
  }
  finally {
    clearTimeout(watchdog)
    clock.mockRestore()
    for (const resume of resumes) resume()
    await rm(writerGate, { recursive: true, force: true })
    await Promise.all(readers)
  }
  await expect(store.readFile(paths[0]!)).resolves.toMatchObject({ path: paths[0] })
}, 10_000)

it("shares one directory read registration across parallel reads", async () => {
  const { gate, paths, root, store } = await storeWithFiles(32)
  gateAttempts.clear()

  const files = await Promise.all(paths.map(path => store.readFile(path)))

  expect(files).toMatchObject(paths.map(path => ({ path, content: new TextEncoder().encode(path) })))
  // Each unshared read registers and later unregisters through the gate, so
  // one attempt per read or more means parallel reads still contend for it.
  expect(gateAttempts.get(gate("docs"))).toBeLessThan(paths.length)
  expect(gateAttempts.get(gate("docs/guide"))).toBeLessThan(paths.length)
  const locks = await readdir(join(root, ".vitehub/locks"))
  expect(locks.filter(name => name.endsWith(".gate"))).toEqual([])
  for (const readers of locks.filter(name => name.endsWith(".readers")))
    expect(await readdir(join(root, ".vitehub/locks", readers))).toEqual([])
}, 60_000)

it("lets a cross-process writer drain a shared lease before later reads", async () => {
  const { gate, paths, root, store } = await storeWithFiles(2)
  let entered!: () => void
  let resume!: () => void
  const reading = new Promise<void>((resolve) => { entered = resolve })
  const resumed = new Promise<void>((resolve) => { resume = resolve })
  pausedReads.set(join(root, paths[0]!), { entered, resume: resumed })
  const first = store.readFile(paths[0]!)
  await reading

  // An independent writer takes the filesystem gate without pendingWriters
  // in this process, then waits for the existing reader marker to drain.
  const writerGate = gate("docs")
  await mkdir(writerGate)
  let completed = false
  const later = store.readFile(paths[1]!).then(file => { completed = true; return file })
  try {
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(completed).toBe(false)
    resume()
    await first
    const readers = writerGate.replace(/\.gate$/, ".readers")
    expect(await readdir(readers)).toEqual([])
    await writeFile(join(root, paths[1]!), "updated by independent writer")
  }
  finally {
    resume()
    await first
    await rm(writerGate, { recursive: true, force: true })
    await later
  }
  expect(await later).toMatchObject({ content: new TextEncoder().encode("updated by independent writer") })
}, 20_000)

it("does not attach a reader when a writer takes the gate after its probe", async () => {
  const { gate, paths, root, store } = await storeWithFiles(2)
  let entered!: () => void
  let resume!: () => void
  const reading = new Promise<void>((resolve) => { entered = resolve })
  const resumed = new Promise<void>((resolve) => { resume = resolve })
  pausedReads.set(join(root, paths[0]!), { entered, resume: resumed })
  const first = store.readFile(paths[0]!)
  await reading

  let probed!: () => void
  let continueProbe!: () => void
  const probe = new Promise<void>((resolve) => { probed = resolve })
  const continued = new Promise<void>((resolve) => { continueProbe = resolve })
  const writerGate = gate("docs")
  pausedProbes.set(writerGate, { entered: probed, resume: continued })
  let completed = false
  const later = store.readFile(paths[1]!).then(file => { completed = true; return file })
  await probe
  await mkdir(writerGate)
  try {
    continueProbe()
    resume()
    await first
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(completed).toBe(false)
    expect(await readdir(writerGate.replace(/\.gate$/, ".readers"))).toEqual([])
    await writeFile(join(root, paths[1]!), "written after probe")
  }
  finally {
    continueProbe()
    resume()
    await first
    await rm(writerGate, { recursive: true, force: true })
    await later
  }
  expect(await later).toMatchObject({ content: new TextEncoder().encode("written after probe") })
}, 20_000)

it("rolls back shared reader admission when gate cleanup fails", async () => {
  const { gate, paths, root, store } = await storeWithFiles(2)
  let entered!: () => void
  let resume!: () => void
  const reading = new Promise<void>((resolve) => { entered = resolve })
  const resumed = new Promise<void>((resolve) => { resume = resolve })
  pausedReads.set(join(root, paths[0]!), { entered, resume: resumed })
  const first = store.readFile(paths[0]!)
  await reading
  const admissionGate = gate("docs")
  failedGateRemovals.set(admissionGate, 3)
  try {
    await expect(store.readFile(paths[1]!)).rejects.toThrow("Admission gate removal failed")
    resume()
    await first
    expect(await readdir(admissionGate.replace(/\.gate$/, ".readers"))).toEqual([])
  }
  finally {
    resume()
    await first
    await rm(admissionGate, { recursive: true, force: true })
  }
  await expect(store.readFile(paths[1]!)).resolves.toMatchObject({ path: paths[1] })
}, 20_000)

it("lets a writer pass continuous shared reads in the same process", async () => {
  const { paths, store } = await storeWithFiles(16)
  let reading = true
  const readers = Array.from({ length: 8 }, async () => {
    while (reading) await Promise.all(paths.map(path => store.readFile(path)))
  })

  try {
    await new Promise(resolve => setTimeout(resolve, 50))
    const started = Date.now()
    await store.rm("docs/guide", { recursive: true })
    expect(Date.now() - started).toBeLessThan(5_000)
  }
  finally {
    reading = false
    await Promise.all(readers)
  }
  await expect(store.readFile(paths[0]!)).resolves.toBeUndefined()
}, 60_000)
