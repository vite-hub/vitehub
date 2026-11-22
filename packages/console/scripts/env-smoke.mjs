import { createHash, randomBytes, randomUUID } from "node:crypto"

import { check, json, request } from "./smoke.mjs"

export const envKey = () => randomBytes(32).toString("hex")

const apiKey = () => `vhk_${randomBytes(32).toString("base64url")}`
const literal = value => value === null ? "NULL" : typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`
const insert = (table, row) => `INSERT INTO "${table}" (${Object.keys(row).map(name => `"${name}"`).join(", ")}) VALUES (${Object.values(row).map(literal).join(", ")});`

export async function seedOwner(sql) {
  const run = randomUUID().slice(0, 8)
  const now = Date.now()
  const teamId = `smoke-team-${run}`
  const people = { member: { key: apiKey(), userId: `smoke-member-${run}` }, owner: { key: apiKey(), userId: `smoke-owner-${run}` } }
  const statements = [
    insert("organization", { created_at: now, id: teamId, name: "Host smoke", slug: teamId }),
  ]
  for (const [role, person] of Object.entries(people)) {
    statements.push(
      insert("user", { created_at: now, email: `${person.userId}@smoke.invalid`, email_verified: 1, id: person.userId, name: `Smoke ${role}`, updated_at: now }),
      insert("member", { created_at: now, id: `${person.userId}-member`, organization_id: teamId, role, user_id: person.userId }),
      insert("console_api_keys", {
        created_at: now,
        expires_at: now + 3_600_000,
        id: `${person.userId}-key`,
        key_hash: createHash("sha256").update(person.key).digest("hex"),
        name: "host smoke",
        project_ids: null,
        start: person.key.slice(0, 8),
        team_id: teamId,
        user_id: person.userId,
      }),
    )
  }
  await sql(statements.join("\n"))
  return { canary: `smoke-${randomBytes(16).toString("hex")}`, kept: `smoke-${randomBytes(16).toString("hex")}`, memberKey: people.member.key, ownerKey: people.owner.key, projectId: undefined }
}

function call(base, key, method, path, body) {
  return request(base, path, {
    method,
    headers: { "authorization": `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }), "origin": new URL(base).origin },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

const env = (ctx, ...parts) => [`/api/projects/${encodeURIComponent(ctx.projectId)}/env`, ...parts.map(encodeURIComponent)].join("/")

function problem(result, status, code, what) {
  check(result.response.status === status, `${what} answered ${result.response.status}, not ${status}: ${result.text.slice(0, 300)}`)
  check(json(result.text, what).code === code, `${what} answered ${result.text.slice(0, 300)}, not ${code}`)
}

export const envOffChecks = [
  ["links a project with an owner API key", async (base, ctx) => {
    const linked = await call(base, ctx.ownerKey, "POST", "/api/projects", { label: "Host smoke", url: "https://host-smoke.example.com" })
    check(linked.response.status === 201, `POST /api/projects with an API key answered ${linked.response.status}: ${linked.text.slice(0, 300)}`)
    ctx.projectId = json(linked.text, "/api/projects").project?.id
    check(typeof ctx.projectId === "string", `POST /api/projects answered no project id: ${linked.text.slice(0, 300)}`)
  }],
  ["answers CONSOLE_ENV_VALUES_OFF on every env route while values are off", async (base, ctx) => {
    for (const [method, path, body] of [
      ["GET", env(ctx)],
      ["GET", env(ctx, "production")],
      ["PUT", env(ctx, "production", "SMOKE_TOKEN"), { value: ctx.canary }],
      ["POST", env(ctx, "production", "reveal"), {}],
    ]) {
      const result = await call(base, ctx.ownerKey, method, path, body)
      problem(result, 404, "CONSOLE_ENV_VALUES_OFF", `${method} ${path}`)
      check(!result.text.includes("console.vitehub.dev"), `${method} ${path} speaks about console.vitehub.dev: ${result.text}`)
    }
  }],
]

