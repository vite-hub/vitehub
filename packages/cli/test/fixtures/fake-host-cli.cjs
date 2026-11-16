// A fake wrangler, vercel, netlify, and deno for `vitehub deploy` tests. It never reaches a host.
// Each run appends `{ name, argv, stdin, cwd }` to FAKE_HOST_LOG and keeps its state in FAKE_HOST_STATE.
// FAKE_HOST_FAIL names a step that exits 1, such as "wrangler secret list". FAKE_HOST_ECHO_STDIN prints stdin then.
const { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } = require("node:fs")
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
const stdin = name === "deno" && argv[2] === "load" ? readFileSync(argv[3], "utf8") : usesStdin ? readStdin() : ""
const config = name === "wrangler" ? flag("--config") : name === "vercel" && argv[0] === "deploy" ? ".vercel/output/functions/__server.func/.vc-config.json" : undefined
const generated = config ? JSON.parse(readFileSync(resolve(config), "utf8")) : undefined
// `--secrets-file` of `wrangler deploy` and `wrangler versions upload`: its mode and values while the run lasts.
const secretsPath = name === "wrangler" ? flag("--secrets-file") : undefined
const secretsFile = secretsPath && existsSync(resolve(secretsPath))
  ? { path: resolve(secretsPath), mode: statSync(resolve(secretsPath)).mode & 0o777, values: JSON.parse(readFileSync(resolve(secretsPath), "utf8")) }
  : secretsPath ? { path: resolve(secretsPath), missing: true } : undefined
appendFileSync(process.env.FAKE_HOST_LOG, `${JSON.stringify({ argv, cwd: process.cwd(), name, stdin, generated, secretsFile, accountId: process.env.CLOUDFLARE_ACCOUNT_ID })}\n`)
if (process.env.FAKE_HOST_ECHO_TOKEN) {
  const token = process.env.CLOUDFLARE_API_TOKEN ?? process.env.VERCEL_TOKEN ?? process.env.NETLIFY_AUTH_TOKEN ?? process.env.DENO_DEPLOY_TOKEN
  process.stdout.write(`stdout token: ${token}\n`)
  process.stderr.write(`stderr token: ${token}\n`)
}
if ((process.env.FAKE_HOST_FAIL ?? "").split(",").includes(step)) {
  // A host CLI may echo what it read in an error, so tests check that the CLI redacts it.
  if (process.env.FAKE_HOST_ECHO_STDIN) process.stderr.write(`could not read value: ${stdin}\n`)
  process.stderr.write(`${step} failed\n`)
  process.exit(1)
}

function wrangler() {
  if (argv[0] === "secret" && argv[1] === "put") {
    state.secrets[argv[2]] = stdin
    state.uploadedSecrets = { ...state.secrets }
    save()
    process.stdout.write(`Success! Uploaded secret ${argv[2]}\n`)
    return
  }
  if (argv[0] === "secret" && argv[1] === "list") {
    process.stdout.write(JSON.stringify(Object.keys(state.uploadedSecrets ?? state.secrets).map(key => ({ name: key, type: "secret_text" }))))
    return
  }
  if (argv[0] === "d1" && argv[1] === "migrations" && argv[2] === "apply") {
    process.stdout.write("✅ No migrations to apply!\n")
    return
  }
  const preview = argv[0] === "versions"
  const config = JSON.parse(readFileSync(resolve(flag("--config")), "utf8"))
  config.name = flag("--name") ?? config.name
  // Wrangler prints the value of each plain var in its bindings table.
  for (const [key, value] of Object.entries(config.vars ?? {})) process.stdout.write(`env.${key} ("${value}")  Environment Variable\n`)
  if (argv.includes("--temporary")) {
    process.stderr.write("Temporary account ready:\n  Account: temp (created)\n  Claim within: 59 minutes\n  Claim URL: https://dash.cloudflare.com/claim/abc123\n")
  }
  // Inheritance uses the latest uploaded version, even if that version was never deployed.
  state.uploadedSecrets = { ...(state.uploadedSecrets ?? state.secrets), ...secretsFile?.values }
  if (!preview) state.secrets = { ...state.uploadedSecrets }
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
  // Variables live in `state.vercel[environment]`, as Vercel keeps one value for each environment.
  if (argv[0] === "env" && argv[1] === "add") {
    const environment = flag("--environment")
    state.vercel = state.vercel ?? {}
    state.vercel[environment] = { ...state.vercel[environment], [argv[2]]: stdin }
    save()
    process.stderr.write(`Added Environment Variable ${argv[2]} to Project ${flag("--project")} [${environment}]\n`)
    return
  }
  if (argv[0] === "env" && argv[1] === "ls") {
    const environment = flag("--environment")
    // `--json` prints readable values, as Vercel CLI 65 does for plain variables.
    const envs = Object.entries(state.vercel?.[environment] ?? {}).map(([key, value]) => ({ key, target: [environment], type: "plain", value }))
    process.stdout.write(JSON.stringify({ envs }))
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
  // `env:list --json` prints `{ KEY: value }` for one context. Tests write `state.netlify[context]` through the API fake.
  if (argv[0] === "env:list") {
    process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(state.netlify?.[flag("--context")] ?? {}).filter(([key]) => flag("--scope") !== "functions" || (state.netlifyScopes?.[key] ?? ["functions"]).includes("functions")))))
    return
  }
  state.deploys++
  save()
  process.stdout.write(JSON.stringify({ site_id: "site-1", site_name: flag("--site-name") ?? "my-app", deploy_id: `deploy-${state.deploys}`, deploy_url: "https://deploy--my-app.netlify.app", ...(argv.includes("--prod") ? { url: "https://my-app.netlify.app" } : {}) }))
}

function deno() {
  // `deno deploy deployments list` and `deno deploy apps get` print FAKE_DENO_DEPLOYMENTS and FAKE_DENO_APP.
  if (argv[0] === "deploy" && argv[1] === "deployments" && argv[2] === "list") {
    process.stdout.write(process.env.FAKE_DENO_DEPLOYMENTS ?? JSON.stringify({ items: [], nextCursor: null }))
    return
  }
  if (argv[0] === "deploy" && argv[1] === "apps" && argv[2] === "get") {
    process.stdout.write(process.env.FAKE_DENO_APP ?? JSON.stringify({ productionRevisionId: null, productionUrl: null }))
    return
  }
  if (argv[0] === "deploy" && argv[1] === "env" && argv[2] === "load") {
    if (!state.denoApp) process.exit(4)
    // One `KEY='value'` line, as @std/dotenv reads a single-quoted value.
    const match = /^(\w+)='([^']*)'\n$/u.exec(stdin)
    if (!match) {
      process.stderr.write("could not parse the dotenv file\n")
      process.exit(1)
    }
    const existed = match[1] in state.secrets
    if (existed && !argv.includes("--replace")) {
      process.stderr.write("Existing env vars found and prompting is disabled.\n")
      process.exit(1)
    }
    state.secrets[match[1]] = match[2]
    save()
    process.stdout.write(JSON.stringify({ file: argv[3], added: existed ? [] : [match[1]], updated: existed ? [match[1]] : [], skipped: [] }))
    return
  }
  if (argv[0] === "deploy" && argv[1] === "env" && argv[2] === "list") {
    if (!state.denoApp) {
      process.stderr.write(JSON.stringify({ error: { code: "NOT_FOUND", message: "app not found" } }))
      process.exit(4)
    }
    process.stdout.write(JSON.stringify(Object.keys(state.uploadedSecrets ?? state.secrets).map(key => ({ key, isSecret: true, value: null }))))
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
