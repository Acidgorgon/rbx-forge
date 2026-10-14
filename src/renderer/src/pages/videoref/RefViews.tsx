// Video reference views shared by the VFX Lab and the Animation Lab: the library card, the detail
// panel (contact sheet, beat strip, key frames, palette per beat, glow / motion, the vision summary,
// tags / notes / rating and "Make it like this"), and the side-by-side compare of a result's
// rendered beats with its pinned reference's key frames.
import { useEffect, useMemo, useState } from "react";
import type {
  AnimClip,
  RefEntry,
  RefLab,
  VfxEffect,
  VideoRef,
  VideoRefAnalysis,
} from "@shared/types";
import { paletteText } from "@shared/videoref/analyze";
import { glowText, motionText } from "@shared/videoref/prompt";
import { animNumericMatch, vfxNumericMatch } from "@shared/videoref/match";
import { refPrinciples } from "@shared/principles/ref";
import { principleName } from "@shared/principles/catalog";
import { useStore } from "../../store";
import { Icon } from "../../components/Icons";
import { errorText } from "../../lib/format";
import { BEAT_COLORS } from "./decode";
import "../vfx/vfx.css";
import "./videoref.css";

// The fields of a library entry (VfxEntry / AnimEntry of kind 'media') the views read.
export interface RefLike {
  id: string;
  name: string;
  scope: "user" | "project";
  tags: string[];
  notes?: string;
  rating?: "up" | "down";
  quality?: "reference" | "good" | "avoid";
  updatedAt: number;
  thumbs: string[];
  video?: VideoRef;
}

