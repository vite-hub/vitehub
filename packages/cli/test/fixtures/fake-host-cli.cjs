// A fake wrangler, vercel, netlify, and deno for `vitehub deploy` tests. It never reaches a host.
// Each run appends `{ name, argv, stdin, cwd }` to FAKE_HOST_LOG and keeps its state in FAKE_HOST_STATE.
// FAKE_HOST_FAIL names a step that exits 1, such as "wrangler secret list".
const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs")
const { dirname, join, resolve } = require("node:path")

const name = process.env.FAKE_HOST_NAME
const argv = process.argv.slice(2)
const stateFile = process.env.FAKE_HOST_STATE
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { secrets: {}, deploys: 0 }
const save = () => writeFileSync(stateFile, JSON.stringify(state))
const step = `${name} ${argv.filter(arg => !arg.startsWith("-")).slice(0, 2).join(" ")}`.trim()
const flag = key => {
  const index = argv.indexOf(key)
  return index === -1 ? undefined : argv[index + 1]
}

function readStdin() {
  try {
    return readFileSync(0, "utf8")
  }
  catch {
    return ""
  }
}

const usesStdin = /secret put|env add|env load/u.test(argv.join(" "))
const stdin = usesStdin ? readStdin() : ""
appendFileSync(process.env.FAKE_HOST_LOG, `${JSON.stringify({ argv, cwd: process.cwd(), name, stdin })}\n`)
if ((process.env.FAKE_HOST_FAIL ?? "").split(",").includes(step)) {
  process.stderr.write(`${step} failed\n`)
  process.exit(1)
}

function wrangler() {
  if (argv[0] === "secret" && argv[1] === "put") {
    state.secrets[argv[2]] = stdin
    save()
    process.stdout.write(`Success! Uploaded secret ${argv[2]}\n`)
    return
  }
  if (argv[0] === "secret" && argv[1] === "list") {
    process.stdout.write(JSON.stringify(Object.keys(state.secrets).map(key => ({ name: key, type: "secret_text" }))))
    return
  }
  const preview = argv[0] === "versions"
  const config = JSON.parse(readFileSync(resolve(flag("--config")), "utf8"))
  // Wrangler prints the value of each plain var in its bindings table.
  for (const [key, value] of Object.entries(config.vars ?? {})) process.stdout.write(`env.${key} ("${value}")  Environment Variable\n`)
  if (argv.includes("--temporary")) {
    process.stderr.write("Temporary account ready:\n  Account: temp (created)\n  Claim within: 59 minutes\n  Claim URL: https://dash.cloudflare.com/claim/abc123\n")
  }
  state.deploys++
  save()
  const url = `https://${config.name}.example.workers.dev`
  process.stdout.write(`Uploaded ${config.name}\n${preview ? "Worker Version Preview URL: https://v1-" + config.name + ".example.workers.dev" : url}\nCurrent Version ID: version-${state.deploys}\n`)
  const entry = preview
    ? { type: "version-upload", version: 1, worker_name: config.name, version_id: `version-${state.deploys}`, preview_url: `https://v1-${config.name}.example.workers.dev` }
    : { type: "deploy", version: 1, worker_name: config.name, version_id: `version-${state.deploys}`, targets: [url] }
  if (process.env.WRANGLER_OUTPUT_FILE_PATH) appendFileSync(process.env.WRANGLER_OUTPUT_FILE_PATH, `${JSON.stringify(entry)}\n`)
}

function vercel() {
  if (argv[0] === "env" && argv[1] === "add") {
    state.secrets[argv[2]] = stdin
    save()
    process.stderr.write(`Added Environment Variable ${argv[2]}\n`)
    return
  }
  if (argv[0] === "env" && argv[1] === "ls") {
    process.stdout.write(JSON.stringify({ envs: Object.keys(state.secrets).map(key => ({ key, type: "sensitive" })) }))
    return
  }
  state.deploys++
  save()
  if (argv.includes("--temporary")) {
    const file = join(process.cwd(), ".vercel", "anonymous.json")
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ claimUrl: "https://vercel.com/claim/xyz", expiresAt: Date.UTC(2026, 10, 7), projectId: "prj_temp", token: "anonymous-token" }))
  }
  process.stderr.write("Deploying\n")
  process.stdout.write(JSON.stringify({ status: "ok", deployment: { id: `dpl_${state.deploys}`, url: "https://my-app-abc.vercel.app", productionUrl: "https://my-app.vercel.app" } }, null, 2))
}

function netlify() {
  state.deploys++
  save()
  process.stdout.write(JSON.stringify({ site_id: "site-1", site_name: flag("--site-name") ?? "my-app", deploy_id: `deploy-${state.deploys}`, deploy_url: "https://deploy--my-app.netlify.app", ...(argv.includes("--prod") ? { url: "https://my-app.netlify.app" } : {}) }))
}

function deno() {
  if (argv[0] === "deploy" && argv[1] === "env" && argv[2] === "load") {
    if (!state.denoApp) process.exit(4)
    const [key, value] = stdin.trim().split("=")
    state.secrets[key] = value
    save()
    process.stdout.write(JSON.stringify({ file: argv[3], added: [key], updated: [], skipped: [] }))
    return
  }
  if (argv[0] === "deploy" && argv[1] === "env" && argv[2] === "list") {
    if (!state.denoApp) {
      process.stderr.write(JSON.stringify({ error: { code: "NOT_FOUND", message: "app not found" } }))
      process.exit(4)
    }
    process.stdout.write(JSON.stringify(Object.keys(state.secrets).map(key => ({ key, isSecret: true, value: null }))))
    return
  }
  if (argv[0] === "deploy" && argv[1] === "create") {
    if (state.denoApp) process.exit(5)
    state.denoApp = true
  }
  state.deploys++
  save()
  process.stdout.write(`Deployed\nhttps://${process.env.DENO_DEPLOY_APP}.${process.env.DENO_DEPLOY_ORG}.deno.net\n`)
}

({ deno, netlify, vercel, wrangler })[name]()
