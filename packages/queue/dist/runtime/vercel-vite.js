import { runWithQueueRuntimeEvent, setQueueRuntimeConfig, setQueueRuntimeRegistry } from "./state.js";
import { createApp, fromWebHandler } from "h3";
import { toNodeHandler } from "h3/node";
//#region src/runtime/vercel-vite.ts
function resolveQueueAppFetch(queueApp) {
	if (!queueApp) return;
	if (typeof queueApp === "function") return queueApp;
	if (typeof queueApp.request === "function") return (request, context) => queueApp.request(request, void 0, context);
	if (typeof queueApp.fetch === "function") return queueApp.fetch.bind(queueApp);
	throw new TypeError("Invalid Vite queue server app. Expected an h3 app or a fetch-compatible handler.");
}
function createQueueVercelServer(options = {}) {
	setQueueRuntimeConfig(options.queue);
	setQueueRuntimeRegistry(options.registry);
	const app = createApp();
	const fetchHandler = resolveQueueAppFetch(options.app);
	if (fetchHandler) app.use(fromWebHandler(async (request, context) => await fetchHandler(request, context)));
	const nodeHandler = toNodeHandler(app);
	return function vercelQueueServer(req, res) {
		return runWithQueueRuntimeEvent({
			req,
			res
		}, () => nodeHandler(req, res));
	};
}
//#endregion
export { createQueueVercelServer };
