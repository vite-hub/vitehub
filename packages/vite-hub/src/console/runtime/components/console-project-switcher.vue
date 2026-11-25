<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, ref, useTemplateRef, watch } from "vue";

import type { ConsoleAppIdentity } from "../client/app-identity";
import type { ConsoleLinkedProject } from "../client/projects";
import { consoleAppIdentity } from "../client/app-identity";
import { canManageConsoleProjects, checkConsoleProjects, consoleInviteRequested, favoriteAccountProjects, reloadConsoleAccount, switchConsoleProject, toggleFavoriteAccountProject, useConsoleProjects } from "../client/project-session";
import { orderSwitcherProjects } from "../client/projects";
import { consoleSidebarOpen } from "../client/sidebar";
import { useConsoleToast } from "../client/toast";
import ConsoleAppLogo from "./console-app-logo.vue";
import Icon from "./console-icon.vue";

const ConsoleAccountLink = defineAsyncComponent(() => import("./console-account-link.vue"));
const ConsoleTeamCreate = defineAsyncComponent(() => import("./console-team-create.vue"));
const ConsoleAccountTeam = defineAsyncComponent(() => import("./console-account-team.vue"));
const ConsoleAccountTeamSettings = defineAsyncComponent(() => import("./console-account-team-settings.vue"));

/**
 * The tile at the top of the sidebar: where the person is. In an `account` Console it names the open app and its team,
 * or the team on the pages of the team, and opens the switcher: a dialog with the teams and the pages of the team on
 * the left, and the apps of the team on the right, the starred ones first. An embedded Console has one app, so the
 * tile only names it.
 */
const props = defineProps<{ app?: ConsoleAppIdentity }>();

type SwitcherTab = "apps" | "members" | "settings";
interface SwitcherApp { project: ConsoleLinkedProject, identity: ConsoleAppIdentity, favorite: boolean, current: boolean, index: number }

const projects = useConsoleProjects();
const toast = useConsoleToast();
const switcher = computed(() => projects.mode === "account");
const account = computed(() => projects.account.value);
const team = computed(() => account.value?.teams.find(item => item.id === account.value?.teamId));
const manage = computed(() => account.value ? canManageConsoleProjects(account.value) : false);
const role = computed(() => ["owner", "admin", "member"].find(item => account.value?.roles.includes(item)));
const current = computed(() => props.app ? projects.current.value : undefined);
const open = ref(false);
const tab = ref<SwitcherTab>("apps");
const query = ref("");
const active = ref(-1);
const favorites = ref<string[]>([]);
const creating = ref(false);
const results = useTemplateRef<HTMLElement>("results");

const teamIdentity = computed<ConsoleAppIdentity>(() => {
  const name = team.value?.name ?? "Team";
  return { name, host: "", letter: name.trim().charAt(0).toUpperCase() || "T" };
});
const roleLabel = computed(() => role.value ? `${role.value.charAt(0).toUpperCase()}${role.value.slice(1)}` : undefined);
const tile = computed(() => props.app
  ? { identity: props.app, name: props.app.name, detail: switcher.value ? team.value?.name : (props.app.host !== props.app.name ? props.app.host : undefined) }
  : { identity: teamIdentity.value, name: teamIdentity.value.name, detail: roleLabel.value ? `Team · ${roleLabel.value}` : "Team" });

const identities = computed(() => new Map(projects.projects.value.map(project => [project.id, consoleAppIdentity(project)])));
const identityOf = (project: ConsoleLinkedProject): ConsoleAppIdentity => identities.value.get(project.id) ?? consoleAppIdentity(project);

const groups = computed(() => {
  const words = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const found = projects.projects.value.filter((project) => {
    const { name, host } = identityOf(project);
    const text = `${name} ${host}`.toLowerCase();
    return words.every(word => text.includes(word));
  });
  const ordered = orderSwitcherProjects(found, favorites.value, project => identityOf(project).name);
  let index = 0;
  const item = (project: ConsoleLinkedProject): SwitcherApp => ({
    project,
    identity: identityOf(project),
    favorite: favorites.value.includes(project.id),
    current: project.id === current.value?.id,
    index: index++,
  });
  return [
    { id: "favorites", label: "Favorites", apps: ordered.favorites.map(item) },
    { id: "apps", label: ordered.favorites.length ? "Apps" : undefined, apps: ordered.others.map(item) },
  ].filter(group => group.apps.length);
});
const apps = computed(() => groups.value.flatMap(group => group.apps));