export const envOnChecks = [
  ["lists the stages, and no value that was sent while values were off", async (base, ctx) => {
    const stages = await call(base, ctx.ownerKey, "GET", env(ctx))
    check(stages.response.status === 200, `GET ${env(ctx)} answered ${stages.response.status}: ${stages.text.slice(0, 300)}`)
    check(JSON.stringify(json(stages.text, env(ctx)).stages) === JSON.stringify(["production", "preview"]), `GET ${env(ctx)} answered ${stages.text}`)
    const listed = json((await call(base, ctx.ownerKey, "GET", env(ctx, "production"))).text, env(ctx, "production"))
    check(listed.canReveal === true, `an owner gets canReveal ${listed.canReveal}`)
    check(Array.isArray(listed.variables) && listed.variables.length === 0, `production lists ${JSON.stringify(listed.variables)} before any write`)
  }],
  ["sets a value as an owner", async (base, ctx) => {
    const set = await call(base, ctx.ownerKey, "PUT", env(ctx, "production", "SMOKE_TOKEN"), { value: ctx.canary })
    check(set.response.status === 201, `PUT SMOKE_TOKEN answered ${set.response.status}: ${set.text.slice(0, 300)}`)
    check(json(set.text, "PUT SMOKE_TOKEN").variable?.name === "SMOKE_TOKEN", `PUT SMOKE_TOKEN answered ${set.text}`)
  }],
  ["lists the name and never the value", async (base, ctx) => {
    for (const key of [ctx.ownerKey, ctx.memberKey]) {
      const listed = await call(base, key, "GET", env(ctx, "production"))
      check(listed.response.status === 200, `GET production answered ${listed.response.status}: ${listed.text.slice(0, 300)}`)
      check(json(listed.text, "GET production").variables.some(item => item.name === "SMOKE_TOKEN"), `GET production lists ${listed.text}`)
      check(!listed.text.includes(ctx.canary), "GET production holds the value")
    }
  }],
  ["stores the value sealed in the host database", async (base, ctx, sql) => {
    const rows = await sql(`SELECT key, payload FROM vitehub_env_secrets WHERE namespace = '${ctx.projectId}:production'`)
    check(rows.length === 1 && rows[0].key === "SMOKE_TOKEN", `vitehub_env_secrets holds ${JSON.stringify(rows)}`)
    check(!JSON.stringify(rows).includes(ctx.canary), "vitehub_env_secrets holds the value in plain text")
  }],
  ["reveals the value to an owner", async (base, ctx) => {
    const revealed = await call(base, ctx.ownerKey, "POST", env(ctx, "production", "reveal"), { names: ["SMOKE_TOKEN"] })
    check(revealed.response.status === 200, `POST reveal answered ${revealed.response.status}: ${revealed.text.slice(0, 300)}`)
    check(json(revealed.text, "POST reveal").values?.SMOKE_TOKEN === ctx.canary, "POST reveal did not answer the value that PUT stored")
  }],
  ["refuses writes and reveals to a member", async (base, ctx) => {
    const listed = json((await call(base, ctx.memberKey, "GET", env(ctx, "production"))).text, "GET production")
    check(listed.canReveal === false, `a member gets canReveal ${listed.canReveal}`)
    problem(await call(base, ctx.memberKey, "PUT", env(ctx, "production", "SMOKE_TOKEN"), { value: "member" }), 403, "CONSOLE_ENV_FORBIDDEN", "PUT as a member")
    const revealed = await call(base, ctx.memberKey, "POST", env(ctx, "production", "reveal"), {})
    problem(revealed, 403, "CONSOLE_ENV_FORBIDDEN", "POST reveal as a member")
    check(!revealed.text.includes(ctx.canary), "POST reveal as a member answered the value")
    problem(await call(base, ctx.memberKey, "DELETE", env(ctx, "production", "SMOKE_TOKEN")), 403, "CONSOLE_ENV_FORBIDDEN", "DELETE as a member")
  }],
  ["logs the write and the reveal, without the value", async (base, ctx, sql) => {
    const activity = await call(base, ctx.ownerKey, "GET", env(ctx, "production", "SMOKE_TOKEN", "activity"))
    check(activity.response.status === 200, `GET activity answered ${activity.response.status}: ${activity.text.slice(0, 300)}`)
    const events = json(activity.text, "GET activity").events ?? []
    const rows = events.map(event => `${event.action}:${event.outcome}`)
    check(JSON.stringify(rows) === JSON.stringify(["resolve:succeeded", "resolve:started", "replace:succeeded"]), `the activity of SMOKE_TOKEN has ${JSON.stringify(rows)}`)
    check(events[0].operationId === events[1].operationId, "the started and succeeded rows of the reveal have different operation ids")
    check(events.every(event => event.actor?.id?.startsWith("api-key:") && event.target?.kind === "user"), `the activity names ${JSON.stringify(events.map(event => event.actor))}`)
    check(!activity.text.includes(ctx.canary), "GET activity holds the value")
    const stored = await sql(`SELECT payload FROM vitehub_env_activity WHERE namespace = '${ctx.projectId}:production'`)
    check(stored.length === 3, `vitehub_env_activity has ${stored.length} rows, not 3`)
    check(!JSON.stringify(stored).includes(ctx.canary), "vitehub_env_activity holds the value")
  }],
  ["deletes a value as an owner", async (base, ctx) => {
    const removed = await call(base, ctx.ownerKey, "DELETE", env(ctx, "production", "SMOKE_TOKEN"))
    check(removed.response.status === 204, `DELETE SMOKE_TOKEN answered ${removed.response.status}: ${removed.text.slice(0, 300)}`)
    const listed = await call(base, ctx.ownerKey, "GET", env(ctx, "production"))
    check(!json(listed.text, "GET production").variables.some(item => item.name === "SMOKE_TOKEN"), `GET production still lists SMOKE_TOKEN: ${listed.text}`)
    const revealed = await call(base, ctx.ownerKey, "POST", env(ctx, "production", "reveal"), { names: ["SMOKE_TOKEN"] })
    check(JSON.stringify(json(revealed.text, "POST reveal").values) === "{}", `POST reveal after DELETE answered ${revealed.text}`)
    const activity = json((await call(base, ctx.ownerKey, "GET", env(ctx, "production", "SMOKE_TOKEN", "activity"))).text, "GET activity")
    check(activity.events.some(event => event.action === "remove"), "the activity has no remove event")
  }],
  ["keeps a value for the next start", async (base, ctx) => {
    const set = await call(base, ctx.ownerKey, "PUT", env(ctx, "preview", "SMOKE_KEPT"), { value: ctx.kept })
    check(set.response.status === 201, `PUT SMOKE_KEPT answered ${set.response.status}: ${set.text.slice(0, 300)}`)
  }],
]

