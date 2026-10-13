// How to choreograph a move, for the assistant (ability_compose, the "ability-choreography" memory
// skill) and the composer's model prompt.

export const ABILITY_GUIDE = `# Ability choreography (RBX Forge Ability Composer)
A move = one animation clip (Animation Lab) + VFX (VFX Lab effects attached to R15 parts) + sound + camera shake + screen effects + hit-stop + root movement, on one timeline. The composer references lab items by id; edit the clip in the Animation Lab and the effect in the VFX Lab.

Beats: anticipation (wind-up, telegraph) -> release (the contact / launch frame) -> impact (the first ~0.1 s after release) -> follow-through -> recovery.
- Put the clip's "release" marker on the contact frame and sync impact events to it: {"marker":"release","at":0}. Prefer marker-relative times over absolute ones so retiming the clip keeps everything in sync.
- Impact stack, all on the release marker (within 2 frames): a screen flash (white or the effect's hot colour, attack 0.02 s, hold 0.03-0.06 s, release 0.2-0.35 s), camera shake (light 0.25-0.4 amplitude / 20-25 Hz / 0.2-0.3 s; heavy 0.7-1 / 16-18 Hz / 0.4-0.6 s, exponential falloff) and a hit-stop (0.04-0.12 s at timeScale 0.03-0.1). Add a bloom pop for magic and big hits.
- VFX: attach to the body part that does the work (RightGripAttachment for a hand / weapon, HumanoidRootPart with an offset for projectiles and AoE). Retime the effect so its release stage (fire / impact / slash) lands on the release marker: at = {"marker":"release","at": -<stage time>}.
- Anticipation: 0.15-0.5 s for normal attacks; up to ~3 s for charged ultimates when the charge itself is a spectacle (colour-correction build-up, gathering VFX). Below ~0.1 s the move pops without a read.
- Follow-through: leave 0.3 s or more after the release; the effect dissipates and the pose recovers.
- Root movement: a lunge before the release (velocity [0,0,-30..-50], decay, 0.2-0.3 s) or a recoil after a blast ([0,0,6..10], decay).
- Screen effects never hide the action: a flash opacity above 0.85 or blur above ~12 for long reads as a glitch. Colour correction is for build-ups (desaturate, add contrast, tint toward the effect colour).
- Sounds need a Roblox asset id to export (import local files for the preview, upload them, then set the id).

Tools: ability_compose drafts a whole move (picks or makes the VFX with vfx_compose and the clip with anim_compose when available, else library items or a placeholder pose track) and times it; ability_get reads the timeline with resolved times; ability_set edits events by id (marker-relative times); ability_critique checks the timing rules (flash / shake / hit-stop / effect release on the release marker, anticipation, follow-through) and, with a vision model, frames at the key beats; ability_export writes the client Luau module and the AbilityRunner runtime into the game.`
