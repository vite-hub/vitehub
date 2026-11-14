---
title: Forms limits and errors
description: "Default and fixed limits of a form, plus the FORMS error codes and how to fix them."
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Limits

Set `maxBytes` and `rateLimit` in `defineForm()` to change the body and message limits. The page path and selected text caps are fixed. Set `limit` in each `forms.list` call to change its page size.

| Limit | Default |
| --- | --- |
| Body | 64 KB |
| Messages from one address | 5 a minute, in each server process |
| Page path | 2,000 characters |
| Selected text (`_anchor.exact`) | 1,000 characters |
| `forms.list` page | 100, at most 500 |

The address is the peer address that the host reports, and an IPv6 address counts as its /64 network. Behind a reverse proxy, such as nginx, Caddy, or a Docker ingress, the peer is the proxy, so all visitors share one budget. Raise `rateLimit` there, or turn it off and limit at the proxy.

## Errors

A wrong `defineForm()` throws when you define it. The inbox returns `[error, data]`.

### FORMS_C0001

The form is wrong: `schema` is not a Standard Schema, a limit is out of range, or a file of `server/forms/` does not default-export `defineForm()`. Fix the definition.

### FORMS_B0001

A file of `server/forms/` has a name that is not lowercase letters, digits, and dashes, or two files define the same form. Rename the file.

### FORMS_B0002

A build has forms that store messages, but the app has no Database, so the messages would be lost. Remove `database: false`, or set `store: false` with `notify` or `onSubmit` in each form that the error names. A development server keeps the messages in memory instead.

### FORMS_R0001

The Database could not read or write a message. Most often the table is missing: run `vitehub database generate` and `vitehub database migrate`.

### FORMS_R0002

No message has that id. List the messages again.
