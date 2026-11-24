# UI architecture

The UI in `frontend/` is a Vite app: React 19, React Router 7, TanStack Query 5,
Zustand 5 and styled-components 6, in TypeScript. It runs in Tauri's webview
and talks to the native side only through Tauri commands and events. This note
is the set of rules for adding to it; the design canvas is the source for every
screen, and [PARITY.md](ui-rewrite/PARITY.md) lists what each task must carry
over from the old UI.

```text
pnpm dev               the UI alone at http://localhost:3119, on mock IPC
pnpm storybook         stories at http://localhost:6006
pnpm run lint
pnpm test              Vitest, once (pnpm test:watch to keep watching)
pnpm run build         tsc -b, then vite build into frontend/out
pnpm run build-storybook
pnpm run tauri:dev     the desktop app; Tauri starts Vite on 3118 (devUrl)
```

## Folder layout

```text
src/
  main.tsx             entry: mock IPC outside Tauri in dev, QueryClientProvider, App
  app/                 App, routes, AppThemeProvider, app-wide sync hooks
  api/                 native domains shared by several features (see below)
  components/ui/       design-system primitives, no feature knowledge
  features/<x>/
    api/               native domains only this feature uses
    components/
    hooks/             queries, mutations, event syncs
    pages/             route components
    store/             Zustand stores of client state
    types/
  lib/                 framework-free helpers (queryClient, platform)
  styles/              tokens, GlobalStyle, fonts, icon defaults, theme mode
  mocks/               the in-memory mock IPC and its state
  test/                Vitest setup and fakes
```

A feature imports from `components/ui`, `api`, `lib` and `styles`, never from
another feature. Something two features need moves down to one of those.

`src/lib/claude-output-limits.json` also belongs to native code:
`src-tauri/src/summary/llm_client.rs` embeds it with `include_str!` at compile
time, so moving or renaming it breaks the native build, which the frontend
checks do not run. The old summary settings (`162e8be`) read their limits
from it, and the new ones should too.

Two windows load the same `index.html`: the main window at `/`, and the minibar,
which `minibar.rs` opens as `WebviewUrl::App("minibar")`, at `/minibar`. Tauri's
asset resolver falls back to `index.html` for that path (as the Vite dev server
does), so a new window needs a route, not a new entry. A route outside the
router's list goes to `/`.

## Styling

- Values come from the theme only: `theme.colors`, `text`, `fonts`,
  `fontWeights`, `radii`, `space`, `sizes`, `shadows` (`src/styles/theme.ts`).
  A literal color, size or radius in a component is a missing token; add it to
  both themes. Foundations/Tokens in Storybook shows them all.
- Text styles are objects, used whole: `${({theme}) => theme.text.body};`.
- Components never branch on light or dark; both themes have the same keys.
- Props meant only for styling are transient: `$selected`, `$tone`, so they
  never reach the DOM.
- Values that change every frame (audio levels, the ring, a playhead, a
  progress that ticks) never go through styled props: each new value would
  generate a new class. Write them through a ref (`el.style.transform`), a CSS
  variable on a ref (`el.style.setProperty('--level', …)`), or a canvas.
- Icons are Phosphor (`@phosphor-icons/react`), Regular weight, 16 px by
  default (`ICON_DEFAULTS`). Import the `*Icon` names (`MicrophoneIcon`); the
  bare names are deprecated, and `Record` would shadow TypeScript's type.
- Shortcut hints use `formatShortcut('K')`: `⌘K` on macOS, `Ctrl K` elsewhere.
  `platform` comes from the user agent; `?platform=macos|windows|linux` previews
  another platform on mock IPC.
- `index.html` gets no `<style>` element. Tauri gives inline styles in the
  HTML a nonce, and a nonce in `style-src` turns off the `'unsafe-inline'`
  that styled-components needs. Its boot script, which sets `color-scheme`
  before the bundle runs, repeats the theme key and values of `themeMode.ts`;
  `themeBoot.test.ts` runs it against them.

## Native data

- Every call goes through `command()` in `src/api/core.ts`. It rejects with a
  `CommandError` whose `message` is the Rust error string and whose `detail` is
  the raw value, for commands that reject with an enum.
- A domain file (`src/api/updater.ts`, or `features/<x>/api/…` when one feature
  owns it) holds the payload types mirroring the Rust ones, one wrapper per
  command, the event names, the query keys and the `queryOptions`. No React in
  it.
