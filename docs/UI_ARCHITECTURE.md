# UI architecture

The UI in `frontend/` is a Vite app: React 19, React Router 7, TanStack Query 5,
Zustand 5 and styled-components 6, in TypeScript. It runs in Tauri's webview
and talks to the native side only through Tauri commands and events. This note
is the set of rules for adding to it; the design canvas is the source for every
screen.

```text
pnpm dev               the UI alone at http://localhost:3118, on mock IPC
pnpm storybook         stories at http://localhost:6006
pnpm run lint
pnpm test              Vitest, once (pnpm test:watch to keep watching)
pnpm run build         tsc -b, then vite build into frontend/out
pnpm run build-storybook
pnpm run tauri:dev     the desktop app; Tauri starts the Vite dev server
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
  mocks/               the in-memory mock IPC and its fixtures
  test/                Vitest setup and fakes
```

A feature imports from `components/ui`, `api`, `lib` and `styles`, never from
another feature. Something two features need moves down to one of those.

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
  that styled-components needs.

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
  A store that must survive a restart uses `persist`.
- `staleTime: Infinity` fits data that native code pushes by event; otherwise
  keep the default and invalidate after mutations.

## Events

Native code emits with `app.emit(name, payload)`. To use an event:

1. Add it to `NativeEvents` in `src/api/events.ts` with its payload type.
2. Subscribe with `useNativeEvent(name, handler)`. It registers once, always
   calls the latest handler, and removes a listener that finishes registering
   after an unmount.
3. Write the payload into the cache instead of refetching. When the event
   carries the whole value, `setQueryData`; when it only says something
   changed, `invalidateQueries`:

   ```ts
   export function useUpdaterStatusSync() {
       const queryClient = useQueryClient()
       useNativeEvent(UPDATER_STATUS_EVENT, (snapshot) => {
           queryClient.setQueryData(updaterStatusQuery.queryKey, snapshot)
       })
   }
   ```

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
- `mockState` is built from `src/mocks/fixtures.ts`, the old preview's sample
  library. Add fields there and in `createMockState`; `resetMockState()`
  restores the fixtures (tests and stories call it before each case).
- A command without a handler rejects with a message naming
  `src/mocks/handlers.ts`, so a screen never renders an empty reply as data.
- To push an event, call `emitMockEvent(name, payload)`; in `pnpm dev`, the
  console has `__PROTOCOL_MOCK__.emit(...)` and `__PROTOCOL_MOCK__.state`.
- The old preview also mocked recording, speech models and Intel GPUs
  (`live.ts`, `models.ts`, `intel.ts` in `main:frontend/src/dev/preview/`); the
  tasks that build those screens port them.

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
- `src/test/setup.ts` installs the mock IPC on fresh fixtures before each test
  and clears the DOM, the theme mode and localStorage after it. Change a reply
  for one test with `vi.spyOn(handlers, 'command').mockImplementation(…)`; spies
  are restored after each test.
- jsdom has no `matchMedia`; `setSystemDark()` from `src/test/matchMedia.ts`
  flips the OS theme.
- Test behavior through the UI: roles and visible text, `userEvent` for input.
  Render with a fresh `QueryClient` per test.
- `listen()` registers asynchronously; wait one macrotask
  (`setTimeout(resolve, 0)`) after mounting before emitting an event.
