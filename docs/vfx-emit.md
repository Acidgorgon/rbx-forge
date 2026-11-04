# ForgeVFX: attribute-driven effects (spec)

Goal: build an effect in Studio as plain instances plus attributes, then play it anywhere with one call.
No per-effect code, no import step needed. Forge's VFX Lab previews the same attributes the game reads.
This is Forge's own design (inspired by attribute-driven plugins such as VFX Forge; no code copied).

## Runtime module

`src/shared/VFX/ForgeVFX.luau` (Rojo: `ReplicatedStorage.Shared.VFX.ForgeVFX`). Written by Forge next to
`ForgeFX.luau` (same ownership-header rule: only rewritten when the header says it is ours). Luau source
lives in `src/shared/vfx/emitRuntime.ts` as a string (like `runtime.ts`).

```lua
local ForgeVFX = require(ReplicatedStorage.Shared.VFX.ForgeVFX)
ForgeVFX.init()                                  -- optional; sets shared.ForgeVFX, makes the Workspace.ForgeVFX folder
local e = ForgeVFX.emit(template, at?, options?) -- at: CFrame | BasePart | Attachment | nil (template's own pivot)
e.Finished:Wait()  /  e.Finished:Connect(fn)     -- fires once, after cleanup
e:Stop()                                         -- stops spawning, disables emitters, lets alive particles finish
e.Duration                                       -- seconds the play is expected to take (from the plan)
ForgeVFX.stopAll()
```

- `emit` **always clones** the template (the template is never changed, so it can live in ReplicatedStorage,
  or in Workspace while authoring). The clone is parented to `options.parent` or `Workspace.ForgeVFX`.
- `at` = BasePart/Attachment: the clone follows it (weld for parts; attachments: per-frame pivot) when
  `options.follow ~= false`. CFrame or nil: placed once.
- Clean-up: the clone is destroyed at `Duration + linger` (linger = longest ParticleEmitter Lifetime.Max /
  Trail Lifetime alive at the end). `Finished` fires after that.
- Every BasePart in the clone is set Anchored (unless welded to `at`), CanCollide/CanQuery/CanTouch false.
- Scripts inside the template are removed from the clone (they would double-play).
- Works on client (recommended) and server.

## Attributes (all optional, seconds)

Inherited: a node without its own value uses its nearest ancestor's (same as `emitAttributes` in
`analyze.ts`). `EmitDelay` on a container is **added** to the children's own delays.

| Attribute | Type | On | Meaning |
|---|---|---|---|
| `EmitDelay` | number | any | wait before the layer starts (0..30) |
| `EmitDuration` | number | any | layer stays on this long (0..30) |
| `EmitCount` | number | ParticleEmitter, mesh effect | burst size (mesh: copies per burst, default 1) |
| `Rate` | number | mesh effect | copies per second while on (needs `EmitDuration`) |

ParticleEmitter (identical to `cuesFromAttributes` today, keep it so): emitter starts disabled; at the delay
`Emit(EmitCount)`; with `EmitDuration` and `Rate` 0 the count is spread over the duration (at most 60
steps, ~30/s); with `EmitDuration` and Rate > 0 it is Enabled for the window; only a delay = one burst of
`max(8, round(Rate*0.25))`.

Beam / Trail / PointLight / SpotLight / SurfaceLight / Highlight: off until `EmitDelay`, on for
`EmitDuration` (or until the end). Optional `FadeOut` (number, seconds): Beam/Trail transparency (whole
sequence) and light Brightness ease to invisible over the last `FadeOut` seconds of the window.

## Mesh effect

