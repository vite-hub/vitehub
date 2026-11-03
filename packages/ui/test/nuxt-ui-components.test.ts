import type { CommentThread as CommentThreadModel } from "@vite-hub/comments/client";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vitest";
import { createSSRApp, defineComponent, h } from "vue";
import { CommentThread } from "../src/components/comment-thread.ts";
import { createViteHubUI } from "../src/config.ts";

const ana = { id: "ana", name: "Ana Ruiz" };
const thread: CommentThreadModel = {
  anchor: { kind: "page" },
  author: ana,
  createdAt: 1_000,
  id: "thread-1",
  messages: [{ attachments: [], author: ana, body: "Comment", createdAt: 1_000, id: "message-1", mentions: [], threadId: "thread-1" }],
  n: 1,
  scope: "site",
  status: "open",
  subject: { id: "/pricing", kind: "page" },
  updatedAt: 1_000,
};

const stand = (name: string) => defineComponent({ setup: (_props, { attrs }) => () => h("button", { "data-stand-in": name, "aria-label": attrs["aria-label"] }) });

// Nuxt imports Nuxt UI into each template and registers nothing globally, so a part cannot find `UButton` by name.
describe("the Nuxt UI components of the parts", () => {
  it("renders Nuxt UI's own components when the app registers none", async () => {
    const html = await renderToString(createSSRApp({ render: () => h(CommentThread, { thread, user: ana }) }));
    expect(html).toContain('aria-label="Resolve"');
    expect(html).not.toContain("<ubutton");
    expect(html).not.toContain("data-stand-in");
  });

  it("renders the components given to createViteHubUI before global ones", async () => {
    const app = createSSRApp({ render: () => h(CommentThread, { thread, user: ana }) });
    app.component("UButton", stand("global"));
    app.use(createViteHubUI({ components: { UButton: stand("provided") } }));
    const html = await renderToString(app);
    expect(html).toContain('data-stand-in="provided"');
    expect(html).not.toContain('data-stand-in="global"');
  });

  it("renders a globally registered stand-in, as a page without Nuxt UI registers", async () => {
    const app = createSSRApp({ render: () => h(CommentThread, { thread, user: ana }) });
    app.component("UButton", stand("global"));
    expect(await renderToString(app)).toContain('data-stand-in="global"');
  });
});