watch(query, (value) => { active.value = value.trim() && apps.value.length ? 0 : -1; });

const optionId = (app: SwitcherApp) => `vitehub-switcher-app-${app.project.id}`;
const activeId = computed(() => apps.value[active.value] ? optionId(apps.value[active.value]!) : undefined);

function onOpen(value: boolean): void {
  if (!value) return;
  tab.value = "apps";
  query.value = "";
  active.value = -1;
  favorites.value = favoriteAccountProjects(account.value?.teamId);
  void checkConsoleProjects();
}

function focusSearch(event: Event): void {
  event.preventDefault();
  document.getElementById("vitehub-switcher-search")?.focus();
}

function select(app: SwitcherApp): void {
  open.value = false;
  if (!app.current) switchConsoleProject(app.project.id);
}

function star(app: SwitcherApp): void {
  const keepActive = apps.value[active.value]?.project.id;
  favorites.value = toggleFavoriteAccountProject(account.value?.teamId, app.project.id);
  if (!keepActive) return;
  active.value = apps.value.findIndex(item => item.project.id === keepActive);
  reveal();
}

function reveal(): void {
  void nextTick(() => {
    if (activeId.value) document.getElementById(activeId.value)?.scrollIntoView({ block: "nearest" });
  });
}

/** The app above or below the active one, nearest to its middle, as the grid wraps. */
function nearestRow(down: boolean): number {
  const options = [...results.value?.querySelectorAll<HTMLElement>("[role='option']") ?? []];
  const from = options[active.value]?.getBoundingClientRect();
  if (!from) return active.value;
  const middle = from.left + from.width / 2;
  let best = active.value;
  let bestScore = Number.POSITIVE_INFINITY;
  options.forEach((option, index) => {
    const box = option.getBoundingClientRect();
    const gap = down ? box.top - from.bottom : from.top - box.bottom;
    if (gap < -1) return;
    const score = gap * 1000 + Math.abs(box.left + box.width / 2 - middle);
    if (score < bestScore) {
      best = index;
      bestScore = score;
    }
  });
  return best;
}

function onKeydown(event: KeyboardEvent): void {
  const count = apps.value.length;
  if (!count) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (active.value < 0) active.value = event.key === "ArrowDown" ? 0 : -1;
    else if (event.key === "ArrowUp" && nearestRow(false) === active.value) active.value = -1;
    else active.value = nearestRow(event.key === "ArrowDown");
    reveal();
  }
  else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && active.value >= 0) {
    event.preventDefault();
    active.value = Math.min(count - 1, Math.max(0, active.value + (event.key === "ArrowRight" ? 1 : -1)));
    reveal();
  }
  else if (event.key === "Enter" && apps.value[active.value]) {
    event.preventDefault();
    if (event.shiftKey) star(apps.value[active.value]!);
    else select(apps.value[active.value]!);
  }
}

function show(next: SwitcherTab): void {
  tab.value = next;
  if (next === "apps") void nextTick(() => document.getElementById("vitehub-switcher-search")?.focus());
}

function invite(): void {
  if (tab.value === "members") {
    document.querySelector<HTMLElement>(".vitehub-switcher #vitehub-team-invite-email")?.focus();
    return;
  }
  consoleInviteRequested.value = true;
  tab.value = "members";
}

function switchTeam(id: string): void {
  if (id === account.value?.teamId) {
    show("apps");
    return;
  }
  open.value = false;
  void import("../client/account").then(({ switchConsoleTeam }) => switchConsoleTeam(id)).then(reloadConsoleAccount, error => toast.show({ title: error instanceof Error ? error.message : "Try again." }));
}

function linkApp(): void {
  open.value = false;
  projects.linkOpen.value = true;
}

const label = computed(() => props.app
  ? `Switch app or team. Current: ${props.app.name}${team.value ? `, team ${team.value.name}` : ""}`
  : `Switch team or app. Current team: ${teamIdentity.value.name}`);
</script>

