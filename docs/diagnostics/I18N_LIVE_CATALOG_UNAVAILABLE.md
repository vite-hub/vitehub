---
description: "Find out why the browser fell back to the build catalog after a failed live catalog request."
---

The request to `/_vitehub/i18n/<locale>.json` failed or returned a non-2xx status. The browser logs a warning and uses the build catalog. This warning does not make `setLocale()` return an error.

Open the URL for the affected locale and check the server log and network. If `fetch()` rejected, the warning's `cause` holds the fetch error. If the server returned a non-2xx response, the warning reports the HTTP status without a `cause`.
