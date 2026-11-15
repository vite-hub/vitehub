/**
 * Define operations that the Console, the CLI, MCP, and Agents call. A Vite plugin contributes them with
 * `vitehub: { operations: [{ module, export }] }`. Read https://vitehub.dev/docs/development/operations.
 */
export { defineOperation } from "@vite-hub/internal/operation-definition"
export type {
  OperationAccess,
  OperationActor,
  OperationContext,
  OperationContributingPlugin,
  OperationContributionEntry,
  OperationContributions,
  OperationDefinition,
  OperationFailure,
  OperationKind,
  OperationResult,
  OperationUser,
} from "@vite-hub/internal/operation-definition"
