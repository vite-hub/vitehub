import { ViteHubError } from "@vite-hub/runtime"

import type { ViteHubErrorDetails, ViteHubErrorOptions } from "@vite-hub/runtime"

export type WorkflowErrorCode =
  | "VERCEL_WORKFLOW_SDK_LOAD_FAILED"
  | "WORKFLOW_DEFINITION_NOT_FOUND"
  | "WORKFLOW_DISABLED"
  | "WORKFLOW_NATIVE_ENTRY_INVALID"
  | "WORKFLOW_NATIVE_ENTRY_REQUIRED"
  | "WORKFLOW_OPERATION_UNSUPPORTED"
  | "WORKFLOW_RUN_ID_UNSUPPORTED"

export interface WorkflowErrorOptions<
  TCode extends string = string,
  TDetails extends ViteHubErrorDetails = ViteHubErrorDetails,
> extends Pick<ViteHubErrorOptions<TDetails>, "cause" | "details"> {
  code: TCode
  message: string
}

export class WorkflowError<
  TCode extends string = string,
  TDetails extends ViteHubErrorDetails = ViteHubErrorDetails,
> extends ViteHubError<TCode, TDetails> {
  constructor(options: WorkflowErrorOptions<TCode, TDetails>) {
    const { code, message, ...errorOptions } = options
    super(code, message, errorOptions)
    this.name = "WorkflowError"
  }
}
