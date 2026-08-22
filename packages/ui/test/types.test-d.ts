import type { UIMessage } from "ai";
import type { ViteHubUIMessage, ViteHubUISession } from "../src/index.ts";

declare const message: ViteHubUIMessage<{ createdAt: string }, { weather: { city: string } }>;
const compatible: UIMessage = message;
const session: ViteHubUISession<typeof message> = { id: "session-1", messages: [message] };

void compatible;
void session;
