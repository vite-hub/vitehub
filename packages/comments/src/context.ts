import type { CommentContext } from "./types.ts"

/**
 * The context of a thread as label and value pairs, in the order a person reads them: page, element, components,
 * browser, build. The Console and Agent tools show these.
 */
export function describeCommentContext(context: CommentContext | null): Array<{ label: string, value: string }> {
  if (!context) return []
  const fields: Array<{ label: string, value: string }> = [{ label: "URL", value: context.url }]
  if (context.title) fields.push({ label: "Title", value: context.title })
  if (context.route) fields.push({ label: "Route", value: context.route })
  const element = context.element
  if (element) {
    const tag = `<${element.tag}${element.id ? ` id="${element.id}"` : ""}${element.testId ? ` data-testid="${element.testId}"` : ""}>`
    fields.push({ label: "Element", value: [tag, element.role && `role ${element.role}`, element.name && `"${element.name}"`].filter(Boolean).join(" ") })
  }
  if (context.components?.length) {
    fields.push({ label: "Components", value: context.components.map(component => component.name).join(" › ") })
    const files = [...new Set(context.components.flatMap(component => component.files ?? []))]
    if (files.length) fields.push({ label: "Files", value: files.join(", ") })
  }
  const environment = context.environment
  if (environment) {
    fields.push({ label: "Viewport", value: `${environment.viewport.width}×${environment.viewport.height} at ${environment.devicePixelRatio}x${environment.colorScheme ? `, ${environment.colorScheme}` : ""}` })
    fields.push({ label: "Browser", value: environment.userAgent })
  }
  if (context.build?.commit || context.build?.branch) {
    fields.push({ label: "Build", value: [context.build.branch, context.build.commit?.slice(0, 12)].filter(Boolean).join(" @ ") })
  }
  return fields
}
