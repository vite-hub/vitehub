<script setup lang="ts">
import { ref } from "vue";
import { BellIcon, FileTextIcon, InboxIcon, LayoutDashboardIcon, PlusIcon, SettingsIcon, UsersIcon } from "@lucide/vue";
import AppShell from "@/components/app-shell/AppShell.vue";
import type { AppShellGroup } from "@/components/app-shell/AppShell.vue";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from "@/components/ui/command";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCaption, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Toaster, toast } from "@/components/ui/toast";

const route = useRoute();
useHead({ htmlAttrs: { class: route.query.theme === "dark" ? "dark" : "" } });

const groups: AppShellGroup[] = [
  {
    items: [
      { title: "Overview", href: "#overview", icon: LayoutDashboardIcon },
      { title: "Inbox", href: "#inbox", icon: InboxIcon, badge: 4 },
    ],
  },
  {
    label: "Workspace",
    items: [
      { title: "Documents", icon: FileTextIcon, children: [{ title: "Drafts", href: "#drafts" }, { title: "Published", href: "#published" }] },
      { title: "Members", href: "#members", icon: UsersIcon },
      { title: "Settings", href: "#settings", icon: SettingsIcon },
    ],
  },
];

const name = ref("Ada Lovelace");
const notes = ref("");
const notify = ref(true);
const palette = ref(false);
const last = ref("");
const rows = [
  { id: "INV-001", status: "Paid", amount: "$250.00" },
  { id: "INV-002", status: "Pending", amount: "$150.00" },
  { id: "INV-003", status: "Failed", amount: "$350.00" },
];
const tone = { Paid: "success", Pending: "warning", Failed: "error" } as const;

function save() {
  toast.success("Changes saved", { description: "Your profile is up to date." });
}
</script>

