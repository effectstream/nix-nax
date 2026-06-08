# Explainer-video build

Tooling that turns the screen recording of a tic-tac-toe channel game into a
narrated, subtitled explainer (TTS narration + burned-in captions), timed to
the on-screen events.

## Pipeline

| Script | Role |
|--------|------|
| `timeline.py` | Single source of truth: per-segment start times (anchored to real on-screen events) + the narration/subtitle text. |
| `eleven.py` | ElevenLabs TTS client. Reads the API key from `.elevenlabs_key` or `$ELEVENLABS_API_KEY` (never hard-coded). `whoami` / `voices` / `tts` / `sample`. |
| `make_narration.py` | Places each natural-pace segment at its start time, mixes, loudness-normalizes to −16 LUFS → `narration.m4a`. |
| `build.py` | Renders caption PNGs with Pillow and composites them over the video with ffmpeg `overlay` (this ffmpeg has no libass), muxes the narration → `video.mp4`. Also writes `subs.srt`. |
| `generate_srt.py` | Standalone SRT/ASS generator (superseded by `build.py`). |
| `segments/*.txt` | The narration text per segment. |

## Usage

```bash
# 1. Provide your own ElevenLabs key (kept out of git by .gitignore)
printf '%s' 'YOUR_KEY' > .elevenlabs_key

# 2. Symlink the source recording as source.mov, then:
python3 eleven.py voices                  # pick a voice id
for i in $(seq 1 9); do python3 eleven.py tts $i <VOICE_ID>; done
python3 make_narration.py                 # -> narration.m4a
python3 build.py overlays && python3 build.py encode   # -> video.mp4
```

## Not committed

The API key (`.elevenlabs_key`), the source recording (`source.mov`), and all
generated media (`*.mp4`, `*.m4a`, `*.aiff`, caption PNGs, `el_audio/`,
`samples/`, …) are git-ignored — only the scripts and segment text are tracked.
