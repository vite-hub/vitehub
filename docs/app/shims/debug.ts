type DebugLogger = ((...args: unknown[]) => void) & {
  destroy: () => boolean;
  enabled: boolean;
  extend: (namespace: string) => DebugLogger;
};

function createLogger(): DebugLogger {
  const logger = Object.assign(() => {}, {
    destroy: () => false,
    enabled: false,
    extend: () => logger,
  });

  return logger;
}

const createDebug = Object.assign((_namespace?: string) => createLogger(), {
  disable: () => "",
  enable: () => {},
  enabled: () => false,
  formatters: {},
  names: [],
  skips: [],
});

export { createDebug };
export default createDebug;
