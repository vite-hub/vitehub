---
title: Build an AI chat app with Nuxt and ViteHub
description: Build a Nuxt chat app with streaming replies, sign-in, SQLite history, and an offline Driver. Verify refresh and restart, then connect a model.
layout: tutorial
tutorial: project
codePanel: true
navigation.title: Build a chat app
navigation.kind: tutorial
navigation.order: 4
navigation.group: Start
icon: i-lucide-messages-square
---

Build a chat app that keeps conversations after a refresh or restart, with sign-in, streaming, saved chats, Stop, and delete. Nuxt serves the app, a ViteHub Agent writes each reply, and `@vite-hub/ui` shows the messages and prompt. Your app owns sign-in, transport, and the SQLite database.

You start with an offline Driver, the part of the Agent that makes a fixed reply, so you can test without a model. `Hello` gets `Offline reply 1: Hello`, word by word. After a restart, `Still here?` gets `Offline reply 2: Still here?`. Then one setting switches to a real model through AI Gateway.

The [complete source](https://github.com/vite-hub/vitehub/tree/main/fixtures/tutorials/chat-app) has the app, a sample environment, and tests. It follows the finished app of the [Nuxt UI chat tutorial](https://ui.nuxt.com/blog/how-to-build-an-ai-chat) with the [ViteHub chat components](/docs/ui/blocks/chat-app).

You need Node.js 22.22+ on 22.x, 24.11+ on 24.x, or 26+, Git, Corepack, and a writable directory. The first install and build take some time. Offline mode needs no account, key, or paid request. Model mode needs a Vercel AI Gateway account and key, a network, and a model the account can use.

::warning
Provider calls can cost money. Check model prices and set a provider budget before you use model mode.
::

This is a text-only app for one owner on one Node process, without public registration, attachments, tools, or resumable replies. A completed turn saves the user message and answer together. A failed, stopped, or interrupted turn is not saved.

::tutorial-step{title="Set up the project"}
## Set up the project

This tutorial uses Nuxt 5, Nitro 3, and H3 2. Use the repository checkout so the fixture and ViteHub packages come from the same revision. The root lockfile pins the full dependency graph. Do not replace `workspace:*` with the package version printed in the manifest; it may describe an older published contract.

```sh [commands/checkout]
git clone https://github.com/vite-hub/vitehub.git
cd vitehub
corepack pnpm install --frozen-lockfile
corepack pnpm exec vp run --cache --filter vite-hub... --filter @vite-hub/ui... build
cd fixtures/tutorials/chat-app
```

The checkout has the finished files to read and edit. Paths start from `fixtures/tutorials/chat-app`. The code panel shows each full file.

```json [package.json]
{
  "name": "vitehub-chat-tutorial",
  "private": true,
  "type": "module",
  "scripts": {
    "setup": "node scripts/setup.mjs",
    "dev": "nuxt dev --host 127.0.0.1 --port 4318",
    "build": "nuxt build",
    "start": "node --env-file=.env .output/server/index.mjs",
    "typecheck": "nuxt typecheck",
    "test": "node --test test/store.test.ts",
    "test:journey": "node --test test/journey.test.mjs"
  },
  "dependencies": {
    "@ai-sdk/vue": "4.0.130",
    "@iconify-json/lucide": "1.2.139",
    "@iconify-json/ph": "1.2.2",
    "@nuxt/ui": "4.11.3",
    "@vite-hub/agent": "workspace:*",
    "@vite-hub/ui": "workspace:*",
    "ai": "7.0.130",
    "h3": "2.0.8",
    "nuxt": "npm:nuxt-nightly@5.0.0-2611052317-a04317f",
    "tailwindcss": "4.3.3",
    "vite-hub": "workspace:*",
    "vue": "3.5.44",
    "zod": "4.6.7"
  },
  "devDependencies": {
    "@types/node": "24.19.1",
    "typescript": "6.0.3",
    "vue-tsc": "3.3.12"
  },
  "engines": { "node": "^22.22.0 || ^24.11.0 || >=26.0.0" }
}
```

The ViteHub Nuxt module discovers Agent Definitions in `server/agents`. Set the Node host once. `workflow: false` keeps these short chat Invocations inline. Register Nuxt UI before ViteHub so Nuxt installs its Icon and color-mode dependencies. ViteHub then gives the chat components their Nuxt runtime, and `main.css` loads their styles. Disable font downloads so the offline app does not need a font service.

- The ViteHub module finds Agent Definitions (one file per Agent) in `server/agents`.
- `host: "node"` builds for a Node.js server.
- `workflow: false` runs each short reply (an Invocation) inside the request.
- Nuxt UI comes before the ViteHub UI module, so its Icon and color-mode dependencies install. The ViteHub UI module adds the chat components.
- `ui: { fonts: false }` skips font downloads, so offline mode needs no font service.
- `buildDir: ".nuxt"` keeps generated TypeScript in the project.
- The Shiki aliases inline its WebAssembly for the Nuxt 5 server build.

```ts [nuxt.config.ts]
import viteHub from "vite-hub/nuxt";

export default defineNuxtConfig({
  buildDir: ".nuxt",
  modules: ["@nuxt/ui", [viteHub, {
    host: "node",
    agent: true,
    workflow: false,
    console: false,
  }]],
  css: ["~/assets/main.css"],
  vite: {
    resolve: {
      alias: [
        // Inline Shiki's WebAssembly for the Nuxt 5 server build.
        { find: /^shiki\/wasm$/, replacement: "@shikijs/engine-oniguruma/wasm-inlined" },
        { find: /^shiki\/dist\/onig\.wasm$/, replacement: "@shikijs/engine-oniguruma/wasm-inlined" },
        { find: /(?:^|[/\\])shiki[/\\]dist[/\\]onig\.wasm$/, replacement: "@shikijs/engine-oniguruma/wasm-inlined" },
      ],
    },
  },
  ui: { fonts: false },
  devtools: { enabled: false },
});
```

```json [tsconfig.json]
{
  "extends": "./.nuxt/tsconfig.json"
}
```

```css [app/assets/main.css]
@import "tailwindcss";
@import "@nuxt/ui";
@import "@vite-hub/ui/styles.css";

body { margin: 0; font-family: system-ui, sans-serif; }
```

```text [.gitignore]
.env
.data/
.nuxt/
.output/
.vitehub/
node_modules/
```

Keep credentials in the server environment. The example has no secrets.

```ini [.env.example]
CHAT_MODE=offline
CHAT_MODEL=openai/gpt-4.1-mini
AI_GATEWAY_API_KEY=
CHAT_PASSWORD=
CHAT_SESSION_SECRET=
CHAT_ORIGIN=http://127.0.0.1:4318
CHAT_DB_PATH=.data/chat.sqlite
NITRO_HOST=127.0.0.1
NITRO_PORT=4318
```

This script creates `.env` with two random secrets: `CHAT_PASSWORD` to sign in, and `CHAT_SESSION_SECRET` for H3 to encrypt the cookie. It never overwrites an existing `.env`.

```js [scripts/setup.mjs]
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
const env = example
  .replace("CHAT_PASSWORD=", `CHAT_PASSWORD=${randomBytes(24).toString("hex")}`)
  .replace("CHAT_SESSION_SECRET=", `CHAT_SESSION_SECRET=${randomBytes(32).toString("hex")}`);
writeFileSync(new URL("../.env", import.meta.url), env, { flag: "wx", mode: 0o600 });
console.log("Created .env. Open it to read your owner password. Existing .env files are never replaced.");
```

```sh [commands/local-setup]
corepack pnpm run setup
```

Checkpoint: `.env` exists, only you can read it, and both secrets are random. Read the owner password there. Never paste it or a model key into source. Keep host and origin at `127.0.0.1:4318` for local steps.
::

::tutorial-step{title="Store completed conversations"}
## Store completed conversations

A chat has an ID, a title, a revision, and text messages in a shape that both the Agent and the UI accept. The server creates message IDs. The first prompt becomes the title, with no extra model call.

```ts [shared/chat.ts]
import { z } from "zod";

export const messageSchema = z.object({
  id: z.uuid(),
  role: z.enum(["user", "assistant"]),
  parts: z.array(z.object({ type: z.literal("text"), text: z.string() })),
});

export const threadSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  revision: z.number().int().nonnegative(),
  messages: z.array(messageSchema),
});

export type Thread = z.infer<typeof threadSchema>;
export type ChatMessage = z.infer<typeof messageSchema>;
export type ThreadSummary = Pick<Thread, "id" | "title">;

export function textMessage(role: ChatMessage["role"], text: string): ChatMessage {
  return { id: crypto.randomUUID(), role, parts: [{ type: "text", text }] };
}
```

Node's built-in SQLite fits this one-process app. The database is at `CHAT_DB_PATH`, outside the build output. Every query checks the signed-in owner, so knowing a chat ID gives no access.

Each completed turn increments the revision. A save runs only if the revision still matches, so an old tab gets an error instead of overwriting newer messages. Both messages save in one SQL statement, so a crash cannot save half a turn.

```ts [server/utils/store.ts]
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { threadSchema, type ChatMessage, type ThreadSummary } from "../../shared/chat.ts";

export function openChatStore(filename: string) {
  mkdirSync(dirname(resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, messages TEXT NOT NULL DEFAULT '[]',
      updated INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chats_owner ON chats(owner, updated);
  `);

  function get(owner: string, id: string) {
    const row = db.prepare("SELECT * FROM chats WHERE owner = ? AND id = ?").get(owner, id);
    if (!row) return null;
    return threadSchema.parse({ ...row, messages: JSON.parse(String(row.messages)) });
  }

  return {
    get,
    list(owner: string): ThreadSummary[] {
      return db.prepare("SELECT id, title FROM chats WHERE owner = ? ORDER BY updated DESC")
        .all(owner).map(row => ({ id: String(row.id), title: String(row.title) }));
    },
    create(owner: string) {
      const id = crypto.randomUUID();
      db.prepare("INSERT INTO chats (id, owner, title, updated) VALUES (?, ?, ?, ?)")
        .run(id, owner, "New chat", Date.now());
      return get(owner, id)!;
    },
    save(owner: string, id: string, revision: number, messages: ChatMessage[]) {
      const title = messages[0]?.parts[0]?.text.slice(0, 60) || "New chat";
      const result = db.prepare(`UPDATE chats SET title = ?, messages = ?,
        revision = revision + 1, updated = ? WHERE owner = ? AND id = ? AND revision = ?`)
        .run(title, JSON.stringify(messages), Date.now(), owner, id, revision);
      if (result.changes !== 1) throw new Error("Chat changed. Reload its saved history.");
    },
    remove(owner: string, id: string) {
      return db.prepare("DELETE FROM chats WHERE owner = ? AND id = ?").run(owner, id).changes === 1;
    },
    close() { db.close(); },
  };
}

