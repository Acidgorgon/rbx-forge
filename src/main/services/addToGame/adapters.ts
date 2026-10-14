// Built-in "Add to game" adapters: VFX Lab, Animation Lab and Ability Composer. Each one asks its
// lab's own exporter (exportFiles) for the files, so nothing is exported twice in two ways. The labs
// are reached through small structural interfaces (tests pass fakes).

import type { AbilityEntry } from '../../../shared/ability/types.ts'
import type { AnimEntry } from '../../../shared/anim/model.ts'
import { animModuleName } from '../../../shared/anim/luau.ts'
import { TEX_SCHEME } from '../../../shared/vfx/tex/textures.ts'
import type { VfxEffect, VfxEntry } from '../../../shared/vfx/types.ts'
import { requireExpression } from '../blink.ts'
import type { AdapterCtx, AdapterFile, AddToGameAdapter } from './service.ts'

type Files = { path: string; content: string; role: string; owned?: (current: string) => boolean; onlyIfExists?: boolean }[]

export interface VfxLabPort {
  get(id: string): Promise<VfxEntry>
  exportFiles(entry: VfxEntry, dir: string): Promise<Files>
  markWritten(entry: VfxEntry, dir: string): Promise<VfxEntry>
}

export interface TexturePort {
  exportEffect(effect: VfxEffect): Promise<{ fallbacks: { ref: string; to: string; reason: string }[] }>
}

export interface AnimLabPort {
  get(id: string): Promise<AnimEntry>
  exportFiles(entry: AnimEntry, dir: string): Files
  markWritten(entry: AnimEntry, dir: string): Promise<AnimEntry>
}

export interface AbilityLabPort {
  get(id: string): Promise<AbilityEntry>
  exportFiles(id: string, dir: string, o: { vfxFolders: Record<string, string>; vfxPath: string[] | null; moduleInstance?: string[] | null }): Promise<{ files: Files; warnings: string[]; requirePath: string | null }>
  markWritten(id: string, dir: string): Promise<void>
}

const parentDir = (file: string) => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '')

// Directory of a ModuleScript-with-children item (<dir>/init.luau) at instance `inst`.
export function itemDir(ctx: AdapterCtx, inst: string[]): string {
  const file = ctx.toDisk(inst, 'ModuleScript', true)
  if (file && /\/init(\.\w+)?\.luau?$/.test(file)) return parentDir(file)
  return `${ctx.dir}/${inst[inst.length - 1]}`
}

function movedNote(current: string | null | undefined, next: string): string[] {
  return current && current !== next ? [`The copy in ${current} stays where it is; delete it if you do not need both.`] : []
}

export function vfxAdapter(vfx: VfxLabPort, textures?: TexturePort): AddToGameAdapter {
  const need = async (id: string) => {
    const e = await vfx.get(id)
    if (!e.effect) throw new Error(`"${e.name}" is a media reference; there is nothing to add`)
    return e as VfxEntry & { effect: VfxEffect }
  }
  return {
    lab: 'vfx',
    label: 'VFX effect',
    // Effects are played by client runners (and the Ability Composer's AbilityRunner).
    realm: 'client',
    folderName: 'VFX',
    describe: async (id) => {
      const e = await need(id)
      const notes: string[] = []
      const uploads: { id: string; label: string }[] = []
      const plan = textures ? await textures.exportEffect(e.effect).catch(() => null) : null
      for (const f of plan?.fallbacks ?? []) {
        if (f.reason === 'not uploaded to Roblox yet' && f.ref.startsWith(TEX_SCHEME)) uploads.push({ id: f.ref.slice(TEX_SCHEME.length), label: f.ref.slice(TEX_SCHEME.length) })
      }
      if (uploads.length) notes.push(`${uploads.length} custom texture${uploads.length === 1 ? ' is' : 's are'} not uploaded to Roblox yet: upload first, or the module uses a built-in stand-in.`)
      for (const f of plan?.fallbacks ?? []) if (f.reason !== 'not uploaded to Roblox yet') notes.push(`${f.ref}: ${f.reason}; ${f.to} is used instead.`)
      return { name: e.effect.name, currentFolder: e.written ? parentDir(parentDir(e.written.module)) : null, notes, ...(uploads.length ? { uploads } : {}) }
    },
    files: async (id, ctx) => {
      const e = await need(id)
      const inst = [...ctx.folder, e.effect.name]
      const dir = itemDir(ctx, inst)
      const files = (await vfx.exportFiles(e, dir)) as AdapterFile[]
      const path = `game.${requireExpression(inst)}`
      return { files, instance: inst, requirePath: path, command: `require(${path}).play(workspace.CurrentCamera.CFrame * CFrame.new(0, -2, -14))`, warnings: movedNote(e.written ? parentDir(e.written.module) : null, dir) }
    },
    committed: async (id, ctx) => {
      const e = await need(id)
      await vfx.markWritten(e, itemDir(ctx, [...ctx.folder, e.effect.name]))
    }
  }
}

