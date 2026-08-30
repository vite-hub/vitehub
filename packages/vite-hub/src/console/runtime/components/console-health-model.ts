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
  workload: { active: number; completed: number; failed: number; snapshots: number; total: number };
};

const diagnosticSchema = v.object({
  detail: v.optional(v.string()),
  label: v.string(),
  status: v.picklist(["neutral", "ok", "warning"]),
  value: v.string(),
});
const finiteNumberSchema = v.pipe(
  v.number(),
  v.check((value) => Number.isFinite(value)),
);
const healthSchema = v.object({
  checkedAt: v.pipe(v.string(), v.check((value) => Number.isFinite(Date.parse(value)))),
  diagnostics: v.array(diagnosticSchema),
  status: v.picklist(["degraded", "healthy"]),
  summary: v.string(),
  workload: v.object({
    active: finiteNumberSchema,
    completed: finiteNumberSchema,
    failed: finiteNumberSchema,
    snapshots: finiteNumberSchema,
    total: finiteNumberSchema,
  }),
});

export function isConsoleHealth(value: unknown): value is ConsoleHealth {
  return v.safeParse(healthSchema, value).success;
}
