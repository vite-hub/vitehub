Host REST responses for `test/setup-link.test.ts`. They copy the samples in the official API docs. No test calls a real host.

- `cloudflare-accounts-*.json`: `GET /client/v4/accounts`, https://developers.cloudflare.com/api/resources/accounts/methods/list/
- `cloudflare-worker.json`: `GET /client/v4/accounts/{account_id}/workers/workers/{worker_id}` (the id can be the Worker name), https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/methods/get/
- `cloudflare-worker-created.json`: `POST /client/v4/accounts/{account_id}/workers/workers`, https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/methods/create/
- `cloudflare-not-found.json`: the Cloudflare error envelope with a 404 status.
- `vercel-project.json`: `GET /v9/projects/{idOrName}`, https://vercel.com/docs/rest-api/reference/endpoints/projects/find-a-project-by-id-or-name
- `vercel-project-created.json`: `POST /v11/projects`, https://vercel.com/docs/rest-api/reference/endpoints/projects/create-a-new-project
- `vercel-not-found.json`: the Vercel error body with a 404 status.
- `netlify-sites.json`: `GET /api/v1/sites?name=` (a partial match, so it can return other sites), https://open-api.netlify.com/#tag/site/operation/listSites
- `netlify-site-created.json`: `POST /api/v1/sites`, https://open-api.netlify.com/#tag/site/operation/createSite

Responses for `test/setup-deployments.test.ts`, with the shapes of the official docs. The ids and commits are made up.

- `cloudflare-deployments.json`: `GET /client/v4/accounts/{account_id}/workers/scripts/{script_name}/deployments`, https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/
- `cloudflare-versions.json`: `GET .../workers/scripts/{script_name}/versions?deployable=true`, https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/list/. The docs list `id`, `number`, and `metadata`; `annotations` (`workers/message`, `workers/tag`) is what Wrangler 4.158 reads from the same list in `wrangler versions list` and writes with `wrangler deploy --message --tag`.
- `cloudflare-version.json`: `GET .../workers/scripts/{script_name}/versions/{version_id}`, https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/
- `cloudflare-subdomain.json`: `GET /client/v4/accounts/{account_id}/workers/subdomain`, https://developers.cloudflare.com/api/resources/workers/subresources/subdomains/methods/get/
- `vercel-deployments.json`: `GET /v6/deployments?projectId=&limit=`, the version that the Vercel CLI 65.11 calls. The fields match the v7 docs: https://vercel.com/docs/rest-api/reference/endpoints/deployments/list-deployments. `meta` holds `vercel deploy --meta` values and the Git fields (`githubCommitSha`).
- `vercel-project-targets.json`: `GET /v9/projects/{idOrName}`. `targets.production` is the deployment that serves production. The docs list `targets` without its schema; the Vercel CLI 65.11 reads `project.targets.production`.
- `netlify-site.json`: `GET /api/v1/sites/{site_id}` (`getSite`), with `published_deploy`, https://open-api.netlify.com/#tag/site/operation/getSite
- `netlify-deploys.json`: `GET /api/v1/sites/{site_id}/deploys` (`listSiteDeploys`), https://open-api.netlify.com/#tag/deploy/operation/listSiteDeploys. `netlify deploy --message` sets `title` (Netlify CLI 27.11.2, `dist/commands/deploy/deploy.js`). A Git build sets `commit_ref`.
