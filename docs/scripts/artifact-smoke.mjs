#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const docsRoot = resolve(import.meta.dirname, "..");
const serverEntry = resolve(docsRoot, ".output/server/index.mjs");
const port = Number(process.env.DOCS_ARTIFACT_SMOKE_PORT ?? 8797);
const origin = `http://127.0.0.1:${port}`;

if (!existsSync(serverEntry)) {
  throw new Error("Missing docs/.output/server/index.mjs. Build vitehub-docs before running the artifact smoke.");
}

const server = spawn("vp", [
  "dlx", "wrangler@4.112.0", "dev",
  "--config", ".output/server/wrangler.json",
  "--port", String(port),
  "--local",
  "--log-level", "error",
], {
  cwd: docsRoot,
  detached: true,
  env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverOutput = "";
server.stdout.on("data", chunk => serverOutput += chunk);
server.stderr.on("data", chunk => serverOutput += chunk);
const serverExit = new Promise(resolveExit => server.once("exit", (code, signal) => resolveExit({ code, signal })));

try {
  await waitUntilReady();
  await assertTextRoute("HTML docs", "/docs/", 200, "text/html", "<title", { accept: "text/html" });
  await assertTextRoute("raw Markdown", "/raw/docs/getting-started.md", 200, "text/markdown", "# Introduction");
  const openApi = await request("OpenAPI", "/openapi.json", 200, "application/json");
  if (JSON.parse(openApi).openapi !== "3.1.0") throw new Error("OpenAPI route did not return the 3.1.0 document");
  await assertTextRoute("sitemap", "/sitemap.xml", 200, "application/xml", "<urlset");
  await assertTextRoute("HTML 404", "/missing-docs-artifact-smoke", 404, "text/html", "Page not found", { accept: "text/html" });
  await assertTextRoute("static logo", "/vitehub-logo.svg", 200, "image/svg+xml", "<svg");
  process.stdout.write("Docs artifact smoke passed: HTML, Markdown, OpenAPI, sitemap, 404, and static asset routes.\n");
}
catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${serverOutput}\n`);
  process.exitCode = 1;
}
finally {
  signalServer("SIGTERM");
  const stopped = await Promise.race([serverExit.then(() => true), delay(5_000).then(() => false)]);
  if (!stopped) {
    signalServer("SIGKILL");
    await serverExit;
  }
}

function signalServer(signal) {
  if (server.pid === undefined) return;
  try {
    process.kill(-server.pid, signal);
  }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}

async function waitUntilReady() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Docs artifact server exited before startup with status ${server.exitCode}`);
    try {
      const response = await fetch(`${origin}/openapi.json`);
      if (response.status === 200) return;
    }
    catch {}
    await delay(250);
  }
  throw new Error("Docs artifact server did not become ready within 60 seconds");
}

async function request(name, path, expectedStatus, expectedType, headers = {}) {
  const response = await fetch(`${origin}${path}`, { headers });
  const body = await response.text();
  if (response.status !== expectedStatus) throw new Error(`${name} returned ${response.status}, expected ${expectedStatus}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith(expectedType)) throw new Error(`${name} returned ${contentType || "no content type"}, expected ${expectedType}`);
  return body;
}

async function assertTextRoute(name, path, status, type, text, headers) {
  const body = await request(name, path, status, type, headers);
  if (!body.includes(text)) throw new Error(`${name} response did not contain ${JSON.stringify(text)}`);
}
