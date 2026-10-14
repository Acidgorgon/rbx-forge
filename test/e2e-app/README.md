# Real-app click-through suite

Drives the **built** RBX Forge (`out/`) with Playwright's `_electron` API and clicks through the
workbench, Forge Sync, the labs, Settings and the AI flows. It is not part of `npm test`.

## Run

```sh
npm run test:app                       # electron-vite build, then every flow under xvfb-run
LUNE_PATH=/path/to/lune npm run test:app   # also runs the Lune-backed parts (UI Preview, sequence compose)
```

Without rebuilding, or a subset (inside an X server / `xvfb-run -a`):

```sh
xvfb-run -a -s "-screen 0 1920x1080x24" node --experimental-strip-types test/e2e-app/run.ts --only=editor,forge-sync
node --experimental-strip-types test/e2e-app/run.ts --list      # flow names
... run.ts --keep                       # keep the temp HOME / project afterwards
```

Needs: Playwright installed globally (`npm i -g playwright`; the suite imports
`$(npm root -g)/playwright/index.mjs`, or set `PLAYWRIGHT_PATH` to the package folder), the Electron
binary in `node_modules/electron`, `git`, and `xvfb-run` on Linux (macOS / Windows run it directly
with `node --experimental-strip-types test/e2e-app/run.ts`).

## What it sets up

- **Isolation**: a temp `HOME` and `XDG_CONFIG_HOME`, so userData is `<tmp>/config/rbx-forge`
  (src/main/index.ts sets userData from appData). The environment is stripped of anything that
  looks like a key, token, cloud credential or `GIT_*` variable; no real API key is ever used.
  `settings.json` is pre-seeded (toolchain gate skipped, the fixture as the last project).
- **Project**: a GenTree-shaped temp project (template `default.project.json`, feature layout,
  UI Labs stories + vendored Vide) with a git repo and a bare local `origin`
  (`lib/project.ts`).
- **Fake model provider** (`lib/fakeProvider.ts`): a local OpenAI-compatible server. The
  `fake-provider` flow points Settings > Providers > Custom at it, so chat, restate-first and lab
  compose run end to end. Answers are chosen by rules (restate JSON, a `write_script` tool call for
  messages with `E2E-WRITE`, default text); add a rule for a new flow. It can report a per-call
  `usage.cost` (`fake.costUsd`) for the spend-cap flow. Flows before it run with **no provider** and
  check the "no key" states; `providerQolFlows` (slash commands, Ask mode, spend cap) run after it.
- **Forge Bridge**: the `forge-sync` flow plays the Studio plugin over HTTP against the app's bridge
  on `127.0.0.1:34877`. If that port is busy (another Forge running) those flows are reported as
  `skip`.
- **WebGL**: Chromium runs with SwiftShader (`--use-angle=swiftshader`) so the lab previews render
  under Xvfb.

## Output

`test/e2e-app/out/` (gitignored by the root `out/` rule):

- `summary.json` / `summary.md`: flow → pass / fail / skip, notes, collected errors
- `fail-<flow>.png`: screenshot when a flow fails; `shots/`: screenshots flows take on purpose
- `main.log`: the app's stdout/stderr; `fake-provider-requests.json`: what the fake model was asked

Each flow fails on its own assertions **and** on any renderer `console.error`, uncaught page error,
or main-process uncaught exception / unhandled rejection that happened while it ran (startup errors
land on the first flow, `launch`). Known Xvfb/Chromium noise is filtered in `lib/app.ts`
(`IGNORED_ERRORS`). A flow throws `SkipFlow` when the environment lacks something (node-pty not built,
no Lune) after checking that the app shows a clear message for it.

## Adding a flow

Flows live in `flows/*.ts` as `{ name, title, run(ctx) }` and are listed in run order in
`flows/index.ts`; they share one app instance, so later flows may use what earlier ones left (the open
VFX preset, the configured fake provider). Pages are table-driven: add a new activity-bar page to
`PAGES` in `flows/pages.ts` and it is opened, screenshotted and checked at 900px wide. Helpers for
common gestures are in `lib/ui.ts` (`openPage`, `showSide`, `canvasInk`, `horizontalOverflow`,
`closeBottom`, `setTheme`).
