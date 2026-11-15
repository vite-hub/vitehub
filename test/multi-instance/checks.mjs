// The checks of the multi-instance harness. Each check returns { status: "pass" | "fail", detail }.
// `context` is built in run.mjs `main()`: the instances, their boot results, the oracle `sql` client, and `stop(name)`.
import { randomUUID } from "node:crypto"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

const pass = detail => ({ detail, status: "pass" })
const fail = detail => ({ detail, status: "fail" })

async function request(instance, path, init) {
  const response = await fetch(`${instance.origin}${path}`, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} on ${instance.name} answered ${response.status}: ${text.slice(0, 300)}`)
  return JSON.parse(text)
}

const post = (instance, path, body) => request(instance, path, { body: JSON.stringify(body), method: "POST" })

/** Waits until `read` returns a value that `done` accepts, or until no progress for `idleMs`. Returns the last value. */
async function settle(read, done, { idleMs = 15_000, timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = await read()
  let lastChange = Date.now()
  while (!done(last) && Date.now() < deadline && Date.now() - lastChange < idleMs) {
    await sleep(500)
    const next = await read()
    if (JSON.stringify(next) !== JSON.stringify(last)) lastChange = Date.now()
    last = next
  }
  return last
}

function bootFailures(context) {
  return context.instances.filter((_, index) => !context.boot[index].ok).map(instance => instance.name)
}

/** Fails a check early when one of the instances it needs did not start. */
function needInstances(context, names) {
  const down = bootFailures(context).filter(name => names.includes(name))
  if (down.length) throw new Error(`instance ${down.join(", ")} did not start (see the boot check)`)
  return names.map(name => context.instances.find(instance => instance.name === name))
}

const distribution = rows => rows.map(row => `${row.instance}=${row.count}`).join(" ") || "none"

export const checks = [
  {
    id: "boot",
    title: "three instances start and answer /api/health",
    async run(context) {
      const failed = context.instances.flatMap((instance, index) =>
        context.boot[index].ok ? [] : [`${instance.name}: ${context.boot[index].error}`])
      if (failed.length) return fail(failed.join("\n"))
      // The build and every instance must see REDIS_URL only in the Redis mode, even when the shell sets it.
      const expected = context.mode === "with-redis" ? "set" : "unset"
      const wrong = []
      for (const instance of context.instances) {
        const health = await request(instance, "/api/health")
        if (health.buildRedis !== expected) wrong.push(`the build saw REDIS_URL ${health.buildRedis}`)
        if (health.serverRedis !== expected) wrong.push(`${instance.name} saw REDIS_URL ${health.serverRedis}`)
      }
      if (wrong.length) return fail(`${context.mode}: ${[...new Set(wrong)].join(", ")}`)
      return pass(`a, b and c answer, REDIS_URL ${expected} in the build and the instances`)
    },
  },
  {
    id: "queue-once",
    title: "1,000 jobs each run exactly once",
    async run(context) {
      const [a] = needInstances(context, ["a", "b", "c"])
      const run = randomUUID().slice(0, 8)
      const ids = Array.from({ length: 1000 }, (_, index) => `${run}-${index}`)
      for (let start = 0; start < ids.length; start += 100) {
        const { errors } = await post(a, "/api/queue", { ids: ids.slice(start, start + 100) })
        if (errors.length) return fail(`sendQueue failed: ${errors[0]}`)
      }
      const read = async () => {
        const [totals] = await context.sql`select count(*)::int as total, count(distinct key)::int as distinct from oracle_events where kind = 'job' and key like ${`${run}-%`}`
        return totals
      }
      await settle(read, value => value.distinct === ids.length)
      // Wait a little longer, so a duplicate run has time to show up.
      await sleep(2000)
      const final = await read()
      const byInstance = await context.sql`select instance, count(*)::int as count from oracle_events where kind = 'job' and key like ${`${run}-%`} group by instance order by instance`
      // The spread is information only. One instance may take every job from a correct shared queue.
      const detail = `${final.distinct}/${ids.length} jobs ran, ${final.total} runs (spread: ${distribution(byInstance)})`
      return final.distinct === ids.length && final.total === ids.length ? pass(detail) : fail(detail)
    },
  },
  {
    id: "rate-limit-shared",
    title: "a 10 per minute limit allows exactly 10 of 60 concurrent requests across all instances",
    async run(context) {
      const instances = needInstances(context, ["a", "b", "c"])
      // The window is the clock minute. Start early in a minute so all requests fall in one window.
      if (new Date().getSeconds() > 45) await sleep((61 - new Date().getSeconds()) * 1000)
      const key = randomUUID()
      // Two batches of 30 requests in flight at the same time, 10 on each instance.
      // A store that reads and then writes lets more than 10 through.
      let allowed = 0
      for (let batch = 0; batch < 2; batch++) {
        const answers = await Promise.all(Array.from({ length: 30 }, (_, index) =>
          request(instances[index % 3], `/api/rate-limit?key=${key}`)))
        allowed += answers.filter(answer => answer.allowed).length
      }
      const detail = `${allowed} of 60 concurrent requests allowed over a, b and c (limit 10)`
      return allowed === 10 ? pass(detail) : fail(detail)
    },
  },
  {
    id: "realtime-fanout",
    title: "a Realtime message sent on A reaches a peer on B",
    async run(context) {
      const [a, b] = needInstances(context, ["a", "b"])
      const Y = context.appRequire("yjs")
      const { WebsocketProvider } = context.appRequire("y-websocket")
      const WebSocket = context.appRequire("ws")
      const room = `room-${randomUUID().slice(0, 8)}`
      const token = randomUUID()
      const connect = instance => new WebsocketProvider(
        `${instance.origin.replace("http", "ws")}/api/_vitehub/realtime/notes`,
        room,
        new Y.Doc(),
        { WebSocketPolyfill: WebSocket, disableBc: true },
      )
      const sender = connect(a)
      // A second peer on A is the control: it proves the client and the room work on one instance.
      const control = connect(a)
      const peer = connect(b)
      const providers = [sender, control, peer]
      const sees = provider => [...provider.awareness.getStates().values()].some(state => state.token === token)
      try {
        const synced = await waitFor(() => providers.every(provider => provider.synced), 15_000)
        if (!synced) return fail(`peers did not sync with their rooms: ${providers.map(provider => provider.synced).join(", ")}`)
        sender.awareness.setLocalStateField("token", token)
        await waitFor(() => sees(control) && sees(peer), 5000)
        if (!sees(control)) return fail("the control peer on A did not get the message, so the room does not relay on one instance")
        if (!sees(peer)) return fail("the peer on B did not get the message from A in 5 s (the control peer on A did)")
        return pass("the peer on B got the message from A")
      }
      finally {
        for (const provider of providers) provider.destroy()
      }
    },
  },
  {
    id: "schedule-once",
    title: "each schedule occurrence runs once across instances",
    async run(context) {
      needInstances(context, ["a", "b", "c"])
      // The cron runs every minute. Wait for one occurrence after all instances started, plus time for late runs.
      const after = new Date(context.startedAt)
      const read = () => context.sql`select key, count(*)::int as count, string_agg(instance, '' order by instance) as instances from oracle_events where kind = 'schedule' and key::timestamptz > ${after} group by key order by key`
      const rows = await settle(read, value => value.length > 0, { idleMs: 75_000, timeoutMs: 75_000 })
      if (!rows.length) return fail("no occurrence ran in 75 s")
      await sleep(10_000)
      const final = await read()
      const detail = final.map(row => `${row.key.slice(11, 16)}: ${row.count} run(s) on ${row.instances}`).join(", ")
      return final.every(row => row.count === 1) ? pass(detail) : fail(detail)
    },
  },
  {
    id: "migrations-once",
    title: "three cold starts apply the Database migrations once",
    async run(context) {
      needInstances(context, ["a", "b", "c"])
      const journal = await readdir(join(context.appDir, "server/databases/default/migrations"), { withFileTypes: true })
      const expected = journal.filter(entry => entry.isDirectory() && /^\d{14}_/.test(entry.name)).length
      const [state] = await context.sql`select to_regclass('drizzle.__drizzle_migrations') is not null as ledger, to_regclass('public.notes') is not null as notes`
      const applied = state.ledger ? (await context.sql`select count(*)::int as count from drizzle.__drizzle_migrations`)[0].count : 0
      const queries = await Promise.all(context.instances.map(instance =>
        request(instance, "/api/notes").then(() => "ok", () => "error")))
      const failed = context.instances.filter((_, index) => queries[index] !== "ok").map(instance => instance.name)
      const detail = [
        `${applied} of ${expected} migrations in the ledger`,
        `table notes ${state.notes ? "exists" : "is missing"}`,
        failed.length ? `/api/notes failed on ${failed.join(", ")}` : "/api/notes works on a, b and c",
      ].join(", ")
      return applied === expected && !failed.length ? pass(detail) : fail(detail)
    },
  },
  {
    id: "kv-shared",
    title: "a KV write on A is read on B",
    async run(context) {
      const [a, b] = needInstances(context, ["a", "b"])
      const key = `kv-${randomUUID()}`
      await post(a, "/api/kv", { key, value: "from-a" })
      const { value } = await request(b, `/api/kv?key=${key}`)
      return value === "from-a" ? pass("B read the value that A wrote") : fail(`B read ${JSON.stringify(value)} instead of "from-a"`)
    },
  },
  {
    id: "blob-shared",
    title: "a Blob written on A is read on B (shared store set in the config)",
    async run(context) {
      const [a, b] = needInstances(context, ["a", "b"])
      const path = `blob-${randomUUID()}.txt`
      await post(a, "/api/blob", { path, value: "from-a" })
      const { value } = await request(b, `/api/blob?path=${path}`)
      return value === "from-a" ? pass("B read the Blob that A wrote") : fail(`B read ${JSON.stringify(value)} instead of "from-a"`)
    },
  },
  {
    id: "workflow-shared",
    title: "a Workflow started on A completes once and B reads its result (OpenWorkflow set in the config)",
    async run(context) {
      const [a, b] = needInstances(context, ["a", "b", "c"])
      const workers = await context.sql`select instance, key from oracle_events where kind = 'worker' order by instance`
      const started = workers.filter(row => row.key === "started").map(row => row.instance)
      const token = randomUUID()
      const { id } = await post(a, "/api/workflow", { token })
      const run = await settle(() => request(b, `/api/workflow?id=${id}`), value => value.status === "completed" || value.status === "failed", { timeoutMs: 60_000 })
      const [{ count }] = await context.sql`select count(*)::int as count from oracle_events where kind = 'workflow' and key = ${token}`
      const detail = [
        `workers started on ${started.join(", ") || "no instance"}`,
        `status ${run.status} on B with result ${JSON.stringify(run.result)}`,
        `the body ran ${count} time(s)`,
      ].join(", ")
      const ok = started.length === 3 && run.status === "completed" && run.result?.token === token && count === 1
      return ok ? pass(detail) : fail(detail)
    },
  },
  // Keep this check last: it stops instance A.
  {
    id: "queue-failover",
    title: "jobs queued on A run on another instance after A stops",
    async run(context) {
      const [a] = needInstances(context, ["a", "b", "c"])
      const run = randomUUID().slice(0, 8)
      const ids = Array.from({ length: 20 }, (_, index) => `${run}-${index}`)
      // The delay keeps every job waiting while A stops, so no job is half done on A.
      const { errors } = await post(a, "/api/queue", { delaySeconds: 5, ids })
      if (errors.length) return fail(`sendQueue failed: ${errors[0]}`)
      await context.stop("a")
      const read = async () => {
        const [totals] = await context.sql`select count(*)::int as total, count(distinct key)::int as distinct from oracle_events where kind = 'job' and key like ${`${run}-%`}`
        return totals
      }
      const final = await settle(read, value => value.distinct === ids.length, { idleMs: 20_000, timeoutMs: 60_000 })
      const byInstance = await context.sql`select instance, count(*)::int as count from oracle_events where kind = 'job' and key like ${`${run}-%`} group by instance order by instance`
      const detail = `${final.distinct}/${ids.length} delayed jobs ran after A stopped, ${final.total} runs (spread: ${distribution(byInstance)})`
      return final.distinct === ids.length && final.total === ids.length ? pass(detail) : fail(detail)
    },
  },
]

async function waitFor(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) return false
    await sleep(100)
  }
  return true
}
