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
