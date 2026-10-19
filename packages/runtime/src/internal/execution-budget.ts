/**
 * Marks a tool whose own implementation spends the enclosing execution budget.
 *
 * This is intentionally an internal, identity-based marker. A public metadata
 * field would let a tool opt out by copying a string into its descriptor.
 */
import type { ExecutionBudget } from "../execution-budget.ts"

const budgetHandledTools = new WeakMap<object, ExecutionBudget>()

export function markExecutionBudgetHandled(tool: object, budget: ExecutionBudget): void {
  budgetHandledTools.set(tool, budget)
}

export function isExecutionBudgetHandled(tool: object, budget: ExecutionBudget): boolean {
  return budgetHandledTools.get(tool) === budget
}

export function executionBudgetHandledBy(tool: object): ExecutionBudget | undefined {
  return budgetHandledTools.get(tool)
}
