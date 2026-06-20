import { parseArgs } from "node:util";
import assert from "node:assert/strict";

import { ofetch } from "ofetch";

const PROVIDERS = ["cloudflare", "vercel"];

const liveOnlyMessage =
  "KV e2e requires a deployed app: vp run kv:e2e --mode live --provider cloudflare|vercel --url <url>";
const log = (msg) => console.log(`[e2e] ${msg}`);

const assertProbe = async (f, expected) =>
  assert.deepEqual(await f("/api/tests/probe"), { ok: true, ...expected });

const assertKvWrite = async (f) =>
  assert.deepEqual(await f("/api/tests/kv", { method: "POST" }), {
    ok: true,
    value: { key: "smoke", store: "kv" },
  });

const providerProbe = {
  cloudflare: { provider: "cloudflare-kv-binding" },
  vercel: { provider: "upstash" },
};

async function assertLiveProbe(f, provider) {
  const expected = providerProbe[provider];

  if (provider !== "cloudflare") {
    await assertProbe(f, expected);
    return;
  }

  let lastError;
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      await assertProbe(f, expected);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 20) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  throw lastError;
}

async function runLive(url, provider) {
  log(`live ${provider} -> ${url}`);
  const f = (p, i) => ofetch(p, { baseURL: url, ...i });
  await assertLiveProbe(f, provider);
  await assertKvWrite(f);
  log(`live ${provider} ✓`);
}

const { values } = parseArgs({
  options: { mode: { type: "string" }, url: { type: "string" }, provider: { type: "string" } },
  strict: true,
});
const mode = values.mode ?? "local";
const provider = values.provider;
if (provider) assert.ok(PROVIDERS.includes(provider), `invalid --provider: ${provider}`);

if (mode !== "live" && mode !== "local") {
  throw new TypeError(liveOnlyMessage);
}

assert.ok(values.url, `--url required for ${mode} mode`);
assert.ok(provider, `--provider required for ${mode} mode`);
await runLive(values.url, provider);