- Query keys are a factory per domain, rooted at the domain name:

  ```ts
  export const meetingKeys = {
      all: ['meetings'] as const,
      lists: () => [...meetingKeys.all, 'list'] as const,
      detail: (id: string) => [...meetingKeys.all, 'detail', id] as const,
  }
  ```

  Invalidate by prefix (`meetingKeys.all`); never write a key by hand.
- Native data lives in Query: what the database, the recorder or the updater
  owns is read with `useQuery` and changed with `useMutation`, never copied into
  a store. Zustand holds client state only: UI choices, drafts, the theme mode.
  A store that must survive a restart uses `persist`. A key PARITY.md marks
  **Keep reading** keeps its name and its old value format. If a Zustand store
  holds it, the store gets a `PersistStorage` of its own, as
  `bareStringStorage` in `src/styles/themeMode.ts` does, never Zustand's
  default `{state, version}` JSON. The default cannot read an old bare string
  or JSON shape, so the store would start from its default and overwrite the
  user's value on the first write. The default format is for new keys only.
  A per-meeting key family (`summaryLanguageFallback:<meetingId>`,
  `detectedSummaryLanguageFallback:<meetingId>`,
  `meetily-speaker-edits:<meetingId>`) belongs to no store: the feature's api
  file reads and writes each key with `localStorage` directly, under the old
  name and format, since `persist` keeps a whole store under one key.
- Data that native code pushes whole by event gets `staleTime: Infinity`, and
  only the event writes it (see Events). Other data keeps the default
  `staleTime` and is invalidated after the mutations that change it.
- Long work that only the WebView sees, saving a meeting after its recording
  stopped (`recordingSave`) and the post-call pipeline between its native
  steps (`postCall`), reports to the updater with
  `updater_set_ui_activity({activities})`, as `markUiActivity` and
  `UpdaterActivityReporter` did in the old UI (`162e8be`). Each call replaces
  the whole set, and native code drops it 150 s after the last call
  (`UI_LEASE`, the UI activity lease in `src-tauri/src/updater/busy.rs`), so
  the reporter sends a non-empty set again every minute while the work runs
  and an empty one when it ends. Otherwise an update can restart the app in
  the middle of the work. A new activity name needs a native `UiActivity`
  variant first: an unknown name fails the whole call, so the lease stops
  being renewed for the others. Long work a native command does registers
  natively and needs no lease: it holds `updater::busy::hold(…)` while it runs
  (model downloads), or `busy::current()` reads it through its owner's getter
  (summaries, through `active_summary_count`). A command that does neither
  (today `ask_live_assistant` and `ask_person`) gets that added in Rust,
  never a UI lease.

## Events

Native code emits with `app.emit(name, payload)`, or `emit_to(label, …)` for
one window. To use an event:

1. Declare its name in the domain file that owns it, typed with its payload:

   ```ts
   export const UPDATER_STATUS_EVENT = 'updater-status' as NativeEvent<UpdaterSnapshot>
   ```

   `src/api/events.ts` keeps no list of events, so it never imports from a
   feature, and a bare string does not type-check where an event is expected.
2. Subscribe with `useNativeEvent(EVENT, handler)`. It registers once, always
   calls the latest handler, and removes a listener that finishes registering
   after an unmount. Without a `target`, a listener also hears events native
   code sent to the other window; an event meant for one window is heard with
   `{target: getCurrentWindow().label}`.
3. When the event carries the whole value, keep its query with
   `useEventQuerySync` (it takes the same `target`) instead of refetching:

   ```ts
   export function useUpdaterStatusSync() {
       useEventQuerySync(UPDATER_STATUS_EVENT, updaterStatusQuery.queryKey)
   }
   ```

   It cancels a read still in flight before it writes the payload with
   `setQueryData`: a reply and an event reach the webview on separate
   channels in no fixed order, so the reply may hold an older value and land
   over the event's. Once the listener is registered it reads the query again,
   because events sent before that went nowhere. From then on the event is the
   only writer of that query: no `setQueryData` from a mutation's reply and no
   `invalidateQueries` for it, since either can bring back an older value.
4. When the event only says that something changed, `invalidateQueries` the
   keys it affects in a `useNativeEvent` handler.

Mount a sync hook once, in the layout of the screens that read the data, or in
`App` when every window needs it. Values that arrive many times a second (audio
levels) skip Query and React state; see Styling.

