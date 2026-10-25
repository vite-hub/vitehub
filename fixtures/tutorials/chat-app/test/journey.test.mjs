import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

test("sign in, stream, reload, restart, continue, stop, and delete offline", { timeout: 45_000 }, async () => {
  assert.ok(existsSync(".output/server/index.mjs"), "Run pnpm build before test:journey.");
  const directory = mkdtempSync(resolve(".chat-journey-test-"));
  const origin = "http://127.0.0.1:4319";
  const password = randomBytes(24).toString("hex");
  const secret = randomBytes(32).toString("hex");
  let child;
  let cookie = "";
  let logs = "";

  async function start() {
    child = spawn(process.execPath, [".output/server/index.mjs"], {
      env: {
        ...process.env, NITRO_HOST: "127.0.0.1", NITRO_PORT: "4319",
        CHAT_ORIGIN: origin, CHAT_MODE: "offline", AI_GATEWAY_API_KEY: "",
        CHAT_PASSWORD: password, CHAT_SESSION_SECRET: secret,
        CHAT_DB_PATH: join(directory, "chat.sqlite"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const output of [child.stdout, child.stderr]) output.on("data", chunk => { logs = (logs + chunk).slice(-8000); });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Server exited: ${logs}`);
      try {
        const response = await fetch(`${origin}/api/session`);
        if (response.ok) return;
      } catch { /* Wait for the Node server to bind. */ }
      await delay(100);
    }
    throw new Error(`Server did not become ready: ${logs}`);
  }

  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 3000);
    await exited;
    clearTimeout(force);
  }

  function request(path, method = "GET", body) {
    return fetch(`${origin}${path}`, {
      method,
      headers: { origin, cookie, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  async function send(id, revision, text) {
    const response = await request("/api/chat", "POST", { id, revision, text });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const events = (await response.text()).split("\n")
      .filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    assert.equal(events.filter(event => event.type === "error").length, 0);
    assert.ok(events.some(event => event.type === "finish"));
    return events.filter(event => event.type === "text-delta").map(event => event.delta).join("");
  }

  try {
    await start();
    assert.equal((await request("/api/chats")).status, 401);
    assert.equal((await request("/api/_vitehub/agents/offline/chat", "POST", {})).status, 404);
    assert.equal((await fetch(`${origin}/api/session`, {
      method: "POST", headers: { origin: "https://wrong.example", "content-type": "application/json" },
      body: JSON.stringify({ password }),
    })).status, 403);
    const login = await request("/api/session", "POST", { password });
    assert.equal(login.status, 200);
    cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    assert.ok(cookie.includes("chat-owner="));
    assert.equal((await fetch(`${origin}/%61pi/chats`, {
      method: "POST", headers: { cookie, origin: "https://wrong.example" },
    })).status, 403);
    const created = await request("/api/chats", "POST");
    assert.equal(created.status, 200);
    const { id } = await created.json();
    assert.equal(await send(id, 0, "Hello"), "Offline reply 1: Hello");
    const saved = await (await request(`/api/chats/${id}`)).json();
    assert.equal(saved.messages.length, 2);
    assert.equal(saved.messages[1].parts[0].text, "Offline reply 1: Hello");
    assert.equal((await request("/api/chat", "POST", { id, revision: 0, text: "stale" })).status, 409);
    assert.equal((await request("/api/chat", "POST", { id, revision: 1, text: "fake", messages: [] })).status, 400);

    await stop();
    await start();
    assert.equal((await (await request("/api/session")).json()).signedIn, true);
    assert.deepEqual(await (await request(`/api/chats/${id}`)).json(), saved);
    assert.equal(await send(id, 1, "Still here?"), "Offline reply 2: Still here?");

    const abort = new AbortController();
    const partial = await fetch(`${origin}/api/chat`, {
      method: "POST", headers: { origin, cookie, "content-type": "application/json" },
      body: JSON.stringify({ id, revision: 2, text: "word ".repeat(100) }), signal: abort.signal,
    });
    const reader = partial.body.getReader();
    await reader.read();
    abort.abort();
    await reader.cancel().catch(() => {});
    await delay(200);
    const afterStop = await (await request(`/api/chats/${id}`)).json();
    assert.equal(afterStop.revision, 2);
    assert.equal(afterStop.messages.length, 4);
    assert.equal((await request(`/api/chats/${id}`, "DELETE")).status, 200);
    assert.equal((await request(`/api/chats/${id}`)).status, 404);
    assert.equal((await request("/api/session", "DELETE")).status, 200);
  } finally {
    await stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
