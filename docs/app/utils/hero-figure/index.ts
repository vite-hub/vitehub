// One hero figure per primitive landing page. Each scene loads on its own, so a page only downloads its figure.

import type { HeroCaption, HeroFigure, Plan, Scene } from "./engine";
import { mountHeroFigure } from "./engine";

export type { HeroCaption, HeroFigure } from "./engine";

export type MountHeroFigure = (host: HTMLElement, opts: { reduce: boolean; onCaption: (caption: HeroCaption) => void }) => { figure: HeroFigure; label: string };

const mounter = <P extends Plan>(scene: Scene<P>): MountHeroFigure => (host, opts) => ({ figure: mountHeroFigure(scene, host, opts), label: scene.label });

export const heroFigures = {
  "agents": () => import("./scenes/agents").then(m => mounter(m.default)),
  "auth": () => import("./scenes/auth").then(m => mounter(m.default)),
  "blob": () => import("./scenes/blob").then(m => mounter(m.default)),
  "browser": () => import("./scenes/browser").then(m => mounter(m.default)),
  "channels": () => import("./scenes/channels").then(m => mounter(m.default)),
  "cms": () => import("./scenes/cms").then(m => mounter(m.default)),
  "comments": () => import("./scenes/comments").then(m => mounter(m.default)),
  "connections": () => import("./scenes/connections").then(m => mounter(m.default)),
  "content": () => import("./scenes/content").then(m => mounter(m.default)),
  "database": () => import("./scenes/database").then(m => mounter(m.default)),
  "decisions": () => import("./scenes/decisions").then(m => mounter(m.default)),
  "email": () => import("./scenes/email").then(m => mounter(m.default)),
  "env": () => import("./scenes/env").then(m => mounter(m.default)),
  "forms": () => import("./scenes/forms").then(m => mounter(m.default)),
  "i18n": () => import("./scenes/i18n").then(m => mounter(m.default)),
  "kv": () => import("./scenes/kv").then(m => mounter(m.default)),
  "logs": () => import("./scenes/logs").then(m => mounter(m.default)),
  "queue": () => import("./scenes/queue").then(m => mounter(m.default)),
  "rate-limit": () => import("./scenes/rate-limit").then(m => mounter(m.default)),
  "realtime": () => import("./scenes/realtime").then(m => mounter(m.default)),
  "sandbox": () => import("./scenes/sandbox").then(m => mounter(m.default)),
  "schedule": () => import("./scenes/schedule").then(m => mounter(m.default)),
  "shell": () => import("./scenes/shell").then(m => mounter(m.default)),
  "source": () => import("./scenes/source").then(m => mounter(m.default)),
  "workflows": () => import("./scenes/workflows").then(m => mounter(m.default)),
  "workspace": () => import("./scenes/workspace").then(m => mounter(m.default)),
} satisfies Record<string, () => Promise<MountHeroFigure>>;

export type HeroFigureName = keyof typeof heroFigures;

export const isHeroFigureName = (name: string): name is HeroFigureName => Object.hasOwn(heroFigures, name);