<template>
  <UModal
    v-if="switcher"
    v-model:open="open"
    title="Switch app or team"
    :description="`The apps, members, and settings of ${teamIdentity.name}, and your other teams.`"
    :content="{ onOpenAutoFocus: focusSearch }"
    :ui="{ content: 'vitehub-switcher divide-y-0' }"
    @update:open="onOpen"
  >
    <UTooltip :text="app ? 'Switch app or team' : 'Switch team or app'" :content="{ side: 'right', sideOffset: 10 }" :disabled="consoleSidebarOpen">
      <button type="button" class="vitehub-app-tile" :aria-label="label">
        <ConsoleAppLogo :app="tile.identity" class="vitehub-app-tile__logo" />
        <span class="vitehub-app-tile__text">
          <span class="vitehub-app-tile__name">{{ tile.name }}</span>
          <span v-if="tile.detail" class="vitehub-app-tile__host">{{ tile.detail }}</span>
        </span>
        <Icon name="i-lucide-chevrons-up-down" class="vitehub-app-tile__chevron" aria-hidden="true" />
      </button>
    </UTooltip>

    <template #content>
      <nav class="vitehub-switcher__rail" aria-label="Teams and team pages">
        <p class="vitehub-switcher__label">Teams</p>
        <button
          v-for="item in account?.teams ?? []"
          :key="item.id"
          type="button"
          class="vitehub-switcher__rail-item"
          :aria-current="item.id === account?.teamId ? 'true' : undefined"
          @click="switchTeam(item.id)"
        >
          <ConsoleAppLogo :app="{ name: item.name, host: '', letter: item.name.trim().charAt(0).toUpperCase() || 'T' }" class="vitehub-switcher__team-logo" />
          <span class="vitehub-switcher__rail-name">{{ item.name }}</span>
          <span v-if="item.id === account?.teamId && roleLabel" class="vitehub-switcher__rail-detail">{{ roleLabel }}</span>
        </button>
        <button type="button" class="vitehub-switcher__rail-item" @click="creating = true">
          <Icon name="i-lucide-plus" class="vitehub-switcher__rail-icon" aria-hidden="true" />
          <span class="vitehub-switcher__rail-name">Create team</span>
        </button>

        <p class="vitehub-switcher__label vitehub-switcher__label--team">{{ teamIdentity.name }}</p>
        <button type="button" class="vitehub-switcher__rail-item" :aria-current="tab === 'apps' ? 'page' : undefined" @click="show('apps')">
          <Icon name="i-lucide-layout-grid" class="vitehub-switcher__rail-icon" aria-hidden="true" />
          <span class="vitehub-switcher__rail-name">Apps</span>
          <span class="vitehub-switcher__rail-detail tabular-nums">{{ projects.projects.value.length }}</span>
        </button>
        <button type="button" class="vitehub-switcher__rail-item" :aria-current="tab === 'members' ? 'page' : undefined" @click="show('members')">
          <Icon name="i-lucide-users" class="vitehub-switcher__rail-icon" aria-hidden="true" />
          <span class="vitehub-switcher__rail-name">Members</span>
        </button>
        <button type="button" class="vitehub-switcher__rail-item" :aria-current="tab === 'settings' ? 'page' : undefined" @click="show('settings')">
          <Icon name="i-lucide-settings" class="vitehub-switcher__rail-icon" aria-hidden="true" />
          <span class="vitehub-switcher__rail-name">Settings</span>
        </button>

        <button v-if="manage" type="button" class="vitehub-switcher__rail-item vitehub-switcher__invite" @click="invite">
          <Icon name="i-lucide-user-plus" class="vitehub-switcher__rail-icon" aria-hidden="true" />
          <span class="vitehub-switcher__rail-name">Invite people</span>
        </button>
      </nav>

      <section v-if="tab === 'apps'" class="vitehub-switcher__pane" aria-label="Apps">
        <header class="vitehub-switcher__search">
          <Icon name="i-lucide-search" class="vitehub-switcher__search-icon" aria-hidden="true" />
          <input
            id="vitehub-switcher-search"
            v-model="query"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="vitehub-switcher-results"
            aria-autocomplete="list"
            :aria-activedescendant="activeId"
            :aria-label="`Search the apps of ${teamIdentity.name}`"
            :placeholder="`Search ${projects.projects.value.length} apps in ${teamIdentity.name}`"
            autocomplete="off"
            spellcheck="false"
            class="vitehub-switcher__search-input"
            @keydown="onKeydown"
          >
          <UButton v-if="manage" size="sm" color="neutral" variant="ghost" icon="i-lucide-plus" label="Link app" @click="linkApp" />
          <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-x" aria-label="Close" @click="open = false" />
        </header>

        <div id="vitehub-switcher-results" ref="results" role="listbox" aria-label="Apps" class="vitehub-switcher__results">
          <div v-for="group in groups" :key="group.id" role="group" :aria-label="group.label ?? 'Apps'" class="vitehub-switcher__group">
            <p v-if="group.label" class="vitehub-switcher__label" aria-hidden="true">{{ group.label }}</p>
            <div class="vitehub-switcher__grid">
              <div v-for="item in group.apps" :key="item.project.id" class="vitehub-switcher__cell" :data-favorite="item.favorite || undefined">
                <div
                  :id="optionId(item)"
                  role="option"
                  class="vitehub-switcher__app"
                  :aria-selected="item.index === active"
                  :aria-current="item.current ? 'true' : undefined"
                  :aria-label="`${item.identity.name}${item.identity.host && item.identity.host !== item.identity.name ? `, ${item.identity.host}` : ''}${item.favorite ? ', starred' : ''}${item.current ? ', open now' : ''}`"
                  @click="select(item)"
                  @pointermove="active = item.index"
                >
                  <ConsoleAppLogo :app="item.identity" class="vitehub-switcher__app-logo" />
                  <span class="vitehub-switcher__app-text">
                    <span class="vitehub-switcher__app-name">{{ item.identity.name }}</span>
                    <span v-if="item.identity.host && item.identity.host !== item.identity.name" class="vitehub-switcher__app-host">{{ item.identity.host }}</span>
                  </span>
                </div>
                <button
                  type="button"
                  tabindex="-1"
                  aria-hidden="true"
                  class="vitehub-switcher__star"
                  :title="item.favorite ? 'Remove from favorites' : 'Add to favorites'"
                  @click="star(item)"
                >
                  <Icon name="i-lucide-star" />
                </button>
              </div>
            </div>
          </div>
          <div v-if="!apps.length" class="vitehub-switcher__empty">
            <p>{{ query.trim() ? `No app matches “${query.trim()}”.` : `${teamIdentity.name} has no apps yet.` }}</p>
            <UButton v-if="manage && !query.trim()" size="sm" color="neutral" variant="outline" icon="i-lucide-plus" label="Link app" @click="linkApp" />
          </div>
        </div>

        <footer class="vitehub-switcher__footer" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> move</span>
          <span><kbd>Enter</kbd> open</span>
          <span><kbd>Shift</kbd><kbd>Enter</kbd> star</span>
          <span><kbd>Esc</kbd> close</span>
        </footer>
      </section>

      <section v-else class="vitehub-switcher__pane" :aria-labelledby="`vitehub-switcher-${tab}`">
        <header class="vitehub-switcher__title">
          <h2 :id="`vitehub-switcher-${tab}`">{{ tab === "members" ? "Members" : "Team settings" }}</h2>
          <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-x" aria-label="Close" @click="open = false" />
        </header>
        <div class="vitehub-switcher__body">
          <ConsoleAccountTeam v-if="tab === 'members'" />
          <ConsoleAccountTeamSettings v-else inline />
        </div>
      </section>
    </template>
  </UModal>

  <UTooltip v-else-if="app" :text="app.name" :content="{ side: 'right', sideOffset: 10 }" :disabled="consoleSidebarOpen">
    <div class="vitehub-app-tile is-static">
      <ConsoleAppLogo :app="app" class="vitehub-app-tile__logo" />
      <span class="vitehub-app-tile__text">
        <span class="vitehub-app-tile__name">{{ app.name }}</span>
        <span v-if="app.host && app.host !== app.name" class="vitehub-app-tile__host">{{ app.host }}</span>
      </span>
    </div>
  </UTooltip>

  <template v-if="switcher">
    <ConsoleAccountLink v-model:open="projects.linkOpen.value" />
    <ConsoleTeamCreate v-if="creating" v-model:open="creating" />
  </template>
