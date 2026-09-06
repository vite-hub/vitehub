export const testLayerIncludes = Object.freeze({
  contracts: ["test/*.test.ts"],
  consumer: ["test/consumer/**/*.test.ts"],
  output: ["test/output/**/*.test.ts"],
  packages: ["packages/*/test/**/*.test.ts", "packages/*/test/**/*.test-d.ts"],
});

export function testLayersFor(path: string) {
  const normalized = path.replaceAll("\\", "/");
  const layers = [];

  if (/^test\/[^/]+\.test\.ts$/.test(normalized)) {
    layers.push("contracts");
  }
  if (/^test\/consumer\/.+\.test\.ts$/.test(normalized)) {
    layers.push("consumer");
  }
  if (/^test\/output\/.+\.test\.ts$/.test(normalized)) {
    layers.push("output");
  }
  if (/^packages\/[^/]+\/test\/.+\.test(?:-d)?\.ts$/.test(normalized)) {
    layers.push("packages");
  }

  return layers;
}
