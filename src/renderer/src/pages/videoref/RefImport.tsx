// "Make it like this": the import review for a video reference. Drop or pick a clip (mp4 / webm /
// mov where Chromium can decode it, or a GIF), trim it (start / end), optionally drag a crop box on
// the preview, analyse it in the renderer (decode.ts + shared/videoref) and save it to the lab's
// library. The vision summary runs in the background after saving when a model is set up.
import { useEffect, useRef, useState } from "react";
import type { RefCrop, RefEntry, RefLab } from "@shared/types";
import { useStore } from "../../store";
import { Icon } from "../../components/Icons";
import { errorText } from "../../lib/format";
import {
  buildReference,
  decodeClip,
  isRefFile,
  loadVideo,
  MAX_SPAN,
  mimeOf,
  probeGif,
  REF_ACCEPT,
  type BuiltRef,
  type Probe,
} from "./decode";
import { BeatStrip, Swatches } from "./RefViews";
import "./videoref.css";

const KEEP_SOURCE = 25 * 1024 * 1024;
const f2 = (x: number) => x.toFixed(2);

export function RefImport({
  lab,
  scope,
  file: initial,
  onClose,
  onSaved,
}: {
  lab: RefLab;
  scope: "user" | "project";
  file?: File | null;
  onClose: () => void;
  onSaved: (e: RefEntry) => void;
}) {
  const { actions } = useStore();
  const [file, setFile] = useState<File | null>(initial ?? null);
  const [url, setUrl] = useState<string | null>(null);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [crop, setCrop] = useState<RefCrop | null>(null);
  const [name, setName] = useState("");
  const [tags, setTags] = useState("");
  const [phase, setPhase] = useState<
    "pick" | "trim" | "decoding" | "review" | "saving"
  >(initial ? "trim" : "pick");
  const [progress, setProgress] = useState<[number, number]>([0, 0]);
  const [built, setBuilt] = useState<BuiltRef | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [at, setAt] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const pickRef = useRef<HTMLInputElement | null>(null);
  const dragFrom = useRef<{ x: number; y: number } | null>(null);

  // A new file: object URL, probe (length and size), default name and trim.
  useEffect(() => {
    if (!file) return;
    setError(null);
    setBuilt(null);
    setCrop(null);
    setPhase("trim");
    setName(
      file.name
        .replace(/\.\w+$/, "")
        .replace(/[_-]+/g, " ")
        .trim()
        .slice(0, 60),
    );
    const u = URL.createObjectURL(file);
    setUrl(u);
    let live = true;
    const mime = mimeOf(file);
    (mime === "image/gif" ? probeGif(file) : loadVideo(u).then((r) => r.probe))
      .then((p) => {
        if (!live) return;
        setProbe(p);
        setStart(0);
        setEnd(Math.min(p.duration, MAX_SPAN));
      })
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
      URL.revokeObjectURL(u);
    };
  }, [file]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) =>
      e.key === "Escape" && phase !== "saving" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase]);

  const choose = (files: FileList | File[] | null) => {
    const f = [...(files ?? [])].find(isRefFile);
    if (f) setFile(f);
    else if (files && [...files].length)
      setError("Pick an mp4, webm, mov or gif.");
  };

  // Crop: drag a box on the preview (normalised to the media's displayed area).
  const point = (e: React.PointerEvent) => {
    const r = boxRef.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
  };
  const onDown = (e: React.PointerEvent) => {
    if (phase !== "trim" || e.button !== 0) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragFrom.current = point(e);
    setCrop(null);
  };
  const onMove = (e: React.PointerEvent) => {
    const a = dragFrom.current;
    if (!a) return;
    const b = point(e);
    setCrop({
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(b.x - a.x),
      h: Math.abs(b.y - a.y),
    });
  };
  const onUp = () => {
    dragFrom.current = null;
    setCrop((c) =>
      c && c.w > 0.05 && c.h > 0.05
        ? { x: round(c.x), y: round(c.y), w: round(c.w), h: round(c.h) }
        : null,
    );
  };

  const span = Math.max(0, end - start);
  const analyse = async () => {
    if (!file || !probe) return;
    setPhase("decoding");
    setError(null);
    setProgress([0, 0]);
    try {
      const d = await decodeClip(
        file,
        mimeOf(file),
        { start, end, crop: crop ?? undefined },
        (a, b) => setProgress([a, b]),
      );
      setBuilt(buildReference(d, crop ?? undefined));
      setPhase("review");
    } catch (e) {
      setError(errorText(e));
      setPhase("trim");
    }
  };
  const save = async () => {
    if (!file || !probe || !built) return;
    setPhase("saving");
    try {
      const entry = await window.harness.refSave({
        lab,
        scope,
        name: name.trim() || file.name,
        tags: tags
          .split(",")
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean),
        source: {
          name: file.name,
          mime: mimeOf(file),
          bytes: file.size,
          width: probe.width,
          height: probe.height,
          duration: probe.duration,
        },
        ...(file.size <= KEEP_SOURCE
          ? { sourceData: new Uint8Array(await file.arrayBuffer()) }
          : {}),
        trim: { start, end },
        ...(crop ? { crop } : {}),
        analysis: built.analysis,
        sheet: built.sheet,
        keyFrames: built.keyFrames,
      });
      actions.toast({
        text: `Saved the reference ${entry.name}`,
        detail:
          "The vision summary runs in the background when a model is set up.",
        kind: "ok",
        ms: 3500,
      });
      onSaved(entry);
    } catch (e) {
      setError(errorText(e));
      setPhase("review");
    }
  };

  const isGif = file ? mimeOf(file) === "image/gif" : false;
  return (
    <>
      <div className="scrim" onClick={() => phase !== "saving" && onClose()} />
      <div
        className="dialog ref-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Import a video reference"
      >
        <div className="ref-dialog-head">
          <h2>
            Video reference · {lab === "vfx" ? "VFX Lab" : "Animation Lab"}
          </h2>
          <span className="grow" />
          <button
            className="btn small ghost"
            onClick={onClose}
            aria-label="Close"
            disabled={phase === "saving"}
          >
            <Icon name="x" size={12} />
          </button>
        </div>
        <div className="ref-dialog-body">
          <input
            ref={pickRef}
            type="file"
            accept={REF_ACCEPT}
            hidden
            onChange={(e) => choose(e.target.files)}
            aria-label="Choose a clip"
          />

          {phase === "pick" || !file ? (
            <div
              className={`vfx-drop ref-pick${drag ? " drag" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => pickRef.current?.click()}
              onKeyDown={(e) =>
                (e.key === "Enter" || e.key === " ") &&
                (e.preventDefault(), pickRef.current?.click())
              }
              onDragOver={(e) => (e.preventDefault(), setDrag(true))}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => (
                e.preventDefault(),
                setDrag(false),
                choose(e.dataTransfer.files)
              )}
            >
              <Icon name="download" size={13} /> Drop a clip or GIF, or click to
              choose{" "}
              <span className="faint mono">
                mp4 · webm · mov · gif — an anime scene, another game's effect,
                a recording
              </span>
            </div>
          ) : (
            <>
              <p>
                {phase === "review"
                  ? 'The beats, palette and key frames below come from the clip. Save it to use it with "Make it like this".'
                  : `Trim to the part that matters (up to ${MAX_SPAN} s) and drag on the preview to crop. Forge samples small frames and measures timing, flashes, colours, glow and motion.`}
              </p>
              {phase !== "review" && phase !== "saving" && url && (
                <div className="ref-preview">
                  <div
                    className="ref-media"
                    ref={boxRef}
                    onPointerDown={onDown}
                    onPointerMove={onMove}
                    onPointerUp={onUp}
                  >
                    {isGif ? (
                      <img src={url} alt="GIF preview" draggable={false} />
                    ) : (
                      <video
                        ref={videoRef}
                        src={url}
                        muted
                        loop
                        playsInline
                        controls={false}
                        autoPlay
                        onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
                      />
                    )}
                    {crop && (
                      <div
                        className="ref-crop"
                        style={{
                          left: `${crop.x * 100}%`,
                          top: `${crop.y * 100}%`,
                          width: `${crop.w * 100}%`,
                          height: `${crop.h * 100}%`,
                        }}
                      />
                    )}
                  </div>
                </div>
              )}
              {probe && phase !== "review" && phase !== "saving" && (
                <div className="ref-trim">
                  <label>
                    <span className="mono">start</span>
                    <input
                      type="range"
                      min={0}
                      max={probe.duration}
                      step={0.01}
                      value={start}
                      onChange={(e) =>
                        setStart(Math.min(Number(e.target.value), end - 0.05))
                      }
                      aria-label="Trim start"
                    />
                    <span className="mono">{f2(start)}s</span>
                  </label>
                  {!isGif && (
                    <label>
                      <span className="mono">at</span>
                      <input
                        type="range"
                        min={0}
                        max={probe.duration}
                        step={0.01}
                        value={Math.min(at, probe.duration)}
                        onChange={(e) => {
                          const v = videoRef.current;
                          const t = Number(e.target.value);
                          if (v) (v.pause(), (v.currentTime = t));
                          setAt(t);
                        }}
                        aria-label="Playhead (pauses the preview)"
                      />
                      <span className="mono">{f2(at)}s</span>
                    </label>
                  )}
                  <label>
                    <span className="mono">end</span>
                    <input
                      type="range"
                      min={0}
                      max={probe.duration}
                      step={0.01}
                      value={end}
                      onChange={(e) =>
                        setEnd(Math.max(Number(e.target.value), start + 0.05))
                      }
                      aria-label="Trim end"
                    />
                    <span className="mono">{f2(end)}s</span>
                  </label>
                  <div className="ref-trim-row">
                    {!isGif && (
                      <>
                        <button
                          type="button"
                          className="btn small ghost"
                          onClick={() =>
                            videoRef.current &&
                            setStart(
                              Math.min(
                                videoRef.current.currentTime,
                                end - 0.05,
                              ),
                            )
                          }
                        >
                          start = playhead
                        </button>
                        <button
                          type="button"
                          className="btn small ghost"
                          onClick={() =>
                            videoRef.current &&
                            setEnd(
                              Math.max(
                                videoRef.current.currentTime,
                                start + 0.05,
                              ),
                            )
                          }
                        >
                          end = playhead
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className="btn small ghost"
                      onClick={() => setCrop(null)}
                      disabled={!crop}
                    >
                      reset crop
                    </button>
                    <span className="grow" />
                    <span
                      className={`note mono${span > MAX_SPAN ? " warn" : ""}`}
                    >
                      {f2(span)}s of {f2(probe.duration)}s · {probe.width}×
                      {probe.height}
                      {crop
                        ? ` · crop ${Math.round(crop.w * 100)}×${Math.round(crop.h * 100)}%`
                        : ""}
                      {span > MAX_SPAN
                        ? ` · only the first ${MAX_SPAN}s are analysed`
                        : ""}
                    </span>
                  </div>
                </div>
              )}
              {phase === "decoding" && (
                <div className="ref-progress mono" aria-live="polite">
                  <span className="spinner" aria-hidden /> decoding frame{" "}
                  {progress[0]}/{progress[1] || "…"}
                  <span className="ref-bar">
                    <i
                      style={{
                        width: `${progress[1] ? (progress[0] / progress[1]) * 100 : 0}%`,
                      }}
                    />
                  </span>
                </div>
              )}
              {built && (phase === "review" || phase === "saving") && (
                <div className="ref-review">
                  <img
                    className="ref-review-sheet"
                    src={built.sheet}
                    alt="Contact sheet"
                  />
                  <BeatStrip a={built.analysis} lab={lab} />
                  <div className="ref-review-row">
                    <span className="mono faint">
                      {built.analysis.segments
                        .map((s) => `${s.label} ${f2(s.end - s.start)}s`)
                        .join(" · ")}
                    </span>
                    <span className="grow" />
                    {lab === "vfx" && (
                      <Swatches colors={built.analysis.palette} />
                    )}
                  </div>
                </div>
              )}
              <div className="ref-fields">
                <label>
                  <span className="mono">name</span>
                  <input
                    className="input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    aria-label="Reference name"
                  />
                </label>
                <label>
                  <span className="mono">tags</span>
                  <input
                    className="input"
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                    placeholder={
                      lab === "vfx" ? "fire, slash, impact" : "attack, punch"
                    }
                    aria-label="Reference tags"
                  />
                </label>
              </div>
            </>
          )}
          {error && (
            <p className="ref-error" role="alert">
              <Icon name="warn" size={11} /> {error}
            </p>
          )}
        </div>
        <div className="actions">
          {file && phase !== "pick" && (
            <button
              className="btn ghost"
              onClick={() => pickRef.current?.click()}
              disabled={phase === "decoding" || phase === "saving"}
            >
              Other file
            </button>
          )}
          <span className="grow" />
          {phase === "review" || phase === "saving" ? (
            <>
              <button
                className="btn"
                onClick={() => setPhase("trim")}
                disabled={phase === "saving"}
              >
                Back
              </button>
              <button
                className="btn primary"
                onClick={() => void save()}
                disabled={phase === "saving"}
              >
                {phase === "saving" ? (
                  <span className="spinner" aria-hidden />
                ) : (
                  <Icon name="check" size={11} />
                )}{" "}
                Save reference
              </button>
            </>
          ) : (
            <button
              className="btn primary"
              onClick={() => void analyse()}
              disabled={!probe || phase === "decoding"}
            >
              {phase === "decoding" ? (
                <span className="spinner" aria-hidden />
              ) : (
                <Icon name="sparkle" size={11} />
              )}{" "}
              Analyse
            </button>
          )}
        </div>
      </div>
    </>
  );
}

const round = (x: number) => Math.round(x * 1000) / 1000;
