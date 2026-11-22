# @vite-hub/forms decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## The browser client has its own small diagnostics catalog with only the submit codes

`formsClientDiagnostics` in `packages/forms/src/client-diagnostics.ts`.

**Context:** client.ts is bundled into the browser; importing the full Forms catalog would ship every server code and fix string.

**Decision:** The browser client has its own small diagnostics catalog with only the submit codes.

**Consequences:** Merging it into formsDiagnostics bloats every page bundle that submits a form.

## submitForm drops File values from FormData and sends only text fields, URL-encoded

`requestBody` in `packages/forms/src/client.ts`.

**Context:** The server guard answers 400 for any non-string form value, and stored submissions are JSON that cannot hold files.

**Decision:** submitForm drops File values from FormData and sends only text fields, URL-encoded.

**Consequences:** Sending files makes every form with a file input fail with 400, or stringifies a File as "[object File]".

## Each route keeps the idempotency key of its latest failed send and reuses it only for a retry with the identical body

`latestSends` in `packages/forms/src/client.ts`.

**Context:** The server may have stored the message before the answer was lost; the same key makes the retry return the stored submission instead of a duplicate.

**Decision:** Each route keeps the idempotency key of its latest failed send and reuses it only for a retry with the identical body.

**Consequences:** Fresh keys on retry store duplicates; reusing keys for a different body makes the server answer 422.

## The idempotency key comes from optional crypto.randomUUID?.(), and is left out when it is missing

`submitForm` in `packages/forms/src/client.ts`.

**Context:** randomUUID exists only in secure contexts (HTTPS, localhost); on plain HTTP the server generates the id instead.

**Decision:** The idempotency key comes from optional crypto.randomUUID?.(), and is left out when it is missing.

**Consequences:** Calling crypto.randomUUID() unconditionally throws on every non-secure page.

## The Console Message column lists the same long-text keys as longTextKeys in fields.ts

`formsConsoleSection` in `packages/forms/src/console.ts`.

**Context:** The column shows the field that AutoForm draws as a textarea; the list is duplicated by hand, not derived.

**Decision:** The Console Message column lists the same long-text keys as longTextKeys in fields.ts.

**Consequences:** Adding a key to longTextKeys without updating this column hides that message in the Console list.

## Detect a missing Forms table by matching `no such table` across up to 5 levels of `cause`

`isMissingTable` in `packages/forms/src/database.ts`.

**Context:** SQLite, libSQL, and D1 all use that message, and Drizzle wraps the driver error in `cause`.

**Decision:** Detect a missing Forms table by matching `no such table` across up to 5 levels of `cause`.

**Consequences:** Checking only the top error loses FORMS_TABLES_MISSING and its migrate fix; it becomes the generic FORMS_R0001.

## Read Valibot enum choices from `node.options`, not from the enum object

`fromValibot` in `packages/forms/src/fields.ts`.

**Context:** A TypeScript numeric enum object also holds reverse keys (name strings); Valibot's `options` holds only the values.

**Decision:** Read Valibot enum choices from `node.options`, not from the enum object.

**Consequences:** Reading the enum object adds the enum names as extra choices and breaks the number type of the select.

## A schema whose jsonSchema.input() throws is reported as a non-drawable field, not as a failure

`collectFields` in `packages/forms/src/fields.ts`.

**Context:** Custom checks such as z.custom() have no JSON Schema but still validate, so only drawing a surface fails.

**Decision:** A schema whose jsonSchema.input() throws is reported as a non-drawable field, not as a failure.

**Consequences:** Letting the error escape breaks validation and coercion for forms that never need drawing.

## Schema output is checked as plain JSON and round-tripped through JSON.stringify/parse before hooks, notifications, and stores see it

`jsonData` in `packages/forms/src/fields.ts`.

**Context:** The memory store and the SQLite store must hold the same data; a Date, Map, or class instance would differ between them.

**Decision:** Schema output is checked as plain JSON and round-tripped through JSON.stringify/parse before hooks, notifications, and stores see it.

**Consequences:** Dropping the round trip makes onSubmit, email, and the memory store see values the Database store cannot return.

## Focus the first invalid field only after nextTick(), once the error element renders

`useFormSubmit.send`, `formSender.send`, `AutoForm.setup.onSubmit` in `packages/forms/src/formisch.ts`, `packages/forms/src/vue.ts`.

**Context:** The field must already reference its error through aria-describedby when focus lands, so a screen reader reads the error with the field.

**Decision:** Focus the first invalid field only after nextTick(), once the error element renders.

