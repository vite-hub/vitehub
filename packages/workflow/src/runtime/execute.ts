import type { WorkflowDefinition, WorkflowExecutionContext, WorkflowProviderStep, WorkflowStepFunction, WorkflowStepOptions } from "../types.ts"

const defaultStepOptions = {
  retries: {
    backoff: "exponential",
    delay: "10 seconds",
    limit: 3,
  },
} satisfies WorkflowStepOptions

export async function runProviderStep<TResult>(
  step: WorkflowProviderStep | undefined,
  name: string,
  run: () => TResult | Promise<TResult>,
  options: WorkflowStepOptions = defaultStepOptions,
): Promise<TResult> {
  if (typeof step?.do === "function") {
    return await step.do(name, options, run)
  }

  return await run()
}

function toStepPropertyName(file: string): string {
  const base = file
    .split("/")
    .pop()!
    .replace(/\.(?:c|m)?[jt]s$/i, "")
    .replace(/^\d+[.-]?/, "")

  return base.replace(/[-_.]+([a-z0-9])/gi, (_, char: string) => char.toUpperCase())
}

export function createWorkflowSteps(
  context: WorkflowExecutionContext,
  stepModules: Array<{ name: string, run: WorkflowStepFunction }>,
): Record<string, WorkflowStepFunction> {
  return Object.fromEntries(stepModules.map((module) => {
    const propertyName = toStepPropertyName(module.name)
    return [
      propertyName,
      async (input: unknown) => await runProviderStep(
        context.step,
        `${context.name}/${module.name}`,
        () => module.run(input),
      ),
    ]
  }))
}

export async function runWorkflowHandler<TPayload, TResult>(
  context: WorkflowExecutionContext<TPayload>,
  definition: WorkflowDefinition<TPayload, TResult>,
): Promise<TResult> {
  const run = () => definition.handler(context)
  if (definition.options?.rootStep === false) {
    return await run()
  }

  return await runProviderStep(context.step, context.name, run)
}
