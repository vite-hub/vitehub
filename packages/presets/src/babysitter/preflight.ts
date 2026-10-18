import { execFile } from "node:child_process";
import { access, open, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { AgentHealthDiagnostic } from "../../server/health.ts";
import type { BabysitterInstall } from "../babysitter.ts";
import type { BabysitterAdmissionPause } from "./admission.ts";
import { isRuntimeRecord } from "../internal/runtime-type.ts";

const execute = promisify(execFile);

async function validateExecutable(path: string): Promise<void> {
  await access(path, constants.X_OK);
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`Executable is not a file: ${path}`);
  // An executable text file must name an interpreter, otherwise execve reports
  // ENOEXEC even though the executable permission bit is present.
  if (process.platform !== "win32") {
    const file = await open(path, "r");
    const buffer = Buffer.alloc(256);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0).finally(() => file.close());
    const header = buffer.subarray(0, bytesRead).toString("utf8");
    if (!header.startsWith("#!")) {
      const bytes = Buffer.from(header);
      const elf = bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
      const macho = (bytes[0] === 0xfe && bytes[1] === 0xed && (bytes[2] === 0xfa || bytes[2] === 0xfb))
        || (bytes[0] === 0xca && bytes[1] === 0xfe && bytes[2] === 0xba && bytes[3] === 0xbe)
        || (bytes[0] === 0xcf && bytes[1] === 0xfa && bytes[2] === 0xed && bytes[3] === 0xfe);
      if (!elf && !macho) {
        throw new Error(`Executable has no interpreter: ${path}`);
      }
    } else {
      const line = header.slice(2, header.indexOf("\n") < 0 ? undefined : header.indexOf("\n")).trim();
      const parts = line.split(/\s+/).filter(Boolean);
      const interpreter = parts[0] === "/usr/bin/env" || parts[0] === "/bin/env"
        ? parts.slice(1).find(part => !part.startsWith("-"))
        : parts[0];
      if (!interpreter) throw new Error(`Executable has no interpreter: ${path}`);
      await resolveExecutable(interpreter);
    }
  }
}

async function resolveExecutable(program: string): Promise<void> {
  if (isAbsolute(program) || program.includes("/") || program.includes("\\")) {
    await validateExecutable(program);
    return;
  }
  const path = process.env.PATH ?? "";
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").some(extension => program.toLowerCase().endsWith(extension.toLowerCase()))
      ? [""]
      : ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")]
    : [""];
  for (const directory of path.split(delimiter)) {
    for (const extension of extensions) {
      const candidate = join(directory || ".", `${program}${extension}`);
      try { await access(candidate, constants.X_OK); } catch { continue; }
      // Continue only when PATH resolution cannot select this entry. Once an
      // executable candidate is found, validation errors must be reported.
      await validateExecutable(candidate);
      return;
    }
  }
  throw new Error(`Executable not found: ${program}`);
}

/** Cached host prerequisites. Failed checks recover without restarting webhook intake. */
export function createBabysitterPreflight(install: BabysitterInstall, checkCommand: (program: string, probe?: "version" | "path") => Promise<void> = async (program, probe = "version") => {
  if (probe === "path") await resolveExecutable(program);
  else await execute(program, ["--version"], { timeout: 5000, maxBuffer: 64 * 1024 });
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
        // A checkout-relative custom command has no stable host PATH probe and
        // may not implement --version; the installer validates its real args.
        if ((isAbsolute(program) || (!program.includes("/") && !program.includes("\\"))) && !commands.includes(program)) commands.push(program);
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
