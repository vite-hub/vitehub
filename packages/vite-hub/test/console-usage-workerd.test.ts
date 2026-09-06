import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import * as v from "valibot";
import { expect, it } from "vitest";

it("paginates Console usage in Cloudflare without Node compatibility", async () => {
  const root = resolve(import.meta.dirname, "..");
  const sourceModule = async (path: string) => ({
    type: "ESModule" as const,
    path: resolve(root, path),
    contents: transpileModule(await readFile(resolve(root, path), "utf8"), {
      compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2023 },
    }).outputText,
  });
  // Load the real usage module and its dependencies without bundling or Node shims.
  const worker = new Miniflare({
    compatibilityDate: "2026-04-20",
    compatibilityFlags: [],
    modulesRoot: root,
    modules: [
      {
        type: "ESModule",
        path: resolve(root, "worker.mjs"),
        contents: `
          import { usageCursor, usageQueryWindow } from "./src/console/runtime/server/usage.ts";
          export default {
            async fetch(request) {
              const query = await request.json();
              const to = "2026-09-05T12:00:00.000Z";
              const last = { at: to, id: "雪🌍%41" };
              const cursor = query.cursor ?? usageCursor(query, to, last);
              const page = usageQueryWindow({ ...query, cursor });
              return Response.json({ cursor, after: page.after, to: page.to, buffer: typeof Buffer });
            }
          };
        `,
      },
      await sourceModule("src/console/runtime/server/usage.ts"),
      await sourceModule("src/error-diagnostics.ts"),
      { type: "ESModule", path: resolve(root, "src/console/runtime/server/valibot"), contents: await readFile(new URL(import.meta.resolve("valibot")), "utf8") },
      { type: "ESModule", path: resolve(root, "src/nostics"), contents: await readFile(new URL(import.meta.resolve("nostics")), "utf8") },
    ],
  });
  try {
    const query = { agentName: "雪🌍%41", search: "100%_ &+?#" };
    const request = (body: object) => worker.dispatchFetch("http://console.test", {
      method: "POST", body: JSON.stringify(body),
    });
    const first = await request(query);
    expect(first.status).toBe(200);
    const page = await first.json();
    const { cursor } = v.parse(v.object({ cursor: v.string() }), page);
    expect(page).toMatchObject({
      buffer: "undefined", after: { id: "雪🌍%41", at: "2026-09-05T12:00:00.000Z" },
    });
    const next = await request({ ...query, cursor });
    expect(next.status).toBe(200);
    expect(await next.json()).toEqual(page);
  } finally {
    await worker.dispose();
  }
}, 30_000);
