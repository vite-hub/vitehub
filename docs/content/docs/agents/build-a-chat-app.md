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

Build a chat app you can keep using after a page refresh or a server restart. You will sign in, create conversations, stream replies, switch between saved chats, stop a reply, and delete history. Nuxt serves the app. A ViteHub Agent runs each reply. `@vite-hub/ui` renders the messages and prompt. Your application owns sign-in, transport, and the SQLite database.

Start with a deterministic Driver. Send `Hello` and see `Offline reply 1: Hello` appear a word at a time. After a restart, send `Still here?` in the same chat and see `Offline reply 2: Still here?`. Once that path works, one environment setting enables a model through AI Gateway.

The [complete source](https://github.com/vite-hub/vitehub/tree/main/fixtures/tutorials/chat-app) includes the app, a sample environment, and tests. This follows the finished-app structure of the [Nuxt UI chat tutorial](https://ui.nuxt.com/blog/how-to-build-an-ai-chat). It uses the current [ViteHub chat components](/docs/ui/blocks/chat-app).

You need Node.js 24.15 or newer, Git, Corepack, and a writable local directory. Allow time for the first repository install and package build. The offline journey needs no provider account, API key, or paid request. Model mode needs a Vercel AI Gateway account and key, a network connection, and a model available to that account. Provider calls can cost money. Check current model pricing and set a provider budget before using that mode.

This is a personal, text-only app for one owner on one Node process. It deliberately leaves out public registration, attachments, tools, and resumable generation. Each completed turn saves the user message and answer together. A failed, stopped, or interrupted turn does not enter saved history.

::tutorial-step{title="Set up the project"}
## Set up the project

Use the repository checkout so the fixture and ViteHub packages come from the same revision. The root lockfile pins the full dependency graph. Do not replace `workspace:*` with the package version printed in the manifest; it may describe an older published contract.

```sh [commands/checkout]
git clone https://github.com/vite-hub/vitehub.git
cd vitehub
corepack pnpm install --frozen-lockfile
corepack pnpm exec vp run --cache --filter vite-hub... --filter @vite-hub/ui... build
cd fixtures/tutorials/chat-app
```

The checkout already contains the finished files. Read and edit them as you follow the steps. All file paths below are relative to `fixtures/tutorials/chat-app`. The code panel contains each complete application file.

The build script allows up to 6 GiB for Node's V8 old-space heap because Nitro bundling exceeds the default heap with these dependencies. Total process memory can be higher. Leave additional RAM available on the build machine. The running app uses the separate `start` command without this flag.

```json [package.json]
{
  "name": "vitehub-chat-tutorial",
  "private": true,
  "type": "module",
  "scripts": {
    "setup": "node scripts/setup.mjs",
    "dev": "nuxt dev --host 127.0.0.1 --port 4318",
    "build": "node --max-old-space-size=6144 node_modules/nuxt/bin/nuxt.mjs build",
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
    "@vite-hub/ui": "workspace:*",
    "ai": "7.0.130",
    "h3": "1.15.11",
    "nuxt": "4.5.2",
    "tailwindcss": "4.3.3",
    "vite-hub": "workspace:*",
    "vue": "3.5.44",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@types/node": "24.19.1",
    "typescript": "6.0.3",
    "vue-tsc": "3.3.12"
  },
  "engines": { "node": ">=24.15.0" }
}
```

The ViteHub Nuxt module discovers Agent Definitions in `server/agents`. Set the Node preset once. `workflow: false` keeps these short chat Invocations inline. Register Nuxt UI before the ViteHub UI module so Nuxt installs its Icon and color-mode dependencies. The ViteHub UI module registers the chat components. Disable font downloads so the offline app does not need a font service.

Set `buildDir: ".nuxt"` to keep generated TypeScript inside the project. The pinned Nitro version skips TypeScript transforms under `node_modules`, where this Nuxt version puts its default build directory.

```ts [nuxt.config.ts]
import viteHub from "vite-hub/nuxt";

export default defineNuxtConfig({
  buildDir: ".nuxt",
  modules: ["@nuxt/ui", "@vite-hub/ui/nuxt", [viteHub, {
    preset: "node",
    agent: true,
    workflow: false,
    console: false,
  }]],
  css: ["~/assets/main.css"],
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

Keep credentials in the server environment. The example contains no secrets.

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

This setup script creates two different random secrets. The owner uses `CHAT_PASSWORD` to sign in. H3 uses `CHAT_SESSION_SECRET` to encrypt the cookie. The script refuses to overwrite an existing `.env`.

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

Checkpoint: `.env` exists, has private file permissions, and contains random values for both secrets. Open it locally to read the owner password. Do not paste that password or a model key into a source file. Keep the host and origin as `127.0.0.1:4318` for the local steps.
::

::tutorial-step{title="Store completed conversations"}
## Store completed conversations

A chat has an ID, a title, a revision, and text messages. The same text-only message shape works with the Agent input and the UI. The server generates message IDs. The first prompt supplies the chat title without another model call.

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

Use Node's SQLite driver for this one-process example. The database lives at `CHAT_DB_PATH`, outside build output. Every lookup, update, and delete includes the authenticated owner. Knowing a chat ID does not grant access.

The revision changes after each completed turn. A conditional update rejects a stale tab instead of overwriting a newer conversation. The app saves both messages in one SQL statement, so a crash cannot leave half of a completed turn.

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

Checkpoint: the store test passes. It saves a turn, closes and reopens the database, checks that another owner cannot read or delete it, rejects a stale save, and deletes the chat. See the [store test source](https://github.com/vite-hub/vitehub/blob/main/fixtures/tutorials/chat-app/test/store.test.ts).
::

::tutorial-step{title="Require the owner to sign in"}
## Require the owner to sign in

Keep access checks on the server before reading history or running an Agent. This personal app uses H3's encrypted cookie session and one high-entropy owner password. It has no public sign-up route. The cookie lasts 12 hours and uses `HttpOnly` and `SameSite=Strict`. An HTTPS `CHAT_ORIGIN` also enables `Secure`.

Write requests must carry the configured Origin. This check also applies to sign-in and sign-out. A client script such as curl must send the same Origin header as the browser.

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

The middleware rejects ViteHub's generated endpoints. The app uses only its own `/api/chat` route, where history, ownership, and limits are checked together. Enabling an Agent integration must not open a second route around those checks.

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

The session route supports status, sign-in, and sign-out. Its simple login limit applies to the whole process. Persistent or shared login limits belong at the reverse proxy for a public service.

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

Keep it running. In another terminal, test an unauthenticated request:

```sh [commands/check-access]
curl -i http://127.0.0.1:4318/api/chats
```

Checkpoint: the request returns `401`. The browser at `http://127.0.0.1:4318` shows sign-in. Use the owner password from `.env`. A missing or short secret leaves the API unavailable; it never enables anonymous access.
::

::tutorial-step{title="Define the offline and model Agents"}
## Define the offline and model Agents

The offline Driver receives the saved conversation plus the new prompt. It counts user turns and streams a fixed reply. Its delay makes the stream visible and gives Stop a path to test. It observes `input.abortSignal`, so closing the response stops its work.

ViteHub event deltas use `text`. The AI SDK transport uses `delta`. The API step below connects those contracts.

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

The second Definition uses the supported model Driver. A model ID string selects AI Gateway. ViteHub reads `AI_GATEWAY_API_KEY` from the server environment when that Driver runs. Defining the Agent makes no provider call.

Limit output, retries, and steps before enabling a billed model. This app grants no tools or Workspace access.

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

Checkpoint: `CHAT_MODE=offline` selects the deterministic Agent. Keep `AI_GATEWAY_API_KEY` empty for the first journey. Both Definitions use `runtime: false`; generation belongs to the active Node request and does not resume after a crash. `invocations: false` disables the separate Agent journal. This app keeps conversation history in its own database.
::

::tutorial-step{title="Expose history and streaming routes"}
## Expose history and streaming routes

The chat-list route returns only the owner's conversations. It allows up to 100 chats. The detail route reads or deletes one owned chat. Deletion waits until its current reply ends.

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

The streaming route accepts only a chat ID, the last saved revision, and one new prompt. It loads trusted history from SQLite. A browser cannot inject assistant messages or another owner's ID into the model context.

The app calls `streamAgent` with `output: 'events'`. It forwards text through an AI SDK UI message stream, waits for the Agent to finish, then saves the completed pair before sending the final transport event. The UI can therefore reload saved history when it receives completion. If saving fails, the stream reports an error.

`getRuntimeContext` adapts the Nuxt request and its background lifetime. The wrapper consumes the full event stream and drains remaining work before finishing. This Node route also aborts the Invocation on a premature response close or after 60 seconds. It removes its listener and active-chat lock in `finally`.

```ts [server/api/chat.post.ts]
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { createError, defineEventHandler, readValidatedBody } from "h3";
import { createMessage, streamAgent, type StreamEvent } from "vite-hub/agent";
import { getRuntimeContext } from "vite-hub/runtime/h3";
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
  const controller = new AbortController();
  const abort = () => { if (!event.node.res.writableEnded) controller.abort(); };
  event.node.res.once("close", abort);
  const timeout = setTimeout(() => controller.abort(), 60_000);
  const runtime = getRuntimeContext(event);
  activeChats.add(id);

  const stream = createUIMessageStream({
    async execute({ writer }) {
      try {
        const output = await streamAgent(mode === "model" ? assistant : offline, runtime, {
          messages: [...thread.messages, user].map(message => createMessage(message)),
          abortSignal: controller.signal,
        }, { output: "events" });
        if (!output || typeof output !== "object" || !(Symbol.asyncIterator in output)) {
          throw new Error("Expected an Agent event stream.");
        }
        writer.write({ type: "start", messageId: reply.id });
        writer.write({ type: "text-start", id: reply.id });
        let answer = "";
        // The events output of streamAgent is a StreamEvent iterable.
        for await (const part of output as AsyncIterable<StreamEvent>) {
          controller.signal.throwIfAborted();
          if (part.type === "error") throw new Error("Agent failed.");
          if (part.type !== "text-delta") continue;
          answer += part.text;
          if (answer.length > 20_000) throw new Error("Reply exceeds the storage limit.");
          writer.write({ type: "text-delta", id: reply.id, delta: part.text });
        }
        await runtime.flushWaitUntil();
        controller.signal.throwIfAborted();
        if (!answer.trim()) throw new Error("Agent returned no text.");
        reply.parts[0]!.text = answer;
        store.save(owner, id, revision, [...thread.messages, user, reply]);
        writer.write({ type: "text-end", id: reply.id });
        writer.write({ type: "finish", finishReason: "stop" });
      } finally {
        clearTimeout(timeout);
        event.node.res.off("close", abort);
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

Checkpoint: after signing in, select New chat in the finished app and send `Hello`. The reply is exactly `Offline reply 1: Hello`. Open the browser Network panel and find `/api/chat`; it returns `text/event-stream`. A stale revision returns `409`, and a provider or persistence error does not appear as a completed saved turn.
::

::tutorial-step{title="Build the chat interface"}
## Build the chat interface

Use the [Chat app block](/docs/ui/blocks/chat-app) composition. A child pane owns each chat's AI SDK state. Its footer keeps the prompt below the message viewport, so status text cannot cover the last reply. Key it by the chat ID so switching conversations unmounts the old prompt and transport.

`DefaultChatTransport` normally sends client history. Its request callback sends only the fields our endpoint accepts. On completion, the pane reloads the server copy and advances its revision. Stop keeps the partial reply visible until the user reloads saved history. Retry loads the saved state before the user sends their draft again; it does not create a second billable request automatically.

```vue [app/components/ChatPane.vue]
<script setup lang="ts">
import { useChat } from "@ai-sdk/vue";
import { ChatSession, PromptInput, type PromptInputSubmit } from "@vite-hub/ui";
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

The app shell adds sign-in, a saved-chat list, and deletion. On a narrow screen, the list sits above the conversation. Local storage remembers only the selected ID. The server still checks the cookie and owner before returning that chat.

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

Checkpoint: create two chats, send a different prompt in each, and switch between them. Each chat shows its own history. Tab through the controls and send a message with Enter. Shift+Enter adds a line. Resize the page to a phone width. The message list and composer stay within the available height.
::

::tutorial-step{title="Prove refresh, restart, and cancellation"}
## Prove refresh, restart, and cancellation

Send `Hello` in a new chat and wait until the prompt is ready again. Refresh the browser. The same two messages return from SQLite. No model or Agent rerun is needed to display them.

Stop the dev server with Ctrl+C and start it again with `corepack pnpm dev`. Keep `.env` and `.data` intact. Refresh, open that chat, and send `Still here?`. The exact reply is `Offline reply 2: Still here?`. That count comes from saved history passed to a new Invocation.

Next, send a long sentence and press Stop while words appear. Select Reload saved history. The partial turn disappears because it never completed. If Stop races with completion, the reload can contain the completed turn. The saved database is authoritative. A response lost after a successful save has the same recovery path.

Stop the dev server before running the automated production check:

```sh [commands/check-journey]
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test:journey
```

The [journey test](https://github.com/vite-hub/vitehub/blob/main/fixtures/tutorials/chat-app/test/journey.test.mjs) runs the built server twice on `127.0.0.1:4319`. It creates temporary credentials and a temporary SQLite database. It checks rejected unauthenticated and cross-origin requests, blocked generated routes, streamed text, history after a real process restart, a second turn, cancellation, and deletion. It forces offline mode, then stops the server and removes its temporary data.

Checkpoint: all checks pass, port 4319 is free again, and your manual browser chat still exists. The automated test uses a different database. HTTP tests cover the server journey; the browser checks cover the layout and interaction.
::

::tutorial-step{title="Connect a real model"}
## Connect a real model

Stop the server. Edit these existing keys in `.env`: set `CHAT_MODE` to `model`, set `AI_GATEWAY_API_KEY` to your private gateway key, and choose an available model through `CHAT_MODEL`. The example defaults to `openai/gpt-4.1-mini`.

Do not put the key in `runtimeConfig.public`, Vue code, or a `VITE_` variable. Set a provider budget before the first request. Each send includes the saved conversation, so later turns can use more input tokens. The app's 800-output-token limit and request limits are not a spending cap.

```sh [commands/start-model]
corepack pnpm dev
```

Checkpoint: the sidebar says that model requests may incur charges. Start a new chat and ask a question. The answer streams through the same route and persists through the same store. The exact text varies. If the request fails, check the model ID, gateway account, key, quota, and network access. Reload saved history before retrying. This tutorial's automated tests never validate a live provider call.

Return `CHAT_MODE` to `offline` and restart whenever you need the exact teaching response again.
::

::tutorial-step{title="Run on a persistent Node server"}
## Run on a persistent Node server

The deployment target is a self-hosted Node.js server with one process and a persistent local disk. Keep `preset: 'node'`. Do not also set a Nitro preset.

```sh [commands/build-node]
corepack pnpm build
corepack pnpm start
```

The start script reads `.env`; a built Nitro server does not load it on its own. Keep `NITRO_HOST=127.0.0.1` and use an SSH tunnel for personal access. If you put an HTTPS reverse proxy in front, set `CHAT_ORIGIN` to the exact public HTTPS origin. Preserve the Origin header, disable buffering for `/api/chat`, and cap request bodies at 16 KiB. Restart after changing the environment.

Before deploying, set `CHAT_DB_PATH` to a private absolute path on a persistent disk, such as `/var/lib/vitehub-chat/chat.sqlite`. Run Node as a user who owns that directory. Keep `CHAT_PASSWORD` and `CHAT_SESSION_SECRET` stable across restarts. Back up the database while the server is stopped, including its WAL side files. Replacing `.output` does not migrate or remove the database.

Checkpoint: repeat sign-in, one completed reply, a browser refresh, and a process restart on the target Node host. Keep the first deployment in offline mode until those checks pass. This guide does not deploy a service or provision storage for you.

The single-owner sign-in is suitable for a private teaching app. It has no account recovery or per-session revocation list. Sign-out clears the current browser cookie. Rotating `CHAT_SESSION_SECRET` signs out all sessions; changing only the owner password does not. Before public registration, replace this flow with [ViteHub Auth](/docs/auth), use its checked user ID as the store owner, add shared access and rate policies, and test access between two real users. A chat ID is never proof of identity.

Storage limits are explicit. The app stores at most 100 chats for the owner and 20 completed turns per chat. It accepts up to 2,000 characters per prompt and 20,000 per answer. It stores plain text. Delete removes a row, but does not securely erase SQLite pages or backups. Choose a retention policy for the data you collect.

Use one Node process. Active-chat locks and request limits live in memory. This setup does not support multiple replicas, network-mounted SQLite, serverless filesystems, or ephemeral container disks. A process crash interrupts generation. Completed turns remain; unfinished turns are not replayed.

To clean up, stop the server first. Delete individual chats through the UI. For a full local reset, remove this fixture's `.data`, `.output`, `.nuxt`, and `.vitehub` directories. Remove its `.env` only when you want to discard the local credentials. Clean up a custom `CHAT_DB_PATH` separately. Revoke a gateway key through its provider when you no longer need it.

Continue with [Agent Drivers](/docs/agents/agent-drivers), [Auth](/docs/auth), and [Node hosting](/docs/frameworks-hosts/node-self-hosted).
::
