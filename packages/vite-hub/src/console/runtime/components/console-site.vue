<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { consoleDateTime, consoleInitials, consoleRelativeTime } from "../client/format";
import { grantSummary, inviteGuest, openSite, phoneLink, qrCode, readSiteAccess, revokeInvite, revokeSession } from "../client/site-access";
import { useConsoleToast } from "../client/toast";
import { rememberConsoleSection } from "../sections";
import ConsoleConfirm from "./console-confirm.vue";
import ConsolePageHeader from "./console-page-header.vue";
import ConsoleSearch from "./console-search.vue";
import ConsoleState from "./console-state.vue";

import type { SiteGrant, SiteInvite, SiteSession } from "../client/site-access";

/**
 * Site access: who the Console signs in to the app for the page tools. Members open the site from here, or scan a QR
 * code with a phone. Guests get a one-time link with a name and the roles a member picked; they never see the Console.
 * Each browser is one row, an app session. Revoking a member's browser signs it out; revoking a guest's deletes the guest.
 */
defineProps<{
  agentsBase: string;
  definitionsBase: string;
  kvBase: string;
  searchBase: string;
  sectionsBase: string;
}>();

const toast = useConsoleToast();
const sessions = ref<SiteSession[]>([]);
const invites = ref<SiteInvite[]>([]);
const grants = ref<SiteGrant[]>([]);
const loading = ref(true);
const error = ref<unknown>();
const now = ref(Date.now());
let request: AbortController | undefined;
let clock: ReturnType<typeof setInterval> | undefined;

async function load(): Promise<void> {
  request?.abort();
  const controller = new AbortController();
  request = controller;
  error.value = undefined;
  try {
    const next = await readSiteAccess(controller.signal);
    if (controller.signal.aborted) return;
    sessions.value = next.sessions;
    invites.value = next.invites;
    grants.value = next.grants;
  }
  catch (cause) {
    if (!controller.signal.aborted) error.value = cause;
  }
  finally {
    if (!controller.signal.aborted) loading.value = false;
  }
}

const guestGrants = computed(() => grants.value.filter(grant => !grant.membersOnly));
const members = computed(() => sessions.value.filter(pass => pass.kind === "member"));
const guests = computed(() => sessions.value.filter(pass => pass.kind === "guest"));

/** `now`, `5 minutes ago`, `3 hours ago`, then `3 days ago`: an app session lasts days after its last use, so days matter. */
function lastUsed(pass: SiteSession): string {
  const days = Math.floor((now.value - Date.parse(pass.lastSeenAt)) / 86_400_000);
  if (days >= 1) return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(-days, "day");
  return consoleRelativeTime(pass.lastSeenAt, now.value)?.label ?? consoleDateTime(pass.lastSeenAt);
}

function expiresIn(value: string): string {
  const days = Math.round((Date.parse(value) - now.value) / 86_400_000);
  if (days >= 2) return `Expires in ${days} days`;
  const hours = Math.max(1, Math.round((Date.parse(value) - now.value) / 3_600_000));
  return hours >= 24 ? "Expires tomorrow" : `Expires in ${hours} ${hours === 1 ? "hour" : "hours"}`;
}

// Open site: the new tab is signed in as you, then opens the app's home page.
const opening = ref(false);
async function open(): Promise<void> {
  opening.value = true;
  try {
    await openSite();
    void load();
  }
  catch {
    toast.error("Couldn't open the site. Try again.");
  }
  finally {
    opening.value = false;
  }
}