A Model or Folder holding two BaseParts named **`Start`** and **`End`** (MeshPart, Part, or a Part with a
`SpecialMesh`). Each copy is a clone of `Start` that animates to `End` over its lifetime:
CFrame (relative to the effect's pivot), Size, Transparency, Color; SpecialMesh `Scale`
and `Offset`; every Decal/Texture child with the **same name** under both parts (Transparency, Color3).
Children only in `Start` (e.g. ParticleEmitters, Attachments with Beams) ride along and get the normal
attribute timing relative to the copy's spawn time. `Start` and `End` themselves are never shown.

Attributes on the Model/Folder:

| Attribute | Type | Default | Meaning |
|---|---|---|---|
| `EmitDelay` / `EmitCount` / `EmitDuration` / `Rate` | number | 0 / 1 / 0 / 0 | spawn timing (above) |
| `Lifetime` | NumberRange | 0.5 | seconds Start -> End per copy (random in range) |
| `Ease` | string | `"Quad.Out"` | default easing, `"<EasingStyle>.<EasingDirection>"` |
| `EaseCFrame` `EaseSize` `EaseTransparency` `EaseColor` | string or NumberSequence | `Ease` | per-property easing; a NumberSequence is a custom curve: time 0..1 -> progress (values may go below 0 / above 1 for overshoot) |
| `SpreadAngle` | Vector2 | 0,0 | random tilt of the whole Start->End path around the pivot's X and Y, degrees (±) |
| `MinInitRot` / `MaxInitRot` | Vector3 | 0 | random extra rotation per copy, degrees, applied at the pivot |
| `Spin` | Vector3 | 0 | degrees per second each copy rotates about its own centre over its life |
| `SyncPosition` | boolean | false | copies keep following the origin (`at`) while alive; otherwise they stay where they spawned |

Easing styles/directions are the Roblox `Enum.EasingStyle` / `Enum.EasingDirection` names; unknown -> Quad.Out.

## Plan (shared by preview and runtime)

`src/shared/vfx/emitPlan.ts` (pure TS) turns a node tree + attributes into the schedule: per layer the
start/end windows, bursts, mesh-copy spawn times and the total duration + linger. The Lab preview uses it;
tests pin it; the Luau runtime mirrors it (same numbers). Randomness (Lifetime ranges, spread, init rot)
comes from a seeded RNG in the preview and `Random.new()` in game.

## Studio

- Forge Bridge job "Play selection": plays the current Studio selection with ForgeVFX (clone into
  `Workspace.ForgeLivePreview`, Archivable false), once or looped, from the VFX Lab ("Play Studio selection").
- Import from Studio keeps Start/End mesh effects and all attributes; exported templates keep attributes.

## Runtime notes (ForgeVFX.luau, emitStudio.ts)

Where the runtime goes past this spec or pins down open points (agreed with the preview plan):

- Duration: if no layer is timed but an Enabled layer has no attributes, Duration = 1 s; an open
  Beam/Trail/light window keeps the effect going at least 1 s past its start. `options.duration` overrides.
- Clean-up also waits for particles riding on mesh copies (copy death + their Lifetime.Max), so they
  are never cut off.
- `FadeOut` also fades a Highlight (Fill/OutlineTransparency). It is linear.
- Mesh copies: CFrame overshoot extrapolates position linearly and rotation by axis-angle (the same as
  `Lerp` inside 0..1). Part Color is clamped to 0..1; Decal Color3 and SpecialMesh VertexColor are not.
  Random values are drawn when `emit` is called, so `Duration` uses the real lifetimes.
- Extras: `e:Stop(true)` removes everything at once, `e:IsPlaying()`, `e.Instance`, `options.offset`
  (CFrame), `options.duration`. A Folder template is wrapped in a Model (pivot = centre of its bounding
  box) and an Attachment template in an invisible part. A Model `at` is followed by re-pivoting every frame.
- Project files: ForgeVFX.luau is written next to an effect when ForgeFX is written, and also for
  attribute-driven effects (emit attributes or a Start/End mesh effect). "Install ForgeVFX" in the VFX
  Lab writes it on request.
- Play Studio selection reads the selection once when it starts and plays each effect at its own
  pivot, on top of the template being edited. Press it again after selecting something else.
