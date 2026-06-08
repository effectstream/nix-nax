#!/usr/bin/env python3
"""Build the narrated, subtitled tic-tac-toe explainer.

This ffmpeg has no libass/freetype, so subtitles are rendered to transparent
PNGs with Pillow and composited with ffmpeg's `overlay` filter (time-gated).

Stages (argv[1]):
  subs      -> write subs.srt (for delivery)
  overlays  -> render overlay/cueNN.png for every cue
  test T N  -> composite cue N over source frame at time T -> test_composite.png
  encode    -> render the final video.mp4
  all       -> subs + overlays + encode
"""
import subprocess, sys, os, json, textwrap
from PIL import Image, ImageDraw, ImageFont

BUILD = "/Users/edwardalvarado/tictactoe-compact/video-build"
os.chdir(BUILD)

# ---- output geometry (source 3834x2304 -> logical 1x) -------------------
W, H = 1920, 1154

# ---- caption style ------------------------------------------------------
FONT_PATH    = "/System/Library/Fonts/HelveticaNeue.ttc"
FONT_SIZE    = 40
LINE_SP      = 1.20          # line-height multiple
MAX_BOX_W    = int(W * 0.88) # caption box max width
PAD_X, PAD_Y = 32, 18
BOTTOM_MARG  = 70
RADIUS       = 18
BOX_FILL     = (0, 0, 0, 175)
TEXT_FILL    = (255, 255, 255, 255)
STROKE_W     = 0
STROKE_FILL  = (0, 0, 0, 255)

# ---- narration segments come from the single-source timeline -----------
import timeline
SEGMENTS = [(timeline.SEGMENTS[i][0], f"final_audio/seg{i}.wav", timeline.SEGMENTS[i][1])
            for i in timeline.order()]

def dur(path):
    out = subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", path]).decode().strip()
    return float(out)

def build_cues():
    """Return list of dicts: {start, end, text}."""
    cues = []
    for start, audio, parts in SEGMENTS:
        d = dur(audio)
        total = sum(len(p) for p in parts)
        t = start
        for p in parts:
            share = d * (len(p) / total)
            cues.append({"start": round(t, 3), "end": round(t + share, 3), "text": p})
            t += share
    return cues

# ---- font + wrapping -----------------------------------------------------
_font = None
def font():
    global _font
    if _font is None:
        _font = ImageFont.truetype(FONT_PATH, FONT_SIZE)
    return _font

_meas = ImageDraw.Draw(Image.new("RGBA", (10, 10)))
def text_w(s):
    b = _meas.textbbox((0, 0), s, font=font(), stroke_width=STROKE_W)
    return b[2] - b[0]

def wrap_px(text, max_w):
    words, lines, cur = text.split(), [], ""
    for w in words:
        trial = w if not cur else cur + " " + w
        if text_w(trial) <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur); cur = w
    if cur:
        lines.append(cur)
    return lines

# ---- SRT (for delivery) --------------------------------------------------
def fmt_srt(t):
    h = int(t // 3600); t -= h * 3600
    m = int(t // 60);   t -= m * 60
    s = int(t);         ms = int(round((t - s) * 1000))
    if ms == 1000: s += 1; ms = 0
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

def write_srt(cues):
    with open("subs.srt", "w") as f:
        for i, c in enumerate(cues, 1):
            body = "\n".join(textwrap.wrap(c["text"], width=42))
            f.write(f"{i}\n{fmt_srt(c['start'])} --> {fmt_srt(c['end'])}\n{body}\n\n")
    print(f"wrote subs.srt ({len(cues)} cues)")

# ---- overlay PNGs --------------------------------------------------------
def render_cue_png(text, path):
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    lines = wrap_px(text, MAX_BOX_W - 2 * PAD_X)
    line_h = int(FONT_SIZE * LINE_SP)
    text_block_h = line_h * len(lines)
    box_w = max(text_w(ln) for ln in lines) + 2 * PAD_X
    box_h = text_block_h + 2 * PAD_Y
    box_x0 = (W - box_w) // 2
    box_y1 = H - BOTTOM_MARG
    box_y0 = box_y1 - box_h
    d.rounded_rectangle([box_x0, box_y0, box_x0 + box_w, box_y1],
                        radius=RADIUS, fill=BOX_FILL)
    y = box_y0 + PAD_Y
    for ln in lines:
        lw = text_w(ln)
        d.text((((W - lw) // 2), y), ln, font=font(), fill=TEXT_FILL,
               stroke_width=STROKE_W, stroke_fill=STROKE_FILL)
        y += line_h
    img.save(path)
    return len(lines)

def render_overlays(cues):
    os.makedirs("overlay", exist_ok=True)
    for i, c in enumerate(cues, 1):
        n = render_cue_png(c["text"], f"overlay/cue{i:02d}.png")
        print(f"  cue{i:02d} ({n} line(s))  {c['start']:.2f}-{c['end']:.2f}  {c['text'][:48]}")
    json.dump(cues, open("cues.json", "w"), indent=2)
    print(f"rendered {len(cues)} overlay PNGs")

# ---- ffmpeg encode -------------------------------------------------------
def encode(cues):
    inputs = ["-i", "source.mov"]
    for i in range(1, len(cues) + 1):
        inputs += ["-i", f"overlay/cue{i:02d}.png"]
    inputs += ["-i", "narration.m4a"]
    audio_idx = len(cues) + 1

    fc = [f"[0:v]scale={W}:{H},setsar=1[bg]"]
    prev = "bg"
    for i, c in enumerate(cues, 1):
        out = f"v{i}"
        fc.append(f"[{prev}][{i}:v]overlay=x=0:y=0:eof_action=repeat:"
                  f"enable='between(t,{c['start']},{c['end']})'[{out}]")
        prev = out
    filter_complex = ";".join(fc)

    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-stats", *inputs,
           "-filter_complex", filter_complex,
           "-map", f"[{prev}]", "-map", f"{audio_idx}:a",
           "-c:v", "libx264", "-preset", "medium", "-crf", "20",
           "-pix_fmt", "yuv420p", "-movflags", "+faststart",
           "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
           "video.mp4"]
    open("filter_complex.txt", "w").write(filter_complex)
    print("running ffmpeg encode ...")
    subprocess.run(cmd, check=True)
    print("wrote video.mp4")

# ---- test composite ------------------------------------------------------
def test(t, n):
    cues = build_cues()
    render_cue_png(cues[n - 1]["text"], f"overlay/cue{n:02d}.png")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", str(t),
                    "-i", "source.mov", "-vf", f"scale={W}:{H}",
                    "-frames:v", "1", "frame.png"], check=True)
    base = Image.open("frame.png").convert("RGBA")
    over = Image.open(f"overlay/cue{n:02d}.png").convert("RGBA")
    Image.alpha_composite(base, over).convert("RGB").save("test_composite.png")
    print(f"wrote test_composite.png (cue {n}: {cues[n-1]['text']})")

if __name__ == "__main__":
    stage = sys.argv[1] if len(sys.argv) > 1 else "all"
    if stage == "subs":
        write_srt(build_cues())
    elif stage == "overlays":
        render_overlays(build_cues())
    elif stage == "test":
        test(float(sys.argv[2]), int(sys.argv[3]))
    elif stage == "encode":
        encode(build_cues())
    elif stage == "all":
        c = build_cues(); write_srt(c); render_overlays(c); encode(c)
    else:
        print("unknown stage", stage)
