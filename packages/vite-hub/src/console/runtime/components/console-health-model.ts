import * as v from "valibot";

export type ConsoleHealth = {
  checkedAt: string;
  diagnostics: Array<{
    detail?: string;
    label: string;
    status: "neutral" | "ok" | "warning";
    value: string;
  }>;
  status: "degraded" | "healthy";
  summary: string;
  workload: { active: number; completed: number; failed: number; snapshots?: number; total: number };
};

const diagnosticSchema = v.object({
  detail: v.optional(v.string()),
  label: v.string(),
  status: v.picklist(["neutral", "ok", "warning"]),
  value: v.string(),
});
const workloadCountSchema = v.pipe(
  v.number(),
  v.check((value) => Number.isSafeInteger(value) && value >= 0),
);
const healthSchema = v.object({
  checkedAt: v.pipe(
    v.string(),
    v.check((value) => Number.isFinite(Date.parse(value))),
  ),
  diagnostics: v.array(diagnosticSchema),
  status: v.picklist(["degraded", "healthy"]),
  summary: v.string(),
  workload: v.pipe(
    v.object({
      active: workloadCountSchema,
      completed: workloadCountSchema,
      failed: workloadCountSchema,
      snapshots: v.optional(workloadCountSchema),
      total: workloadCountSchema,
    }),
    v.check(
      (workload) =>
        workload.active <= workload.total &&
        workload.completed <= workload.total &&
        workload.failed <= workload.total &&
        workload.active + workload.completed + workload.failed <= workload.total,
    ),
  ),
});

export function isConsoleHealth(value: unknown): value is ConsoleHealth {
  return v.safeParse(healthSchema, value).success;
}
