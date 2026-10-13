// Frames captured in Roblox Studio travel through the labs' render / critique code as plain arrays of
// PNG buffers. A marker on the array tells the critique step where they came from, so the critic is
// told it is looking at real Studio frames (and which images are the preview for comparison).

const MARK = Symbol.for('rbx-forge.studio-frames')

export interface StudioFramesInfo {
  // The first `studio` images are Studio captures.
  studio: number
  // Followed by this many preview frames at the same times (comparison only).
  preview?: number
}

export function markStudioFrames<T>(frames: T[], info: StudioFramesInfo): T[] {
  Object.defineProperty(frames, MARK, { value: info, enumerable: false, configurable: true })
  return frames
}

export function studioFramesOf(frames: unknown): StudioFramesInfo | null {
  return frames && typeof frames === 'object' ? (((frames as Record<symbol, unknown>)[MARK] as StudioFramesInfo | undefined) ?? null) : null
}

// Appended to a critique prompt when the frames came from Studio.
export function studioFramesNote(frames: unknown): string {
  const info = studioFramesOf(frames)
  if (!info) return ''
  const lines = [
    '',
    `Important: the ${info.preview ? `first ${info.studio} images are` : 'frames are'} real Roblox Studio captures (the engine players see: a neutral stage, the default dummy, Studio lighting), not the approximate WebGL preview. Judge what Studio shows.`
  ]
  if (info.preview) lines.push(`The next ${info.preview} image(s) are Forge's preview at the same times, for comparison only: when they differ, trust Studio and say what differs.`)
  return lines.join('\n')
}