let store: ReturnType<typeof openChatStore> | undefined;
export function chatStore() {
  return store ??= openChatStore(process.env.CHAT_DB_PATH || ".data/chat.sqlite");
}

// This tutorial runs one Node process. The revision check also rejects stale tabs.
export const activeChats = new Set<string>();
```

```sh [commands/check-store]
corepack pnpm test
```

Checkpoint: the store test passes. It saves a turn, reopens the database, checks that another owner cannot read or delete it, rejects an old revision, and deletes the chat. See the [store test source](https://github.com/vite-hub/vitehub/blob/main/fixtures/tutorials/chat-app/test/store.test.ts).
::

::tutorial-step{title="Require the owner to sign in"}
## Require the owner to sign in

Check access on the server before reading history or running an Agent. The app uses H3's encrypted cookie session and one long random owner password, with no sign-up route. The cookie lasts 12 hours with `HttpOnly` and `SameSite=Strict`, plus `Secure` when `CHAT_ORIGIN` is HTTPS.

Every write request, including sign-in and sign-out, must send the configured Origin. Scripts such as curl must send it too.

```ts [server/utils/session.ts]
import { createHash, timingSafeEqual } from "node:crypto";
import { createError, getHeader, useSession, type H3Event } from "h3";

export function appOrigin() {
  return process.env.CHAT_ORIGIN || "http://127.0.0.1:4318";
}