<template>
  <AppShell title="Acme" heading="Overview" :groups="groups" current="#overview">
    <template #logo>
      <div class="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground">A</div>
    </template>
    <template #footer>
      <div class="flex items-center gap-2 px-2 py-1">
        <Avatar class="size-6">
          <AvatarFallback>AL</AvatarFallback>
        </Avatar>
        <span class="truncate text-sm group-data-[collapsible=icon]:hidden">Ada Lovelace</span>
      </div>
    </template>
    <template #actions>
      <Button variant="ghost" size="icon" aria-label="Notifications"><BellIcon /></Button>
      <CommandDialog v-model:open="palette" @action="(value) => (last = value)">
        <template #trigger>
          <DialogTrigger data-demo="command" :class="buttonVariants({ variant: 'outline' })" class="text-muted-foreground">
            Search
            <kbd class="rounded-sm bg-muted px-1 font-mono text-xs">⌘K</kbd>
          </DialogTrigger>
        </template>
        <CommandInput placeholder="Type a command or search" />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Pages">
            <CommandItem value="overview"><LayoutDashboardIcon />Overview</CommandItem>
            <CommandItem value="inbox"><InboxIcon />Inbox<CommandShortcut>⌘I</CommandShortcut></CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Actions">
            <CommandItem value="new-document"><PlusIcon />New document<CommandShortcut>⌘N</CommandShortcut></CommandItem>
            <CommandItem value="settings"><SettingsIcon />Settings</CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </template>

    <div class="grid gap-4 lg:grid-cols-2">
      <Card data-demo-section="buttons">
        <CardHeader>
          <CardTitle>Buttons and badges</CardTitle>
          <CardDescription>Every button variant and size.</CardDescription>
          <CardAction><Badge variant="info">New</Badge></CardAction>
        </CardHeader>
        <CardContent class="flex flex-col gap-3">
          <div class="flex flex-wrap gap-2">
            <Button>Default</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Delete</Button>
            <Button variant="link">Link</Button>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <Button size="xs">Extra small</Button>
            <Button size="sm">Small</Button>
            <Button size="lg">Large</Button>
            <Button size="icon" variant="outline" aria-label="Add"><PlusIcon /></Button>
            <Button disabled>Disabled</Button>
          </div>
          <div class="flex flex-wrap gap-2">
            <Badge>Default</Badge>
            <Badge variant="outline">Outline</Badge>
            <Badge variant="solid">Solid</Badge>
            <Badge variant="success">Success</Badge>
            <Badge variant="warning">Warning</Badge>
            <Badge variant="error">Error</Badge>
          </div>
        </CardContent>
      </Card>

      <Card data-demo-section="form">
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>Inputs, a textarea and labels.</CardDescription>
        </CardHeader>
        <CardContent class="flex flex-col gap-4">
          <div class="flex items-center gap-3">
            <Avatar>
              <AvatarImage src="/missing-avatar.png" alt="" />
              <AvatarFallback>AL</AvatarFallback>
            </Avatar>
            <div class="text-sm">
              <div class="font-medium">Ada Lovelace</div>
              <div class="text-muted-foreground">ada@example.com</div>
            </div>
          </div>
          <div class="flex flex-col gap-1.5">
            <Label for="name">Name</Label>
            <Input id="name" v-model="name" />
          </div>
          <div class="flex flex-col gap-1.5">
            <Label for="notes">Notes</Label>
            <Textarea id="notes" v-model:value="notes" placeholder="Anything we should know?" />
          </div>
        </CardContent>
        <CardFooter class="justify-end gap-2">
          <Button variant="outline">Cancel</Button>
          <Button data-demo="toast" @click="save">Save</Button>
        </CardFooter>
      </Card>

      <Card data-demo-section="tabs" class="lg:col-span-2">
        <CardHeader>
          <CardTitle>Invoices</CardTitle>
          <CardDescription>Tabs and a table.</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs default-value="all">
            <TabsList>
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="open">Open</TabsTrigger>
              <TabsTrigger value="archived">Archived</TabsTrigger>
            </TabsList>
            <TabsContent value="all" class="pt-3">
              <Table>
                <TableCaption>Recent invoices.</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead class="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="row in rows" :key="row.id">
                    <TableCell class="font-medium">{{ row.id }}</TableCell>
                    <TableCell><Badge :variant="tone[row.status as keyof typeof tone]">{{ row.status }}</Badge></TableCell>
                    <TableCell class="text-right">{{ row.amount }}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </TabsContent>
            <TabsContent value="open" class="pt-3">
              <Table>
                <TableBody>
                  <TableEmpty :colspan="3">No open invoices.</TableEmpty>
                </TableBody>
              </Table>
            </TabsContent>
            <TabsContent value="archived" class="pt-3">
              <div class="flex flex-col gap-2">
                <Skeleton class="h-4 w-2/3" />
                <Skeleton class="h-4 w-1/2" />
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <Card data-demo-section="loading">
        <CardHeader>
          <CardTitle>Loading</CardTitle>
          <CardDescription>Skeletons hold the place of content.</CardDescription>
        </CardHeader>
        <CardContent class="flex items-center gap-3">
          <Skeleton class="size-10 rounded-full" />
          <div class="flex flex-1 flex-col gap-2">
            <Skeleton class="h-4 w-3/4" />
            <Skeleton class="h-4 w-1/2" />
          </div>
        </CardContent>
      </Card>

      <Card data-demo-section="empty">
        <Empty>
          <EmptyHeader>
            <EmptyMedia><InboxIcon /></EmptyMedia>
            <EmptyTitle>No messages yet</EmptyTitle>
            <EmptyDescription>New messages show up here.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm"><PlusIcon />Compose</Button>
          </EmptyContent>
        </Empty>
      </Card>

      <Card data-demo-section="overlays" class="lg:col-span-2">
        <CardHeader>
          <CardTitle>Overlays</CardTitle>
          <CardDescription>A dialog, a sheet, a menu and the command palette.<span v-if="last"> Last command: {{ last }}.</span></CardDescription>
        </CardHeader>
        <CardContent class="flex flex-wrap gap-2">
          <Dialog>
            <DialogTrigger data-demo="dialog" :class="buttonVariants({ variant: 'outline' })">
              Open dialog
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete project</DialogTitle>
                <DialogDescription>This removes the project and its deployments. You cannot undo this.</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose :class="buttonVariants({ variant: 'outline' })">Cancel</DialogClose>
                <Button variant="destructive">Delete</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Sheet>
            <SheetTrigger data-demo="sheet" :class="buttonVariants({ variant: 'outline' })">Open sheet</SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>Filters</SheetTitle>
                <SheetDescription>Choose what the list shows.</SheetDescription>
              </SheetHeader>
              <div class="flex flex-col gap-1.5">
                <Label for="search">Search</Label>
                <Input id="search" placeholder="Invoice number" />
              </div>
              <SheetFooter>
                <SheetClose :class="buttonVariants()">Apply</SheetClose>
              </SheetFooter>
            </SheetContent>
          </Sheet>

          <DropdownMenu>
            <DropdownMenuTrigger data-demo="menu" :class="buttonVariants({ variant: 'outline' })">Open menu</DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>My account</DropdownMenuLabel>
              <DropdownMenuItem>Profile<DropdownMenuShortcut>⌘P</DropdownMenuShortcut></DropdownMenuItem>
              <DropdownMenuItem>Billing</DropdownMenuItem>
              <DropdownMenuCheckboxItem v-model="notify" value="email-alerts">Email alerts</DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive">Sign out</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardContent>
      </Card>
    </div>
    <Toaster />
  </AppShell>
</template>
