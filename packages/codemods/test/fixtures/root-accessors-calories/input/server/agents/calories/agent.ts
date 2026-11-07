import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
import { defineAgent } from "vite-hub/agent";
import {
  audioBytes,
  blob,
  db as databaseCapability,
  transcribe,
  usage,
} from "vite-hub/agent/capabilities";
import { telegram } from "vite-hub/agent/channels";
import { useServerEnv } from "#vitehub/env/server";

// Models sometimes copy the message headers and reply lines they receive.
function withoutMessageMetadata(text: string) {
  return text
    .replace(/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{4}-\d{2}-\d{2} [^\]\n]*\][ \t]*\n?/gm, "")
    .replace(/^↪ replying to .*$\n?/gm, "")
    .trim();
}

function dashboardUrl() {
  return new URL("/dashboard", useServerEnv().app.url).href;
}

export default defineAgent({
  // Run history for the Console and CLI. A failed history write does not stop a meal.
  invocations: "database",
  capabilities: [
    blob({ mode: "write" }),
    databaseCapability({ mode: "write" }),
    transcribe({
      async execute({ audio }) {
        const { text } = await generateText({
          model: createOpenRouter({ apiKey: useServerEnv().openrouter.apiKey.unseal() })(
            "mistralai/voxtral-small-24b-2507",
          ),
          messages: [{
            role: "user",
            content: [
              { type: "text", text: "Transcribe this audio exactly. Return only the transcript." },
              { type: "file", data: await audioBytes(audio), mediaType: audio.mediaType },
            ],
          }],
        });
        return text;
      },
    }),
    usage(),
  ],
  channels: {
    telegram: telegram({
      allowedUserIds: () => [useServerEnv().telegram.allowedUserId],
      botToken: () => useServerEnv().telegram.botToken,
      webhookSecret: () => useServerEnv().telegram.webhookSecret,
      messages: {
        concurrency: "steer",
        // Messages sent within this window start one run; later ones steer into it.
        debounceMs: 2_000,
        delivery: "manual",
        fallbackStreamingPlaceholderText: null,
        lockScope: "channel",
        // Message headers show this local time. Madrid and Stockholm share one clock.
        timeZone: "Europe/Stockholm",
        triggerHistory: {
          maxAgeMs: 30 * 60 * 1_000,
          maxImages: 3,
          maxMessages: 20,
          source: "thread",
        },
        timeout: 28_000,
      },
    }),
  },
  driver: {
    maxRetries: 0,
    model: () => createOpenRouter({ apiKey: useServerEnv().openrouter.apiKey.unseal() })(
      "z-ai/glm-5.3-flashx",
    ),
  },
  hooks: {
    "agent:error"(event) {
      console.error("[calories] Agent invocation failed", event.error);
      const reference = event.invocation.traceId ?? event.invocation.run?.runId;

      return event.reply([
        "Sorry, I couldn't finish that reply. I may have saved the meal before the failure, so check the dashboard before retrying.",
        "Dashboard: " + dashboardUrl(),
        ...(reference ? [`Reference: ${reference}`] : []),
      ].join("\n"));
    },
    "agent:finish"(event) {
      const cost = event.invocation.usage?.cost?.display ?? "Cost unavailable";
      return event.reply([
        withoutMessageMetadata(event.text ?? "") || "No reply was returned. Check the dashboard for the result.",
        "Dashboard: " + dashboardUrl(),
        cost,
      ].join("\n\n"));
    },
  },
});