export function checkOrigin(event: H3Event) {
  if (getHeader(event, "origin") !== appOrigin()) {
    throw createError({ statusCode: 403, statusMessage: "Use the app's own origin." });
  }
}

export function ownerSession(event: H3Event) {
  const password = process.env.CHAT_SESSION_SECRET;
  if (!password || password.length < 32) {
    throw createError({ statusCode: 503, statusMessage: "Set CHAT_SESSION_SECRET to at least 32 characters." });
  }
  return useSession<{ owner?: string }>(event, {
    name: "chat-owner",
    password,
    maxAge: 60 * 60 * 12,
    sessionHeader: false,
    cookie: { httpOnly: true, sameSite: "strict", secure: appOrigin().startsWith("https:") },
  });
}

export async function requireOwner(event: H3Event) {
  const session = await ownerSession(event);
  if (session.data.owner !== "owner") {
    throw createError({ statusCode: 401, statusMessage: "Sign in first." });
  }
  return session.data.owner;
}

export function validPassword(value: string) {
  const expected = process.env.CHAT_PASSWORD;
  if (!expected || expected.length < 24) {
    throw createError({ statusCode: 503, statusMessage: "Set CHAT_PASSWORD to at least 24 random characters." });
  }
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(value), digest(expected));
}
```

The middleware blocks ViteHub's generated endpoints. Only the app's `/api/chat` route runs the Agent, so no second route can skip its history, owner, and limit checks.

```ts [server/middleware/access.ts]
import { createError, defineEventHandler, setHeader } from "h3";
import { checkOrigin, requireOwner } from "../utils/session";

