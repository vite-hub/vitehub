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