// Link a phone: a QR code of a link that lasts 10 minutes.
const phoneOpen = ref(false);
const phone = ref<{ url: string, expiresAt: string }>();
const phoneLoading = ref(false);
const phoneLeft = computed(() => phone.value ? Math.max(0, Date.parse(phone.value.expiresAt) - now.value) : 0);
const phoneCountdown = computed(() => {
  const seconds = Math.floor(phoneLeft.value / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
});
async function linkPhone(): Promise<void> {
  phoneOpen.value = true;
  phoneLoading.value = true;
  try {
    phone.value = await phoneLink();
  }
  catch {
    phoneOpen.value = false;
    toast.error("Couldn't make a QR code. Try again.");
  }
  finally {
    phoneLoading.value = false;
  }
}
watch(phoneOpen, (value) => {
  if (value) return;
  phone.value = undefined;
  // The phone may have opened the link while the dialog was open.
  void load();
});

// Invite someone: a name, the grants, and how long the link stays open, then the link itself, once.
const inviteOpen = ref(false);
const inviteName = ref("");
const inviteGrants = ref<string[]>([]);
const inviteDays = ref<"1" | "7" | "30">("7");
const inviting = ref(false);
const invited = ref<{ url: string, expiresAt: string, name: string }>();
const copied = ref(false);
const dayItems = [{ label: "1 day", value: "1" }, { label: "7 days", value: "7" }, { label: "30 days", value: "30" }];
const canInvite = computed(() => inviteName.value.trim().length > 0 && inviteGrants.value.length > 0);

function startInvite(): void {
  inviteName.value = "";
  // Most guests come to comment: they read and write.
  inviteGrants.value = guestGrants.value.filter(grant => grant.id === "comments-read" || grant.id === "comments-write").map(grant => grant.id);
  inviteDays.value = "7";
  invited.value = undefined;
  copied.value = false;
  inviteOpen.value = true;
}

function toggleGrant(id: string, value: boolean | "indeterminate"): void {
  inviteGrants.value = value === true ? [...new Set([...inviteGrants.value, id])] : inviteGrants.value.filter(grant => grant !== id);
}

async function invite(): Promise<void> {
  if (!canInvite.value) return;
  inviting.value = true;
  try {
    const result = await inviteGuest({ name: inviteName.value.trim(), grants: inviteGrants.value, expiresInDays: Number(inviteDays.value) as 1 | 7 | 30 });
    invited.value = { url: result.url, expiresAt: result.expiresAt, name: result.invite.name };
    invites.value = [result.invite, ...invites.value];
  }
  catch {
    toast.error("Couldn't create the invite. Try again.");
  }
  finally {
    inviting.value = false;
  }
}

async function copyInvite(): Promise<void> {
  if (!invited.value) return;
  copied.value = await navigator.clipboard.writeText(invited.value.url).then(() => true, () => false);
  if (!copied.value) toast.error("Couldn't copy the link. Select it and copy it yourself.");
}

// Revoke a browser or an open invite.
const revoking = ref<{ kind: "session", session: SiteSession } | { kind: "invite", invite: SiteInvite }>();
const revokeOpen = ref(false);
const revokeBusy = ref(false);
const revokeTitle = computed(() => revoking.value?.kind === "session" ? `Revoke ${revoking.value.session.person.name} on ${revoking.value.session.device}?` : `Revoke the invite for ${revoking.value?.invite.name}?`);
const revokeDescription = computed(() => revoking.value?.kind === "session"
  ? (revoking.value.session.kind === "guest" ? "This signs the browser out and deletes the guest. Their comments stay." : "This signs the browser out of the app.")
  : "The link stops working. Nobody has opened it yet.");

function askRevoke(target: NonNullable<typeof revoking.value>): void {
  revoking.value = target;
  revokeOpen.value = true;
}

async function revoke(): Promise<void> {
  const target = revoking.value;
  if (!target) return;
  revokeBusy.value = true;
  try {
    if (target.kind === "session") {
      await revokeSession(target.session.id);
      sessions.value = sessions.value.filter(session => session.id !== target.session.id);
      toast.show({ title: "Browser revoked" });
    }
    else {
      await revokeInvite(target.invite.id);
      invites.value = invites.value.filter(invite => invite.id !== target.invite.id);
      toast.show({ title: "Invite revoked" });
    }
    revokeOpen.value = false;
  }
  catch {
    toast.error("Couldn't revoke it. Try again.");
  }
  finally {
    revokeBusy.value = false;
  }
}

onMounted(() => {
  rememberConsoleSection("site");
  clock = setInterval(() => { now.value = Date.now(); }, 1000);
  void load();
});
onBeforeUnmount(() => {
  request?.abort();
  clearInterval(clock);
});
</script>

<template>
  <ConsoleSearch
    :agents-base="agentsBase"
    :definitions-base="definitionsBase"
    :kv-base="kvBase"
    :search-base="searchBase"
    :sections-base="sectionsBase"
  />
  <UDashboardPanel id="site">
    <ConsolePageHeader title="Site access" :toggle="false">
      <template #right>
        <UButton icon="i-lucide-smartphone" label="Link a phone" variant="ghost" class="max-sm:hidden" @click="linkPhone" />
        <UButton icon="i-lucide-external-link" label="Open site" variant="ghost" :loading="opening" @click="open" />
        <UButton icon="i-lucide-user-plus" label="Invite someone" :disabled="!guestGrants.length" @click="startInvite" />
      </template>
    </ConsolePageHeader>

    <main class="min-h-0 flex-1 overflow-auto">
      <ConsoleState v-if="error" :error="error" title="Couldn't load site access" :retry="load" />
      <div v-else-if="loading" class="mx-auto grid w-full max-w-3xl gap-3 p-6" aria-busy="true">
        <USkeleton class="h-5 w-40" />
        <USkeleton v-for="index in 3" :key="index" class="h-14 w-full" />
      </div>
      <div v-else class="mx-auto grid w-full max-w-3xl gap-8 p-6">
        <p class="text-pretty text-[13px] text-muted">
          The Console signs these browsers in to the app, so they get the page tools. Members also get the Console link; guests get only the roles you picked.
        </p>

        <section v-for="group in [{ id: 'members', title: 'Members', rows: members }, { id: 'guests', title: 'Guests', rows: guests }]" :key="group.id" :aria-labelledby="`site-${group.id}`" class="grid gap-2">
          <h2 :id="`site-${group.id}`" class="flex items-baseline gap-2 text-[13px] font-semibold text-highlighted">
            {{ group.title }}
            <span class="font-normal tabular-nums text-dimmed">{{ group.rows.length }}</span>
          </h2>
          <ul v-if="group.rows.length" class="divide-y divide-default rounded-lg border border-default">
            <li v-for="pass in group.rows" :key="pass.id" class="flex min-w-0 items-center gap-3 px-3 py-2.5">
              <UAvatar :src="pass.person.image" :alt="pass.person.name" :text="consoleInitials(pass.person.name)" size="sm" />
              <span class="grid min-w-0 flex-1">
                <span class="truncate text-[13px] font-medium text-highlighted">{{ pass.person.name }}</span>
                <span class="truncate text-xs text-dimmed">{{ pass.device }} · {{ grantSummary(pass.kind, pass.grants, grants) }}</span>
              </span>
              <UTooltip :text="`Signed in ${consoleDateTime(pass.createdAt)}`">
                <span class="shrink-0 text-xs tabular-nums text-dimmed max-sm:hidden">Used {{ lastUsed(pass) }}</span>
              </UTooltip>
              <UButton size="xs" variant="ghost" color="neutral" label="Revoke" :aria-label="`Revoke ${pass.person.name} on ${pass.device}`" @click="askRevoke({ kind: 'session', session: pass })" />
            </li>
          </ul>
          <p v-else class="rounded-lg border border-dashed border-default px-3 py-4 text-center text-xs text-dimmed">
            {{ group.id === "members" ? "No member browsers yet. Open the site, or link a phone." : "No guests yet. Invite someone to comment on the site." }}
          </p>
        </section>

        <section v-if="invites.length" aria-labelledby="site-invites" class="grid gap-2">
          <h2 id="site-invites" class="flex items-baseline gap-2 text-[13px] font-semibold text-highlighted">
            Open invites
            <span class="font-normal tabular-nums text-dimmed">{{ invites.length }}</span>
          </h2>
          <ul class="divide-y divide-default rounded-lg border border-default">
            <li v-for="item in invites" :key="item.id" class="flex min-w-0 items-center gap-3 px-3 py-2.5">
              <span class="grid size-8 shrink-0 place-items-center rounded-full bg-elevated text-muted"><UIcon name="i-lucide-link" class="size-4" aria-hidden="true" /></span>
              <span class="grid min-w-0 flex-1">
                <span class="truncate text-[13px] font-medium text-highlighted">{{ item.name }}</span>
                <span class="truncate text-xs text-dimmed">{{ grantSummary("guest", item.grants, grants) }}</span>
              </span>
              <span class="shrink-0 text-xs tabular-nums text-dimmed max-sm:hidden">{{ expiresIn(item.expiresAt) }}</span>
              <UButton size="xs" variant="ghost" color="neutral" label="Revoke" :aria-label="`Revoke the invite for ${item.name}`" @click="askRevoke({ kind: 'invite', invite: item })" />
            </li>
          </ul>
        </section>
      </div>
    </main>
  </UDashboardPanel>

  <UModal v-model:open="inviteOpen" :title="invited ? `Invite for ${invited.name}` : 'Invite someone'" :description="invited ? undefined : 'They get the page tools you pick on the site. They never see the Console.'">
    <template #body>
      <form v-if="!invited" id="site-invite" class="grid gap-5" @submit.prevent="invite">
        <UFormField label="Name" help="Shown as the author of their comments. They don't type it." required>
          <UInput v-model="inviteName" class="w-full" autocomplete="off" :maxlength="64" placeholder="Ana from design" autofocus />
        </UFormField>
        <fieldset class="grid gap-2">
          <legend class="mb-2 text-[13px] font-medium text-highlighted">What they can do</legend>
          <UCheckbox
            v-for="grant in guestGrants"
            :key="grant.id"
            :model-value="inviteGrants.includes(grant.id)"
            :label="grant.label"
            :description="grant.description"
            @update:model-value="toggleGrant(grant.id, $event)"
          />
          <UCheckbox :model-value="false" disabled label="Console" description="Members only." />
        </fieldset>
        <UFormField label="The link works for">
          <URadioGroup v-model="inviteDays" :items="dayItems" orientation="horizontal" />
        </UFormField>
      </form>
      <div v-else class="grid justify-items-center gap-4">
        <!-- uqr draws only rects in currentColor from the link, so the markup holds no input of a person. Cameras read dark
             modules on a light ground best, so the code keeps a white tile in dark mode too. -->
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div class="size-48 rounded-lg bg-white p-2 text-black [&>svg]:size-full" role="img" :aria-label="`QR code of the invite link for ${invited.name}`" v-html="qrCode(invited.url)" />
        <div class="flex w-full gap-2">
          <UInput :model-value="invited.url" readonly class="min-w-0 flex-1 font-mono" aria-label="Invite link" @focus="($event.target as HTMLInputElement).select()" />
          <UButton :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'" :label="copied ? 'Copied' : 'Copy'" @click="copyInvite" />
        </div>
        <p class="text-pretty text-center text-xs text-muted">
          Works once, in one browser, until {{ consoleDateTime(invited.expiresAt) }}. The Console can't show this link again.
        </p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <template v-if="!invited">
          <UButton variant="ghost" label="Cancel" @click="inviteOpen = false" />
          <UButton type="submit" form="site-invite" label="Create link" :loading="inviting" :disabled="!canInvite" />
        </template>
        <template v-else>
          <UButton variant="ghost" label="Invite someone else" @click="startInvite" />
          <UButton label="Done" @click="inviteOpen = false" />
        </template>
      </div>
    </template>
  </UModal>

  <UModal v-model:open="phoneOpen" title="Link a phone" description="Scan the code with the phone's camera. The phone gets the page tools as you.">
    <template #body>
      <div class="grid justify-items-center gap-3">
        <USkeleton v-if="phoneLoading || !phone" class="size-52" />
        <template v-else-if="phoneLeft > 0">
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div class="size-52 rounded-lg bg-white p-2 text-black [&>svg]:size-full" role="img" aria-label="QR code of the link for your phone" v-html="qrCode(phone.url)" />
          <p class="text-xs tabular-nums text-muted" aria-live="off">Works once. Expires in {{ phoneCountdown }}</p>
        </template>
        <div v-else class="grid size-52 place-items-center rounded-lg border border-dashed border-default p-4 text-center">
          <div class="grid justify-items-center gap-3">
            <p class="text-xs text-muted">This code expired.</p>
            <UButton size="sm" label="Make a new code" @click="linkPhone" />
          </div>
        </div>
      </div>
    </template>
  </UModal>

  <ConsoleConfirm
    v-model:open="revokeOpen"
    :title="revokeTitle"
    :description="revokeDescription"
    confirm-label="Revoke"
    destructive
    :loading="revokeBusy"
    @confirm="revoke"
  />
</template>
