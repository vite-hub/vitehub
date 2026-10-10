import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentHealthDiagnostic } from "../../server/health.ts";
import type { BabysitterInstall } from "../babysitter.ts";
import type { BabysitterAdmissionPause } from "./admission.ts";
import { isRuntimeRecord } from "../../internal/runtime-type.ts";

const execute = promisify(execFile);

/** Cached host prerequisites. Failed checks recover without restarting webhook intake. */
export function createBabysitterPreflight(install: BabysitterInstall, checkCommand: (program: string) => Promise<void> = async program => {
  await execute(program, ["--version"], { timeout: 5000, maxBuffer: 64 * 1024 });
}) {
  let cached: { checkedAt: string; diagnostics: AgentHealthDiagnostic[]; pause?: BabysitterAdmissionPause } | undefined;
  let expiresAt = 0;
  let pending: Promise<NonNullable<typeof cached>> | undefined;
  return async () => {
    if (cached && Date.now() < expiresAt) return cached;
    pending ??= (async () => {
      const diagnostics: AgentHealthDiagnostic[] = [];
      const commands = ["git"];
      if (install !== false && !(isRuntimeRecord(install) && install.command)) commands.push("corepack");
      for (const program of commands) {
        try {
          await checkCommand(program);
          diagnostics.push({ label: `Host ${program}`, status: "ok", value: "Available" });
        } catch {
          diagnostics.push({ label: `Host ${program}`, status: "warning", value: "Unavailable", detail: `Install ${program === "git" ? "Git" : "Corepack"} in the trusted host service PATH. Model passes wait until this check succeeds.` });
        }
      }
      const failures = diagnostics.filter(item => item.status === "warning");
      const result: NonNullable<typeof cached> = { checkedAt: new Date().toISOString(), diagnostics };
      if (failures.length) result.pause = { reason: "host-prerequisite", detail: failures.map(item => item.detail).join(" "), retryAt: Date.now() + 30_000 };
      cached = result;
      expiresAt = Date.now() + (failures.length ? 30_000 : 5 * 60_000);
      return result;
    })();
    try { return await pending; }
    finally { pending = undefined; }
  };
}
