# Templates

Starter apps that developers copy. Each template is a full Nuxt app on ViteHub that works on every host.

| Template | Path | App |
| --- | --- | --- |
| Dashboard | `templates/nuxt/dashboard` | A SaaS app with a landing page, a blog, and a signed-in dashboard. |
| Agent | `templates/nuxt/agent` | A chat assistant with tools, memory, and channels. |
| Jobs | `templates/nuxt/jobs` | A nightly repository reviewer that runs on a schedule. |

`template.json` in each template lists the primitives that it claims, with the package ids of this repository (`rate-limit`, `markdown-template`).

## Stack

- Nuxt 4.7 on Nitro 3, with `vite-hub/nuxt`.
- Tailwind 4 and the kit tokens (`@vite-hub/kit/styles/tokens.css` and `tailwind.css`).
- ui-sdk (`@ui-sdk/vue`, `@ui-sdk/core`) for behavior. Do not add `@nuxt/ui` or `reka-ui`.

## Conventions

- Use the default ViteHub APIs. If a template needs a workaround, fix the primitive instead.
- Write the code inline. Do not add a helper that has one caller.
- Write a comment only when the code cannot say it.
- Every third-party key is an optional Env value. The app starts without it, and the Setup page names each value that is missing.
- UI comes from owned components in `app/components/ui`, in shadcn style: ui-sdk parts styled with the kit tokens. Copy a component, then change it in place.
- The Nuxt UI templates are the quality bar for layout, states, and copy.

## Test a template

```sh
pnpm test:templates                                        # all templates, nuxt dev
pnpm test:templates -- --template dashboard --mode docker  # Node output in a Docker image
pnpm test:templates -- --template jobs --mode cloudflare   # cloudflare_module output on wrangler dev
pnpm test:templates -- --template agent --mode vercel      # Vercel output on the local function bridge
pnpm test:templates -- --template agent --url https://agent.example.com
```

The run checks three things:

- Coverage: the templates together claim every developer-facing primitive, except the exemptions in `test/templates/coverage.test.ts`.
- Gates: no `@nuxt/ui` or `reka-ui`, `nuxt typecheck`, and a copy in a temporary folder that installs from npm and builds. Skip them with `--no-gates`.
- Smoke flows: `test/templates/flows.ts` has one flow for each claimed primitive. A `pending` flow fails, so a template is done only when every flow runs.

Each template uses a fixed port (Dashboard 29641, Agent 29642, Jobs 29643). Set another one with `--port`.