export function animAdapter(anim: AnimLabPort): AddToGameAdapter {
  const nameOf = (e: AnimEntry) => animModuleName(e.clip?.name || e.name)
  return {
    lab: 'anim',
    label: 'Animation',
    // A module with the KeyframeSequence and the rbxassetid: required from client and server.
    realm: 'shared',
    folderName: 'Animations',
    describe: async (id) => {
      const e = await anim.get(id)
      const notes = e.roblox?.assetId
        ? [`AnimationId rbxassetid://${e.roblox.assetId} goes into the module.`]
        : ['Not uploaded to Roblox yet: the module carries the KeyframeSequence but no AnimationId. Upload it in the Animation Lab first to play it with Animator:LoadAnimation.']
      return { name: nameOf(e), currentFolder: e.written ? parentDir(parentDir(e.written.module)) : null, notes }
    },
    files: async (id, ctx) => {
      const e = await anim.get(id)
      const inst = [...ctx.folder, nameOf(e)]
      const dir = itemDir(ctx, inst)
      const path = `game.${requireExpression(inst)}`
      return { files: anim.exportFiles(e, dir), instance: inst, requirePath: path, command: `require(${path}).play(game.Players.LocalPlayer.Character)`, warnings: movedNote(e.written ? parentDir(e.written.module) : null, dir) }
    },
    committed: async (id, ctx) => {
      const e = await anim.get(id)
      await anim.markWritten(e, itemDir(ctx, [...ctx.folder, nameOf(e)]))
    }
  }
}

export function abilityAdapter(ability: AbilityLabPort, vfx: VfxLabPort | null): AddToGameAdapter {
  // VFX the move needs that are not in the game yet: added with it, into the VFX folder suggested
  // for the same place.
  const vfxPlan = async (e: AbilityEntry, ctx: AdapterCtx) => {
    const folders: Record<string, string> = {}
    const extra: AdapterFile[] = []
    const added: { entry: VfxEntry; dir: string }[] = []
    let vfxPath: string[] | null = null
    for (const ev of e.ability.events) {
      if (ev.kind !== 'vfx' || ev.muted || !vfx) continue
      const fx = await vfx.get(ev.effect).catch(() => null)
      if (!fx?.effect) continue
      let dir: string | null = fx.written ? parentDir(fx.written.module) : null
      if (dir && !ctx.fromDisk(`${dir}/init.luau`)) dir = null // lives outside this place's mapped tree
      if (!dir) {
        const t = ctx.suggestFolder('vfx')
        if (!t) continue
        const inst = [...t.instance, fx.effect.name]
        dir = itemDir({ ...ctx, folder: t.instance, dir: ctx.toDisk(t.instance, 'Folder') ?? ctx.dir }, inst)
        for (const f of await vfx.exportFiles(fx, dir)) extra.push({ ...f, role: `${f.role} (${fx.effect.name})` })
        added.push({ entry: fx, dir })
      }
      folders[ev.id] = dir
      vfxPath ??= ctx.fromDisk(`${parentDir(dir)}/x.luau`)?.slice(0, -1) ?? null
    }
    return { folders, extra, added, vfxPath }
  }
  return {
    lab: 'ability',
    label: 'Ability',
    realm: 'client',
    folderName: 'Abilities',
    describe: async (id) => {
      const e = await ability.get(id)
      const notes: string[] = []
      if (e.ability.animation && !e.ability.animation.assetId) notes.push(`Animation "${e.ability.animation.name}" has no asset id yet: publish it to Roblox and set the id.`)
      return { name: e.ability.name, currentFolder: e.written ? parentDir(e.written.module) : null, notes }
    },
    files: async (id, ctx) => {
      const e = await ability.get(id)
      const v = await vfxPlan(e, ctx)
      const moduleInstance = ctx.fromDisk(`${ctx.dir}/${e.ability.name}.luau`)
      const out = await ability.exportFiles(id, ctx.dir, { vfxFolders: v.folders, vfxPath: v.vfxPath, moduleInstance })
      const warnings = [...out.warnings]
      if (v.vfxPath?.[0] === 'StarterPlayer') warnings.push('The VFX folder is under StarterPlayer: AbilityRunner looks effects up from a service, so move VFX to ReplicatedStorage (or edit AbilityRunner.VfxPath).')
      warnings.push(...movedNote(e.written ? parentDir(e.written.module) : null, ctx.dir))
      return {
        files: [...v.extra, ...out.files],
        warnings,
        instance: moduleInstance ?? [...ctx.folder, e.ability.name],
        requirePath: out.requirePath,
        command: out.requirePath ? `require(${out.requirePath}).play(game.Players.LocalPlayer.Character)` : null
      }
    },
    committed: async (id, ctx) => {
      const e = await ability.get(id)
      const v = await vfxPlan(e, ctx)
      for (const a of v.added) await vfx?.markWritten(a.entry, a.dir)
      await ability.markWritten(id, ctx.dir)
    }
  }
}
