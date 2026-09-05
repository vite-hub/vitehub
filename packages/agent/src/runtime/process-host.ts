import { mkdir } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { join } from "node:path";
import {
  createProcessReconciler,
  type ProcessReconciler,
  type ProcessReconcilerOptions,
  type ProcessReconcilerStatus,
} from "@vite-hub/runtime/node";
import { normalizeRuntimeDiagnosticError } from "@vite-hub/runtime";
import { createLibsqlAgentInvocationStore } from "../invocations/sqlite.ts";
import { readAgentInvocationWorkload } from "../server/invocation-health.ts";
import {
  createProcessAgentCapacity,
  createProcessAgentInvocations,
  type ProcessAgentCapacityOptions,
} from "./process.ts";
import type { AgentInvocations } from "../invocations.ts";
import type { AgentDriverCapacityOptions } from "../types.ts";

export interface ProcessAgentHostOptions {
  /** Exclusively owned by this process. Do not share with another running host. */
  dataDir?: string;
  name?: string
  providerCommand?: string;
  capacity: ProcessAgentCapacityOptions;
  intervalMs?: number;
  run: (
    reason: string,
    context: Parameters<ProcessReconcilerOptions["run"]>[1],
    accepting: () => boolean,
  ) => Promise<void> | void;
}

export interface ProcessAgentDiagnostic {
  label: string
  status: "neutral" | "ok" | "warning"
  value: string
  detail?: string
}

export interface ProcessAgentHost {
  capacity: AgentDriverCapacityOptions;
  invocations: AgentInvocations;
  providerSessionStorePath: string;
  event(event: string, detail?: Record<string, unknown>): void;
  error(event: string, error: unknown, detail?: Record<string, unknown>): void;
  start(): void;
  close(): Promise<void>;
  wake(reason?: string): void;
  status(): ProcessReconcilerStatus | "starting";
  health(): Promise<{ diagnostics: ProcessAgentDiagnostic[];
    checkedAt: string;
    status: "healthy" | "degraded";
    workload: Awaited<ReturnType<typeof readAgentInvocationWorkload>>;
  }>;
}

/** Own process admission, interrupted invocation recovery, and graceful drain together. */
export async function createProcessAgentHost(
  options: ProcessAgentHostOptions,
): Promise<ProcessAgentHost> {
  const dataDir = options.dataDir ?? ".vitehub";
  await mkdir(dataDir, { recursive: true });
  const startedAt = Date.now();
  const capacity = createProcessAgentCapacity(options.capacity);
  const invocations = await createProcessAgentInvocations({
    content: "content",
    store: createLibsqlAgentInvocationStore({
      maxRecords: 5_000,
      url: `file:${join(dataDir, "invocations.sqlite")}`,
    }),
    recovery: { before: startedAt, recover: () => true },
  });
  let reconciler: ProcessReconciler | undefined;
  let accepting = false;
  let closed = false;
  const event = (event: string, detail: Record<string, unknown> = {}) =>
    console.info(
      `[${options.name ?? "vitehub"}]`,
      JSON.stringify({ ...detail, event, timestamp: new Date().toISOString() }),
    );
  const error = (event: string, error: unknown, detail: Record<string, unknown> = {}) =>
    console.error(
      `[${options.name ?? "vitehub"}]`,
      JSON.stringify({
        ...detail,
        event,
        timestamp: new Date().toISOString(),
        error: normalizeRuntimeDiagnosticError(error, { includeStack: true }),
      }),
    );
  return {
    event,
    error,
    capacity,
    invocations,
    providerSessionStorePath: join(dataDir, "provider-sessions.sqlite"),
    start() {
      if (reconciler || closed) return;
      accepting = true;
      reconciler = createProcessReconciler({
        intervalMs: options.intervalMs ?? 120_000,
        signal: "SIGUSR2",
        onQuiesce: () => {
          accepting = false;
        },
        onError: (cause, reason) => error("process.reconcile.failed", cause, { reason }),
        run: (reason, context) => options.run(reason, context, () => accepting),
      });
      reconciler.wake("startup");
    },
    async close() {
      closed = true;
      accepting = false;
      await reconciler?.close();
    },
    wake(reason = "work-completed") {
      if (accepting) reconciler?.wake(reason);
    },
    status: () => reconciler?.status() ?? "starting",
    async health() {
      const workload = await readAgentInvocationWorkload(invocations, startedAt);
      const diagnostics: ProcessAgentDiagnostic[] = [
        { label: "Runtime", status: "ok", value: `Node ${process.version}`, detail: `Up for ${Math.floor(process.uptime() / 60)}m` },
        { label: "Invocation state", status: workload.stale ? "warning" : "ok", value: workload.stale ? `${workload.stale} stale` : "Reconciled", detail: "Process-owned invocation recovery" },
      ]
      if (options.providerCommand) {
        try {
          const { stdout } = await promisify(execFile)(options.providerCommand, ["--version"], { timeout: 2_000 })
          diagnostics.push({ label: "Provider", status: "ok", value: stdout.trim().split(/\r?\n/, 1)[0] || "Available" })
        }
        catch { diagnostics.push({ label: "Provider", status: "warning", value: "Executable unavailable" }) }
      }
      return {
        diagnostics,
        checkedAt: new Date().toISOString(),
        status: diagnostics.some(item => item.status === "warning") ? "degraded" : "healthy",
        workload,
      };
    },
  };
}
