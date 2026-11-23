---
name: forge-refactor
description: Refactor, migrate or optimize a Roblox game in the RBX Forge framework (GenTree layout and the Harbor libraries Current, Anchor, Ripple, Tide, Lighthouse). Use when asked to refactor or port a game or feature to RBX Forge or Harbor, replace RemoteEvents, Blink, DataStores or ProfileStore, replicate state, add character interpolation or lag compensation, or optimize a Roblox game.
---

# Forge refactor

1. Read `.forge/FRAMEWORK.md` in full, and the project's `AGENTS.md`. They are the rules for this job and override your defaults.
2. Read `.forge/MIGRATION.md`.
   - If it does not exist, do the audit in FRAMEWORK.md section 4 and write it.
   - For a whole-game refactor, show the user the plan (features, their order, open questions such as raw DataStore formats or ball physics) and wait for a go-ahead before changing code.
3. Pick the next unchecked item in MIGRATION.md, or the feature the user named. Migrate it in the order networking, data, state, movement, telemetry, optimization (FRAMEWORK.md 4.1 to 4.6). Before you use an API call you have not used in this project yet, read its Harbor docs page.
4. Run the checks in FRAMEWORK.md section 5 and tick the item in MIGRATION.md.
5. Report:
   - what moved;
   - behaviour changes;
   - Studio-only instances to delete;
   - what to test in Studio.

   Then stop. Do one feature per run unless the user asks for more.