export default defineEventHandler(async (event) => {
  const path = event.path.split("?")[0] || "/";
  // The app owns its chat API. Generated Agent endpoints must not bypass it.
  if (/^\/(?:api\/)?_+vitehub(?:\/|$)/.test(path)) {
    throw createError({ statusCode: 404 });
  }
  if (!path.startsWith("/api/")) return;
  setHeader(event, "cache-control", "no-store");
  if (!["GET", "HEAD"].includes(event.method)) checkOrigin(event);
  if (path !== "/api/session") await requireOwner(event);
});
```

The session route handles status, sign-in, and sign-out, with 10 sign-in attempts per minute per process. A public service needs shared limits in the reverse proxy.

```ts [server/api/session.ts]
import { createError, defineEventHandler, readValidatedBody } from "h3";
import { z } from "zod";
import { ownerSession, validPassword } from "../utils/session";

let attempts = 0;
let windowStart = Date.now();

export default defineEventHandler(async (event) => {
  const session = await ownerSession(event);
  if (event.method === "POST") {
    if (Date.now() - windowStart > 60_000) { attempts = 0; windowStart = Date.now(); }
    if (++attempts > 10) throw createError({ statusCode: 429, statusMessage: "Wait a minute before signing in." });
    const { password } = await readValidatedBody(event, z.object({ password: z.string().max(256) }).parse);
    if (!validPassword(password)) throw createError({ statusCode: 401, statusMessage: "Incorrect password." });
    await session.update({ owner: "owner" });
  } else if (event.method === "DELETE") {
    await session.clear();
  } else if (event.method !== "GET") {
    throw createError({ statusCode: 405 });
  }
  return { signedIn: session.data.owner === "owner", mode: process.env.CHAT_MODE || "offline" };
});
```

Start the app from the fixture directory:

```sh [commands/start-dev]
corepack pnpm dev
```

In another terminal, send a request without signing in:

```sh [commands/check-access]
curl -i http://127.0.0.1:4318/api/chats
```

Checkpoint: the request returns `401`. `http://127.0.0.1:4318` shows sign-in. Use the password from `.env`. A missing or short secret makes the API unavailable, never anonymous.
::

::tutorial-step{title="Define the offline and model Agents"}
## Define the offline and model Agents

The offline Driver gets the saved conversation and new prompt, counts user turns, and streams a fixed reply. A delay between words makes the stream visible and Stop testable. It stops when the response closes, through `input.abortSignal`.

ViteHub events carry text in `text`. The AI SDK transport uses `delta`. The API route converts it.

```ts [server/agents/offline.ts]
import { setTimeout } from "node:timers/promises";
import { defineAgent } from "vite-hub/agent";

export default defineAgent({
  runtime: false,
  invocations: false,
  driver: {
    async *run({ messages, input }) {
      const turns = messages.filter(message => message.role === "user");
      const prompt = turns.at(-1)?.parts.filter(part => part.type === "text").map(part => part.text).join("") || "";
      const answer = `Offline reply ${turns.length}: ${prompt}`;
      for (const word of answer.match(/\S+\s*/g) || []) {
        await setTimeout(40, undefined, { signal: input.abortSignal });
        yield { type: "text-delta" as const, text: word };
      }
      yield { type: "finish" as const };
    },
  },
});
```

The second Agent uses the model Driver. A model ID string goes through AI Gateway, with `AI_GATEWAY_API_KEY` read when the Driver runs. Defining it calls no provider. Limit output, retries, and steps before you use a paid model. The Agent gets no tools or Workspace access.

```ts [server/agents/assistant.ts]
import { defineAgent } from "vite-hub/agent";

export default defineAgent({
  runtime: false,
  invocations: false,
  driver: {
    model: () => process.env.CHAT_MODEL || "openai/gpt-4.1-mini",
    instructions: "Answer clearly and briefly. Use the conversation for context.",
    maxRetries: 0,
    execution: { stepLimit: 1, callSettings: { maxOutputTokens: 800 } },
  },
});
```

Checkpoint: `CHAT_MODE=offline` selects the offline Agent. Keep `AI_GATEWAY_API_KEY` empty for now. `runtime: false` runs each reply in the Node request, so it does not resume after a crash. `invocations: false` turns off the Agent journal, because the app keeps history in its own database.
::

::tutorial-step{title="Expose history and streaming routes"}
## Expose history and streaming routes

The list route returns the owner's chats, up to 100. The detail route reads or deletes one owned chat, but not while it writes a reply.

```ts [server/api/chats/index.ts]
import { createError, defineEventHandler } from "h3";
import { requireOwner } from "../../utils/session";
import { chatStore } from "../../utils/store";

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event);
  const store = chatStore();
  if (event.method === "GET") return store.list(owner);
  if (event.method !== "POST") throw createError({ statusCode: 405 });
  if (store.list(owner).length >= 100) {
    throw createError({ statusCode: 409, statusMessage: "Delete a chat before creating another." });
  }
  return store.create(owner);
});
```

