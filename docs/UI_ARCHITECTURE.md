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
  app/                 App, routes, hotkeys, AppThemeProvider, app-wide sync hooks
    shell/             the main window's frame (Window shell below)
    placeholder/       stand-ins for the screens until their tasks replace them
  api/                 native domains shared by several features (see below)
  components/ui/       design-system primitives, no feature knowledge
  components/editor/   the notes editor (BlockNote), loaded as its own chunk; its
                       schema names checklist checkboxes by their item's text
  components/transcript/  the transcript of a saved or a live meeting
  features/<x>/
    api/               native domains only this feature uses
    components/
    hooks/             queries, mutations, event syncs
    pages/             route components
    store/             Zustand stores of client state
    types/
  lib/                 framework-free helpers (queryClient, platform, paths)
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
router's list goes to `/`. Window shell below has the routes.

## Window shell

`app/shell/` is the frame every screen of the main window lives in (#110):
the title bar, the screen, the bar docked under it, the startup gate and the
shell's own commands. The minibar window has none of it.

### Window and title bar

- The main window opens at 460×700 and stays resizable, down to 360×480:
  360 px keeps room for the docked bar's status beside its 56 px ring and
  Record or Stop, and for the Windows strip beside its three 46 px caption
  buttons; 480 px leaves the content room under the title bar, a screen's
  header and the bar. `tauri.conf.json` holds the window for Windows and
  Linux; `tauri.macos.conf.json` repeats the whole entry for its title bar,
  since a platform file replaces the `windows` array.
- The app draws the title strip (`TitleBar`, the `<header>`) on every
  platform, as the design does: macOS keeps its traffic lights over an overlay
  title bar (`titleBarStyle: Overlay`, `hiddenTitle`, `trafficLightPosition`
  {13, 17}: tao makes the title bar the buttons' height plus `y` and leaves
  the buttons at AppKit's offset from its bottom, which centres them on the
  38 px strip; not yet checked on a Mac) and the strip starts after them;
  Windows (`decorations: false`) gets Windows 11's caption buttons, Maximize
  turning into Restore with every resize; Linux (`decorations: false`) gets
  GNOME's round close button and the screen's title in the middle (a route's
  `handle.title`). `?platform=` previews the others on mock IPC.
- The strip is `data-tauri-drag-region="deep"`: it drags the window and
  double-clicks to maximize, and Tauri's drag script leaves out buttons,
  links and other controls, so nothing in it needs its own exception. The
  window permissions it calls are in `tauri.conf.json`'s capability
  (`allow-minimize`, `allow-toggle-maximize`, `allow-close`,
  `allow-start-dragging`, `allow-internal-toggle-maximize`,
  `allow-set-always-on-top`; `is-maximized` comes with `core:window:default`).
  Close hides the main window to the tray (`lib.rs`); minimizing it during a
  recording opens the minibar.
- **Keep on top** is the pin in the strip, on every screen of the main window
  so a pinned window can always be unpinned (the design draws it on the
  recording screen). It is new, so it keeps Zustand's own format under a new
  key, `protocol-keep-on-top`, and the shell applies it to the window at
  startup (`keepOnTop.ts`).
- "Back to meetings" shows on every screen but the meetings (a route's
  `handle.back`) and goes to `/`.

### Routes and screens

- `routes.tsx` is the route table of both windows and `lib/paths.ts` (in
  `lib` so that features can navigate too) names every path: `/` the meetings, `/meetings/:meetingId` a meeting, `/recording` the
  recording screen, `/settings` with an optional `?section=` (the old UI's
  section ids, which the tray still sends; it replaces the old
  `meetily-settings-*` sessionStorage keys), and `/minibar` outside the shell.
  It is a data router (`createBrowserRouter`), for `handle` and
  `useMatches` now and `lazy` and `useBlocker` later. Native code knows
  `/settings`, `/settings?section=about` and `/minibar`: they keep resolving,
  or native changes with them.
- A screen renders `Screen`: its `<main>`, with its own h1 first (in
  `theme.text.screen`), and the
  `<footer>` under it, both siblings of the title bar's `<header>`, so every
  screen has the banner, main and contentinfo landmarks. The footer docks
  the recording bar (`RecordingBar`, laid out by `DockedBar`, both in
  `features/recording`: the ring, what is happening, Record or Stop) over the
  screen's own `bar`, the meeting's player (#113). The recording bar shows
  on every screen while a recording starts, runs or is being saved, and
  idle (Record) only where the screen sets `recordBar`: Home. The status
  line of model downloads (#117) goes in the same footer on every screen;
  with nothing in it, the footer is `:empty` and hidden from the eye and
  from screen readers.
- A screen arrives with a fade and a 4 px rise over `base`; the screen it
  replaces leaves at once, so a click never waits for an exit.
- A screen opened by a navigation focuses its `<main>` (`tabIndex={-1}`,
  `preventScroll`): the control that navigated, such as Settings or Back to
  meetings, leaves with the old screen, and focus would fall to `<body>`.
  The first screen of the page (location key `default`) leaves focus alone.
- Screens are placeholders in `app/placeholder/Screens.tsx` until their tasks
  replace them in the route table; the theme switch sits on the Settings
  placeholder until #114.

### Startup

- Until native code says whether first launch is done
  (`get_onboarding_status`, `src/api/onboarding.ts`) the main window shows
  "Checking setup…" with a spinner under the title bar; a failed read, or
  one still running after 8 s (`STARTUP_PATIENCE_MS`), offers Retry, as
  the old layout did.
  Then it shows first launch (#115; first launch invalidates
  `onboardingKeys.all` when it is done) or the app.
- Once first launch is done, a crash report the previous session left
  (`src/api/crashReport.ts`) opens as a sheet over the app: Send Report and
  Save ZIP save the ZIP through the save dialog (Send then opens a GitHub
  issue to attach it to), Ignore dismisses it. Closing the sheet without a
  choice leaves the report for the next launch; a failure says so in the
  sheet and keeps it open.
- In a release the webview's context menu is off in both windows, as in the
  old app.

### Tray

- The tray (`tray.rs`) talks to the main window by event only, never by a
  reload, which would drop a meeting still being saved and the queued
  post-call jobs (`src/api/tray.ts`). `tray-navigate` carries a path and the
  shell routes it, from startup on. Start Recording sends
  `request-recording-toggle` (the old UI's name) instead of writing
  sessionStorage `autoStartRecording` and reloading, which started a
  recording without asking whether first launch was done.
- The shell hears the start request only once first launch is done
  (`ShellCommands`), so a Start during first launch does nothing. Native code
  no longer shows "Starting Recording…" for it: the menu keeps Start until
  `start_recording` succeeds and updates it, so a refused or failed start
  leaves no stale item, and a second click sends the request again. The
  start itself, with its order (PARITY.md › Recording start order), is
  #112's: until then the request, ⌘R and Record open the recording screen.

### Hotkeys

- `app/hotkeys.ts` is the window's one keydown listener, attached when the
  module loads. A screen, or a part of one, registers with
  `useHotkey({code, mod, shift}, run)` while mounted; the shell registers its
  defaults with `level: 'app'`.
- `mod` is ⌘ on macOS and Ctrl elsewhere, the other one must be up, and so
  must Alt (AltGr on Windows is Ctrl and Alt). Keys are `KeyboardEvent.code`,
  the physical key, so Ctrl R is Ctrl R on a Russian layout too. Hints write
  them with `formatShortcut`.
- On the same keys a `screen` hotkey wins over an `app` one, and within a
  level the latest registration wins. The shell's are ⌘R (start a recording;
  the recording's own ⌘R, Stop, overrides it while it runs) and ⌘, (Settings);
  ⌘K is search's (#118).
- A ⌘ hotkey works from a text field too, and always stops the browser's own
  action (Ctrl R would reload the page), even while it does not run: while a
  sheet is open (`role="dialog"`), or for a key held down. ⌘R is blocked even
  with no hotkey on it, so startup and first launch, before the shell
  registers its own, do not reload either. A bare key, such as
  Space, belongs to the focused control first (fields, buttons, links, tabs,
  switches, menu items: Space presses them) and to an open sheet; it runs only
  when focus is on none of them.
- **Space** belongs to the screen in front, and nothing registers it
  app-wide: on the recording screen it pauses and resumes the recording (the
  ring, the minibar's `Pause (Space)`); on a meeting it plays and pauses that
  meeting's audio, also while a recording runs elsewhere. So it never pauses
  a recording the user cannot see, and the old player's Space keeps working.
  The meeting's ← and → stay on the scrubber's focus.

## Styling

- Values come from the theme only: `theme.colors`, `text`, `fonts`,
  `fontWeights`, `radii`, `space`, `sizes`, `shadows`, `motion`
  (`src/styles/theme.ts`; Motion below).
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

## Primitives

`components/ui` holds the building blocks every screen uses, each with Light
and Dark stories. Behaviour and accessibility come from Radix (Dialog, Select,
DropdownMenu, Switch, Tooltip) or from native elements; the look from the
theme; the motion from the Motion section.

- `Button` (filled, secondary, ghost; `sm` 28 px in rows, `md` 30 px in
  footers; `pending` while what it started runs, see Motion) and
  `IconButton`, whose required `label` is its accessible name
  and its tooltip. `Kbd` shows a shortcut on the window, a grey field or a
  filled button.
- `SegmentedControl`, and `Tabs` with `TabList` and `TabPanels` (see Motion).
- `Switch`, `Select`, `TextField` and `TextArea`. `SettingsGroup`,
  `SettingsRow` and `SettingsNavRow` lay out a settings card; a control in a
  row without a name of its own (`label`, `aria-label`, `aria-labelledby`)
  is named by the row's label and described by its description. A focused
  field draws a 2 px stroke in the text colour on its edge
  (`fieldFocusRing`), so focus differs from hover's `muted` border. The
  stroke is one outline over the border, never a border plus a spread
  shadow: the two snap to device pixels separately, and at a fractional
  display scale (175 %) one side comes out thinner. An
  external `SettingsNavRow` says "(opens in browser)" to screen readers.
- `VisuallyHidden` holds text only assistive technology reads.
- Menu and select rows keep the design's faint highlight; the keyboard's row
  also gets an inset `muted` ring on `:focus-visible` (`keyboardRowRing`),
  which the pointer never shows. The notes editor's menus do the same.
- `Menu` with `MenuItem`, `MenuCheckboxItem`, `MenuRadioGroup` and
  `MenuRadioItem`, `MenuGroup`, `MenuSub` and `MenuSeparator`.
- `Sheet`: a dialog over the dimmed window, opened through `open`. On close
  it returns focus to the control that opened it; for a menu item, which
  has gone with its menu, that is the menu's button. Its scrim starts under
  the title strip, which stays live (`pointer-events: auto` against Radix's
  lock on `<body>`), and a press there does not close the sheet, so the
  window still moves, minimizes and closes on Windows and Linux.
- `Tooltip` shares its open delay through `TooltipProvider`.
- Toasts: `toast('Recording cancelled')`, or with a tone,
  `toast.success | info | warning | error | loading(title, {description,
  action: {label, onClick}, duration, id})` from `toastStore.ts`, callable
  from anywhere, a mutation's callback or an event handler outside React;
  `toast.dismiss(id?)` closes one or all. The window's one `Toaster`
  (`Toast.tsx`) draws them under the title strip, newest on top, at most
  three (a fourth closes the oldest), above an open sheet and usable over
  it. The design draws no toast: it takes the Home banner's look, an icon
  for the tone (none is red, which is the recording's), a medium title, a
  muted line that wraps anywhere (a hash fits), one small action and the
  close button. Radix's toast gives the behaviour: the time on screen
  (5 s, `Infinity` for `loading` or to wait for the user, 30 s for a
  warning that must not be missed) stops under the pointer, on focus and
  while the window is in the background; Escape closes the focused toast,
  F8 reaches them, errors and warnings interrupt screen readers and the
  rest waits its turn. An action closes its toast; give it `altText` when
  the same can be done elsewhere. Showing a toast again with its id
  replaces it where it stands (a loading toast and its outcome); the
  Toaster announces the new text, since Radix announces a toast only when
  it appears. A mouse drag never dismisses one.
- `UiProviders` (`app/`) is what the primitives expect above them besides
  the theme: `MotionProvider`, the icon defaults, `TooltipProvider` and the
  `Toaster`. App, Storybook's decorator and the tests' `renderUi`
  (`src/test/`) mount it.
- `StatusLine`, whose `busy` status turns a spinner before its text, and
  `ProgressBar`. The bar scales its fill by transform from an inline
  style, so a ticking value makes no new class. `Spinner` marks a wait of
  unknown length (see Motion).
- `Collapse` holds what a disclosure shows and hides (see Motion); the
  button that toggles it sets `aria-expanded`.

## Motion

Motion shows what changed: where a selection went, what arrived, what left,
and that a wait is still running. It is never decoration. CSS transitions
carry state feedback (hover, press, focus); motion (`motion/react`) carries
enter and exit, indicators and springs.

- Tokens live in `src/styles/motion.ts`: durations `fast` (120 ms: hover,
  press, focus), `base` (200 ms: most changes of state, the theme crossfade)
  and `slow` (320 ms: large surfaces); easings `standard`, `enter` and
  `exit`; springs `snappy` (indicators) and `gentle` (sheets, panels); and
  `spinner`: one `turn` (900 ms, linear) and the `delay` (400 ms) before a
  delayed spinner shows. CSS reads `theme.motion.duration.*`,
  `theme.motion.easing.*` and `theme.motion.spinner.*`; motion/react
  reads `tween(duration, easing)` and `springs.*`. A literal duration or curve
  in a component is a missing token. Foundations/Tokens plays the durations,
  easings and springs side by side; UI/Spinner shows the spinner's.
- Only `transform` and `opacity` animate, plus colours in state feedback and
  the theme change. Width, height, top, left and margin never animate: each
  frame would lay the window out again. Something that has to grow appears
  with a fade and a small rise, and the layout moves once. The one exception
  is `Collapse`, a disclosure's content ("What's included?", advanced
  settings): it grows its height under a clip, because what follows it has
  to slide rather than jump, and its text must not fade, since text that
  ends an opacity animation is rasterized again and visibly blinks. It is a
  short block in a sheet or a settings card, so laying it out each frame
  is cheap.
- Animated elements are `m.*` (`import * as m from 'motion/react-m'`) under
  `MotionProvider` (through `UiProviders`). It loads
  `domAnimation` (`app/motionFeatures.ts`) as its own chunk after the first
  render; until then an `m` element keeps the values it mounted with and
  catches up when the chunk arrives. Its `strict` mode rejects the full
  `motion.*`. Import nothing from
  motion's imperative API (`animate()`, `useAnimate`): it puts the engine back
  into the first chunk. Layout animations (`layout`, `layoutId`) need
  `domMax`, which is not loaded: an indicator moves by transform instead.
- Segmented controls and tabs share one track (`SegmentedControl.tsx` in
  `components/ui`), whose motion follows ddoemonn's
  [Segmented Control](https://21st.dev/@ddoemonn/components/segmented-control)
  on 21st.dev, the owner's pick: equal segments, a thumb moved by transform
  on `springs.snappy`, and the thumb as the only filled shape. Hover and press
  change only the text colour; keyboard focus draws an outline.
  `SegmentedControl` is a radio group on the window (the theme);
  `Tabs` with `TabList` and `TabPanels` is a tab list on a grey track over
  its views (the meeting's Notes · Transcript · Summary).
- Radix gives the overlays their behaviour; motion animates them. Sheet,
  Menu and Tooltip hold their open state, and AnimatePresence keeps their
  `forceMount`ed content until the exit has played (Radix's guide to
  JavaScript animation). Select cannot: closed, Radix keeps its items in a
  detached fragment, which shows the current label and selects by typing, so
  its list stays forced in for `fast` after it closes.
- Waits always move, though the window otherwise moves little: a wait of
  unknown length shows a `Spinner`, a wait whose share is known shows how
  far it has got (a `ProgressBar`, or a percent that climbs), and static
  text alone never marks a wait, since it looks frozen. The spinner is
  Phosphor's CircleNotch turning in the current colour, sized to the text
  (`1em`) and hidden from screen readers: the text beside it, or
  `aria-busy` on what waits, says what the wait is. It is essential motion
  and keeps turning under reduced motion. Where waits show:
  - `StatusLine` turns one before a `busy` status, such as "Checking for
    updates…" or the startup gate's "Checking setup…".
  - A spinner standing in for something that usually ends at once is
    `delayed`: it fades in only after `spinner.delay`, so a fast load or
    action shows nothing rather than a flash. The notes editor's fallback,
    while its BlockNote chunk loads, turns one on the notes' first line.
  - `Button`'s `pending` disables the button and sets `aria-busy` at once;
    if what the click started runs past `spinner.delay`, the label turns
    transparent in one step (never fading), keeping the button's width, and
    a delayed spinner fades in over it until the action ends. So Ignore,
    which usually ends at once, keeps its label. The crash report sheet's
    Send Report, Save ZIP and Ignore use it.
- What animates and how:
  - Tabs and segmented controls: the thumb slides; the panel below swaps
    with a `base` crossfade, without sliding.
  - Sheets and dialogs: in from their edge by `y` on `springs.gentle`, the
    scrim fading over `base`; out with `tween('base', 'exit')`. A sheet hangs
    under the window's header, so it arrives from above.
  - Toasts hang there too and move the same way, from above and back up. A
    toast replaced where it stands swaps its content as a status change
    does.
  - Menus, select lists and tooltips: opacity and a scale from `SCALE_FROM`
    (0.96), with `transform-origin` on the side of their anchor, over
    `fast`. Inside a menu or a select list one highlight slides between the
    items on `springs.snappy` (`SlidingHighlight`); it stays on the last
    item while the pointer crosses a separator, and fades when the pointer
    leaves the list or rests on a disabled item, where Enter would do
    nothing.
  - Lists: a new row fades in rising 4 px over `base`, a removed row fades
    out; no stagger, and no reordering animation (it needs layout).
  - Disclosures: `Collapse` grows from nothing to its content's height over
    `base` and shrinks back the same way, at full opacity throughout; its
    button's caret turns over `fast`. The clip holds only while the height
    moves, so a focus ring at the content's edge shows once it is open.
  - Status changes (a status line, a badge, a count): `AnimatePresence
    mode="wait"` with the old value leaving and the new one arriving, opacity
    and 4 px of `y` over `fast`, as the shell's update status does. The key
    names the meaning, not the text: re-key when the meaning changes, never
    on every value; a value inside one meaning (a download's percent, a
    count) updates in place. That value also stays outside the
    `role="status"` live region, beside it, so screen readers announce a
    change of meaning and not every tick; `StatusLine` does both.
  - Hover, press, focus: CSS on the element. Colour and background change
    over `fast`; a button's press scales it to `SCALE_FROM` inside
    `MOTION_OK`; the focus outline appears at once. Segmented options take neither a fill nor
    a scale.
  - Every theme change crossfades: `setMode` goes through
    `changeThemeSmoothly` (`styles/themeTransition.ts` says how and why), and
    so do an OS switch in system mode and a change made in the other window.
    Callers just call `setMode`. With View Transitions the window crossfades
    over `base`, and clicks made during it are lost; without them the theme
    switches at once. Colours never transition one by one.
  - Values that change every frame (audio levels, the ring) stay outside
    motion and React; see Styling.
- Reduced motion: `MotionProvider` sets `reducedMotion="user"`, so transform
  and size animations (`Collapse`'s height) jump to their end while opacity
  still fades. The spinner's turn stays outside `MOTION_OK`. CSS movement goes
  inside `MOTION_OK` (`@media (prefers-reduced-motion: no-preference)`);
  colour and opacity transitions stay outside it, and so does the theme
  crossfade, which moves nothing. motion reads the setting when an element
  mounts: a change while the window is open reaches elements mounted after it,
  and all of them after a reload; CSS follows at once. The `ReducedMotion`
  story of `SegmentedControl` shows it, and Orca's browser emulates the setting
  with `orca set media --reduced-motion reduce`.
- Tests run with `MotionGlobalConfig.skipAnimations` (`src/test/setup.ts`), so
  every animation ends at once; motion writes styles on its next frame, so
  assert them inside `waitFor`.

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
- The user's preferences that several screens read sit in
  `src/api/preferences.ts`: the name, the meeting language, the automatic
  summary and the summary language are one small store each, under the old
  keys and formats; the summary model is a query. `usePreferencesSync`
  (mounted in `App`) reads a change made in the other window again and sends
  the meeting language to native at startup and on every change, since native
  keeps it in memory only. Pin a summary language with
  `pinSummaryLanguage`, which keeps it on the recent list.
- The recording preferences (`src/api/devices.ts`) are one native object that
  `set_recording_preferences` replaces whole. Change them only with
  `updateRecordingPreferencesMutation()`: its updates share a mutation scope,
  so they run one at a time, and each reads the stored object again before
  writing it, so fields no screen shows and changes made at once all
  survive; it keeps the legacy single-app fields on the first chosen app.
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

## Recording state other screens read

Two small stores in `src/api` let screens outside the recording feature
follow it without importing it. The recording feature is the only writer of
both; its session and its post-call runner come with the recording screen
(#112), so until then nothing writes them.

- `recordingPhase.ts`: where the main window's recording is: `idle`,
  `starting`, `recording`, `paused` or `finishing` (Stop pressed, the
  meeting being saved). `useRecordingPhase()` reads it, `useRecordingBusy()`
  says whether it is anything but idle (Settings locks the meeting language
  then), `recordingPhase.get()` reads it outside React. It changes with the
  recording's own events, before the updater's busy snapshot would.
- `postCall.ts`: the pass after a recording is saved (retranscription,
  diarization, the automatic summary), one job per meeting:
  `usePostCallJob(meetingId)` is the meeting's job while it is queued, runs
  or failed, and null once it has ended. #112's runner, mounted once by
  the shell above navigation, is to write it (`postCallJobs`); a screen
  asks it to cancel, retry or skip a step through `postCallControls`, never
  by writing a job. When a step ends the runner is to invalidate the
  meeting's queries. The file also holds the retranscription and
  diarization commands and events, which Enhance transcript (#119) and
  "N speakers · change" (#113) call, and `RETRANSCRIPTION_BANDS`: native's
  percent is not linear in time, and only its chunks' band (25 to 80) has a
  pace, so the time left is measured there.
  `features/meetings/components/processing` draws a job (#113 owns it once
  merged): `ProcessingStatus` (the strip under a meeting's header),
  `ProcessingSteps` (the steps where the summary will be) and
  `ProcessingLine` (Home's row); each renders nothing without a job.
  `progress.ts` beside them has the words, the share of the pass done and
  the time left.

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
levels) skip Query and React state; see Styling and the next section.

### Models and permissions

- `src/api/models.ts` holds the speech models (Parakeet live, Whisper after
  meetings) and the built-in summary models: their lists, the downloads and
  retries, the recommended summary model, and the download events. Native
  code owns every download and holds the `modelDownload` busy reason while
  one runs; a download command resolves only when its download ends.
- A download's progress, its Whisper activation and its last failure come
  only by event. `useModelDownloadSync` (`app/`, mounted by the shell in
  front of the startup gate, so first launch's downloads are heard and keep
  being heard after it) writes them into `downloadsQuery`, which nothing
  fetches, and reads a model's list again when its download ends, clearing
  the download only once the list has answered. A second call for a running
  download is refused, and native code sends the refusal as an error event
  too (`isAlreadyDownloading`); the sync ignores it, since the first
  download goes on. `modelState(status, download)` folds a list's status and the download into
  what a screen shows: `ready` only after the completion event, which comes
  after verification, so a percent stays below 100 until then.
- Native code activates a model after its download, never the UI:
  `downloadWhisperModel(POST_CALL_WHISPER_MODEL, {enablePostCall: true})`
  saves Whisper as the after-meeting model before it resolves, which
  survives a reload of the window; it needs the database.
- `src/api/permissions.ts` asks for the microphone and, on macOS, Audio
  Capture, reads the Audio Capture record and opens the privacy panes (macOS
  only). A microphone is usable when the device list has an input. The
  Audio Capture probe (`systemAudioProbeQuery`) may prompt and listens for
  5 s, so it runs only on a click (`refetch()`); its answer holds for the
  session and stands in for a record that lags (`systemAudioAllowed`).

## Audio levels, the ring and the meters

- Native code pushes two level events, declared in `src/api/audio.ts`:
  `recording-audio-levels`, one sample per source (`mic`, `system`) and audio
  chunk during a recording, about 25 a second per source; and `audio-levels`,
  every previewed device about 12 times a second between
  `start_audio_level_monitoring` and `stop_audio_level_monitoring`.
  `levelOf(rms, peak)` turns a sample into 0 to 1 on the old meters' decibel
  scale (-50 dB empty, -16 dB full).
- A screen says what to follow with a `LevelFeed`, plain data:
  `{kind: 'recording', source: 'mic' | 'system' | 'both'}` (`both` is the
  louder source) or `{kind: 'device', type: 'input' | 'output', device?,
  gain?}`. As in the old preview, a device matches when either name contains
  the other (a stored device carries a ` (input)` or ` (output)` suffix),
  otherwise the loudest device of the type counts, and `gain` (the volume
  slider beside a preview meter) applies before the decibels, so moving the
  slider moves the meter at once.
  `useAudioLevel(feed, onLevel)` hands each level to a callback that writes a
  ref or a canvas, never state; `subscribeAudioLevel` is the same without
  React, on `subscribeNative` (`src/api/events.ts`). Each subscriber has
  its own listener: Tauri sends an event to a webview once, with every
  listener's id, so more listeners cost only their callbacks.
  `useAudioLevelMonitoring(deviceNames)` runs the device preview while mounted
  and stops it on unmount; its starts and stops wait for each other, because
  native's start stops the old preview and waits before it opens the devices,
  so a stop arriving meanwhile would be undone.
- `components/ring` holds what draws them. `Ring` is the design's WebGL ring
  in four modes: `rec` follows the level, `test` (the mic test) exaggerates
  it, `idle` is greyed and slow and does not listen, `paused` is flat and
  grey. `LevelMeter` is the five bars;
  `SourceMeter` is the mute toggle of the recording bar and the minibar, with
  the bars or, muted, "Muted" on an inverted fill. Its name comes from its
  content, so it holds the visible "Muted" (WCAG 2.5.3): "Mute microphone"
  while on, "Muted microphone" while muted, with `aria-pressed`; its
  Tooltip says what a click does. The button around the ring
  (pause) and the native mute calls belong to the screens.
- The ring's cost is bounded in `ringLoop.ts`: one requestAnimationFrame loop
  per ring, running only while the canvas is on screen, the document is
  visible and motion is allowed; under reduced motion it draws one frame and
  draws it again when a prop or the theme changes. The canvas is the CSS
  size times the device pixel ratio, capped at 2, on a context without
  antialiasing, depth or stencil that asks for the low-power GPU. The shader
  runs in highp where the GPU has it, and its clock wraps every 40π s, the
  period on which every time term repeats, so on a GPU with only a 16-bit
  mediump its error stays under 1/16 s instead of growing with the
  recording. Without
  WebGL, or while the context is lost, `StaticRing` shows a still gradient
  ring greyed per mode. Under reduced motion the ring holds the logo's frame
  in its mode's grey; the meters still show the level, without easing.
- The meters write `transform: scaleY(…)` on their bars at each sample and
  let a CSS transition smooth it; they fall to rest 300 ms after the last
  sample, since native stops sending when a recording stops. The ring's
  loop reads the level as 0 after the same 300 ms, and `Ring` resets it
  when its feed ends.
- The mock fakes both events (`src/mocks/audio.ts`): outside tests a fake
  conversation emits `recording-audio-levels` from the start, and the preview
  commands emit `audio-levels` for the devices asked for.
  `mockState.audio.level` holds both sources at one level instead (the
  stories' level slider). Tests emit the samples they need.

## Meetings and the transcript

- `src/api/meetings.ts` is the meetings domain: the list, a meeting's
  header, its transcript a page at a time, folders (native's groups; the
  Groups page became folders on the list), the summary and its run, action
  items and speaker labels. #112 saves a recording through `saveTranscript`,
  files it with `setMeetingFolderMutation` and starts the automatic summary
  with `startSummary`; the meeting screen (#113) uses the rest. A mutation
  invalidates what it changed: a rename the list, the header and the
  folders' counts; a delete drops the meeting's own queries instead, so a
  screen still on it does not refetch "Meeting not found".
- `startSummary` reads the whole transcript, writes it as
  `[mm:ss] Speaker: text` lines, picks the language (the one chosen for the
  meeting, else the one detected before, else it detects and keeps it, in
  the old `…Fallback:<meetingId>` keys for a meeting without
  metadata.json) and calls `api_process_transcript` with the
  `standard_meeting` template until #117 stores a default. Checks of the
  model itself (downloaded, installed) are the caller's. The run goes on
  natively, which holds it as busy work for the updater: `summary-progress`
  says it moved on, and `summaryQuery` also reads it again every 5 s while
  it runs, since a run that fails before its first step sends no event.
- `TranscriptList` (`components/transcript/`) shows a transcript, saved
  or live: one row per turn, consecutive lines of one voice less than
  2.5 s apart joined. Rows off screen are neither laid out nor painted
  (`content-visibility: auto`), so a meeting of several hours costs about
  what its visible rows cost, and rows re-render only when what they show
  changes. The turn being played comes from a `PlaybackClock` the player
  passes in; the list writes `data-active` and `aria-current` straight
  onto that row, never through React state, and keeps it in view unless
  the user scrolled in the last 4 s. A `live` list (#112) follows its end
  until the user scrolls up, then offers Latest; its new rows fade in. A
  voice other than the user's can be named in place (`onRenameSpeaker`);
  the user's own label comes from the microphone and is never renamed here.

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
  `intel.ts`: Intel GPUs), into a domain file of its own,
  `src/mocks/<domain>.ts`, as `src/mocks/notes.ts` does: `<domain>Handlers(state)`
  returns the handlers, spread into `handlers`, and `createMock<Domain>()`
  builds the sample data, called from `createMockState`. The handlers take
  the state as an argument because `state.ts` imports the domain file, so
  importing `mockState` back would make a cycle. A domain with no sample
  data of its own, as `src/mocks/audio.ts`, keeps its few fields inline in
  `createMockState` and exports its handlers as an object that reads
  `mockState`, since `state.ts` does not import it. Parallel tasks then add one
  line each to `handlers.ts` and `state.ts` instead of editing the same
  blocks. It types the data with the domain's payload types from `src/api`
  or `features/<x>/api`, never with interfaces of its own, so a field that
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

The decorator in `.storybook/preview.tsx` provides the theme, `GlobalStyle`,
`UiProviders` and a query client on the mock IPC. The toolbar switches the
theme for stories that do not set it.

`@storybook/addon-a11y` runs axe on every story in its Accessibility panel, in
both themes; a violation there is fixed in the component, not hidden in the
story.

## Tests

- Vitest with Testing Library on jsdom; files are `*.test.ts(x)` next to the
  code. Import `describe`, `it`, `expect` and `vi` from `vitest`.
- `src/test/setup.ts` installs the mock IPC on a fresh state before each test
  and clears the DOM, the theme mode, the toasts and localStorage after it.
  It also gives jsdom the pointer capture methods Radix's toasts call. A
  fake model download (`src/mocks/models.ts`) steps
  `mockState.models.downloadStep` percent every 250 ms and fails halfway for
  a key in `mockState.models.failing`. Change a reply
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
  `renderUi` (`src/test/renderUi.ts`) renders under the light theme and
  `UiProviders`, as the app does; its `rerender` keeps them.
  Give each test its own client from `createTestQueryClient()`
  (`src/test/queryClient.ts`): it does not retry, so a rejected command shows
  as an error at once instead of after Query's 7 s of retries.
- `listen()` registers asynchronously; wait one macrotask
  (`setTimeout(resolve, 0)`) after mounting before emitting an event, and one
  after emitting before reading what `useEventQuerySync` wrote: it awaits the
  cancel first.
