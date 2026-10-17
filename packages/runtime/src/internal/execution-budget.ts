/**
 * Marks a tool whose own implementation spends the enclosing execution budget.
 *
 * This is intentionally an internal, identity-based marker. A public metadata
 * field would let a tool opt out by copying a string into its descriptor.
 */
const budgetHandledTools = new WeakSet<object>()

export function markExecutionBudgetHandled(tool: object): void {
  budgetHandledTools.add(tool)
}

export function isExecutionBudgetHandled(tool: object): boolean {
  return budgetHandledTools.has(tool)
}
