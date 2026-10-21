import { describe, expect, it } from "vitest";
import { createAgentEnvIdentity } from "../../agent/src/internal/env-identity.ts";
import { agentEnvAccess } from "../src/internal/agent.ts";
import { connectionEnvAccess, envAccessAgentParents } from "../src/internal/connections.ts";
import type { EnvAccessContext, EnvBridge } from "../src/bridge.ts";

describe("Agent parents in Env access", () => {
  it("carries the parents that the Agent runtime registered, nearest first", () => {
    const identity = createAgentEnvIdentity({ name: "bot-canary" }, "bot-canary", ["bot-dev", "bot", "bot-canary"]);
    const access = agentEnvAccess(identity);
    expect(access.actor).toEqual({ kind: "agent", id: "bot-canary" });
    expect(envAccessAgentParents(access)).toEqual(["bot-dev", "bot"]);
    // The result is a copy. Changing it does not change the authority.
    envAccessAgentParents(access).push("admin");
    expect(envAccessAgentParents(access)).toEqual(["bot-dev", "bot"]);
    expect(envAccessAgentParents(agentEnvAccess(createAgentEnvIdentity({ name: "inline" })))).toEqual([]);
  });

  it("ignores parents in caller values", () => {
    const registered = createAgentEnvIdentity({ name: "bot-dev" });
    const forgedIdentity = createAgentEnvIdentity({ name: "bot-dev", parents: ["bot"] });
    expect(envAccessAgentParents(agentEnvAccess(forgedIdentity))).toEqual([]);
    expect(() => agentEnvAccess({ ...registered, parents: ["bot"] })).toThrow(expect.objectContaining({ code: "ENV_BRIDGE_UNTRUSTED" }));
    const copied = { ...agentEnvAccess(createAgentEnvIdentity({ name: "bot-dev" }, "bot-dev", ["bot"])) } as EnvAccessContext;
    const forged = { actor: { kind: "agent", id: "bot-dev" }, parents: ["bot"] } as unknown as EnvAccessContext;
    for (const context of [copied, forged]) {
      expect(() => envAccessAgentParents(context)).toThrow(expect.objectContaining({ code: "ENV_BRIDGE_UNTRUSTED" }));
    }
  });

  it("does not give parents to contexts that are not Agent runtime contexts", () => {
    // A key context only carries the bridge. This test never calls it.
    const bridge = {} as unknown as EnvBridge;
    const key = connectionEnvAccess(bridge, { actor: { kind: "agent", id: "bot-dev" }, name: "mail", permission: "use" });
    expect(() => envAccessAgentParents(key)).toThrow(expect.objectContaining({ code: "ENV_BRIDGE_UNTRUSTED" }));
  });
});