```ts [server/api/chats/[id].ts]
import { createError, defineEventHandler, getRouterParam } from "h3";
import { requireOwner } from "../../utils/session";
import { activeChats, chatStore } from "../../utils/store";

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event);
  const id = getRouterParam(event, "id") || "";
  const store = chatStore();
  const thread = store.get(owner, id);
  if (!thread) throw createError({ statusCode: 404 });
  if (event.method === "GET") return thread;
  if (event.method !== "DELETE") throw createError({ statusCode: 405 });
  if (activeChats.has(id)) throw createError({ statusCode: 409, statusMessage: "Wait for the reply to finish." });
  store.remove(owner, id);
  return { deleted: true };
});
```

The streaming route accepts only a chat ID, the last revision, and one prompt. It loads history from SQLite, so a browser cannot inject assistant messages or another owner's ID.

The app calls `streamAgent`, which returns typed Agent events by default. It forwards text through an AI SDK UI message stream, waits for the Agent to finish, then saves the completed pair before sending the final transport event. The UI can therefore reload saved history when it receives completion. If saving fails, the stream reports an error.

`getRuntimeContext` adapts the Nuxt request and its background lifetime. The wrapper consumes the full event stream and drains remaining work before finishing. The route aborts the Invocation when the client leaves before the reply ends, through `runtime.request.signal`, or after 60 seconds. It releases the active-chat lock in `finally`.

```ts [server/api/chat.post.ts]
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { createError, defineEventHandler, readValidatedBody } from "h3";
import { createMessage, streamAgent } from "vite-hub/agent";
import { getRuntimeContext } from "vite-hub/runtime";
import { z } from "zod";
import { textMessage } from "../../shared/chat";
import assistant from "../agents/assistant";
import offline from "../agents/offline";
import { requireOwner } from "../utils/session";
import { activeChats, chatStore } from "../utils/store";

const requestSchema = z.object({
  id: z.uuid(),
  revision: z.number().int().nonnegative(),
  text: z.string().trim().min(1).max(2000),
}).strict();
let requests = 0;
let windowStart = Date.now();

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event);
  const { id, revision, text } = await readValidatedBody(event, requestSchema.parse);
  const store = chatStore();
  const thread = store.get(owner, id);
  if (!thread) throw createError({ statusCode: 404 });
  if (thread.revision !== revision || activeChats.has(id)) {
    throw createError({ statusCode: 409, statusMessage: "Chat changed. Reload its saved history." });
  }
  if (thread.messages.length >= 40) throw createError({ statusCode: 409, statusMessage: "Start a new chat after 20 turns." });
  if (Date.now() - windowStart > 60_000) { requests = 0; windowStart = Date.now(); }
  if (activeChats.size >= 2 || ++requests > 20) throw createError({ statusCode: 429, statusMessage: "Wait before sending another message." });
  const mode = process.env.CHAT_MODE || "offline";
  if (!["offline", "model"].includes(mode)) throw createError({ statusCode: 503, statusMessage: "Invalid CHAT_MODE." });
  if (mode === "model" && !process.env.AI_GATEWAY_API_KEY) {
    throw createError({ statusCode: 503, statusMessage: "Set AI_GATEWAY_API_KEY on the server." });
  }

  const user = textMessage("user", text);
  const reply = textMessage("assistant", "");
  const runtime = getRuntimeContext(event);
  // The request signal aborts when the client leaves before the reply ends.
  const signal = AbortSignal.any([runtime.request.signal, AbortSignal.timeout(60_000)]);
  activeChats.add(id);

  const stream = createUIMessageStream({
    async execute({ writer }) {
      try {
        const [error, output] = await streamAgent(mode === "model" ? assistant : offline, {
          messages: [...thread.messages, user].map(message => createMessage(message)),
          abortSignal: signal,
        }, { runtimeContext: runtime });
        if (error) throw error;
        writer.write({ type: "start", messageId: reply.id });
        writer.write({ type: "text-start", id: reply.id });
        let answer = "";
        for await (const part of output) {
          signal.throwIfAborted();
          if (part.type === "error") throw new Error("Agent failed.");
          if (part.type !== "text-delta") continue;
          answer += part.text;
          if (answer.length > 20_000) throw new Error("Reply exceeds the storage limit.");
          writer.write({ type: "text-delta", id: reply.id, delta: part.text });
        }
        await runtime.flushWaitUntil();
        signal.throwIfAborted();
        if (!answer.trim()) throw new Error("Agent returned no text.");
        reply.parts[0]!.text = answer;
        store.save(owner, id, revision, [...thread.messages, user, reply]);
        writer.write({ type: "text-end", id: reply.id });
        writer.write({ type: "finish", finishReason: "stop" });
      } finally {
        activeChats.delete(id);
        await runtime.flushWaitUntil();
      }
    },
    onError: () => "Reply not saved. Reload saved history before sending again.",
  });
  return createUIMessageStreamResponse({
    stream,
    headers: { "cache-control": "no-store", "x-accel-buffering": "no" },
  });
});
```