</template>

<style>
/* The 30px logo sits in the middle of the 52px rail, as the 18px icons below it do. */
.vitehub-app-tile {
  align-items: center;
  background: none;
  border: 0;
  border-radius: 0.5rem;
  display: flex;
  flex: none;
  gap: 0.625rem;
  height: 2.5rem;
  margin-top: 0.25rem;
  overflow: hidden;
  padding: 0 0.1875rem;
  text-align: start;
  white-space: nowrap;
  width: 100%;
}

button.vitehub-app-tile:hover,
.vitehub-app-tile[aria-expanded="true"],
.vitehub-app-tile[data-state="open"] {
  background: var(--muted);
}

.vitehub-app-tile .vitehub-app-tile__logo {
  border-radius: 0.4375rem;
  height: 1.875rem;
  width: 1.875rem;
}

.vitehub-app-tile__text {
  display: grid;
  flex: 1 1 auto;
  line-height: 1.2;
  min-width: 0;
}

.vitehub-app-tile__name {
  color: var(--foreground);
  font-size: 0.8125rem;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
}

.vitehub-app-tile__host {
  color: var(--ui-text-dimmed);
  font-size: 0.75rem;
  overflow: hidden;
  text-overflow: ellipsis;
}

.vitehub-app-tile__chevron {
  color: var(--ui-text-dimmed);
  flex: none;
  height: 0.875rem;
  width: 0.875rem;
}

