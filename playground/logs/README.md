# Logs playground

Run real Evlog request capture and inspect the same events in ViteHub Logs. The Console fixture playground remains available at `playground/console` for UI states with synthetic data.

From the repository root:

```sh
pnpm --filter playground-logs dev --port 5191 --strictPort
```

Generate events:

```sh
curl http://localhost:5191/api/status
curl -X POST http://localhost:5191/api/checkout
curl -X POST 'http://localhost:5191/api/checkout?fail=1'
```

Open <http://localhost:5191/_vitehub/logs>. Select the failed checkout. Its right inspector shows a serialized Nostics diagnostic, order context, and a redacted customer email. Search for `order-demo` or `PAYMENT_UNAVAILABLE`. Switch between Explorer and Stream, or enable Follow before sending more requests.

The route enriches the request logger with `useLogger(event)` from Evlog's Nitro 3 adapter. Evlog emits the request once. No route calls `initLogger()`, adds a drain, or emits the request again. The config excludes Console requests from capture so inspecting logs does not fill the buffer.

`console: { auth: false, local: true }` limits this playground to the local development server. Capture is temporary and per process. The build disables Logs and the development-only Console. To inspect production history, configure a server-side `LogSource` that reads the existing backend. This playground does not configure a backend, exporter, API key, or production deployment.

The Vite `environments.nitro.resolve.external` setting keeps the linked Agent package external in this monorepo. This avoids eager resolution of unused Blob APIs while the Console loads. Published packages do not need this workspace setting.
