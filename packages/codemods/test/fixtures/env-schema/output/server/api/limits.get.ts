import { useServerEnv } from "#vitehub/env/server";
import { usePublicEnv } from "#vitehub/env/public";

export default defineEventHandler(async (event) => {
  const config = useServerEnv(event);
  const db = await connect(config.database.url);
  return {
    limit: config.requestLimit ?? 100,
    retries: config.settings.retries,
    replay: usePublicEnv().replayEnabled,
    sample: usePublicEnv().posthogReplaySampleRate,
    secret: config.apiSecret,
    db,
  };
});