Checkpoint: sign in, select New chat, and send `Hello`. The reply is exactly `Offline reply 1: Hello`. In the Network panel, `/api/chat` returns `text/event-stream`. An old revision returns `409`. Provider and save errors never appear as saved turns.
::

::tutorial-step{title="Build the chat interface"}
## Build the chat interface

Use the [Chat app block](/docs/ui/blocks/chat-app) layout. A child pane holds one chat's AI SDK state. Its footer keeps the prompt below the messages, so status text never covers the last reply. Key it by chat ID, so switching chats removes the old prompt and transport.

`DefaultChatTransport` normally sends browser history. Here its request callback sends only the fields the endpoint accepts. On completion, the pane reloads the server copy and its revision. Stop keeps the partial reply visible until a reload. Retry loads saved state before the user resends the draft, so it never sends a second paid request on its own.

```vue [app/components/ChatPane.vue]
<script setup lang="ts">
import { useChat } from "@ai-sdk/vue";
import { ChatSession, PromptInput, type PromptInputSubmit } from "vite-hub/ui";
import { DefaultChatTransport } from "ai";
import type { Thread } from "../../shared/chat";

const props = defineProps<{ thread: Thread; blocked: boolean }>();
const emit = defineEmits<{ saved: []; busy: [value: boolean] }>();
const input = ref("");
const revision = ref(props.thread.revision);
const title = ref(props.thread.title);
const notice = ref("");
const recovering = ref(false);
const limitReached = computed(() => revision.value >= 20);

const { messages, status, error, sendMessage, stop, clearError } = useChat({
  id: props.thread.id,
  messages: props.thread.messages,
  transport: new DefaultChatTransport({
    api: "/api/chat",
    prepareSendMessagesRequest({ id, messages }) {
      const last = messages.at(-1);
      const text = last?.parts.filter(part => part.type === "text").map(part => part.text).join("") || "";
      return { body: { id, text, revision: revision.value } };
    },
  }),
  async onFinish({ isAbort, isError }) {
    if (!isAbort && !isError) await reload();
  },
});

const busy = computed(() => recovering.value || status.value === "submitted" || status.value === "streaming");
watch(busy, value => emit("busy", value), { immediate: true });
onBeforeUnmount(() => { void stop(); });

async function reload() {
  recovering.value = true;
  try {
    const saved = await $fetch<Thread>(`/api/chats/${props.thread.id}`);
    messages.value = saved.messages;
    revision.value = saved.revision;
    title.value = saved.title;
    clearError();
    notice.value = "Saved history loaded.";
    emit("saved");
  } catch {
    notice.value = "Could not load saved history. Sign in again or retry.";
  } finally {
    recovering.value = false;
  }
}

async function submit({ text }: PromptInputSubmit) {
  if (busy.value || props.blocked || limitReached.value) return;
  if (text.length > 2000) { notice.value = "Use at most 2,000 characters."; return; }
  notice.value = "";
  input.value = "";
  await sendMessage({ text });
  if (error.value && !input.value) input.value = text;
}

async function stopReply() {
  await stop();
  notice.value = "Stopped. Reload saved history before continuing. Partial replies are not saved.";
}
</script>

<template>
  <ChatSession :session="{ id: thread.id, title, messages }" :status
    class="h-full min-h-0" style="--vh-chat-content-padding: 1rem">
    <template #footer>
      <div class="px-4 pb-4">
        <p v-if="limitReached" role="status" class="mb-2 text-sm text-muted">
          This chat has 20 turns. Select New chat to continue.
        </p>
        <p v-else-if="error" role="alert" class="mb-2 text-sm text-error">
          The reply failed. Reload saved history, then send your draft again.
        </p>
        <p v-if="notice" role="status" class="mb-2 text-sm text-muted">{{ notice }}</p>
        <UButton v-if="error || notice" variant="link" :disabled="busy" @click="reload">
          Reload saved history
        </UButton>
        <fieldset :disabled="blocked || recovering || limitReached">
          <PromptInput v-model="input" :status :attachments="false"
            placeholder="Ask a question" @submit="submit" @stop="stopReply" @reload="reload" />
        </fieldset>
      </div>
    </template>
  </ChatSession>
</template>
```

The shell adds sign-in, the chat list (above the chat on narrow screens), and deletion. Local storage keeps only the selected ID, and the server still checks cookie and owner.

