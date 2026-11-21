#!/usr/bin/env node
// Runs coding-agent tasks against the raw docs with and without `::agent-only` content, and optionally with the `vitehub` skill.
// Usage: node evals/agent-docs/run.mjs [--tasks a,b] [--variants agent,baseline,skill] [--repeat 1] [--model sonnet] [--concurrency 2] [--keep]
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { toRawMarkdown } from "@vite-hub/docs/server";
import { capabilityReferences, expandCapabilityTools } from "../../modules/vitehub-docs/capability-references.ts";

const docsRoot = resolve(import.meta.dirname, "../..");
const { values: args } = parseArgs({
  // `pnpm run eval:agent-docs -- --keep` passes the `--` through.
  args: process.argv.slice(2).filter(arg => arg !== "--"),
  options: {
    concurrency: { type: "string", default: "2" },
    keep: { type: "boolean", default: false },
    model: { type: "string", default: "sonnet" },
    repeat: { type: "string", default: "1" },
    tasks: { type: "string" },
    variants: { type: "string", default: "agent,baseline" },
  },
});

const allTasks = JSON.parse(readFileSync(resolve(import.meta.dirname, "tasks.json"), "utf8"));
const taskIds = args.tasks?.split(",");
const tasks = taskIds ? allTasks.filter(task => taskIds.includes(task.id)) : allTasks;
const variants = args.variants.split(",");
const repeat = Number(args.repeat);

function listFiles(root, filter = () => true) {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((entry) => {
    const path = resolve(root, entry);
    if (statSync(path).isDirectory()) return entry === "node_modules" ? [] : listFiles(path, filter);
    return filter(path) ? [path] : [];
  });
}

/** Writes every docs page as `/raw` serves it: `docs/kv/index.md` becomes `docs/kv.md`. */
function writeDocs(target, includeAgentOnly, references) {
  const contentRoot = resolve(docsRoot, "content");
  for (const path of listFiles(resolve(contentRoot, "docs"), file => file.endsWith(".md"))) {
    const destination = resolve(target, relative(contentRoot, path).replace(/\/index\.md$/, ".md"));
    mkdirSync(dirname(destination), { recursive: true });
    const source = expandCapabilityTools(readFileSync(path, "utf8"), references);
    writeFileSync(destination, toRawMarkdown(source, { siteUrl: "https://vitehub.dev", includeAgentOnly }));
  }
}

/** Writes a new Vite app, then the task's `files`, which set the task in an existing app. */
function writeProject(root, files = {}) {
  writeFileSync(resolve(root, "package.json"), `${JSON.stringify({
    name: "eval-app",
    private: true,
    type: "module",
    dependencies: { h3: "^2.0.0", nitro: "^3.0.0", "vite-hub": "latest" },
    devDependencies: { vite: "^8.0.0" },
  }, null, 2)}\n`);
  writeFileSync(resolve(root, "vite.config.ts"), [
    "import { defineConfig } from 'vite'",
    "import { nitro } from 'nitro/vite'",
    "",
    "export default defineConfig({",
    "  plugins: [nitro()],",
    "})",
    "",
  ].join("\n"));
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), source);
  }
}

const instructions = [
  "You are working in a Vite application that uses Nitro for server routes. Dependencies are not installed; do not install them.",
  "The ViteHub documentation is in ./vitehub-docs as Markdown. A link to https://vitehub.dev/docs/<path> or https://vitehub.dev/raw/docs/<path>.md is the file ./vitehub-docs/docs/<path>.md.",
  "Use only those files as the ViteHub reference. Write the code, then stop.",
].join("\n");

const skillInstructions = "The vitehub skill is installed. Use it as well as the docs.";

