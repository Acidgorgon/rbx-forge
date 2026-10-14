# RBX Forge

![RBX Forge: the editor with the Roblox explorer, luau-lsp and the assistant](docs/screenshots/20-editor-dark.png)

RBX Forge is a desktop workbench for Roblox games built on the GenTree template (MyTemplate-Legacy). Point it at a game folder, or have it create one, and it installs the toolchain, runs the dev loop, Rojo, luau-lsp and Studio sync for you. It shows the game the way Studio does, as a DataModel explorer, next to a code editor with full Luau intellisense, a terminal, Lune tests, Wally packages, Blink events, git sync for your team, releases and analytics. The AI assistant works on the same project with the same tools. It can use Claude, OpenAI, Gemini, OpenRouter, Ollama or any OpenAI-compatible model, pull other models into a group chat, split big jobs across a team of agents, remember how you work, and generate game art that it uploads to Roblox.

- [Feature tour](#feature-tour)
- [Install](#install)
- [Build it yourself](#build-it-yourself)
- [Settings](#settings)
- [Layout](#layout)

## Feature tour

### Editor with luau-lsp intellisense

Monaco with Luau and Blink highlighting, driven by luau-lsp: diagnostics, completion, hover, signature help and go to definition. It uses the Roblox type definitions and API docs, which are downloaded once and cached. The bottom panel has Output (filterable by service), Problems, the Dev and Rojo logs and the terminal. When a script also changed in Studio, a banner offers **Compare**. Ctrl/Cmd+K opens the command palette, which searches scripts, instances and commands.

The editor is in the screenshot at the top of this page.

### Explorer, scripts and Studio two-way sync

![Explorer context menu with New, Copy Roblox path and Copy require](docs/screenshots/21-explorer-menu-dark.png)

- **Explorer.** The DataModel tree from the Rojo project and `sourcemap.json`, merged with a live snapshot from the Studio plugin. Models, sounds and GUIs that exist only in Studio show up too, marked *Studio*. The **Files** and **Features** tabs show the same project by folder and by GenTree feature.
- **Create from the tree.** Right-click > **New** adds a ModuleScript, Script or LocalScript, a folder, a whole GenTree feature (shared module + server service + client controller) or a Blink event.
- **Copy paths.** **Copy Roblox path** (`game.ReplicatedStorage.Shared.Features.Inventory`), **Copy as GetService**, slash path, **Copy require(…)** and **Copy file path**.
- **Scripts.** Every script grouped as Configs, Data, Services, Controllers, Modules, Events, UI and Entry points, with realm and feature tags.

![Source control with Studio conflicts, incoming changes and the pre-sync check](docs/screenshots/25-sync-dark.png)

- **Studio sync, both ways.** Rojo pushes files into Studio. Edits made in Studio (including Team Create) come back into the repo through [Forge Sync](#forge-sync-studio-first-then-rojo), or the project's own `tools/studio-sync.py` when you pick it in Settings > Sync. When a file changed in both places it is held under `.studio-sync/conflicts` and opens as a side-by-side diff where you pick the Studio or the repo version.
- **Collaborator sync.** Source control shows ahead/behind, incoming commits grouped by feature (with overlap warnings against your local changes), and a selene + StyLua pre-sync check. **Sync now** (or every N minutes) commits your work, pulls with rebase, falls back to a merge on conflict and pushes. It never force-pushes.

### Multi-place projects

Every `*.project.json` at the project root is a place. The place switcher in the title bar (and in the palette) changes which place Rojo serves, which sourcemap the explorer and luau-lsp read, and which place releases go to. **Serve all places** runs a `rojo serve` for each place on its own `servePort`.

### Forge Sync: Studio first, then Rojo

![Forge Sync holding a place: a teammate's Studio edit and yours, side by side, with Take disk / Take Studio](docs/screenshots/140-forge-sync-conflict-dark.png)

When a teammate edits scripts in Studio (Team Create) and you then connect Rojo, Rojo pushes your disk copy over their work. Forge Sync stops that, for every place and any Rojo project:

1. **Studio goes first.** When a place opens in Studio, the Forge Bridge plugin sends Forge everything under that place's mapped folders. Rojo serve for that place waits ("Waiting for Studio sync check").
2. **Forge reconciles three ways.** For each file it compares Studio, disk and the last version both agreed on. A teammate's change is written to disk; yours is left for Rojo to push; changes on both sides are merged line by line when they don't overlap. New folders made in Studio (a new move under `Moves/`), renames, deletes (moved to `.forge/sync/trash`, never removed) and non-script instances (an `Animations` folder becomes `.model.json`) come along too.
3. **Then Rojo serves.** If both sides changed the same lines, the place is held: open the conflict, compare **disk ⇄ studio**, **base → disk** or **base → studio**, and pick **Take Studio** or **Take disk** (or **Serve anyway**). A new Studio session for a place Rojo already serves stops that serve, re-checks, and restarts it.

![First sync for a place: Studio wins or Disk wins for every file, then commit the teammate edits](docs/screenshots/142-forge-sync-first-run-light.png)

- **First run.** With no shared version yet, a place whose Studio and disk differ asks once: **Studio wins** or **Disk wins**.
- **Commit teammate edits (N).** Files Forge wrote from Studio are committed on their own, as `Studio edits: Uppercut.luau, NewMove…`, and nothing else you changed is staged. Before a pull or a new feature branch, Forge commits them first (with *Commit local work before pulling* on) or warns you.
- **Old plugin.** If the project's `StudioSyncPlugin` (`FSFStudioSync.lua`, `RepoStudioSync.lua`) is still in Studio's Plugins folder, Source control offers **Disable it** (renamed to `*.disabled`). With Forge Sync on, `./dev` runs with `FORGE_SYNC=1` so the project's `studio-sync.py` stays off.
- **Settings > Sync.** *Studio sync*: **Forge (recommended)**, **Project script** (the old `tools/studio-sync.py` path) or **Off**; *Check Studio before Rojo serves* turns the gate off.

![Settings > Sync with the Studio sync engine and the Rojo gate](docs/screenshots/143-forge-sync-settings-dark.png)

### Services that run themselves

When you open a project, Forge starts the template's `./dev` loop (feature watcher, Blink, sourcemap, Wally, Studio sync), `rojo serve` and luau-lsp. A crashed process restarts with backoff. The status bar and the Forge home page show each service, with Restart and Logs.

- Forge does not run `./dev` inside the template repo itself, because `./dev` disconnects the template's git there. Add `.keep-git` (or set `allowTemplateDisconnect`) if you really want that.

### Terminal

![Integrated terminal with Lune test output and an assistant command waiting for approval](docs/screenshots/40-terminal-dark.png)

A real terminal (xterm.js on node-pty) in the bottom panel, opened in the project folder with the Roblox tools on its PATH. It has tabs, a shell picker, find in the scrollback, and one-click tasks for the project's commands. File paths in the output are links that open in the editor. When the assistant wants to run a command (`wally install` above), it asks first, and the command runs in your terminal only after you click **Run**.

### New project and automatic toolchain

![New project dialog creating a game from the GenTree template](docs/screenshots/41-new-project-progress-dark.png)

- **Toolchain setup.** Forge ships rokit. On first launch it installs rokit and the pinned tools into `~/.rokit/bin` for your user only, with no admin rights: **rojo, wally, blink, lune, luau-lsp, selene, stylua** and wally-package-types. Each project still uses the versions pinned in its own `rokit.toml`. Forge runs `rokit install` for a project whose known tools are missing. Re-run it from **Settings > Toolchain**.
- **New project.** Fetches the GenTree template (or makes an empty Rojo project), removes the template's history, names the project, runs `git init` and the first commit with your team's remote, then installs tools and packages and compiles the Blink events.
- **Join project.** Clones a teammate's game and runs `rokit install` and `wally install`.

### AI assistant: providers, effort and images

![Assistant answering a question about an attached screenshot, with effort and routing](docs/screenshots/42-dark-image.png)

The assistant panel is a chat with project tools: overview, list/read/edit/write scripts, explorer tree, find instance, new feature, Blink events, Wally packages, tests, terminal commands, service logs and restarts, collaborator sync and Studio conflicts. Writes are limited to the Rojo folders under `src/` and `events.blink`. `Packages/` is off limits. Type `@` to attach files and `/` for commands.

- **Providers.** Pick a provider and model per chat.
  - **Anthropic** (Claude Opus, Sonnet and Haiku 5.5) runs through the Claude Agent SDK. It is the only provider with the Roblox Studio MCP tools.
  - **OpenAI**, **OpenRouter**, **Google Gemini** (its OpenAI-compatible endpoint), **Ollama** (local, `http://localhost:11434/v1`, no key) and **Custom** (any OpenAI-compatible base URL) run through Forge's own agent loop, with the same tools and write rules.
- **Model routing and effort.** Unless you pin a model for the chat, a router sends quick questions to a small model and big jobs to a large one (the budget bar shows the choice, such as `auto → haiku · low`). The effort menu sets reasoning effort per chat: Auto, Low, Medium, High, X-High or Max. Each level is clamped to what the model supports. A budget bar shows tokens and cost for the chat.
- **Images.** Paste, drop or attach screenshots and concept art. Models with vision see them, and Forge tells you when the chosen model can't.
- **Keys.** Settings has a card per provider. A pasted key is encrypted with the OS keychain (Electron safeStorage) and never sent to the window. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY` and `OLLAMA_API_KEY` are used when nothing is stored. Model lists come from each provider's `GET /models`, and you can type any model id.
- **Claude Code login.** An Anthropic API key is Anthropic's documented way to authenticate apps built on the Agent SDK, and it is the default. *Use my Claude Code login (personal use only)* in Settings lets Forge fall back to the Claude Code login on this machine (or `CLAUDE_CODE_OAUTH_TOKEN`) when no key is set. That is for your own personal use and draws from your Claude Pro/Max plan limits. It is off by default.

### Chat modes and commands

![Plan mode: the agent investigates read-only and proposes a plan to approve](docs/screenshots/181-plan-card-dark.png)

The pill under the message box sets how the assistant works in this chat. **Shift+Tab** cycles it, and the chat remembers its mode. Each of your messages shows the mode it was sent in.

| Mode | What the agent may do |
| --- | --- |
| **Ask** | Read and search only. Every tool that writes or runs something (file edits, `new_feature`, Blink and Wally edits, sync, `run_in_terminal`, Studio tools, Bash) is removed. |
| **Plan** | Investigates read-only, then shows a plan card with steps, files and risks. *Approve & run* switches the chat to the edit mode you pick and runs the plan. *Edit plan* lets you change it first, and *Keep planning* closes the card so you can push back. On Claude this is the Agent SDK's `plan` permission mode. Other providers get the same read-only tool set and a plan prompt. |
| **Edit with approval** (default) | Every file edit shows a diff card. *Accept* or *Reject* it, or untick hunks and accept the rest; Forge applies only the hunks you kept. Other write tools show what they will run and wait the same way. |
| **Auto-accept edits** | Edits inside the project apply without asking (the SDK's `acceptEdits`). `Packages/` and paths outside the project stay blocked. |

Ask and Plan are enforced three ways on Claude: the write tools are left out of the tool list, `disallowedTools` names them, and a `PreToolUse` hook denies anything that is not a read tool. Other providers only get the read tools. A tool Forge doesn't know counts as a write. The team (orchestrator) only runs in Auto-accept, or when the routing pill is set to *team*.

![Slash commands with descriptions](docs/screenshots/184-slash-typeahead-dark.png)

Type `/` for the commands (Claude Code's set):

- `/ask <question>`, `/plan <request>`: send one message in that mode.
- `/clear` starts the conversation over in the same chat. `/compact [focus]` summarizes it on the cheap tier and carries on from the summary, showing the tokens saved.
- `/model [provider/model]`, `/effort [level]`: switch for this chat. With no argument, `/model` opens a picker.
- `/cost`: tokens and cost for this chat, today's total, and the Labs' cost per kept result from lab gating. `/context` shows what fills the context window (system prompt, rules and memory, tools, conversation).
- `/memory` opens Memory. `/memory <note>` saves a project note.
- `/init` reads the project and writes notes to `.forge/AGENTS.md`, which every agent then reads after the root `AGENTS.md`. If the file already exists, `/init` merges: your lines stay as they are and only new bullets and sections are added. The root `AGENTS.md` is never written.
- `/review [focus]` reviews the uncommitted git diff in Ask mode.
- `/resume` picks a past chat. `/export` saves the chat as markdown in `.forge/exports/`.
- `/rewind` restores files, the conversation, or both to before a turn. Before each turn in Edit or Auto mode, Forge snapshots the project into a separate git repository at `.forge/checkpoints/shadow.git`, with the project as its work tree. Your own `.git`, branches, index and history are never touched, and ignored files such as `Packages/` are left alone. A rewind takes a snapshot first, so you can undo it.
- `/todos` shows the agent's task list. `/permissions` shows which tools run, ask or are blocked in the current mode. `/help` lists everything, including your own commands.

**Custom commands** are markdown files: `.forge/commands/*.md` in the project (shared with the team) or the `commands` folder in Forge's user data folder (just you). The file name is the command (`econ/balance.md` becomes `/econ:balance`). `$ARGUMENTS` is replaced by what you type after the command and `$1`…`$9` by single words. Optional frontmatter: `description`, `argument-hint` and `mode` (`ask`, `plan`, `edit` or `auto`). A Claude Code `allowed-tools` line that lists no write tool runs the command in Ask mode.

```markdown
---
description: Check a feature's economy numbers
argument-hint: <feature>
mode: ask
---
Review prices, rewards and drop rates in the $ARGUMENTS feature. Flag anything that breaks progression.
```

### Restate first

![The assistant restates a big request as goal, problem and assumptions, then waits](docs/screenshots/100-restate-chat-card-dark.png)

Before a big task, Forge says back what it thinks you want and waits. The card has three parts: the **goal** (one or two lines), the **problem** it solves, and up to three **assumptions**. *Yes, go* starts the work. *Edit* turns the card into fields you can fix, and *Send back* starts the work with your version. The agent gets the reading you approved together with your message, and the card stays in the chat history.

- **When.** A quick check in code decides, with no model call. It looks at length, how many actions and files the request names, listed steps, open-ended words ("rework", "make it better") and the chat's effort level. Short questions and small fixes skip the card. *Settings → Chat → Restate goals before big tasks* can be *Always*, *Big tasks* (the default) or *Never*. Type `/restate <request>` to get the card for any one message.
- **Labs.** The VFX Lab (sequences), Animation Lab and Ability Composer show the same card for a brief before they compose: "What I think you want", "The problem" and "Assumptions". The confirmed version goes into the compose prompt and is saved with the entry (shown under *confirmed brief* in the info tab), and the critic scores against it later. It has its own setting under *Settings → Labs*. A one-word brief like "fireball" skips the card.
- **Learning.** A plain yes or a small wording fix saves nothing extra. If an edit changes the meaning, Forge keeps the correction and writes one short memory note (`restate-corrections-chat` or `restate-corrections-labs`) through the memory system. Later restatements then match the way you describe goals.
- **Cost.** Each restatement is one call on the Labs *cheap* tier. If that call fails, the request just runs as usual.

### Group chats with other models

![Group chat: Claude hosts, GPT and Gemini advise, and the host writes a plan](docs/screenshots/42-dark-group-room.png)

Invite other models into a chat. The host model has the project tools and is the only one that edits files. Guests are read-only advisers, and you choose whether they may read project files. `@sol what do you think?` asks one guest directly. "Talk to Sol about…" lets the host consult a guest. A **roundtable** has the models take turns on a topic for 1 to 4 rounds, then the host writes a plan card (agreements, disagreements, recommendation) that becomes a task list in one click. Guests get a compact context pack instead of the whole history, and the usage panel shows tokens per model.

#### Consults, second opinions and the Board

![Conclusion card: Opus and Sol agreed after 2 of 3 exchanges, with what each model checked](docs/screenshots/170-group-conclusion-dark.png)

Say "ask gpt 6.1 sol how to fix the shop race, come up with a conclusion and report back", "check with gemini …" or "get a second opinion from opus". The guest answers first, then the host and the guest take turns, each ending with a stance (agree, partly, disagree), until they agree or reach the turn cap (3 exchanges by default). The host then posts a **Conclusion card**: the answer, what they agreed on, where they disagreed and who said what, a confidence level, and what each model actually checked (taken from its tool calls, not from what it says). The host can also start a consult itself with `consult_until_agreed`.

- **Model names**: "gpt 6.1 sol", "sol", "opus" and "gemini" all work. A bare family name picks its flagship (Gemini 3.1 Pro, Claude Opus). If a model's provider is not set up, Forge says so and links to **Settings → Providers** instead of failing silently.
- **Read-only guests**: when *Guests can read project files* is on, guests can search code, read files, list scripts and instances, read lint diagnostics (selene) and see the git diff. They use the host's own read tools with the same caps. They never get a write tool. A guest can propose a change as a unified diff, which shows up as a **patch card**: *Apply* writes it through the host's write path (all files or none), and *Ask host to merge* has the host adapt it in its own turn.
- **Cross-check edits** (off by default): after the host edits 2 or more files, a model from another provider reviews the diff. A compact review card lists the findings, and the host has to address any blocking ones in a follow-up turn.
- **Board**: each group chat has a Board with decisions, open questions and conclusions. Conclusion and plan cards fill it automatically, and you can edit it. Guests get the Board in their context pack instead of long history.
- **Limits**: each consult has a token cap and a cost cap (120k tokens and $0.75 by default). When the consult reaches a cap, the host concludes with what it has. Guest calls are counted in the chat's usage meter, and the usage panel shows tokens and cost per model. Big consults get the restate-first card, following its setting.

### Multi-agent orchestration

In team mode, large multi-part requests go to an orchestrator instead of a single agent. Shift+Tab in the message box cycles the mode: *auto routing* (Forge decides when a request is big enough to split), *single agent* or *team*. A **lead** model plans the work as a task graph. Specialists run in parallel: **scouts** read, **builders** edit, **testers** write and run Lune specs, and **reviewers** check the diff. Each writer claims its files first, so two agents never edit the same file at once. Shared files such as `events.blink`, `wally.toml` and `default.project.json` go through the lead. Per-task and per-run token and cost caps, plus timeouts, stop a run that runs away. The lead then integrates the results and answers.

### Memory and skills

![Memory page with user and project memories, skills, and learning settings](docs/screenshots/44-memory-page-dark.png)

Forge's agents keep memories about you (user) and about the game (project, stored in `.forge/memory` so the team shares them), plus **skills**, which are step-by-step recipes such as "add a GenTree feature". Prompts only carry names and one-line descriptions. Agents load the rest with `recall` and `use_skill`. After a chat, a background review can propose new memories as a card you save, edit or dismiss (*Ask*), save them itself (*Auto*), or do nothing (*Off*). **Learn code style** builds a Luau style profile of the project locally, with no model call. You can edit, pin, delete, or promote any memory to the project from the Memory page.

### Art: OpenAI images to Roblox assets

![Art page: prompt, style presets, gallery and a generated asset's details](docs/screenshots/43-art-detail-dark.png)

Generate UI art, icons, key art and thumbnails with OpenAI's image models (`gpt-image-2.5-flare` by default). You get style presets, sizes, quality, 1 to 4 variants, transparent backgrounds and reference images to edit or riff on. Every generation shows its cost up front, and a daily budget (default $5) stops overspending. Concepts are saved under `art/` in the project. **Roblox import** uploads an image as an Image or Decal asset through the Open Cloud Assets API and returns its asset id. **Ask the agent** hands the image to the assistant, and the assistant can generate art with the same tools.

### Studio check for the labs

![VFX Lab Studio tab: Studio frames next to the preview at each beat](docs/screenshots/90-studio-check-vfx-dark.png)

The VFX Lab, Animation Lab and Ability Composer can play the current item in your own Roblox Studio and capture it at the key beats. **Studio check** (next to Refine or Critique) and the **Studio** tab show each Studio frame next to the preview frame for the same beat, plus how far each stage drifted in Studio. With **critique in Studio when connected** on, refine loops and the ability critique judge the Studio frames, and use the preview when Studio is not connected. The captures are saved with the library entry under `studio/`. The assistant has a `studio_check(kind, id)` tool, which needs Studio.

- **Setup.** Click **Install plugin** to copy the Forge Bridge plugin into Studio's plugins folder (`%LOCALAPPDATA%\Roblox\Plugins` on Windows, `~/Documents/Roblox/Plugins` on macOS), then restart Studio. When Studio asks, allow HTTP requests to `127.0.0.1` and script injection; you can change both later under Plugin Management. Rojo is not needed, because each job carries its own modules.
- **During a check.** The plugin builds a temporary stage far from your place (a dummy rig, a floor, a backdrop and a fixed camera), plays the item and removes the stage afterwards. Keep the Studio window visible and not minimised, because Forge records that window. On macOS, allow Screen Recording for Forge.
- **Status.** The tab tells you when the plugin is missing or outdated, when Studio is not connected, when no Studio window can be recorded, and when a job times out.

### VFX textures

![VFX Lab textures: procedural generator and texture library](docs/screenshots/110-vfx-textures-library-dark.png)

The VFX Lab's **textures** tab makes particle, beam and trail textures. **Procedural** shapes are free and deterministic: glow, ring, spark, smoke, crack, star and slash, each with sliders and a seed. **AI** textures use the Art workflow with the same key, models, pricing and daily budget, plus per-type prompts. AI output is cleaned up: the alpha is fixed, the shape is centred, a radial falloff stops hard edges, and the image is resized to a power-of-two square. Textures are white, or greyscale for smoke, so `Color` tints them. One texture works for every palette.

- **Flipbooks**: 2×2, 4×4 and 8×8 sheets up to 1024 px, with spacing between frames and a size that is an exact multiple of the grid. Picking one sets `FlipbookLayout` and `FlipbookMode`, and the preview simulates the frames (Loop, OneShot, PingPong, Random; framerate capped at 30). [ParticleEmitter](https://create.roblox.com/docs/reference/engine/classes/ParticleEmitter), [ParticleFlipbookLayout](https://create.roblox.com/docs/reference/engine/enums/ParticleFlipbookLayout), [particle emitters guide](https://create.roblox.com/docs/effects/particle-emitters).
- **Library**: each texture is stored at user scope (`<userData>/vfx/textures`, included in .forgepack and sync) or project scope (`.forge/vfx/textures`). You can rate, tag and search it. The Texture field in the params editor has a picker.
- **References**: an effect points at `forgetex://<id>` and the preview uses the local file right away. When the project is written, each reference becomes `rbxassetid://` if the texture has been uploaded. If it has not, a built-in texture stands in, and the log says so.
- **Upload**: textures go up as an **Image** asset (PNG) through Open Cloud. An Image id works directly in `Texture`. A Decal id points at a wrapper that Studio has to convert to its image id. See the [Assets API](https://create.roblox.com/docs/cloud/guides/usage-assets) and [asset ids](https://create.roblox.com/docs/projects/assets). **Check** reads the moderation state (`Reviewing`, `Approved`, `Rejected`).
- **Agents**: `vfx_texture_generate` and `vfx_texture_list` are available, and compose and draft know the free `forgetex://gen/...` shapes. The critic can suggest a better texture. Thumbs up or down are saved to memory, so liked styles come back in later prompts.

### Video references: "make it like this"

![VFX Lab: a reference clip's key frames next to the rendered result with a match score](docs/screenshots/104-vfx-make-like-this-compare-dark.png)

Drop an mp4, webm, mov or GIF on the VFX Lab or Animation Lab (or click **Video ref**), trim it to the part that matters, drag to crop, and press **Analyse**. Forge decodes small frames in the app itself (no ffmpeg) and measures the beats from motion energy (anticipation, release, impact, dissipate), flashes, the palette of each beat, glow, and the size and direction of motion. The Animation Lab also gets a holds vs fast-motion lane. The reference is saved in the library with a contact sheet and key frames, and the vision model (critic tier) describes it in the background. Poses come from that description; Forge does no pose estimation. **Make it like this**, or pinning a reference to Make, passes its beats, palette, description and key frames to compose. The critic then scores how well the render matches the reference, and the iterations tab shows the two side by side. A rated reference feeds learned styles only through its timing and palette. The assistant can use `ref_import` (from a path), `ref_get` and `ref_list`.

### Thumbnail Lab

![Thumbnail Lab: four variations with scores, the discovery preview and the critique panel](docs/screenshots/161-thumbs-critique-dark.png)

Make experience thumbnails with OpenAI's image models in a style you like, built from shots of your own game. It reuses the Art page's OpenAI key (kept in the OS keychain), pricing and daily budget.

- **References teach style only.** Drop, paste or pick thumbnails you like, or add an image URL (it is downloaded and kept locally). Each reference gets code-measured stats (palette, saturation, contrast, colourfulness, edge density, centre focus) and a vision **style card**: framing, palette, saturation, outline, rim light, glow, text (word count, size, placement), emotion, focal contrast and clutter. The card never records characters, logos or the text itself. Select several references to make a named **style profile**. Profiles are stored at user scope and included in .forgepack files and Brain Sync; project scope is also available.
- **Bases from the real game.** Pick project screenshots, or use **Capture Studio** to grab the Studio viewport through the Forge Bridge plugin (the plugin crops the viewport and leaves your camera alone; with an older plugin Forge grabs the whole Studio window instead). Roblox requires that "graphics shown must be representative of the actual in-game visuals" and that thumbnails show no mechanics or UI the game does not have ([Creator Hub: Thumbnails](https://create.roblox.com/docs/production/promotion/thumbnails)). For that reason the game shots are what gets edited. The prompt is built from the style fields only, with names of the reference games stripped out, and it tells the model never to copy characters, logos or text. The critic also runs a **copy guard**: a flagged variation has its honesty score capped and is never picked as best.
- **Generate.** "Make a thumbnail of ___" restates the brief first, shows the cost (n × price, today's spend against the cap), then makes all N variations (default 4, up to 10) in **one** call. With game shots it calls `/v1/images/edits` with the shots plus up to two style references (the edit endpoint takes up to 16 images); without shots it calls `/v1/images/generations`. Both take `n` from 1 to 10. The gpt-image-2 family takes custom sizes whose sides are multiples of 16, so Forge asks for 1920×1088 and crops to 1920×1080 (16:9). Other models get 1536×1024 and a cover crop. Models are a setting: `gpt-image-2.5-sunburst` by default and `gpt-image-1-mini` as the cheap option. See the Images API reference for [generate](https://developers.openai.com/api/reference/resources/images/methods/generate) and [edit](https://developers.openai.com/api/reference/resources/images/methods/edit).
- **Critique.** Each variation is scored against the `thumb` principles: readable at small size, one focal point, contrast and separation, three words of text or fewer, faces and emotion, colour pop on the discovery page, honest to the game, and nothing essential along the bottom edge. Code renders every variation at 256×144 and 160×90 and measures legibility, focal strength, detail kept, the visual weight in the bottom strip, and how far the colours stand out from Roblox's dark and light page backgrounds. The critic (critic tier) sees the variation next to the game shots. The best of N is ranked by the critique, your learned taste, and copy flags. **Refine** edits a variation with the critic's changes and your note.
- **Discovery preview.** A strip shows every variation at its real pixel size on a dark or light page, so you can see what survives at phone size.
- **Taste and CTR.** +1 or −1 and **would ship** teach which image stats you prefer. After a thumbnail has run on Roblox, type in impressions and clicks from Creator Hub analytics. CTR is a stronger label than ratings: once a thumbnail has at least 200 impressions and there are at least two thumbnails to compare, the ones whose CTR interval sits clearly above or below the median count up to 4× a rating. The learned taste goes into a `thumbnail-taste` memory skill and the principle priorities.
- **Roblox.** **Upload to Roblox** creates an **Image** asset through the Open Cloud Assets API. **Add to experience…** adds the image to the live experience's thumbnails through the **experimental** Open Cloud endpoint `POST /legacy-game-internationalization/v1/game-thumbnails/games/{universeId}/language-codes/{languageCode}/image` (API key scope `legacy-universe:manage`), and only after you confirm it with the universe id ([reference](https://create.roblox.com/docs/cloud/reference/features/localization)). Order the thumbnails in Creator Hub.

![Thumbnail Lab references board: style cards with framing, palette, outline and text](docs/screenshots/162-thumbs-references-light.png)

### Animation and VFX principles

![VFX Lab iterations: per-principle scorecard with the focus the next round fixes first](docs/screenshots/120-vfx-principle-scorecard-dark.png)

The VFX Lab, Animation Lab and Ability Composer score their work against named principles (`src/shared/principles`). The animation set covers the 12 principles adapted for Roblox rigs plus responsiveness, readability, weight and impact, and loopability. The VFX set covers shape, timing, value and contrast, hue shifting, layering, readability, anticipation, break-up, dissipation, cohesion with the animation, and the performance budget. Each principle has a one-line rule, a note on how it applies in Roblox, good and bad examples, and a flag saying whether code can measure it.

- **Plan.** Compose asks the writer for a short plan covering the few principles that matter for the request type (attack, idle, burst, aura and so on). The plan stays under about 170 tokens.
- **Score.** The critic gives each relevant principle a score from 0 to 10, with a note and a fix. Code measures the principles it can: arcs, slow in and out, overshoot and settle, anticipation against the action, timing variety, and loop seams for animation; value contrast from the simulation, layer roles, dissipation, shape break-up, timing, and the `analyze.ts` performance budget for VFX. When both the critic and code score a principle, the two are averaged. The weighted principle score makes up half of the overall score.
- **Refine.** The lowest-scoring principles, weighted by your priorities, become the focus. The next critique sees the focus first, and changes tagged with a focus principle are applied first. Each iteration shows a compact scorecard. A row marked `›` is in the focus. `c`, `m` and `c+m` show whether the critic, the code or both scored that row. Click a row to see the note and the fix.
- **Your priorities.** Thumbs up and down, and the notes you write, teach a weight for each principle. A thumbs down on a result whose weak point was arcs raises the arcs weight. A thumbs up despite weak readability lowers that weight. Notes that name a principle ("floaty", "pops off") push it up. Weights range from ×0.4 to ×2.5. They are stored under `<userData>/principles`, included in .forgepack files and device sync, and summarised in memory. The **priorities** tab of each lab shows them and has a Reset button.
- **References.** Video references list which principles they show and how, using the vision model's notes where it gave them and measured beats, flashes, palette and motion otherwise. Compose and the critic receive that list.

### Saving tokens

![Settings > Labs: decision gates, decision models and the cost per kept result](docs/screenshots/98-labs-gating-settings-dark.png)

The VFX Lab, Animation Lab and Ability Composer decide cheap things in code, so the big model only gets the calls that matter (`src/shared/gating`, `src/main/services/gating`).

- **Gates.** Before a vision critique, Forge compares the rendered frames with the previous round. Each frame becomes a 32×24 greyscale thumbnail and a 64-bit difference hash. When nothing visible changed, the critic is skipped and the previous scores carry over. After a critique, refining stops when the score has stopped moving for two rounds or got worse twice in a row. When a composed script or JSON answer fails, code decides what happens next, with typed reasons: repair with the error, ask again with the format spelled out, or give up and use the built-in draft. A timeout or a missing Lune is never repaired, and there are at most two extra calls.
- **Shadow mode.** Settings > Labs > **Decision gates** can be Off, Shadow or On. Shadow is the default for this release: the gates decide and log, but the labs behave exactly as before. Learned principle weights follow the same switch. In shadow mode, each rating logs the weight change it would make, and the critics keep neutral weights until you switch to On.
- **Decisions.** Every gate decision is logged with the gate, a summary of its inputs, the outcome, whether it acted, and an estimate of the tokens it saved. Shadow decisions show what they would have saved. The **Decisions** list appears under a lab entry (iterations tab, or critique tab in the Ability Composer), and the latest decisions also appear in Settings > Labs.
- **Decision models.** Small logistic-regression classifiers in plain TypeScript (`src/shared/decide`) learn from the gate log on your computer. Nothing is downloaded, the models are free to run, and training takes milliseconds. There are three: "is this critique worth running", "will another round help" and "will a repair work". Their inputs are numbers the gates already compute (frame difference, score gains, rounds without progress, iteration, error type) plus keyword counts from the critique summary and the error message. Labels come from what Forge sees afterwards: whether the critique moved the score by 0.25 or more, whether the next round improved, and whether the repair recorded. A model only replaces the code heuristic when it has at least 50 labelled examples and beats the heuristic on held-out examples. The settings show "learning (n/50)" or "active, 87% vs heuristic 79%", and **Retrain** retrains on demand (Forge also retrains every 10 new labels). **Decision models** can be Off, Shadow (the default: predict and log) or On.
- **Cost per kept.** Each compose, refine or critique run records the tokens and cost of its model calls per Labs tier. Rating a result up, exporting it or testing it in Studio counts it as kept. The cost line under each lab's Make bar and the table in Settings > Labs show what the lab spent divided by the results you kept, overall and per tier. Everything is stored as small JSON files under `<userData>/labs-gating`.

### Lune tests and test agents

![Tests panel with Lune specs, Run all and Watch, and test agent scenarios](docs/screenshots/26-tests-dark.png)

- **Lune tests.** `*.spec.luau` files run headless under Lune, against a bundled Roblox-like world built from the Rojo tree (`require` of instances, services, signals). The runner supports `describe`/`it`, Jest-style `expect` and mocks. Run everything, one spec or a name filter, or **Watch** to rerun on save. Failures link to the line.
- **Test agents.** Give one scenario per line and Forge runs them as parallel agents (3 at a time by default), each reporting passed or failed. If Roblox Studio's MCP server is configured (`studioMcp`), one agent at a time gets Studio to play-test; the others review the code.

### Packages (Wally and rokit)

![Packages page listing wally.toml dependencies with available updates](docs/screenshots/32-packages-dark.png)

- **Wally.** Search the Wally registry and add a package as *Shared* (`[dependencies]`), *Server* (`[server-dependencies]`) or *Dev* (`[dev-dependencies]`). Forge edits `wally.toml` line by line, so comments and order are kept. It shows installed versions from `wally.lock`, newer releases with one-click updates, and removal. The dev loop (or Forge itself) then runs `wally install`.
- **Tools.** The project's `rokit.toml` tools, with installed state and newer GitHub releases. You can add from a curated list (luau-lsp, StyLua, selene, Blink, Zap, Lune, darklua, pesde, Rojo, Wally) or any `owner/repo`.

### Blink events

![Events panel listing Blink events and types next to events.blink](docs/screenshots/24-events-dark.png)

The **Events** panel lists every `event` and `function` in `events.blink` and the files it imports, with direction (Server → Client / Client → Server), Reliable or Unreliable, and the types. Click one to jump to it. **Copy usage** copies the calls Blink generates (`Fire`/`FireAll`/`On`/`Invoke`, and so on), with the `require` path worked out from the project. On every save Forge compiles a copy with the project's `blink` into a temp folder, so your real output files are never touched. Errors show in the panel, as editor squiggles and in the logs. The generated client and server files open read-only.

### Release and publish

![Release page with publish mode and version bump](docs/screenshots/33-release-dark.png)

A release runs checks (git state, Studio conflicts, Blink, Lune tests, selene), writes a changelog from the commits since the last tag, bumps the version (suggested from the commits), tags and pushes, and can post to a Discord webhook. There are three modes:

- **Studio publish** (default). You publish from Studio afterwards. Use this for every GenTree game, because maps, models and GUIs live only in the Studio place.
- **Rojo build.** Builds the place with Rojo and publishes it with Open Cloud. This only works for fully Rojo-managed games, and it asks you to confirm first.
- **Place file.** Publishes a `.rbxl` exported from Studio with Open Cloud.

The Open Cloud key and the webhook are stored encrypted and never written to the repo.

### Analytics

![Analytics page with DAU, retention, revenue and signals](docs/screenshots/34-analytics-dark.png)

DAU, retention, session length, revenue and concurrent players for the experience. The data comes from the Open Cloud Analytics API when you add a key, from a Creator Dashboard CSV export, or otherwise from public stats. **Signals** explain changes without a model (week over week, retention cohorts, anomalies, release impact), and **Ask the agent** brings the numbers into a chat. Agents also get analytics tools and Luau `AnalyticsService` snippets in the GenTree layout.

### Team collaboration

![Team panel with file claims, pull requests, activity and history (light theme)](docs/screenshots/27-team-light.png)

The Team panel shows **claims** (shared "working on" markers in `.forge/claims.json`, flagged when stale or contested), open pull requests (through `gh`, or a GitHub compare link), an activity feed that merges git history with Studio sync events, the history and blame of the open file, and lint problems. Team settings are kept in `.forge/project.json` and committed. Forge has light and dark themes. Use the sun/moon button in the title bar.

### Quality of life

#### Compare any two versions

![VFX Lab compare: two versions side by side on one timeline, with score and parameter deltas](docs/screenshots/200-compare-vfx-iterations-dark.png)

The VFX Lab, the Animation Lab and the Ability Composer have a **Compare** button next to Studio check. It opens two versions side by side in the lab's own preview, so you can see what a refine round actually changed.

- **Pick any two.** A and B can each be the current version, any refine iteration (the best one is marked) or any other entry in the library. It opens on the best scored version that differs from the current one. The swap button switches A and B.
- **One timeline.** Play, pause, loop, speed and the scrubber drive both previews together, so they are always on the same frame. **Same time** plays both in seconds, and the shorter one holds its last frame. **Stretch** scales both to the same length so you can compare phases. **A/B flip** shows one frame and switches between A and B in place (press `F`). Space plays or pauses, and `,` and `.` step one frame.
- **What changed.** The score card shows the overall score, every rubric score and every principle score for A and B, with the change. The params list shows each parameter that changed, was added or was removed: nodes by name (`Fireball/Core.Rate`), number and color sequences as one line, joints by key times, easing and pose, and ability events by kind and label. You can filter it by text or by kind.
- **Use a version.** In the VFX and Animation labs, **Use #n** restores the chosen iteration as the current version.

![Ability Composer compare in the light theme](docs/screenshots/205-compare-ability-light.png)

The compare is generic. `CompareView` / `CompareDialog` (`src/renderer/src/components/compare/`) take a list of `CompareItem`s and a `renderPane(item, ctx)`. A canvas lab wraps its scene class in `<ScenePane create load loadKey />`, and other renderers use `useCompareTime(ctx, draw)`. The data side is in `src/shared/compare/` (`flattenParams`, `diffParams`, score and principle deltas, `defaultPair`, the shared clock), so another lab only needs an item builder like the ones in `labs.ts`.
#### Bug reports, notifications, restore and digest

![Since your last session: Studio edits, commits by others, a finished lab run, a conflict and failing tests](docs/screenshots/190-qol-away-digest-dark.png)

- **Report a bug**: use the bug button in the title bar, the palette (*Report a bug…*) or Settings > Notifications. Forge takes a screenshot of its window, then asks what happened and what you expected. The report adds the open page, the app and OS versions, the project **name** (the full path only if you tick it), recent renderer and main-process errors and the last 300 log lines from every service. Anything that looks like a key, token, password, cookie or webhook is replaced with `[REDACTED]`, and your home folder shows as `~`. Forge saves `report.md` and `screenshot.png` under `<userData>/bug-reports/<time>/` and copies the markdown to your clipboard; **Reveal** opens the folder. Nothing is uploaded.
- **Done notifications**: you get an OS notification, with optional sound, when a long task finishes or needs you:
  - lab compose / refine / critique runs (VFX, Animation, Ability, plus any lab that sends `<lab>:progress` events);
  - team runs and their change requests;
  - chat replies that took over 30 s;
  - Lune tests, test agents and releases;
  - new Forge Sync conflicts.

  Clicking a notification brings Forge forward on the right page. In **Settings > Notifications** you choose *In background* (default), *Always* or *Off*, and turn each category on or off.
- **Pick up where you left off**: Forge saves your session to `<userData>/session-state.json` (versioned) and reopens it on start and after an auto-update restart:
  - open tabs and the active tab;
  - panel layout;
  - chat drafts and scroll position;
  - the selected entry and tab in each lab;
  - editor cursors.

  Files or entries you deleted in the meantime are skipped.
- **Since you were away**: a card that shows when you open a project, and when you come back after an hour idle. It lists:
  - teammate edits Forge Sync pulled from Studio;
  - new git commits by other people (since the HEAD you last saw);
  - lab runs that finished;
  - open Studio conflicts and held places;
  - failing tests from the last run.

  Each line opens its place in Forge. You can dismiss the card, and turn it off in Settings.

![Report a bug dialog with the redacted report preview](docs/screenshots/192-qol-bug-report-dark.png)
### Doctor, budget, Add to game

![Forge Doctor with failing, to-check and OK checks](docs/screenshots/210-doctor-issues-dark.png)

**Forge Doctor** (Help menu `ⓘ`, the command palette, or the banner at the top of Settings) checks your whole setup in one run and lists each check as OK, check, or failing. The checks cover:

- the rokit toolchain and its pinned versions
- Python (for the project sync engine)
- git and `gh`
- Studio, the Forge Bridge plugin version and any legacy StudioSync plugins
- the bridge and `rojo serve` ports
- the Studio connection, and whether HTTP requests are allowed
- Forge Sync gate state and conflicts
- whether a key is set for each provider (keys are never shown)
- Open Cloud key scopes, checked with Roblox's [API key introspection](https://create.roblox.com/docs/cloud/auth/api-keys) endpoint
- the OpenAI key used for Art
- free disk space
- the project files, Wally packages and sourcemap
- the updater
- the macOS screen-recording permission

Each problem comes with a one-click fix or the exact command to run. **Copy as Markdown** puts the report into a bug report, with your home folder replaced by `~`.

![Usage and spending cap settings near the daily cap](docs/screenshots/214-settings-usage-warn-dark.png)

**Spending cap** (Settings > Usage) sets one daily and one monthly USD budget for every AI call: chat, group chats, test agents, team runs, the Labs and image generation. At 80% (adjustable) you get a toast and a status-bar pill. At 100%, new calls are refused with a clear message and a **Raise cap for today** button. The page breaks spending down by provider and by feature and shows the last 14 days. Days and months are counted in your local time. The data stays on your computer in `spend.json` in the app data folder.

![Add to game dialog with a diff to confirm before overwriting](docs/screenshots/217-a2g-diff-light.png)

**Add to game** (VFX Lab, Animation Lab, Ability Composer) writes a lab result into your game:

1. Pick the place (`*.project.json`) and the folder. Forge suggests one from your project layout and remembers your last choice for each lab.
2. Review the files. The dialog lists every file it will write, using the labs' own exporters and the Rojo mapping. Each one is marked new, unchanged or changed.
3. Confirm any overwrites. A changed file is only overwritten after you open its diff and tick it.

The result shows the `require` line to paste into Studio's command bar. Other labs can add their own adapter to the same dialog.

## Install

Download the installer for your computer from the **[latest release](https://github.com/Acidgorgon/rbx-forge/releases/latest)**.

| Your computer | File |
|---|---|
| Mac with Apple Silicon (M1 and later) | `RBX-Forge-<version>-mac-arm64.dmg` |
| Intel Mac | `RBX-Forge-<version>-mac-x64.dmg` |
| Windows PC (most) | `RBX-Forge-<version>-win-x64.exe` |
| Windows on ARM (Surface Pro X, Copilot+ PCs) | `RBX-Forge-<version>-win-arm64.exe` |

Not sure which Mac you have? Open Apple menu > About This Mac. "Chip: Apple M…" means arm64, and "Processor: Intel" means x64.

The builds are not signed with a paid certificate, so your OS warns you the first time:

- **macOS (Gatekeeper).** Open the `.dmg` and drag **RBX Forge** into **Applications**. The first time, **right-click (or Control-click) RBX Forge > Open**, then click **Open** in the dialog. If macOS says the app "is damaged and can't be opened" or shows no Open button, go to **System Settings > Privacy & Security**, scroll down and click **Open Anyway**. You can also run this once in Terminal:
  ```bash
  xattr -dr com.apple.quarantine "/Applications/RBX Forge.app"
  ```
- **Windows (SmartScreen).** Run the `.exe`. When SmartScreen says "Windows protected your PC", click **More info > Run anyway**. The installer lets you pick a folder and adds Desktop and Start menu shortcuts. Uninstall from Settings > Apps.

On first launch Forge sets up the Roblox toolchain (see [above](#new-project-and-automatic-toolchain)). You need **git** (on macOS `xcode-select --install`, on Windows from git-scm.com). Studio sync also needs **Python 3**, because the template's `tools/studio-sync.py` runs on it (on Windows, install it from python.org with the `py` launcher). Forge looks for tools in `~/.rokit/bin` (`%USERPROFILE%\.rokit\bin`), your PATH, Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`), nvm and, on macOS, your login shell's PATH, so it finds them even when started from the Dock or Finder. On Windows the dev loop runs `tools\dev.ps1` in PowerShell (or `./dev` with Git Bash when there is no `dev.ps1`).

Settings are stored in the same place for the installed app and `npm run dev`: `~/Library/Application Support/rbx-forge` (macOS) or `%APPDATA%\rbx-forge` (Windows).

## Updates

Forge updates itself from this repository's [GitHub Releases](https://github.com/Acidgorgon/rbx-forge/releases) with [electron-updater](https://www.electron.build/v26/docs/features/auto-update). It checks shortly after launch and then every 4 hours, downloads a new version in the background and shows **Update 0.2.1 ready, restart** in the status bar. Restart installs it; if you keep working, it installs the next time you quit. It never restarts on its own, and when a chat or agent is running or a file has unsaved changes it asks first. **Settings > Updates** has the auto-check switch, the channel, **Check now**, your version and the release notes.

- **Channels.** *Stable* gets full releases. *Beta* also gets prereleases. Switching back to Stable keeps the beta you have until a newer full release comes out (no downgrades).
- **Windows.** Updates install silently into the same folder. This works with the unsigned installer: electron-updater only checks the installer's signature when the build was signed with a certificate. Windows SmartScreen judges files by reputation and may still warn about the first, manually downloaded installer.
- **macOS.** macOS only lets an app replace itself when it is signed with an Apple Developer ID (Squirrel.Mac checks the update against the running app's signature, and an ad-hoc signature only matches that exact build). The current builds are ad-hoc signed, so Forge shows **Update 0.2.1 available, download** and opens the release page. A build signed with a Developer ID switches to installing updates by itself, with no code change.
- **Linux.** No Linux build is published, so updates are off.

### Releasing

Push a tag such as `v0.2.1` after bumping `version` in `package.json`, or run **Actions > Build > Run workflow** with a `release_tag`. The release job uploads the installers together with `latest.yml` (Windows), `latest-mac.yml` (macOS) and the `.blockmap` files the updater reads. Each arch builds on its own runner, so the job merges the per-arch `latest*.yml` files (`build/merge-update-info.mjs`) into one per platform that lists both arches. A release without these files (such as v0.2.0) is only visible to people who download it by hand.

Builds on every push would ship unfinished code and spend macOS/Windows runner minutes, so updates come from releases only. For testers, run the workflow with **prerelease** checked: it publishes a GitHub prerelease such as `v0.2.1-beta.57` (the next patch after the last release, plus the run number, without changing `package.json`) that only the Beta channel offers.

### Private source repository

The app reads releases without a token, and a private repository answers those requests with "404 Not Found". Forge never ships a token (anyone could pull it out of the app), so with a private repository the check fails and Settings > Updates explains why. To keep the source private:

1. Create a small **public** repository for the binaries only, for example `Acidgorgon/rbx-forge-releases`.
2. In `electron-builder.yml`, change `publish.repo` to `rbx-forge-releases`. New builds then look for updates there.
3. Add a `RELEASES_TOKEN` secret to the source repository: a fine-grained token with **Contents: read and write** on the releases repository. The release job uploads there when the feed repository differs from the one running the workflow.

Apps already installed keep reading the repository they were built with, so make the switch while the old repository is still public, release once, then make it private.

## Build it yourself

You need **Node 22+** and **git**.

```bash
npm ci
npm run dev         # run from source with hot reload
npm run dist        # installer for this computer (.dmg/.zip on a Mac, .exe on Windows) in dist/
```

Other scripts:

```bash
npm run dist:mac    # macOS arm64 + x64 (run on a Mac)
npm run dist:win    # Windows x64 + arm64 (run on Windows; NSIS needs Windows or wine)
npm run dist:dir    # unpacked app only, quickest check
npm run build       # production build into out/; npm start runs it
npm test            # node --test suites; npm run typecheck for tsc
```

Then click **Open project** and pick a game folder (one with `default.project.json`), or create a **New project**. Forge remembers the folder. To preview the UI in a browser with sample data, run `npx vite --config src/renderer/vite.preview.config.ts`.

Packaging is configured in `electron-builder.yml`. The icon is `build/icon.png` (source `build/icon.svg`), which electron-builder converts to `.icns`/`.ico`. Three native or binary pieces are handled per target:

- **Claude Agent SDK CLI.** The chat runs the Agent SDK's native CLI from `@anthropic-ai/claude-agent-sdk-<platform>-<arch>`. npm installs only the package for the machine running it, so the `dist` scripts first run `build/sdk-binaries.mjs`, which downloads the package for each target platform and arch when it is missing. The packages are unpacked from the asar, because an executable cannot run from inside it.
- **rokit.** `build/rokit-binaries.mjs` downloads the pinned rokit release for the target (SHA-256 checked) into `resources/rokit/<os>-<arch>`, and electron-builder ships it.
- **node-pty.** The terminal uses node-pty 1.1.0, an N-API addon whose npm package carries prebuilds for all four targets, so no rebuild is needed.

`build/afterPack.cjs` keeps only the target's binaries and fails the build if one is missing. The Lune test runtime ships from `resources/lune`.

CI (`.github/workflows/build.yml`) runs typecheck, tests and a build on every push. Installers are built on a manual run (Actions > Build > Run workflow, downloadable from the run's **Artifacts**) or a `v*` tag. Each target builds on its own runner: macOS arm64 on `macos-latest`, macOS x64 on `macos-15-intel`, and Windows x64 and arm64 on `windows-latest`. A tag such as `v0.2.0` also publishes a GitHub Release with all four installers and the update metadata (see [Updates](#updates)).

macOS builds get an ad-hoc signature only. To sign and notarize, set `mac.identity` (or `CSC_LINK`/`CSC_KEY_PASSWORD`) and `hardenedRuntime: true`, and add notarization. Windows signing takes `CSC_LINK` / `WIN_CSC_LINK`.

## Settings

Most settings are in the app (gear at the bottom of the activity bar): providers and keys, default model and effort, budgets, toolchain, memory and the Studio MCP. They are stored in `settings.json` in the app's user data folder. Useful keys include:

- `defaultModel` (`{ "provider": "anthropic", "model": "claude-opus-5-5" }`) and `defaultEffort`
- `providerConfig` (base URLs for `ollama`/`custom`) and `anthropicUseClaudeLogin` (default `false`)
- `chatMaxTurns`, `studioMcp` (`{ "command": "...", "args": [] }`), `maxParallelAgents` and `agentMaxTurns`
- `serveAllPlaces` and `allowTemplateDisconnect`
- `sync.engine` (`forge` default, `project`, `off`) and `sync.gateRojo` (default `true`)

Team settings (version, publish mode and place ids, notifications) live in the project's `.forge/project.json`. Secrets never go there.

## Layout

```
src/main            Electron main process
  services/         supervisor, project tree and places, git sync, Studio conflicts, luau-lsp bridge,
                    Blink, packages, terminal, setup (toolchain, new project), tests (Lune),
                    collab, release, analytics, art
  agent/            chat and providers, gentree tools, group chat, orchestrator, memory,
                    budget, test agents, credentials
src/preload         the window.harness bridge
src/renderer        React UI: shell, views, pages, assistant, terminal, Monaco + LSP client
src/shared          types shared by all three
resources/lune      Lune test runtime (world, testkit, expect)
test                node --test suites (npm test)
```