.vitehub-sidebar:not([data-open]) :is(.vitehub-app-tile__text, .vitehub-app-tile__chevron) {
  opacity: 0;
}

@media (prefers-reduced-motion: no-preference) {
  .vitehub-sidebar[data-ready] :is(.vitehub-app-tile__text, .vitehub-app-tile__chevron) {
    transition: opacity 150ms ease-out;
  }
}

.vitehub-switcher.vitehub-switcher {
  display: grid;
  grid-template-columns: 14rem minmax(0, 1fr);
  height: min(37.5rem, calc(100dvh - 2rem));
  max-width: 55rem;
  overflow: hidden;
}

.vitehub-switcher__rail {
  background: var(--ui-bg-muted);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  min-height: 0;
  overflow-y: auto;
  padding: 0.625rem 0.5rem;
}

.vitehub-switcher__label {
  color: var(--ui-text-dimmed);
  font-size: 0.75rem;
  font-weight: 500;
  overflow: hidden;
  padding: 0.25rem 0.5rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vitehub-switcher__label--team {
  margin-top: 0.75rem;
}

.vitehub-switcher__rail-item {
  align-items: center;
  border-radius: 0.375rem;
  color: var(--ui-text-toned);
  display: flex;
  flex: none;
  font-size: 0.8125rem;
  gap: 0.625rem;
  min-height: 2rem;
  padding: 0.25rem 0.5rem;
  text-align: start;
}

.vitehub-switcher__rail-item:hover {
  background: var(--muted);
}

.vitehub-switcher__rail-item[aria-current] {
  background: var(--ui-bg-accented);
  color: var(--foreground);
  font-weight: 500;
}

.vitehub-switcher__rail-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vitehub-switcher__rail-detail {
  color: var(--ui-text-dimmed);
  flex: none;
  font-size: 0.75rem;
  font-weight: 400;
}

.vitehub-switcher__rail-icon {
  color: var(--ui-text-dimmed);
  flex: none;
  height: 1rem;
  width: 1rem;
}

.vitehub-switcher__rail .vitehub-switcher__team-logo {
  border-radius: 0.3125rem;
  font-size: 0.625rem;
  height: 1.25rem;
  width: 1.25rem;
}

.vitehub-switcher__invite {
  margin-top: auto;
}

.vitehub-switcher__pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}

.vitehub-switcher__search {
  align-items: center;
  border-bottom: 1px solid var(--border);
  display: flex;
  flex: none;
  gap: 0.25rem;
  height: 3.25rem;
  padding: 0 0.5rem 0 1rem;
}

.vitehub-switcher__search-icon {
  color: var(--ui-text-dimmed);
  flex: none;
  height: 1rem;
  width: 1rem;
}

.vitehub-switcher__search-input {
  background: none;
  color: var(--foreground);
  flex: 1 1 auto;
  font-size: 0.875rem;
  height: 100%;
  min-width: 0;
  outline: none;
  padding: 0 0.5rem;
}

.vitehub-switcher__search-input::placeholder {
  color: var(--ui-text-dimmed);
}

.vitehub-switcher__results {
  display: grid;
  flex: 1 1 auto;
  gap: 0.75rem;
  align-content: start;
  min-height: 0;
  overflow-y: auto;
  padding: 0.5rem 0.625rem 0.75rem;
}

.vitehub-switcher__group {
  display: grid;
  gap: 0.125rem;
}

.vitehub-switcher__grid {
  display: grid;
  gap: 0.25rem;
  grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
}

.vitehub-switcher__cell {
  position: relative;
}

