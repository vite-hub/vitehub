import { execFileSync, spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { containerBrokerAddon, containerBrokerEntrypoint } from "../src/internal/container-broker.ts";

describe("container broker", () => {
  it.skipIf(spawnSync("python3", ["--version"]).status !== 0)("defaults both egress and credential hosts to port 443", () => {
    const result = execFileSync("python3", ["-c", `
import json
import sys
import types
sys.modules["mitmproxy"] = types.SimpleNamespace(http=None)
exec(sys.stdin.read())
broker = addons[0]
print(json.dumps([
    broker.allowed("github.com", 443),
    broker.allowed("github.com", 22),
    broker.allowed("github.com", 80),
    broker.allowed("api.github.com", 443),
    broker.allowed("api.github.com", 22),
    host_matches("*.example.com", "api.example.com", 443),
    host_matches("*.example.com", "api.example.com", 8443),
    host_matches("api.example.com:8443", "api.example.com", 8443),
    host_matches("api.example.com:8443", "api.example.com", 443),
]))
`], {
      encoding: "utf8",
      env: { ...process.env, VITEHUB_BROKER_RULES: JSON.stringify({
        allow: ["github.com"],
        policy: "allowlist",
        secrets: [{ hosts: ["api.github.com"], name: "GH_TOKEN", placeholder: "unused" }],
      }) },
      input: containerBrokerAddon,
    });
    expect(JSON.parse(result.trim().split("\n").at(-1)!)).toEqual([true, false, false, true, false, true, false, true, false]);
  });

  it("disables raw TCP fallback and waits for HTTP before connecting upstream", () => {
    expect(containerBrokerEntrypoint).toContain("--set rawtcp=false");
    expect(containerBrokerEntrypoint).toContain("--set connection_strategy=lazy");
  });
});
