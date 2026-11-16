---
description: "Fix EMAIL_TEMPLATE_RENDER_FAILED in ViteHub. email.send({ template }) got data that the Markdown template cannot render. Correct the data."
seo.title: "EMAIL_TEMPLATE_RENDER_FAILED: fix the data"
---

`email.send({ template, data })` returns `EMAIL_TEMPLATE_RENDER_FAILED`. The template under `server/emails` did not render with `data`, so ViteHub did not send the message.

## Why it happens

`error.cause` is the error of the Markdown renderer, and its message names the binding. For example, `data.user.name` is missing, is `null`, or is an object. TypeScript catches these cases when the type of `data` is known. They happen at runtime when `data` comes from a request body, a database row, or a value typed as `unknown`.

## Fix it

Pass a string, number, or boolean for each `{{ data.* }}` binding, and a string for each `:insert` binding. A value that the template reads only inside an `::if` branch can be missing.

```diff [server/welcome.ts]
 const [error] = await email.send({
   template: 'welcome',
-  data: { user },
+  data: { user: { name: user.name ?? 'there' } },
   from: 'hello@example.com',
   to,
   subject: 'Welcome',
 })
```

Do not retry the same message. It fails the same way until `data` changes.

## Check the fix

Run `vitehub email preview welcome --data '{"user":{"name":"Ada"}}'` with the same `data`. It renders the template without sending it, and fails with the same binding when `data` does not fit.

## Related

- [Send a template](/docs/email/server-api#send-a-template)
- [`EMAIL_TEMPLATE_NOT_FOUND`](/docs/email/diagnostics/email_template_not_found)
- [Email limits and errors](/docs/email/limits-and-errors)
