# Headless Luau tests (Lune) — integration contract

Everything below is **new files only**. This document lists what the integrator wires into
`src/main/index.ts`, `src/shared/types.ts`, the preload, the renderer, the agent tools and packaging.

## Files

| Path | What |
|---|---|
| `resources/lune/runner.luau` | Entry point: `lune run <abs>/runner.luau -- [flags]`. Discovers/loads specs, prints JSON lines + a human summary, exits 0/1/2. |
| `resources/lune/forge/world.luau` | Roblox-like world: instance tree from a Rojo sourcemap, `require(Instance)`, services, globals. |
| `resources/lune/forge/testkit.luau` | `describe`/`it`/hooks, `.only`/`.skip`/`.todo`, per-test timeout, error/line parsing, `forge` helpers. |
| `resources/lune/forge/expect.luau` | `expect()` matchers (Jest-style + TestEZ chain aliases), `forge.fn()` mocks. |
| `resources/lune/forge/signal.luau` | RBXScriptSignal/Connection stand-ins. |
| `src/main/services/tests/types.ts` | Types (mirror the IPC ones into `@shared/types`, see below). |
| `src/main/services/tests/protocol.ts` | JSON-line parser (`parseEventLine`, `EventStream`, `ResultCollector`) and `formatCompact` for agents. |
| `src/main/services/tests/rojoTree.ts` | Rojo mapping → sourcemap JSON (`buildSourcemap`), `discoverSpecs`, `instancePathOf`. |
| `src/main/services/tests/lune.ts` | `findLune` (rokit bin first, via `tools.ts`), `luneStatus`, runtime dir lookup. |
| `src/main/services/tests/scaffold.ts` | `createSpec(root, modulePath)`. |
| `src/main/services/tests/service.ts` | `TestService`: run / cancel / timeout / watch / progress. |
| `src/main/services/tests/agentTools.ts` | `testTools(service)` → `run_tests`, `create_spec` (GentreeTool-shaped). |
| `src/main/services/tests/index.ts` | Barrel. |
| `test/lune.test.ts` | Unit tests (no lune needed): parser, discovery, watch impact, scaffold, compact output, lookup. |
| `test/lune.e2e.test.ts` | Real `lune` (via `$LUNE_PATH` or rokit/PATH); skips with a message otherwise. |
| `test/fixtures/lune-project/` | GenTree-shaped sample: modules + specs (shared, server Init/Start service, client controller, `tests/`). |

## Main process wiring (`src/main/index.ts`)

```ts
import { TestService, testTools } from './services/tests/index.ts'

const tests = new TestService({
  onProgress: (event) => emit('tests:progress', event),
  log: (text, stream = 'info') => logs.push({ service: 'tests', stream, text }), // if the log panel takes a new source
  lunePath: () => settings.get<string | null>('tests.lunePath', null)
})
// on project open / switch / close:
tests.setRoot(project?.root ?? null)
// optional: if (settings.get('tests.watch', false)) tests.startWatch()
// on quit: tests.stopWatch(); tests.cancel()
```

`setRoot` stops watch and cancels any run. A new `run()` cancels the one in flight (that one resolves
`state: 'cancelled'`). The temp sourcemap goes to `os.tmpdir()` and is deleted after each run.

### IPC (all `ipcMain.handle`)

| Channel | Args | Returns |
|---|---|---|
| `tests:status` | – | `LuneStatus` |
| `tests:discover` | – | `SpecFile[]` |
| `tests:run` | `RunRequest` | `RunSummary` |
| `tests:cancel` | – | `boolean` (true if a run was killed) |
| `tests:watch` | `on: boolean` | `boolean` (watching) — `on ? tests.startWatch() : tests.stopWatch()` |
| `tests:createSpec` | `modulePath: string` (repo-relative) | `CreateSpecResult` (throws `SpecError` with a user-facing message) |
| `tests:last` | – | `RunSummary \| null` |

Event: `tests:progress` → `TestProgress` (`start`, `file`, `test`, `log`, `end`). Watch-triggered runs
report through the same events (`end` carries the summary).

### Types to mirror into `src/shared/types.ts`

From `src/main/services/tests/types.ts`: `TestStatus`, `TestError`, `TestCaseResult`, `TestLog`,
`Realm`, `SpecFile`, `RunScope`, `RunRequest`, `RunState`, `RunSummary`, `LuneStatus`,
`TestProgress`, `CreateSpecResult`. (Or re-export them from there; the file has no runtime imports.)
Add `'tests'` to `HarnessEvents` (`tests:progress: TestProgress`) and to the log sources if the log
panel shows it.

