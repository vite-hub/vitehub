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
