import { describe, expect, it } from "vitest";

import {
  createDummyMessage,
  resolveDummyModuleOptions,
} from "../src/index.ts";
import { hubDummyNitro } from "../src/integrations/nitro.ts";
import { hubDummyNuxt } from "../src/integrations/nuxt.ts";
import { hubDummyVite } from "../src/integrations/vite.ts";

describe("resolveDummyModuleOptions", () => {
  it("applies the workspace defaults", () => {
    expect(resolveDummyModuleOptions()).toEqual({
      label: "vitehub",
      enabled: true,
    });
  });

  it("trims the package label", () => {
    expect(resolveDummyModuleOptions({
      label: "  starter  ",
      enabled: false,
    })).toEqual({
      label: "starter",
      enabled: false,
    });
  });
});

describe("createDummyMessage", () => {
  it("builds a ready message", () => {
    expect(createDummyMessage({
      label: "blueprint",
    })).toBe("dummy package ready for blueprint");
  });

  it("builds a disabled message", () => {
    expect(createDummyMessage({
      label: "blueprint",
      enabled: false,
    })).toBe("dummy package disabled for blueprint");
  });
});

describe("integrations", () => {
  it("builds the nitro entry payload", () => {
    expect(hubDummyNitro({
      label: "nitro",
    })).toEqual({
      module: "@vitehub/dummy/nitro",
      message: "dummy package ready for nitro",
    });
  });

  it("builds the nuxt entry payload", () => {
    expect(hubDummyNuxt({
      label: "nuxt",
    })).toEqual({
      module: "@vitehub/dummy/nuxt",
      message: "dummy package ready for nuxt",
    });
  });

  it("builds the vite entry payload", () => {
    expect(hubDummyVite({
      label: "vite",
    })).toEqual({
      name: "vitehub-dummy",
      message: "dummy package ready for vite",
    });
  });
});
