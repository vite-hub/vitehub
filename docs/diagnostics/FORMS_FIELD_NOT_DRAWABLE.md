---
description: "Fix FORMS_FIELD_NOT_DRAWABLE in ViteHub. A surface cannot draw a field of the form schema, such as a nested object in a Slack modal. Keep the form flat."
seo.title: "FORMS_FIELD_NOT_DRAWABLE: field cannot render"
---

`formFields()`, `toElicitation()`, `toChatModal()`, or `AutoForm` throws `FORMS_FIELD_NOT_DRAWABLE`. One field of the form schema has a shape that the surface cannot draw. The message names the field, its shape, and the surface.

## Why it happens

Every surface draws a flat form: one input for each text, number, true or false, or choice. These shapes have no input:

- a nested object
- a list
- a union of types
- a root that is not an object

An MCP elicitation also refuses a choice of numbers, because MCP choices are text.

`FORMS_FIELD_NOT_DRAWABLE` is a configuration error. It throws when you draw the form, and it does not come back as `[error, value]`.

## Fix it

Keep the form flat. Move nested data to its own form, or join it into one text field.

```diff [server/forms/contact.ts]
 export default defineForm({
   schema: v.object({
     email: v.pipe(v.string(), v.email()),
-    address: v.object({ street: v.string(), city: v.string() }),
+    street: v.string(),
+    city: v.string(),
   }),
 })
```

For an MCP elicitation, write a choice of numbers as text, such as `v.picklist(['1', '2', '3'])`, and convert the answer on the server.

## Related

- [One schema on every surface](/docs/forms/server-api)
- [Forms limits and errors](/docs/forms/limits-and-errors)
