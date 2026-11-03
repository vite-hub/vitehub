export default defineEventHandler(async (event) => {
  const config = useSafeRuntimeConfig(event);
  const db = await connect(config.database.url);
  return {
    limit: config.requestLimit ?? 100,
    retries: config.settings.retries,
    replay: config.public.replayEnabled,
    sample: config.public.posthog.replaySampleRate,
    secret: config.apiSecret,
    db,
  };
});
