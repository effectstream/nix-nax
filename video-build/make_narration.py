#!/usr/bin/env python3
"""Place each natural-pace Brian segment at its timeline start and mix.

No acceleration: every segment plays at ElevenLabs' natural 1.0x pace.
Start times come from timeline.py (anchored to real on-screen events).
Output: narration.m4a (loudness-normalized, 95.404s).
"""
import subprocess, os
import timeline
BUILD = "/Users/edwardalvarado/tictactoe-compact/video-build"
os.chdir(BUILD)
SR = 48000
TOTAL = timeline.TOTAL

def dur(p):
    return float(subprocess.check_output(
        ["ffprobe","-v","error","-show_entries","format=duration",
         "-of","csv=p=0",p]).decode().strip())

os.makedirs("final_audio", exist_ok=True)
ids = timeline.order()
finals = []
for i in ids:
    start = timeline.SEGMENTS[i][0]
    src = f"el_audio/seg{i}.mp3"
    out = f"final_audio/seg{i}.wav"
    subprocess.run(["ffmpeg","-y","-loglevel","error","-i",src,
                    "-af",f"aresample={SR}","-ar",str(SR),"-ac","1",out], check=True)
    finals.append((i, start, out, dur(out)))

inputs, fc = [], []
for idx, (i, start, out, d) in enumerate(finals):
    inputs += ["-i", out]
    ms = int(round(start * 1000))
    fc.append(f"[{idx}:a]adelay={ms}|{ms}[a{idx}]")
fc.append("".join(f"[a{idx}]" for idx in range(len(finals))) +
          f"amix=inputs={len(finals)}:normalize=0:dropout_transition=0[m]")
fc.append(f"[m]loudnorm=I=-16:TP=-1.5:LRA=11,aresample={SR},apad,atrim=0:{TOTAL}[out]")
subprocess.run(["ffmpeg","-y","-loglevel","error",*inputs,
                "-filter_complex",";".join(fc),"-map","[out]",
                "-c:a","aac","-b:a","192k","-ar",str(SR),"-ac","2",
                "narration.m4a"], check=True)

print(f"{'seg':<4}{'start':>7}{'dur':>7}{'end':>7}{'next':>7}  fit")
ok = True
for n, (i, start, out, d) in enumerate(finals):
    nxt = timeline.SEGMENTS[ids[n+1]][0] if n + 1 < len(ids) else TOTAL
    end = start + d
    fit = end <= nxt - 0.05
    ok = ok and fit
    print(f"{i:<4}{start:>7.2f}{d:>7.2f}{end:>7.2f}{nxt:>7.2f}  {'OK' if fit else 'OVERLAP!'}")
print(f"narration.m4a = {dur('narration.m4a'):.3f}s   {'ALL OK' if ok else 'HAS OVERLAPS'}")
