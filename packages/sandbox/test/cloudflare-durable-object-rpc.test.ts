import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { expect, it } from "vitest";

it("transfers generated process logs across a Workers Durable Object RPC boundary", async () => {
  const bundle = await build({
    bundle: true,
    external: ["cloudflare:*"],
    format: "esm",
    platform: "neutral",
    stdin: {
      resolveDir: import.meta.dirname,
      contents: `
        import { DurableObject } from "cloudflare:workers";
        import { createCloudflareSandboxDurableObject } from "../src/internal/cloudflare-durable-object.ts";
        const Implementation = createCloudflareSandboxDurableObject({
          DurableObject: class {}, Files: class {}, SandboxFileError: { is: () => false },
        });
        export class Sandbox extends DurableObject {
          async logs() {
            const encode = text => new TextEncoder().encode(text);
            const container = {
              running: true,
              async exec() {
                return {
                  exitCode: Promise.resolve(0),
                  stdout: new ReadableStream({ start(c) { c.enqueue(encode("output")); c.close(); } }),
                  stderr: new ReadableStream({ start(c) { c.enqueue(encode("warning")); c.close(); } }),
                };
              },
            };
            const sandbox = new Implementation({ container }, {});
            const process = await sandbox.startProcess("short-command");
            const stream = await sandbox.streamProcessLogs(process.id);
            // RPC documents a byte source even on runtimes that also accept default streams.
            const reader = stream.getReader({ mode: "byob" });
            reader.releaseLock();
            return stream;
          }
        }
        export default {
          async fetch(request, env) {
            const sandbox = env.SANDBOX.get(env.SANDBOX.idFromName("test"));
            return new Response(await sandbox.logs());
          },
        };
      `,
    },
    write: false,
  });
  const worker = new Miniflare({
    compatibilityDate: "2026-07-30",
    durableObjects: { SANDBOX: "Sandbox" },
    modules: true,
    script: bundle.outputFiles![0]!.text,
  });
  try {
    const response = await worker.dispatchFetch("https://example.com/");
    const events = await response.text();
    expect(response.status).toBe(200);
    expect(events).toContain('"data":"output","type":"stdout"');
    expect(events).toContain('"data":"warning","type":"stderr"');
    expect(events).toContain('"exitCode":0,"type":"exit"');
  } finally {
    await worker.dispose();
  }
}, 30_000);