```vue [app/app.vue]
<script setup lang="ts">
import type { Thread, ThreadSummary } from "../shared/chat";

const password = ref("");
const notice = ref("");
const busy = ref(false);
const loading = ref(false);
const selected = ref<Thread>();
const chats = ref<ThreadSummary[]>([]);
const { data: session, refresh: refreshSession } = await useFetch("/api/session");

async function loadList() { chats.value = await $fetch<ThreadSummary[]>("/api/chats"); }

async function choose(id: string) {
  if (busy.value || loading.value) return;
  loading.value = true;
  try {
    selected.value = await $fetch<Thread>(`/api/chats/${id}`);
    localStorage.setItem("chat-id", id);
  } catch { notice.value = "Could not open this chat."; }
  finally { loading.value = false; }
}

async function createChat() {
  if (busy.value || loading.value) return;
  loading.value = true;
  try {
    const thread = await $fetch<Thread>("/api/chats", { method: "POST" });
    selected.value = thread;
    localStorage.setItem("chat-id", thread.id);
    await loadList();
  } catch { notice.value = "Could not create a chat. Try again or delete an old chat."; }
  finally { loading.value = false; }
}

async function restore() {
  try {
    await loadList();
    const id = localStorage.getItem("chat-id");
    const previous = chats.value.find(chat => chat.id === id) || chats.value[0];
    if (previous) await choose(previous.id);
  } catch { notice.value = "Could not load chats. Sign in again."; }
}

async function signIn() {
  try {
    await $fetch("/api/session", { method: "POST", body: { password: password.value } });
    password.value = "";
    notice.value = "";
    await refreshSession();
    await restore();
  } catch { notice.value = "Sign-in failed. Check the password and server configuration, or wait a minute."; }
}

async function signOut() {
  await $fetch("/api/session", { method: "DELETE" });
  selected.value = undefined;
  chats.value = [];
  localStorage.removeItem("chat-id");
  await refreshSession();
}

async function removeChat() {
  if (!selected.value || busy.value) return;
  if (!window.confirm("Delete this chat and its saved messages?")) return;
  try {
    await $fetch(`/api/chats/${selected.value.id}`, { method: "DELETE" });
    selected.value = undefined;
    localStorage.removeItem("chat-id");
    await loadList();
    if (chats.value[0]) await choose(chats.value[0].id);
  } catch { notice.value = "Could not delete the chat. Wait for its reply to finish."; }
}

onMounted(() => { if (session.value?.signedIn) void restore(); });
</script>

<template>
  <UApp>
    <main v-if="!session?.signedIn" class="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 px-6">
      <h1 class="text-2xl font-semibold">Your chat workspace</h1>
      <p class="text-sm text-muted">Sign in with the owner password from your server's .env file.</p>
      <form class="flex flex-col gap-3" @submit.prevent="signIn">
        <label for="password">Owner password</label>
        <UInput id="password" v-model="password" type="password" autocomplete="current-password" required />
        <UButton type="submit" class="justify-center">Sign in</UButton>
      </form>
      <p v-if="notice" role="alert">{{ notice }}</p>
    </main>
    <main v-else class="flex h-dvh flex-col bg-default md:flex-row">
      <aside class="flex max-h-72 shrink-0 flex-col gap-3 border-b border-default p-4 md:max-h-none md:w-64 md:border-r md:border-b-0">
        <h1 class="text-lg font-semibold">Your chats</h1>
        <p class="text-xs text-muted">{{ session.mode === 'offline' ? 'Offline practice. No model calls.' : 'AI model. Requests may incur charges.' }}</p>
        <UButton :disabled="busy || loading" @click="createChat">New chat</UButton>
        <nav aria-label="Saved chats" class="flex-1 overflow-y-auto">
          <button v-for="chat in chats" :key="chat.id" type="button"
            :aria-current="selected?.id === chat.id ? 'page' : undefined"
            :disabled="busy || loading"
            class="block w-full truncate rounded px-2 py-2 text-left text-sm hover:bg-elevated focus-visible:outline-2 aria-[current=page]:bg-elevated disabled:opacity-50"
            @click="choose(chat.id)">{{ chat.title }}</button>
        </nav>
        <div class="flex gap-2">
          <UButton variant="ghost" :disabled="busy || !selected" @click="removeChat">Delete chat</UButton>
          <UButton variant="ghost" :disabled="busy" @click="signOut">Sign out</UButton>
        </div>
      </aside>
      <section aria-label="Conversation" class="flex min-h-0 min-w-0 flex-1 flex-col">
        <p v-if="notice" role="alert" class="p-4">{{ notice }}</p>
        <p v-if="loading" role="status" class="p-4">Loading chat...</p>
        <ChatPane v-if="selected" :key="selected.id" :thread="selected" :blocked="loading" @saved="loadList" @busy="busy = $event" />
        <div v-else class="m-auto max-w-sm p-6 text-center">
          <h2 class="text-xl font-medium">Start a conversation</h2>
          <p class="mt-2 text-sm text-muted">Choose New chat, then send Hello. Completed replies stay here after a restart.</p>
        </div>
      </section>
    </main>
  </UApp>
</template>
```

Checkpoint: two chats with different prompts each keep their own history. Tab reaches every control, Enter sends, and Shift+Enter adds a line. At phone width, messages and prompt fit the screen.
::