### Preload / `HarnessApi`

```ts
tests: {
  status(): Promise<LuneStatus>
  discover(): Promise<SpecFile[]>
  run(request: RunRequest): Promise<RunSummary>
  cancel(): Promise<boolean>
  watch(on: boolean): Promise<boolean>
  createSpec(modulePath: string): Promise<CreateSpecResult>
  last(): Promise<RunSummary | null>
}
// + on('tests:progress', handler)
```
`renderer/src/mock.ts` needs the same members (it implements `HarnessApi`).

### Settings

- `tests.lunePath` (string | null): explicit lune binary; default is rokit bin / PATH lookup.
- `tests.watch` (boolean, default false): start watch mode on project open.

### Renderer (suggested)

A Tests panel: Lune status (when `available: false`, show `hint` — it says
`rokit add lune-org/lune` — with a copy button), Run all / Run file (current editor file: a module path
maps to its sibling spec) / Run test (gutter or list click → `{ kind: 'name', name: 'Suite > test', file }`),
Cancel, Watch toggle, and results grouped by file with failures expanded (message, `file:line` link to
the editor, stack, captured `print`/`warn` logs). "New spec" on a ModuleScript → `tests:createSpec`
then open the returned path.

## AI tools

`testTools(tests)` returns two GentreeTool-shaped objects (`name`, `description`, zod `inputSchema`,
`handler`). Pass them as `createGentreeServer(ctx, { extraTools: testTools(tests) })`, or add a
`tests()` accessor to `HarnessContext` and build them inside `gentreeTools`. For the
OpenAI-compatible loop they go through `toFunctionSpecs()` like the others.

| Tool | Input | Output (text) |
|---|---|---|
| `run_tests` | `{ file?: string, name?: string, timeoutMs?: number }` — none = all; `file` = a spec or the module it tests; `name` = `"Suite > test"` (exact) or a substring | `formatCompact(summary)`: one line `PASS 11 passed (4 files, 40 ms)` / `FAIL 2 failed, 9 passed, 1 skipped (…)`, then per failure `x <file>:<line> <Suite > test>: <first error line>` (+1 more line), max 8 failures then `… N more`. Passing tests are never listed. `isError` for no-lune / no-tests / error / timeout / cancelled. |
| `create_spec` | `{ path: string }` (repo path of a ModuleScript) | `created <spec path>` or `exists <spec path> (not overwritten)`, `requires <instance path>`, then the spec content. `isError` with the reason for scripts, specs, unmapped files. |

Policy:
- `run_tests` is read-only (it only reads files and runs Lune) — give it to every agent, including
  test agents.
- `create_spec` writes one new `*.spec.luau` next to a module and never overwrites. Recommended: allow it
  for test agents (do **not** add it to `WRITE_TOOLS`); if test agents must stay strictly read-only, add
  it to `WRITE_TOOLS` instead.
- System prompt line for test/QA agents:
  > Test logic headless first: call `run_tests` (and `create_spec` for untested modules) before any
  > Studio tool. Use Studio only for what needs the engine: physics, rendering/UI layout, replication
  > between real clients, DataStores/HTTP against live services, and playtesting.
- Only failures' first lines are returned to save tokens; the full `RunSummary` (stack, logs) stays in
  the app (`tests:last`).

## Packaging

`electron-builder.yml` must ship the Luau runtime outside the asar (lune reads it from disk):

```yaml
extraResources:
  - from: resources/lune
    to: lune
```

`findRuntimeDir()` looks in `process.resourcesPath/lune` (packaged), then the repo's `resources/lune`
(dev: from `out/main` and from `src/main/services/tests`), then `cwd/resources/lune`.
Lune itself is **not** bundled: like rojo it comes from rokit. The template could pin it in
`rokit.toml`: `lune = "lune-org/lune@0.11.0"` (the version these tests ran against).

## Spec conventions (for docs / prompts)

- Specs live next to code as `X.spec.luau` (Rojo maps it to a ModuleScript `X.spec`, so `script.Parent.X`
  is the module), or in a top-level `tests/` folder (not Rojo-mapped; Forge puts it under
  `game.ForgeTests`, require modules by full path there).
- Require by instance path, GenTree style:
  `require(game:GetService("ReplicatedStorage").Shared.Modules.X)` or `require(script.Parent.X)`.
  Relative string requires (`require("./X")`, `@self`) and `@lune/*` also work; other aliases do not.
