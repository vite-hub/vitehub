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