const fileCache = new Map<string, string | null>();
export function useRefFile(
  lab: RefLab | "ref",
  id: string,
  file: string | undefined,
  stamp = 0,
): string | null {
  const key = file ? `${lab}:${id}/${file}@${stamp}` : "";
  const [url, setUrl] = useState<string | null>(
    key ? (fileCache.get(key) ?? null) : null,
  );
  useEffect(() => {
    if (!file) return setUrl(null);
    if (fileCache.has(key)) return setUrl(fileCache.get(key) ?? null);
    let live = true;
    const h = window.harness;
    const p =
      lab === "vfx"
        ? h.vfxFile(id, file)
        : lab === "anim"
          ? h.animFile(id, file)
          : h.refFile(id, file);
    p.then((u) => {
      fileCache.set(key, u);
      if (live) setUrl(u);
    }).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [key]);
  return url;
}

const f2 = (x: number) => x.toFixed(2);

// ------------------------------------------------------------------ pieces

export function Swatches({
  colors,
  label,
}: {
  colors: { hex: string; share: number }[];
  label?: string;
}) {
  if (!colors.length) return null;
  return (
    <span
      className="ref-swatches"
      role="img"
      aria-label={`${label ?? "palette"}: ${paletteText(colors)}`}
      title={paletteText(colors)}
    >
      {colors.map((c) => (
        <i
          key={c.hex}
          style={{ background: c.hex, flexGrow: Math.max(0.15, c.share) }}
        />
      ))}
    </span>
  );
}

// Motion energy over time with the beats underneath, flash frames as ticks and (Animation Lab) the
// holds / fast motion lane.
export function BeatStrip({
  a,
  lab,
  compact,
}: {
  a: VideoRefAnalysis;
  lab: RefLab;
  compact?: boolean;
}) {
  const W = 600;
  const H = compact ? 26 : 54;
  const dur = a.duration || 1;
  const max = Math.max(1e-6, ...a.frames.map((f) => f.motion));
  const pts = a.frames
    .map(
      (f) =>
        `${((f.t / dur) * W).toFixed(1)},${(H - 2 - (f.motion / max) * (H - 6)).toFixed(1)}`,
    )
    .join(" ");
  return (
    <div className={`ref-strip${compact ? " compact" : ""}`}>
      {!compact && (
        <svg
          className="ref-energy"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="Motion energy over time"
        >
          {a.flashes.map((t) => (
            <line
              key={t}
              x1={(t / dur) * W}
              x2={(t / dur) * W}
              y1={0}
              y2={H}
              className="ref-flash"
            />
          ))}
          <polyline
            points={pts}
            className="ref-line"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
      <div className="ref-beats" role="list" aria-label="Beats">
        {a.segments.map((s) => (
          <span
            key={s.label}
            role="listitem"
            className="ref-beat"
            style={{
              left: `${(s.start / dur) * 100}%`,
              width: `${Math.max(0.5, ((s.end - s.start) / dur) * 100)}%`,
              ["--beat" as string]: BEAT_COLORS[s.label],
            }}
            title={`${s.label} ${f2(s.start)}–${f2(s.end)} s · energy ${Math.round(s.energy * 100)}%`}
          >
            {!compact && (s.end - s.start) / dur >= 0.09 && (
              <span className="mono">{s.label}</span>
            )}
          </span>
        ))}
      </div>
      {lab === "anim" && !compact && (
        <div
          className="ref-lane"
          role="list"
          aria-label="Holds and fast motion"
        >
          {a.timeline.map((s, i) => (
            <span
              key={i}
              role="listitem"
              className={`ref-span ${s.kind}`}
              style={{
                left: `${(s.start / dur) * 100}%`,
                width: `${((s.end - s.start) / dur) * 100}%`,
              }}
              title={`${s.kind} ${f2(s.start)}–${f2(s.end)} s`}
            />
          ))}
        </div>
      )}
      {!compact && (
        <div className="ref-axis mono">
          <span>0</span>
          <span>{f2(dur)} s</span>
        </div>
      )}
    </div>
  );
}

function KeyFrame({
  lab,
  id,
  file,
  label,
  t,
}: {
  lab: RefLab | "ref";
  id: string;
  file?: string;
  label: string;
  t: number;
}) {
  const url = useRefFile(lab, id, file);
  return (
    <figure
      className="ref-key"
      style={{
        ["--beat" as string]: BEAT_COLORS[label] ?? "var(--line-strong)",
      }}
    >
      <div className="ref-key-img">
        {url ? (
          <img src={url} alt={`${label} at ${f2(t)} s`} draggable={false} />
        ) : (
          <span className="vfx-frame-ph" />
        )}
      </div>
      <figcaption className="mono">
        <span>{label}</span>
        <span className="faint">{f2(t)}s</span>
      </figcaption>
    </figure>
  );
}

// ------------------------------------------------------------------ card

export function RefCard({
  lab,
  entry,
  selected,
  onSelect,
}: {
  lab: RefLab;
  entry: RefLike;
  selected: boolean;
  onSelect: () => void;
}) {
  const url = useRefFile(lab, entry.id, entry.thumbs[0], entry.updatedAt);
  const a = entry.video?.analysis;
  return (
    <button
      className={`vfx-card ref-card${selected ? " on" : ""}`}
      onClick={onSelect}
      aria-pressed={selected}
      title={entry.video?.vision?.summary ?? entry.name}
    >
      <div className="vfx-thumb">
        {url ? (
          <img src={url} alt="" loading="lazy" draggable={false} />
        ) : (
          <Icon name="image" size={22} className="vfx-thumb-ph" />
        )}
        {a && <span className="anim-dur mono">{f2(a.duration)}s</span>}
        {a && (
          <span className="ref-card-strip">
            <BeatStrip a={a} lab={lab} compact />
          </span>
        )}
      </div>
      <div className="vfx-cap">
        <span className="vfx-name">{entry.name}</span>
        {entry.quality === "avoid" || entry.rating === "down" ? (
          <span className="tag err">avoid</span>
        ) : entry.rating === "up" ? (
          <span className="tag ok">liked</span>
        ) : null}
        <span className="faint mono">video</span>
      </div>
      <div className="vfx-tags">
        {entry.tags
          .filter((t) => t !== "video")
          .slice(0, 4)
          .map((t) => (
            <span key={t} className="vfx-tag">
              {t}
            </span>
          ))}
      </div>
    </button>
  );
}

// ------------------------------------------------------------------ detail

export function RefDetail({
  lab,
  entry,
  onClose,
  onMade,
  onPin,
}: {
  lab: RefLab;
  entry: RefLike;
  onClose: () => void;
  onMade: (id: string) => void;
  onPin?: (ref: { id: string; name: string }) => void;
}) {
  const { actions } = useStore();
  const h = window.harness;
  const v = entry.video!;
  const a = v.analysis;
  const sheet = useRefFile(lab, entry.id, v.sheet, entry.updatedAt);
  const [tags, setTags] = useState(entry.tags.join(", "));
  const [notes, setNotes] = useState(entry.notes ?? "");
  const [request, setRequest] = useState("");
  const [making, setMaking] = useState(false);
  const [describing, setDescribing] = useState(false);
  useEffect(() => {
    setTags(entry.tags.join(", "));
    setNotes(entry.notes ?? "");
  }, [entry.id, entry.updatedAt]);
  useEffect(() => {
    setRequest(
      lab === "vfx"
        ? `${v.vision?.effect ?? entry.name} effect like the reference`
        : `a move like the reference ${entry.name}`,
    );
  }, [entry.id, !!v.vision]);
  useEffect(
    () =>
      h.on("ref:progress", (p) => {
        if (p.id !== entry.id) return;
        setDescribing(p.phase === "describe");
        if (p.phase === "error")
          actions.toast({
            text: "Vision summary failed",
            detail: p.message,
            kind: "err",
          });
      }),
    [entry.id],
  );

  const update = (patch: { tags?: string[]; notes?: string }) =>
    (lab === "vfx"
      ? h.vfxUpdate(entry.id, patch)
      : h.animUpdate(entry.id, patch)
    ).catch((e) =>
      actions.toast({
        text: "Could not save",
        detail: errorText(e),
        kind: "err",
      }),
    );
  const rate = async (r: "up" | "down") => {
    try {
      const next = entry.rating === r ? null : r;
      await (lab === "vfx"
        ? h.vfxRate(entry.id, next)
        : h.animRate(entry.id, next));
      if (next)
        actions.toast({
          text:
            r === "up"
              ? "Liked: its timing and palette feed the learned style"
              : "Marked avoid: it no longer feeds the learned style",
          kind: "ok",
          ms: 2600,
        });
    } catch (e) {
      actions.toast({
        text: "Rating failed",
        detail: errorText(e),
        kind: "err",
      });
    }
  };
  const describe = async () => {
    setDescribing(true);
    try {
      await h.refDescribe(entry.id);
    } catch (e) {
      actions.toast({
        text: "Vision summary failed",
        detail: errorText(e),
        kind: "err",
      });
    } finally {
      setDescribing(false);
    }
  };
  const make = async () => {
    if (making) return;
    setMaking(true);
    try {
      const r =
        lab === "vfx"
          ? await h.vfxCompose(request.trim(), { reference: entry.id })
          : await h.animCompose(request.trim(), { reference: entry.id });
      if (!r.ok || !r.entry)
        throw new Error(
          r.error
            ? `${r.error.line ? `line ${r.error.line}: ` : ""}${r.error.message}`
            : "the script did not compile",
        );
      actions.toast({
        text: `Made ${r.entry.name} from the reference`,
        detail:
          "Refining in the background; the iterations tab compares it with the reference.",
        kind: "ok",
        ms: 4000,
      });
      onMade(r.entry.id);
    } catch (e) {
      actions.toast({
        text: "Could not make it",
        detail: errorText(e),
        kind: "err",
      });
    } finally {
      setMaking(false);
    }
  };
  const remove = async () => {
    if (!confirm(`Delete the video reference ${entry.name}?`)) return;
    await (
      lab === "vfx" ? h.vfxDelete(entry.id) : h.animDelete(entry.id)
    ).catch((e) =>
      actions.toast({
        text: "Delete failed",
        detail: errorText(e),
        kind: "err",
      }),
    );
    onClose();
  };

  return (
    <section
      className="vfx-detail ref-detail"
      aria-label={`${entry.name} details`}
    >
      <div className="vfx-detail-head">
        <Icon name="image" size={13} />
        <b className="vfx-title">{entry.name}</b>
        <span className="badge-o">{entry.scope}</span>
        <span className="tag info">video ref</span>
        <span className="grow" />
        <button
          className={`btn small ghost${entry.rating === "up" ? " on" : ""}`}
          aria-pressed={entry.rating === "up"}
          onClick={() => void rate("up")}
          title="Good reference: its timing and palette feed the learned style"
        >
          +1
        </button>
        <button
          className={`btn small ghost${entry.rating === "down" ? " on" : ""}`}
          aria-pressed={entry.rating === "down"}
          onClick={() => void rate("down")}
          title="Bad reference: leave it out of the learned style"
        >
          −1
        </button>
        <button
          className="btn small ghost"
          onClick={onClose}
          aria-label="Close details"
        >
          <Icon name="x" size={12} />
        </button>
      </div>

      <form
        className="ref-make"
        onSubmit={(e) => {
          e.preventDefault();
          void make();
        }}
      >
        <span className="vfx-make-lead mono">
          <span className="vfx-prompt-sigil">›</span> Make it like this
        </span>
        <input
          className="input grow"
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          aria-label="What to make from this reference"
          spellCheck
        />
        <button className="btn small primary" disabled={making}>
          {making ? (
            <span className="spinner" aria-hidden />
          ) : (
            <Icon name="play" size={11} />
          )}{" "}
          Make
        </button>
        {onPin && (
          <button
            type="button"
            className="btn small ghost"
            onClick={() => onPin({ id: entry.id, name: entry.name })}
            title="Pin as the reference for the next Make request above"
          >
            <Icon name="pin" size={11} /> Pin
          </button>
        )}
      </form>

      <div className="ref-sheet">
        {sheet ? (
          <img src={sheet} alt={`Contact sheet of ${entry.name}`} />
        ) : (
          <span className="spinner" aria-hidden />
        )}
      </div>

      <BeatStrip a={a} lab={lab} />

      <div className="ref-keys" role="list" aria-label="Key frames">
        {a.keyFrames.map((k) => (
          <KeyFrame
            key={k.index}
            lab={lab}
            id={entry.id}
            file={k.file}
            label={k.label}
            t={k.t}
          />
        ))}
      </div>

      <dl className="vfx-meta ref-meta">
        <dt>beats</dt>
        <dd className="mono">
          {a.segments
            .map((s) => `${s.label} ${f2(s.end - s.start)}s`)
            .join(" · ") || "one beat"}
        </dd>
        {lab === "vfx" && (
          <>
            <dt>palette</dt>
            <dd>
              <Swatches colors={a.palette} />
            </dd>
            {a.segments.map((s) => (
              <PaletteRow key={s.label} label={s.label} colors={s.palette} />
            ))}
            <dt>glow</dt>
            <dd className="mono">{glowText(a)}</dd>
            <dt>flashes</dt>
            <dd className="mono">
              {a.flashes.length
                ? a.flashes.map((t) => `${f2(t)}s`).join(" ")
                : "—"}
            </dd>
          </>
        )}
        {lab === "anim" && (
          <>
            <dt>timing</dt>
            <dd className="mono">
              {a.timeline.filter((s) => s.kind === "hold").length} holds ·{" "}
              {a.timeline.filter((s) => s.kind === "fast").length} fast · peaks{" "}
              {a.peaks.map((p) => `${f2(p.t)}s`).join(" ") || "—"}
            </dd>
          </>
        )}
        <dt>motion</dt>
        <dd className="mono">{motionText(a)}</dd>
        <dt>source</dt>
        <dd className="mono ref-src">
          {v.source.name} · {v.source.width}×{v.source.height} · trim{" "}
          {f2(v.trim.start)}–{f2(v.trim.end)}s{v.crop ? " · cropped" : ""} ·{" "}
          {a.frames.length} frames @ {a.fps} fps
        </dd>
        <dt>tags</dt>
        <dd>
          <input
            className="input"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            onBlur={() =>
              tags !== entry.tags.join(", ") &&
              void update({
                tags: tags
                  .split(",")
                  .map((t) => t.trim().toLowerCase())
                  .filter(Boolean),
              })
            }
            aria-label="Tags"
          />
        </dd>
        <dt>notes</dt>
        <dd>
          <textarea
            className="input ref-notes"
            rows={2}
            value={notes}
            placeholder="What matters in this clip (the critic and compose read it)"
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() =>
              notes !== (entry.notes ?? "") && void update({ notes })
            }
            aria-label="Notes"
          />
        </dd>
      </dl>

      <div className="ref-vision">
        <div className="ref-vision-head">
          <span className="mono">vision summary</span>
          {v.vision?.model && (
            <span className="faint mono">{v.vision.model}</span>
          )}
          <span className="grow" />
          <button
            className="btn small ghost"
            onClick={() => void describe()}
            disabled={describing}
            title="Send the contact sheet and key frames to the vision model (Labs critic tier)"
          >
            {describing ? (
              <span className="spinner" aria-hidden />
            ) : (
              <Icon name="eye" size={11} />
            )}{" "}
            {v.vision ? "Describe again" : "Describe"}
          </button>
        </div>
        {v.vision ? (
          <VisionView lab={lab} vision={v.vision} />
        ) : (
          <p className="note">
            {describing
              ? "Describing the key frames…"
              : "No vision summary yet. Compose still uses the measured beats, palette and key frames."}
          </p>
        )}
      </div>

      <RefPrincipleList video={v} />

      <div className="vfx-actions">
        <span className="grow" />
        <button
          className="btn small ghost danger"
          onClick={() => void remove()}
          aria-label="Delete"
        >
          <Icon name="trash" size={11} />
        </button>
      </div>
    </section>
  );
}

// What the reference is a good example of, per principle (vision notes first, then measured ones).
function RefPrincipleList({ video }: { video: VideoRef }) {
  const list = refPrinciples(video);
  if (!list.length) return null;
  return (
    <div className="ref-principles" aria-label="Principles this reference exemplifies">
      <div className="ref-vision-head">
        <span className="mono">exemplifies</span>
        <span className="faint mono">{list.length} principles</span>
      </div>
      <ul>
        {list.map((p) => (
          <li key={p.id}>
            <span className="mono ref-pr-id">{principleName(p.id)}</span>
            <span className="ref-pr-note">{p.note}</span>
            <span className="faint mono" title={p.source === "measured" ? "measured from the clip" : "from the vision model"}>
              {p.source === "measured" ? "m" : "v"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PaletteRow({
  label,
  colors,
}: {
  label: string;
  colors: { hex: string; share: number }[];
}) {
  if (!colors.length) return null;
  return (
    <>
      <dt
        className="ref-sub"
        style={{ ["--beat" as string]: BEAT_COLORS[label] }}
      >
        {label}
      </dt>
      <dd>
        <Swatches colors={colors} label={`${label} palette`} />
      </dd>
    </>
  );
}

function VisionView({
  lab,
  vision,
}: {
  lab: RefLab;
  vision: NonNullable<VideoRef["vision"]>;
}) {
  return (
    <div className="ref-vision-body">
      <p>{vision.summary}</p>
      {vision.layers?.length ? (
        <ul className="ref-layers">
          {vision.layers.map((l, i) => (
            <li key={i}>
              <span className="mono">{l.name}</span>{" "}
              <span className="faint">
                {[l.shape, l.color, l.motion, l.timing]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {vision.poses?.length ? (
        <ul className="ref-layers">
          {vision.poses.map((p, i) => (
            <li key={i}>
              <span className="mono" style={{ color: BEAT_COLORS[p.beat] }}>
                {p.beat}
              </span>{" "}
              <span className="faint">{p.pose}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {vision.timing && <p className="note">Timing: {vision.timing}</p>}
      {lab === "vfx" && vision.roblox && (
        <p className="note">Roblox: {vision.roblox}</p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ compare

// A result next to its pinned reference: the reference key frames on top, the rendered beats of one
// iteration below (paired in order), the critic's match and the numbers-only match.
export function RefCompare({
  lab,
  refId,
  entryId,
  frames,
  times,
  match,
  matchNotes,
  effect,
  clip,
  iteration,
}: {
  lab: RefLab;
  refId: string;
  entryId: string;
  frames: string[];
  times?: number[];
  match?: number;
  matchNotes?: string;
  effect?: VfxEffect;
  clip?: AnimClip;
  iteration?: number;
}) {
  const [ref, setRef] = useState<RefEntry | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let live = true;
    window.harness
      .refGet(refId)
      .then((r) => live && setRef(r))
      .catch(() => live && setMissing(true));
    return () => {
      live = false;
    };
  }, [refId]);
  const numeric = useMemo(() => {
    if (!ref) return null;
    try {
      return lab === "vfx" && effect
        ? vfxNumericMatch(effect, ref.video)
        : lab === "anim" && clip
          ? animNumericMatch(clip, ref.video)
          : null;
    } catch {
      return null;
    }
  }, [ref, effect, clip]);
  if (missing)
    return (
      <p className="note">
        The pinned reference ({refId}) is no longer in the library.
      </p>
    );
  if (!ref) return null;
  const keys = ref.video.analysis.keyFrames;
  const cols = Math.max(keys.length, Math.min(frames.length, 6), 1);
  return (
    <section
      className="ref-compare"
      aria-label={`Compared with the reference ${ref.name}`}
    >
      <header className="ref-compare-head">
        <Icon name="image" size={12} />
        <span className="mono">like {ref.name}</span>
        <span className="grow" />
        {match != null && (
          <span className="ref-match" title={matchNotes}>
            match <b className="mono">{match.toFixed(1)}</b>
          </span>
        )}
        {numeric && (
          <span className="faint mono" title={numeric.notes}>
            timing {numeric.timing.toFixed(1)}
            {numeric.palette != null
              ? ` · palette ${numeric.palette.toFixed(1)}`
              : ""}
          </span>
        )}
      </header>
      <div
        className="ref-compare-grid"
        style={{ gridTemplateColumns: `auto repeat(${cols}, minmax(0, 1fr))` }}
      >
        <span className="ref-row-label mono">reference</span>
        {Array.from({ length: cols }, (_, i) =>
          keys[i] ? (
            <KeyFrame
              key={`r${i}`}
              lab="ref"
              id={ref.id}
              file={keys[i].file}
              label={keys[i].label}
              t={keys[i].t}
            />
          ) : (
            <span key={`r${i}`} />
          ),
        )}
        <span className="ref-row-label mono">
          {iteration ? `#${iteration}` : "result"}
        </span>
        {Array.from({ length: cols }, (_, i) =>
          frames[i] ? (
            <ResultFrame
              key={`f${i}`}
              lab={lab}
              id={entryId}
              file={frames[i]}
              t={times?.[i]}
            />
          ) : (
            <span key={`f${i}`} className="ref-empty faint mono">
              {i === 0 && !frames.length
                ? "no frames yet: Refine renders the beats"
                : ""}
            </span>
          ),
        )}
      </div>
      {matchNotes && <p className="note">{matchNotes}</p>}
    </section>
  );
}

function ResultFrame({
  lab,
  id,
  file,
  t,
}: {
  lab: RefLab;
  id: string;
  file: string;
  t?: number;
}) {
  const url = useRefFile(lab, id, file);
  return (
    <figure className="ref-key result">
      <div className="ref-key-img">
        {url ? (
          <img
            src={url}
            alt={`Rendered frame${t != null ? ` at ${f2(t)} s` : ""}`}
            draggable={false}
          />
        ) : (
          <span className="vfx-frame-ph" />
        )}
      </div>
      <figcaption className="mono">
        <span>render</span>
        {t != null && <span className="faint">{f2(t)}s</span>}
      </figcaption>
    </figure>
  );
}

// The analysis' palette as text (cards, tooltips).
export function refPaletteText(v?: VideoRef): string {
  return v ? paletteText(v.analysis.palette.slice(0, 4)) : "";
}