- Globals in specs: `describe`, `it`/`test` (+ `.only`, `.skip`, `.todo`), `beforeAll`, `afterAll`,
  `beforeEach`, `afterEach`, `expect`, TestEZ aliases (`itSKIP`, `itFOCUS`, `describeSKIP`, …; a spec
  may also `return function() ... end` like TestEZ), and `forge`:
  `forge.fn(impl?)` mock, `forge.janitor()` (Janitor-shaped, `:Add`, `:Cleanup`),
  `forge.addPlayer(name?, userId?)` (fires `PlayerAdded`), `forge.removePlayer(p)`,
  `forge.step(dt?)` (fires Heartbeat/Stepped/RenderStepped once), `forge.realm`.
- Matchers: `toBe`, `toEqual` (deep, reports the differing path), `toBeNil`, `toBeTruthy`, `toBeFalsy`,
  `toThrow(substring?)`, `toContain`, `toMatch(pattern)`, `toHaveLength`, `toBeCloseTo`,
  `toBeGreaterThan(OrEqual)`, `toBeLessThan(OrEqual)`, `toBeA(typeName)`, `toHaveBeenCalled`,
  `toHaveBeenCalledTimes`, `toHaveBeenCalledWith`; negate with `.never`. Call with `:` or `.`.
  TestEZ chains: `expect(x).to.equal(y)`, `.to.be.ok()`, `.to.never.throw()`, `.to.be.near(n, eps)`.
- Realm: client for specs under StarterPlayer/StarterGui/ReplicatedFirst/StarterPack (or a
  `--!forge realm=client` line at the top), else server. Client realm has `Players.LocalPlayer`
  (`Player1`, UserId 1).
- Each spec file gets a fresh world and module cache. Tests in a file share module state; reset it in
  `afterEach`.

### What the world provides

Instances are Luau tables shaped like Roblox's (Name/Parent/children, `FindFirstChild`, `WaitForChild`
(5 s cap → error), `GetChildren/Descendants`, `IsA` via Lune's reflection database, attributes, tags,
`Changed`/`GetPropertyChangedSignal`, `Clone`, `Destroy`). Unknown members error like Roblox; real
properties return their reflection-database default. Datatypes (`Vector3`, `CFrame`, `Color3`, `UDim2`,
`Enum`, `BrickColor`, …) are Lune's real `@lune/roblox` ones; `TweenInfo`, `Random`, `DateTime`,
`RaycastParams`, `OverlapParams` are small Luau stand-ins. Services: Players, RunService, Workspace,
ReplicatedStorage, TweenService (goals applied on Play), HttpService (JSON, GUID; HTTP calls error),
CollectionService, DataStoreService (in-memory per file), UserInputService, ContextActionService,
StarterGui, Debris, PhysicsService, MarketplaceService, BadgeService, TeleportService, TextService,
MessagingService (loopback); Bindable/Remote events and functions loop back in-process.
`task` is Lune's (`@lune/task`) plus no-op `synchronize`/`desynchronize`; `wait`/`spawn`/`delay`/`tick`/
`time` exist. `print`/`warn` are captured per test.

Not available (test in Studio): physics/raycasts (return nil/empty), rendering and GUI layout,
animations beyond stubs, real replication, MemoryStore, HTTP, `.rbxm`/`.model.json` contents, string
requires through `.luaurc` aliases.

## Runner protocol (stdout, `--format json`)

One JSON object per line, each with `"forge": 1` and `"type"`:

```
{"type":"start","files":[...],"filter":"name?"}
{"type":"file","file":"src/…/X.spec.luau","realm":"server","instancePath":[...]}
{"type":"test","file":…,"suite":"A > B","test":"name","status":"pass|fail|skip|todo","ms":1.2,"error":{"message":"…","line":12,"stack":"…"}}
{"type":"log","file":…,"test":"A > B > name","level":"print|warn","text":"…"}
{"type":"fileEnd","file":…,"passed":n,"failed":n,"skipped":n,"ms":n}
{"type":"end","passed":n,"failed":n,"skipped":n,"files":n,"ms":n}
{"type":"fatal","message":"…"}            // e.g. no sourcemap; exit code 2
```

A spec that fails to load reports one failing test named `(load)`. Lines that are not events are kept as
`output` logs. Flags: `--sourcemap <file>` (default `sourcemap.json`), `--spec <file>` (repeatable),
`--name <filter>`, `--timeout <ms per test>`, `--realm server|client`, `--format json|human|both`
(default both), `--root <dir>`.