export const envOtherKeyChecks = [
  ["lists the names, and answers CONSOLE_ENV_KEY_MISSING for a value that another key sealed", async (base, ctx) => {
    const listed = await call(base, ctx.ownerKey, "GET", env(ctx, "preview"))
    check(json(listed.text, "GET preview").variables?.some(item => item.name === "SMOKE_KEPT"), `GET preview lists ${listed.text.slice(0, 300)}`)
    const revealed = await call(base, ctx.ownerKey, "POST", env(ctx, "preview", "reveal"), { names: ["SMOKE_KEPT"] })
    problem(revealed, 500, "CONSOLE_ENV_KEY_MISSING", "POST reveal with another key")
    check(json(revealed.text, "POST reveal").fix?.includes("VITEHUB_CONSOLE_ENV_KEYS"), `POST reveal with another key has no fix that names VITEHUB_CONSOLE_ENV_KEYS: ${revealed.text.slice(0, 300)}`)
    check(!revealed.text.includes(ctx.kept), "POST reveal with another key answered the value")
  }],
  ["logs the reveal that no key opened as failed", async (base, ctx) => {
    const activity = await call(base, ctx.ownerKey, "GET", env(ctx, "preview", "SMOKE_KEPT", "activity"))
    const events = json(activity.text, "GET activity").events ?? []
    const rows = events.map(event => `${event.action}:${event.outcome}`)
    check(JSON.stringify(rows) === JSON.stringify(["resolve:failed", "resolve:started", "replace:succeeded"]), `the activity of SMOKE_KEPT has ${JSON.stringify(rows)}`)
    check(events[0].operationId === events[1].operationId, "the started and failed rows of the reveal have different operation ids")
  }],
]