**Consequences:** Focusing before the render makes screen readers announce the field without its error. `useFormSubmit.send` calls Formisch's `focus()` itself because Formisch's Vue focus runs before that render (open-circle/formisch#271). Drop the manual focus there once Formisch focuses after render.

## Cancel an oversized body stream without awaiting the cancel, and ignore its rejection

`readBytes` in `packages/forms/src/guard.ts`.

**Context:** When the host passes a tee'd (cloned) request, cancel() of one branch waits until the other branch is consumed.

**Decision:** Cancel an oversized body stream without awaiting the cancel, and ignore its rejection.

**Consequences:** Awaiting the cancel can hang the 413 answer forever.

## Collapse leading slashes of the stored page path to one

`appPath` in `packages/forms/src/guard.ts`.

**Context:** A path such as `//evil.test` is a protocol-relative URL; it is used later as the 303 redirect location.

**Decision:** Collapse leading slashes of the stored page path to one.

**Consequences:** Removing the collapse makes the no-JavaScript redirect an open redirect to another site.

## Compare the Origin header with forwardedRequestOrigin(request), not with request.url

`guardRequest` in `packages/forms/src/guard.ts`.

**Context:** Behind a TLS-terminating proxy request.url is http: while the browser sends its https: origin.

**Decision:** Compare the Origin header with forwardedRequestOrigin(request), not with request.url.

**Consequences:** Comparing with request.url refuses every same-site post behind a proxy with 403.

## The app check gets a new Request built from the bounded, buffered bytes and the copied public fields of the original

`guardRequest` in `packages/forms/src/guard.ts`.

**Context:** The size limit must apply before any callback reads the body, the guard must still read the same bytes after the check, and Nitro's Node request adapter has no native Request internal state to clone.

**Decision:** The app check gets a new Request built from the bounded, buffered bytes and the copied public fields of the original.

**Consequences:** Passing the original request lets the check read an unbounded body or consume it before the guard; `new Request(request)` fails on Nitro Node.

## Identify and authorize run in the guard check, before the rate limit and body parsing

`handleFormRequest` in `packages/forms/src/handler.ts`.

**Context:** A refused sender must use no rate budget, and authorize needs the bounded body.

**Decision:** Identify and authorize run in the guard check, before the rate limit and body parsing.

**Consequences:** Moving authorize after the rate limit lets anonymous traffic drain the budget of signed-in senders.

## Store diagnostics are caught and answered as JSON 500 with code, message, and fix; other errors are rethrown

`handleFormRequest.storeFailed` in `packages/forms/src/handler.ts`.

**Context:** A host answers a thrown error with a bare 500, so the code and fix would only reach the server log.

**Decision:** Store diagnostics are caught and answered as JSON 500 with code, message, and fix; other errors are rethrown.

**Consequences:** Letting store errors throw hides FORMS_TABLES_MISSING and its fix from the client.

## A known idempotency key returns the stored answer only when form and data match; otherwise 422

`handleFormRequest.repeated` in `packages/forms/src/handler.ts`.

**Context:** A retry must get the stored 201, but a reused key from another message must not silently drop the new one.

**Decision:** A known idempotency key returns the stored answer only when form and data match; otherwise 422.

**Consequences:** Returning 201 for any known key loses messages that reuse a key.

## When the submission is stored, an email failure is logged (and may run in waitUntil) but the request still succeeds; with store: false it answers 502

`handleFormRequest` in `packages/forms/src/handler.ts`.

**Context:** A stored message is safe in the inbox, so the visitor need not resend; without a store the email is the only copy.

**Decision:** When the submission is stored, an email failure is logged (and may run in waitUntil) but the request still succeeds; with store: false it answers 502.

**Consequences:** Failing a stored request on email error makes the visitor resend and creates a duplicate.

## The operations import runtime.ts lazily, when they run

`inbox` in `packages/forms/src/operations.ts`.

**Context:** The inbox lives in the Nitro runtime; the CLI loads the operations to list them outside that runtime.

**Decision:** The operations import runtime.ts lazily, when they run.

**Consequences:** A static import pulls the Nitro runtime into the CLI and breaks `vitehub forms` listing.

## Forms operations set user: false; access to the Console Forms section is the only authorization

`defineFormsOperation` in `packages/forms/src/operations.ts`.

**Context:** The operations never read the signed-in user; the section gate decides who sees the inbox.

**Decision:** Forms operations set user: false; access to the Console Forms section is the only authorization.

**Consequences:** Adding per-user logic without knowing this mixes two authorization models; removing the section gate exposes every submission.

## Resolve the Forms Database through useDatabase(options.database) and map its error to FORMS_DATABASE_MISSING

`createFormsHandler` in `packages/forms/src/runtime.ts`.

**Context:** The registry also holds a placeholder `default` entry (backing the `db` export) that throws, so reading the registry directly is wrong.

**Decision:** Resolve the Forms Database through useDatabase(options.database) and map its error to FORMS_DATABASE_MISSING.

**Consequences:** Reading `databases.default` directly throws an unexplained error instead of FORMS_DATABASE_MISSING.

## A choice of numbers is refused for MCP elicitation instead of being sent as a text enum

`elicitationProperty` in `packages/forms/src/surfaces.ts`.

**Context:** MCP elicitation enums hold only strings, so number choices come back as text that the schema refuses.

**Decision:** A choice of numbers is refused for MCP elicitation instead of being sent as a text enum.

**Consequences:** Allowing number choices produces elicitations that can never validate.

## The last `store` key or any spread/dynamic key decides; only a literal `store: false` as the last such property counts as not storing

`storingForms` in `packages/forms/src/vite.ts`.

**Context:** A spread or dynamic key after `store: false` can replace it, so the static scan stays conservative.

**Decision:** The last `store` key or any spread/dynamic key decides; only a literal `store: false` as the last such property counts as not storing.

**Consequences:** Ignoring spreads lets a production build without a Database pass for a form that does store, losing submissions.

## The Forms Nitro handler is registered with lazy: false

`hubForms.config.handler` in `packages/forms/src/vite.ts`.

**Context:** Loading the handler installs the inbox on globalThis; server code and operations read the inbox before any submission arrives.

**Decision:** The Forms Nitro handler is registered with lazy: false.

**Consequences:** Making it lazy leaves installedForms() undefined and operations throw FORMS_NOT_INSTALLED until the first post.

## Read event.currentTarget before the first await

`useFormAction.submit`, `AutoForm.setup.onSubmit` in `packages/forms/src/vue.ts`.

**Context:** The DOM resets currentTarget to null once event dispatch ends, which happens at the first await.

**Decision:** Read event.currentTarget before the first await.

**Consequences:** Moving the read after an await makes the form null and the submit silently does nothing.

## Pass the submitter to FormData only when submitter.form is this form

`formSender.send` in `packages/forms/src/vue.ts`.

**Context:** A browser post includes the submitter's name and value, but `new FormData(form, submitter)` throws for a submitter of another form.

**Decision:** Pass the submitter to FormData only when submitter.form is this form.

**Consequences:** Passing any submitter throws for buttons tied to another form; dropping it loses the submitter value.

## Set `selected` on each option instead of relying on the select value

`AutoFormControl` in `packages/forms/src/vue.ts`.

**Context:** A server-rendered select has no value attribute, so before hydration the browser shows the first option.

**Decision:** Set `selected` on each option instead of relying on the select value.

**Consequences:** Using only `value` makes SSR pages show the first real choice instead of "Choose one" and post it without JavaScript.

## Number inputs get step="any"

`AutoFormControl` in `packages/forms/src/vue.ts`.

**Context:** The browser validates number inputs before the app runs, and its default step of 1 refuses decimals that v.number() accepts.

**Decision:** Number inputs get step="any".

**Consequences:** Removing it makes the no-JavaScript form refuse values such as 1.5.

## Field errors have no alert role; only the whole-form error is an alert

`AutoFormControl` in `packages/forms/src/vue.ts`.

**Context:** Focus moves to the first invalid field, which reads its error through aria-describedby; an alert would announce it twice.

**Decision:** Field errors have no alert role; only the whole-form error is an alert.

**Consequences:** Adding role=alert to field errors makes screen readers announce every error twice.

## The honeypot is hidden off screen, out of the tab order and accessibility tree, not with display: none

`FormHoneypot` in `packages/forms/src/vue.ts`.

**Context:** Bots skip fields with display: none, so the trap would not catch them.

**Decision:** The honeypot is hidden off screen, out of the tab order and accessibility tree, not with display: none.

**Consequences:** Switching to display: none or hidden makes the honeypot useless.

## AutoForm counts edits and checks so a stale client check neither sends the form nor overwrites a newer result

`AutoForm.setup`, `AutoForm.setup.onSubmit` in `packages/forms/src/vue.ts`.

**Context:** Schema checks are async and can be slow; the user can edit or click again while one runs.

**Decision:** AutoForm counts edits and checks so a stale client check neither sends the form nor overwrites a newer result.

**Consequences:** Without the counters an old check sends outdated values or replaces newer field errors.

## AutoForm renders method/action and sets novalidate only after mount

`AutoForm.setup` in `packages/forms/src/vue.ts`.

**Context:** Before hydration or without JavaScript, the form posts natively to its route and the browser checks required and type itself.

**Decision:** AutoForm renders method/action and sets novalidate only after mount.

**Consequences:** Setting novalidate on the server or dropping method/action breaks the no-JavaScript form and its browser checks.

## Remove the result query through Vue Router when the app has one, else through history.replaceState

`AutoForm.setup` in `packages/forms/src/vue.ts`.

**Context:** Vue Router keeps its own copy of the address, so a native history change comes back on the next navigation.

**Decision:** Remove the result query through Vue Router when the app has one, else through history.replaceState.

**Consequences:** Using history.replaceState in a router app brings the result query back and shows the message again.

## After a no-JavaScript post returns, focus moves to the status region, unless the visitor is already in a field

`AutoForm.setup.onMounted` in `packages/forms/src/vue.ts`.

**Context:** The page loads at the top and initial text is not announced; focusing while the user is in a field closes the phone keyboard.

**Decision:** After a no-JavaScript post returns, focus moves to the status region, unless the visitor is already in a field.

**Consequences:** Without the move the result is never announced; without the guard the keyboard closes under the user.

## AutoForm strips the `?form=<name>.sent|error` query after it shows the result

`AutoForm.setup.onMounted` in `packages/forms/src/vue.ts`.

**Context:** A reload, a shared link, or navigating back must not show the result again.

**Decision:** AutoForm strips the `?form=<name>.sent|error` query after it shows the result.

**Consequences:** Keeping the query shows a stale success or error on every reload.

## Await router.isReady() before reading the route, then re-check the query

`AutoForm.setup.onMounted` in `packages/forms/src/vue.ts`.

**Context:** An app-shell form can mount before the router reaches the requested page, and a guard may redirect to a page with another form's result while waiting.

**Decision:** Await router.isReady() before reading the route, then re-check the query.

**Consequences:** Reading the route early or skipping the re-check strips the wrong query or another form's result.

## The submit button uses aria-disabled, not disabled, and a second submit is ignored in the handler

`AutoForm.setup` in `packages/forms/src/vue.ts`.

**Context:** The button must stay focusable while sending, so keyboard and screen reader users keep their place.

**Decision:** The submit button uses aria-disabled, not disabled, and a second submit is ignored in the handler.

**Consequences:** Using `disabled` drops focus to the body during each send.

## The role=status live region is always rendered, empty when there is no result

`AutoForm.setup` in `packages/forms/src/vue.ts`.

**Context:** Screen readers announce text inserted into an existing live region, not a region that appears with its text.

**Decision:** The role=status live region is always rendered, empty when there is no result.

**Consequences:** Rendering the region only with a result makes success and error messages silent.

## The submit label never changes while sending; aria-busy signals the busy state

`AutoForm.setup` in `packages/forms/src/vue.ts`.

**Context:** A changing label resizes the button and shifts the layout.

**Decision:** The submit label never changes while sending; aria-busy signals the busy state.

**Consequences:** Swapping the label to "Sending..." makes the button jump width.

## The test writes input values through the HTMLInputElement prototype setter, then dispatches an input event

`mount.fill` in `packages/forms/test/form-action.test.ts`.

**Context:** ui-sdk treats a write through the instance setter as a change by code, not user typing, and ignores it.

**Decision:** The test writes input values through the HTMLInputElement prototype setter, then dispatches an input event.

**Consequences:** Setting `input.value` directly makes the fill a no-op for ui-sdk and the tests fail or pass vacuously.

## Without Rate Limit, Forms counts in the memory of each Worker isolate

`createFormsHandler` in `packages/forms/src/runtime.ts`, `renderFormsHandler` in `packages/forms/src/vite.ts`.

**Context:** A Cloudflare Rate Limit binding needs its name, limit and period (10 s or 60 s) at build time, while Forms reads a policy per form at run time.

**Decision:** When the app uses Rate Limit, the generated handler passes `checkRateLimit` and Forms counts there. Otherwise, or when Rate Limit is unavailable, Forms counts in the memory of the process, which on Workers is one isolate.

**Consequences:** Without Rate Limit, the Workers limit is weak, since each isolate counts on its own. Declaring the `forms` limit as a Cloudflare binding would need build-time policies for every form.
