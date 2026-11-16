// @vitest-environment happy-dom

import type { CommentMessage } from "@vite-hub/comments/client";
import { afterEach, expect, it, vi } from "vitest";
import { createSSRApp, h, nextTick } from "vue";
import { renderToString } from "@vue/server-renderer";
import { CommentReply } from "../src/index.ts";

const message: CommentMessage = {
  attachments: [],
  author: { id: "ana", name: "Ana Ruiz" },
  body: "Hi",
  createdAt: Date.UTC(2026, 10, 16, 8, 14, 31),
  id: "m1",
  mentions: [],
  threadId: "thread-1",
};
const timeZone = process.env.TZ;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.env.TZ = timeZone;
  document.body.innerHTML = "";
});

// Renders on a server at `server`, then hydrates that HTML in a browser at `client`, and returns Vue's hydration warnings.
async function hydrate(server: { now: number, timeZone: string }, client: { now: number, timeZone: string }) {
  const app = () => createSSRApp({ render: () => h(CommentReply, { compact: true, message }) });
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(server.now);
  process.env.TZ = server.timeZone;
  const html = await renderToString(app());

  vi.setSystemTime(client.now);
  process.env.TZ = client.timeZone;
  const warnings: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args) => void warnings.push(args.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => void warnings.push(args.map(String).join(" ")));
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  app().mount(container);
  await nextTick();
  const time = container.querySelector("time");
  if (!time) throw new Error("CommentReply rendered no <time>.");
  return { mismatches: warnings.filter((line) => /hydration/i.test(line)), time };
}

it("hydrates the time of a reply that a server in another time zone rendered", async () => {
  const at = message.createdAt + 15 * 60_000;
  const { mismatches, time } = await hydrate({ now: at, timeZone: "UTC" }, { now: at, timeZone: "America/New_York" });

  expect(mismatches).toEqual([]);
  expect(time.getAttribute("title")).toBe(new Date(message.createdAt).toLocaleString());
});

it("hydrates the time of a reply from HTML that was rendered earlier", async () => {
  const { mismatches, time } = await hydrate(
    { now: message.createdAt + 15 * 60_000, timeZone: "UTC" },
    { now: message.createdAt + 45 * 60_000, timeZone: "UTC" },
  );

  expect(mismatches).toEqual([]);
  expect(time.textContent).toBe("45 minutes ago");
  expect(time.getAttribute("datetime")).toBe("2026-11-16T08:14:31.000Z");

  vi.advanceTimersByTime(60_000);
  await nextTick();
  expect(time.textContent).toBe("46 minutes ago");
});