## Mock IPC

Outside Tauri, `pnpm dev`, Storybook and every test run on
`@tauri-apps/api/mocks`: `src/mocks/ipc.ts` routes commands to
`src/mocks/handlers.ts` and delivers events to the page's listeners.

- A handler is keyed by the Rust command name, or `plugin:<plugin>|<command>`
  for what `@tauri-apps/api` sends. It reads and changes `mockState`
  (`src/mocks/state.ts`), so a mutation shows up on the next query; throwing
  rejects like an `Err`.
- `mockState` holds only what some handler reads; `createMockState()` builds
  it and `resetMockState()` restores it (tests and stories call it before each
  case).
- The task that adds a domain's handlers ports that domain's handlers and
  sample data from the old browser preview, `162e8be:frontend/src/dev/preview/`
  (`index.ts`: the handlers; `fixtures.ts`: meetings, groups, people,
  transcripts, summaries; `live.ts`: recording; `models.ts`: speech models;
  `intel.ts`: Intel GPUs), into `handlers.ts` and `createMockState`.
  It types the data with the domain's payload types from `src/api` or
  `features/<x>/api`, never with interfaces of its own, so a field that
  changes in the payload type stops the stale sample data from compiling.
- A command native code registers on one platform only (`#[cfg]` in
  `generate_handler!`; "Windows only" or "macOS only" in PARITY.md) goes into
  `platformHandlers.windows` or `platformHandlers.macos`, never `handlers`.
  The mock answers it only when `mockState.platform` matches; elsewhere it
  rejects with Tauri's `Command <name> not found`, so the preview and the
  tests reach the screen's "not available" path as the app does on that
  platform. `resetMockState()` sets it from `src/lib/platform.ts` (`?platform=`
  in the browser); a test or story of the available path sets it before
  rendering (see Tests). A command in both maps stops the mock from loading.
- A command without a handler rejects with a message naming
  `src/mocks/handlers.ts`, so a screen never renders an empty reply as data.
- To push an event, call `emitMockEvent(EVENT, payload)`; in `pnpm dev`, the
  console has `__PROTOCOL_MOCK__.emit(...)` and `__PROTOCOL_MOCK__.state`.

## Storybook

Every component in `components/ui` and every feature component gets a story
file next to it with at least a `Light` and a `Dark` story:

```ts
export const Light: Story = {globals: {theme: 'light'}}
export const Dark: Story = {globals: {theme: 'dark'}}
```

The decorator in `.storybook/preview.tsx` provides the theme, `GlobalStyle`, the
icon defaults and a query client on the mock IPC. The toolbar switches the theme
for stories that do not set it.

## Tests

- Vitest with Testing Library on jsdom; files are `*.test.ts(x)` next to the
  code. Import `describe`, `it`, `expect` and `vi` from `vitest`.
- `src/test/setup.ts` installs the mock IPC on a fresh state before each test
  and clears the DOM, the theme mode and localStorage after it. Change a reply
  for one test with `vi.spyOn(handlers, 'command').mockImplementation(…)`; spies
  are restored after each test.
- Tests run as `linux`: jsdom's user agent names no other platform. To test
  a Windows- or macOS-only command's available path, set
  `mockState.platform = 'windows'` (or `'macos'`) before rendering;
  `resetMockState()` restores it before the next test. It changes only what
  the mock answers, not `platform` from `src/lib/platform.ts`.
- The mock's `open_external_url` opens nothing (jsdom has no `window.open`):
  it appends the link to `mockState.openedUrls`, for the test to check.
- The mock takes the window label from the path when it is installed
  (`minibar` for `/minibar`, otherwise `main`). A test of the minibar sets the
  path, then calls `installMockIpc()` again before rendering.
- jsdom has no `matchMedia`; `setSystemDark()` from `src/test/matchMedia.ts`
  flips the OS theme.
- Test behavior through the UI: roles and visible text, `userEvent` for input.
  Give each test its own client from `createTestQueryClient()`
  (`src/test/queryClient.ts`): it does not retry, so a rejected command shows
  as an error at once instead of after Query's 7 s of retries.
- `listen()` registers asynchronously; wait one macrotask
  (`setTimeout(resolve, 0)`) after mounting before emitting an event, and one
  after emitting before reading what `useEventQuerySync` wrote: it awaits the
  cancel first.
