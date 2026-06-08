#!/usr/bin/env python3
"""Generate a precisely-synced SRT from the segment audio durations.

Each segment starts at a fixed timestamp (synced to on-screen action).
Within a segment we split into sentence-level cues and allocate the
segment's measured audio duration to each cue proportional to its length.
"""
import subprocess, textwrap, os

BUILD = "/Users/edwardalvarado/tictactoe-compact/video-build"
os.chdir(BUILD)

def dur(path):
    out = subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", path]).decode().strip()
    return float(out)

# (start_seconds, audio_file, [sentence cues])
segments = [
    (0,  "audio/seg1.aiff", [
        "This is a tic-tac-toe game on the Midnight blockchain.",
        "But it plays at memory speed.",
    ]),
    (5,  "audio/seg2.aiff", [
        "Normally, every move would be a separate blockchain transaction.",
        "That's about twenty-five seconds each.",
        "A nine-move game would take three minutes.",
    ]),
    (15, "audio/seg3.aiff", [
        "Instead, we move the gameplay off-chain.",
        "On the left, player X is deploying the contract.",
        "They submit only their own Merkle root — a commitment to all the moves they might ever make.",
        "The channel opens in a half-open state.",
    ]),
    (30, "audio/seg4.aiff", [
        "On the right, player O pastes the contract address and submits their own commitments from their own browser.",
        "Two transactions, one per player.",
        "Neither side can substitute the other's commitments.",
        "The channel is now live.",
    ]),
    (45, "audio/seg5.aiff", [
        "From here, the chain goes quiet.",
        "Each move is exchanged directly over a WebSocket.",
        "The mover reveals one Merkle-tree leaf — the secret bound to that exact turn and cell.",
        "The opponent verifies the path against the root they already know.",
    ]),
    (55, "audio/seg6.aiff", [
        "X completes the diagonal. The local game ends.",
        "Now X submits one settle transaction.",
        "The contract replays every move and verifies every token's Merkle path under the right player's root.",
        "One proof, for the whole game.",
    ]),
    (65, "audio/seg7.aiff", [
        "Settle lands.",
        "The chain now records five committed turns and X as the winner.",
        "A short challenge window opens — during which a longer, valid history could override this result.",
    ]),
    (80, "audio/seg8.aiff", [
        "The window expires.",
        "X claims the result.",
        "Status: settled.",
    ]),
    (90, "audio/seg9.aiff", [
        "One game. Four chain transactions.",
        "The rest, at memory speed.",
    ]),
]

def fmt(t):
    h = int(t // 3600); t -= h * 3600
    m = int(t // 60);   t -= m * 60
    s = int(t);         ms = int(round((t - s) * 1000))
    if ms == 1000:
        s += 1; ms = 0
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

def fmt_ass(t):
    h = int(t // 3600); t -= h * 3600
    m = int(t // 60);   t -= m * 60
    return f"{h:d}:{m:02d}:{t:05.2f}"

def wrap(text, width=42):
    return "\n".join(textwrap.wrap(text, width=width))

cues = []
for start, audio, parts in segments:
    d = dur(audio)
    total = sum(len(p) for p in parts)
    t = start
    for p in parts:
        share = d * (len(p) / total)
        cues.append((t, t + share, wrap(p)))
        t += share

with open("subs.srt", "w") as f:
    for i, (st, en, text) in enumerate(cues, 1):
        f.write(f"{i}\n{fmt(st)} --> {fmt(en)}\n{text}\n\n")

# Styled ASS for burn-in (PlayRes matches the scaled 1920-wide output).
ASS_HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1154
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Helvetica,42,&H00FFFFFF,&H000000FF,&H00000000,&H40000000,1,0,0,0,100,100,0,0,3,6,0,2,80,80,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, Effect, Text
"""

with open("subs.ass", "w") as f:
    f.write(ASS_HEADER)
    for st, en, text in cues:
        t = text.replace("\n", "\\N")
        f.write(f"Dialogue: 0,{fmt_ass(st)},{fmt_ass(en)},Default,,0,0,0,,{t}\n")

print(f"Wrote {len(cues)} cues to subs.srt and subs.ass")
for i, (st, en, text) in enumerate(cues, 1):
    print(f"{i:2d}  {fmt(st)} --> {fmt(en)}  | {text.replace(chr(10),' / ')}")
