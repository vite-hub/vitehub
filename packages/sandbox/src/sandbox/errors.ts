import { VitehubError, type VitehubErrorMetadata } from '../internal/shared/errors'
export { NotSupportedError } from '../internal/shared/errors'

export class SandboxError extends VitehubError {
  constructor(message: string, metadata?: string | VitehubErrorMetadata) {
    super(message, metadata)
    this.name = 'SandboxError'
  }
}