.vitehub-switcher__app {
  align-items: center;
  border-radius: 0.5rem;
  cursor: pointer;
  display: flex;
  gap: 0.625rem;
  min-width: 0;
  padding: 0.3125rem 2rem 0.3125rem 0.5rem;
}

.vitehub-switcher__app[aria-selected="true"] {
  background: var(--muted);
}

.vitehub-switcher__app[aria-current] {
  box-shadow: inset 0 0 0 1px var(--border);
}

.vitehub-switcher__app[aria-current]:not([aria-selected="true"]) {
  background: var(--ui-bg-muted);
}

.vitehub-switcher .vitehub-switcher__app-logo {
  border-radius: 0.4375rem;
  font-size: 0.75rem;
  height: 2rem;
  width: 2rem;
}

.vitehub-switcher__app-text {
  display: grid;
  line-height: 1.3;
  min-width: 0;
}

.vitehub-switcher__app-name {
  color: var(--foreground);
  font-size: 0.8125rem;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vitehub-switcher__app-host {
  color: var(--ui-text-dimmed);
  font-size: 0.75rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vitehub-switcher__star {
  border-radius: 0.375rem;
  color: var(--ui-text-dimmed);
  display: grid;
  height: 1.75rem;
  opacity: 0;
  place-items: center;
  position: absolute;
  right: 0.25rem;
  top: 50%;
  translate: 0 -50%;
  width: 1.75rem;
}

.vitehub-switcher__star svg {
  height: 0.875rem;
  width: 0.875rem;
}

.vitehub-switcher__star:hover {
  background: var(--ui-bg-accented);
  color: var(--foreground);
}

.vitehub-switcher__cell:hover .vitehub-switcher__star,
.vitehub-switcher__cell:has([aria-selected="true"]) .vitehub-switcher__star,
.vitehub-switcher__cell[data-favorite] .vitehub-switcher__star {
  opacity: 1;
}

.vitehub-switcher__cell[data-favorite] .vitehub-switcher__star {
  color: var(--ui-warning);
}

.vitehub-switcher__cell[data-favorite] .vitehub-switcher__star path {
  fill: currentColor;
}

@media (hover: none) {
  .vitehub-switcher__star {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: no-preference) {
  .vitehub-switcher__star {
    transition: opacity 150ms ease-out;
  }
}

.vitehub-switcher__empty {
  color: var(--muted-foreground);
  display: grid;
  font-size: 0.875rem;
  gap: 0.75rem;
  justify-items: center;
  padding: 3rem 1rem;
  text-align: center;
}

.vitehub-switcher__footer {
  border-top: 1px solid var(--border);
  color: var(--ui-text-dimmed);
  display: flex;
  flex: none;
  flex-wrap: wrap;
  font-size: 0.75rem;
  gap: 0.25rem 1rem;
  justify-content: flex-end;
  padding: 0.5rem 1rem;
}

.vitehub-switcher__footer kbd {
  border-radius: 0.25rem;
  box-shadow: inset 0 0 0 1px var(--border);
  font: inherit;
  font-size: 0.6875rem;
  margin-right: 0.25rem;
  padding: 0 0.3125rem;
}

.vitehub-switcher__title {
  align-items: center;
  border-bottom: 1px solid var(--border);
  display: flex;
  flex: none;
  height: 3.25rem;
  justify-content: space-between;
  padding: 0 0.5rem 0 1.25rem;
}

.vitehub-switcher__title h2 {
  color: var(--foreground);
  font-size: 0.9375rem;
  font-weight: 600;
}

.vitehub-switcher__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 1.25rem;
}

.vitehub-switcher__body .vitehub-settings {
  gap: 1.25rem;
  grid-template-columns: minmax(0, 1fr);
}

.vitehub-switcher__body .vitehub-settings__menu {
  flex-direction: row;
  position: static;
}

@media (max-width: 40rem) {
  .vitehub-switcher.vitehub-switcher {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
    height: calc(100dvh - 2rem);
  }

  .vitehub-switcher__rail {
    border-bottom: 1px solid var(--border);
    border-right: 0;
    flex-direction: row;
    overflow-x: auto;
    overflow-y: hidden;
  }

  .vitehub-switcher__label,
  .vitehub-switcher__footer {
    display: none;
  }

  .vitehub-switcher__group > .vitehub-switcher__label {
    display: block;
  }

  .vitehub-switcher__rail-name {
    overflow: visible;
  }

  .vitehub-switcher__invite {
    margin-top: 0;
  }
}
</style>
