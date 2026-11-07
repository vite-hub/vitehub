export interface ScannedDefinition {
  name: string
  handler: string
  _meta: {
    filename: string
    sourcePath: string
  }
}

export function toTemplateSafeName(name: string) {
  return name.replace(/[^a-z0-9/_:-]/gi, '_').replace(/\//g, '__').replace(/:/g, '__')
}