::tutorial-step{title="Prove refresh, restart, and cancellation"}
## Prove refresh, restart, and cancellation

Send `Hello` in a new chat and wait for the prompt to be ready. Refresh. The two messages come back from SQLite, without running the Agent again.

Stop the dev server with Ctrl+C and run `corepack pnpm dev` again, keeping `.env` and `.data`. Open that chat and send `Still here?`. The reply is exactly `Offline reply 2: Still here?`: the count comes from saved history passed to a new Invocation.

Send a long sentence, press Stop while words appear, and select Reload saved history. The partial turn disappears because it never completed. If Stop races with completion, the reload can show the completed turn: the database is the truth. A response lost after a save recovers the same way.

Stop the dev server, then run the production check:

```sh [commands/check-journey]
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test:journey
```

The [journey test](https://github.com/vite-hub/vitehub/blob/main/fixtures/tutorials/chat-app/test/journey.test.mjs) runs the built server twice on `127.0.0.1:4319` in offline mode, with temporary credentials and database. It checks rejected unauthenticated and cross-origin requests, blocked generated routes, streaming, history after a real restart, a second turn, cancel, and delete. Then it stops the server and removes its data.

Checkpoint: all checks pass, port 4319 is free, and your browser chat still exists, because the test uses its own database. HTTP tests cover the server; your browser checks cover layout and interaction.
::

::tutorial-step{title="Connect a real model"}
## Connect a real model

Stop the server. In `.env`, set `CHAT_MODE` to `model`, `AI_GATEWAY_API_KEY` to your gateway key, and `CHAT_MODEL` to a model your account can use (default `openai/gpt-4.1-mini`).

::warning
Never put the key in `runtimeConfig.public`, Vue code, or a `VITE_` variable. Set a provider budget first. Each message sends the whole conversation, so later turns use more input tokens. The 800-token output limit and request limits are not a spending cap.
::

```sh [commands/start-model]
corepack pnpm dev
```

Checkpoint: the sidebar says requests may cost money. A question in a new chat streams and saves as before, with varying text. If it fails, check the model ID, account, key, quota, and network, then reload saved history before retrying. The automated tests never call a live provider.

Set `CHAT_MODE` back to `offline` and restart to get the fixed reply again.
::

::tutorial-step{title="Run on a persistent Node server"}
## Run on a persistent Node server

Deploy to a self-hosted Node.js server with one process and a persistent local disk. Keep `host: 'node'` and set no Nitro preset.

```sh [commands/build-node]
corepack pnpm build
corepack pnpm start
```

The start script reads `.env`, which a built Nitro server does not load. Keep `NITRO_HOST=127.0.0.1` and reach the app through an SSH tunnel. Behind an HTTPS reverse proxy, set `CHAT_ORIGIN` to the exact public origin, keep the Origin header, turn off buffering for `/api/chat`, and cap bodies at 16 KiB. Restart after environment changes.

Before you deploy, set `CHAT_DB_PATH` to a private absolute path on a persistent disk, such as `/var/lib/vitehub-chat/chat.sqlite`, owned by the Node user. Keep `CHAT_PASSWORD` and `CHAT_SESSION_SECRET` stable. Back up the database and its WAL files while the server is stopped. Replacing `.output` does not migrate or remove the database.

Checkpoint: on the target host, sign in, get one reply, refresh, and restart the process. Stay in offline mode until these pass. This guide does not deploy a service or create storage.

::warning
The single-owner sign-in suits a private learning app only. It has no account recovery or per-session revocation. Sign-out clears the current browser's cookie. A new `CHAT_SESSION_SECRET` signs out all sessions; a new password alone does not.
::

Before public registration, switch to [ViteHub Auth](/docs/auth), use its checked user ID as the store owner, add shared access and rate limits, and test with two real users. A chat ID never proves identity.

The app keeps at most 100 chats and 20 completed turns per chat, with up to 2,000 characters per prompt and 20,000 per answer, as plain text. Delete removes a row but does not securely erase SQLite pages or backups. Choose a retention policy.

Use one Node process: active-chat locks and request limits live in memory. Multiple replicas, network-mounted SQLite, serverless filesystems, and ephemeral container disks are not supported. A crash stops the running reply. Completed turns stay; unfinished ones are not replayed.

To clean up, stop the server and delete chats in the UI. For a full reset, remove the fixture's `.data`, `.output`, `.nuxt`, and `.vitehub`, and `.env` only to discard the credentials. Clean up a custom `CHAT_DB_PATH` separately. Revoke the gateway key when you no longer need it.

Continue with [Agent Drivers](/docs/agents/agent-drivers), [Auth](/docs/auth), and [Node hosting](/docs/frameworks-hosts/node-self-hosted).
::
