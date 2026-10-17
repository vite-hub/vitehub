import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentHealthDiagnostic } from "../../server/health.ts";
import type { BabysitterInstall } from "../babysitter.ts";
import type { BabysitterAdmissionPause } from "./admission.ts";
import { isRuntimeRecord } from "../../internal/runtime-type.ts";

const execute = promisify(execFile);

/** Cached host prerequisites. Failed checks recover without restarting webhook intake. */
export function createBabysitterPreflight(install: BabysitterInstall, checkCommand: (program: string, probe?: "version" | "path") => Promise<void> = async (program, probe = "version") => {
  await execute(probe === "path" ? "which" : program, probe === "path" ? [program] : ["--version"], { timeout: 5000, maxBuffer: 64 * 1024 });
}) {
  let cached: { checkedAt: string; diagnostics: AgentHealthDiagnostic[]; pause?: BabysitterAdmissionPause } | undefined;
  let expiresAt = 0;
  let pending: Promise<NonNullable<typeof cached>> | undefined;
  return async () => {
    if (cached && Date.now() < expiresAt) return cached;
    pending ??= (async () => {
      const diagnostics: AgentHealthDiagnostic[] = [];
      const commands = ["git"];
      if (install !== false) {
        const installer = isRuntimeRecord(install) ? install.command : undefined;
        const program = installer ?? "corepack";
        if (!commands.includes(program)) commands.push(program);
      }
      for (const program of commands) {
        try {
          await checkCommand(program, program === "git" || program === "corepack" ? "version" : "path");
          diagnostics.push({ label: `Host ${program}`, status: "ok", value: "Available" });
        } catch {
          const display = program === "git" ? "Git" : program === "corepack" ? "Corepack" : program;
          diagnostics.push({ label: `Host ${program}`, status: "warning", value: "Unavailable", detail: `Install ${display} in the trusted host service PATH. Model passes wait until this check succeeds.` });
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
