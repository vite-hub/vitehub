---
description: "Fix DOCS_REDIRECTS_BROKEN in @vite-hub/docs. A redirect route rule goes to no docs page, or hides one."
seo.title: "DOCS_REDIRECTS_BROKEN: a redirect breaks docs links"
---

A redirect route rule breaks a link. With the link checker on, a production build stops. The message lists each rule with its fix:

```txt [output/docs-redirect-error.txt]
Docs redirects break links:
- The redirect from /docs/old goes to /docs/nowhere, which is not a docs page. Point it to a page, or remove the route rule.
- The redirect from /docs/guide/install hides the page docs/guide/install.md. Remove the route rule, or move the page.
```

## Why it happens

The link checker accepts a link to a redirect rule, so the redirect must lead to a page. One of these:

- The redirect goes into a section, the docs base, or `/raw/`, where no docs page answers.
- The redirect starts at a docs page, so nobody can open that page.
- Redirects loop back to where they started.

A chain of redirects counts where it ends.

## Fix it

Point the rule's `redirect` to a page, or remove the rule. The module checks only exact rules, and a chain may end at another site. Wildcard rules such as `/docs/old/**` and direct redirects to another site get only the link checker's own checks. The module does not validate destinations outside the docs.
