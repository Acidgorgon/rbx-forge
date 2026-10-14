// Offscreen decoder for ref_import (main/services/videoref/electron.ts loads ?ref-decode=1): exposes
// window.__refDecode.run(token, opts), which reads the file main registered under the token,
// decodes and analyses it like the import review does, and returns the analysis, the contact sheet
// and the key frames (PNG data URLs).
import { useEffect } from "react";
import type { RefDecodeOptions } from "@shared/types";
import { buildReference, decodeClip } from "./decode";

declare global {
  interface Window {
    __refDecode?: {
      run(token: string, opts: RefDecodeOptions): Promise<unknown>;
    };
  }
}

export function RefDecode() {
  useEffect(() => {
    window.__refDecode = {
      async run(token, opts) {
        const src = await window.harness.refDecodeSource(token);
        if (!src) throw new Error("the file is no longer available");
        const blob = new Blob([src.bytes as BlobPart], { type: src.mime });
        const d = await decodeClip(blob, src.mime, opts);
        const built = buildReference(d, opts.crop);
        return {
          source: {
            name: src.name,
            mime: src.mime,
            bytes: src.bytes.byteLength,
            width: d.probe.width,
            height: d.probe.height,
            duration: d.probe.duration,
          },
          trim: { start: d.start, end: d.end },
          ...(opts.crop ? { crop: opts.crop } : {}),
          analysis: built.analysis,
          sheet: built.sheet,
          keyFrames: built.keyFrames,
        };
      },
    };
  }, []);
  return null;
}