function runAgent(cwd, prompt, variant) {
  const command = [
    "-p", `${instructions}${variant === "skill" ? `\n${skillInstructions}` : ""}\n\nTask: ${prompt}`,
    "--output-format", "json",
    "--model", args.model,
    "--permission-mode", "bypassPermissions",
    "--setting-sources", "project",
    "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}",
    // The `skill` variant keeps the Skill tool, so the agent can load `.claude/skills/vitehub`.
    "--disallowedTools", "Bash", "WebFetch", "WebSearch", ...(variant === "skill" ? [] : ["Skill"]), "Agent",
    "--no-session-persistence",
  ];
  return new Promise((resolvePromise) => {
    const child = spawn("claude", command, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    child.on("close", (code) => {
      try {
        resolvePromise({ code, ...JSON.parse(stdout) });
      }
      catch {
        resolvePromise({ code, is_error: true, result: stderr || stdout });
      }
    });
  });
}

/** Reads the value at `keys` in a JSON file, so a check can test one parsed field. */
function readJsonValue(source, keys) {
  try {
    const value = keys.reduce((object, key) => object?.[key], JSON.parse(source));
    return typeof value === "string" ? value : "";
  }
  catch {
    return "";
  }
}

function grade(root, checks) {
  const files = listFiles(root).map(path => relative(root, path)).filter(path => !path.startsWith("vitehub-docs/") && !path.startsWith(".claude/"));
  return checks.map((check) => {
    const sources = files.filter(path => new RegExp(check.files).test(path))
      .map(path => readFileSync(resolve(root, path), "utf8"))
      .map(source => check.json ? readJsonValue(source, check.json) : source);
    const found = sources.some(source => new RegExp(check.pattern).test(source));
    return { label: check.label, passed: found === (check.expect ?? true) };
  });
}

const references = await capabilityReferences();
const outputRoot = mkdtempSync(resolve(tmpdir(), "vitehub-agent-docs-eval-"));
const jobs = tasks.flatMap(task => variants.flatMap(variant => Array.from({ length: repeat }, (_, attempt) => ({ attempt, task, variant }))));
const results = [];

async function runJob({ attempt, task, variant }) {
  const root = resolve(outputRoot, `${task.id}-${variant}-${attempt}`);
  mkdirSync(root, { recursive: true });
  writeProject(root, task.files);
  writeDocs(resolve(root, "vitehub-docs"), variant !== "baseline", references);
  if (variant === "skill") cpSync(resolve(docsRoot, "skills/vitehub"), resolve(root, ".claude/skills/vitehub"), { recursive: true });
  const started = Date.now();
  const run = await runAgent(root, task.prompt, variant);
  const checks = grade(root, task.checks);
  const result = {
    attempt,
    checks,
    costUsd: run.total_cost_usd,
    durationMs: Date.now() - started,
    error: run.is_error ? String(run.result).slice(0, 500) : undefined,
    passed: checks.filter(check => check.passed).length,
    task: task.id,
    total: checks.length,
    turns: run.num_turns,
    variant,
  };
  results.push(result);
  console.log(`${task.id} ${variant}#${attempt}: ${result.passed}/${result.total}${result.error ? ` (error: ${result.error.split("\n")[0]})` : ""}`);
  for (const check of checks.filter(check => !check.passed)) console.log(`  failed: ${check.label}`);
  if (!args.keep) rmSync(root, { force: true, recursive: true });
}

const queue = [...jobs];
await Promise.all(Array.from({ length: Math.max(1, Number(args.concurrency)) }, async () => {
  while (queue.length) await runJob(queue.shift());
}));

console.log("\nSummary (checks passed / checks run, mean cost):");
for (const variant of variants) {
  const runs = results.filter(result => result.variant === variant);
  const passed = runs.reduce((sum, run) => sum + run.passed, 0);
  const total = runs.reduce((sum, run) => sum + run.total, 0);
  const cost = runs.reduce((sum, run) => sum + (run.costUsd || 0), 0) / Math.max(runs.length, 1);
  console.log(`  ${variant}: ${passed}/${total}, $${cost.toFixed(3)} per run`);
}

writeFileSync(resolve(outputRoot, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
console.log(`\nResults: ${resolve(outputRoot, "results.json")}`);
