---
description: "Fix an invalid webhook body by passing JSON data and converting Date or bigint values before calling sendWebhook()."
---

The body is not JSON data. Pass a plain object, an array, a string, a number, a boolean, or `null`. Convert a `Date` to an ISO string and a `bigint` to a string first.
