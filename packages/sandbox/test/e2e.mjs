import assert from "node:assert/strict";
import { parseArgs } from "node:util";

import { ofetch } from "ofetch";

const providers = ["cloudflare", "vercel"];
const liveOnlyMessage =
  "Sandbox e2e requires a deployed app: vp run sandbox:e2e --mode live --provider cloudflare|vercel --url <url>";

const expectedProbe = {
  cloudflare: {
    feature: "sandbox",
    hasWaitUntil: [true, false],
    hosting: "cloudflare-module",
    ok: true,
    provider: "cloudflare",
    runtime: ["cloudflare", null],
  },
  vercel: {
    feature: "sandbox",
    hasWaitUntil: [true, false],
    hosting: "vercel",
    ok: true,
    provider: "vercel",
    runtime: ["vercel", "node", null],
  },
};

const releaseNotesRequest = {
  notes: "- Added weekly digest\n- Fixed invite flow\n- Tightened signup copy",
};

const expectedReleaseNotes = {
  result: {
    items: ["Added weekly digest", "Fixed invite flow", "Tightened signup copy"],
    summary: "Added weekly digest",
  },
};

const log = (message) => console.log(`[e2e] ${message}`);

async function retry(label, run) {
  let lastError;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (attempt < 10) {
        log(`${label} retry ${attempt}/9`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }
  throw lastError;
}

function assertMatches(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    if (Array.isArray(value)) {
      assert.ok(
        value.some((item) => Object.is(item, actual[key])),
        `expected ${key} to be one of ${JSON.stringify(value)}, got ${JSON.stringify(actual[key])}`,
      );
    } else {
      assert.deepEqual(actual[key], value);
    }
  }
}

async function runLive(url, provider) {
  const request = (path, options) => ofetch(path, { baseURL: url, ...options });
  log(`live ${provider} -> ${url}`);

  await retry(`${provider} probe`, async () => {
    assertMatches(await request("/api/tests/probe?sandbox=1"), expectedProbe[provider]);
  });
  await retry(`${provider} sandbox`, async () => {
    assert.deepEqual(
      await request("/api/sandboxes/release-notes", {
        body: JSON.stringify(releaseNotesRequest),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      expectedReleaseNotes,
    );
  });

  log(`live ${provider} ok`);
}

const { values } = parseArgs({
  options: {
    mode: { type: "string" },
    provider: { type: "string" },
    url: { type: "string" },
  },
  strict: true,
});

const mode = values.mode ?? "local";
const provider = values.provider;

if (mode !== "live") throw new TypeError(liveOnlyMessage);
assert.ok(values.url, "--url required for live mode");
assert.ok(provider && providers.includes(provider), "--provider required for live mode");

await runLive(values.url, provider);
