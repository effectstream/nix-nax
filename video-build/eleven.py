#!/usr/bin/env python3
"""Minimal ElevenLabs client for the explainer narration.

Reads the API key from .elevenlabs_key (or $ELEVENLABS_API_KEY) and never
prints it. Subcommands:
  whoami            -> validate key, show tier + character quota
  voices            -> list voices on the account
  tts N VOICE [SPD] -> synthesize segments/segN.txt -> el_audio/segN.mp3
"""
import sys, os, json, urllib.request, urllib.error

BUILD = "/Users/edwardalvarado/tictactoe-compact/video-build"
os.chdir(BUILD)
API = "https://api.elevenlabs.io/v1"

def key():
    k = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if not k and os.path.exists(".elevenlabs_key"):
        k = open(".elevenlabs_key").read().strip().strip('"').strip("'")
    if not k:
        sys.exit("No API key found in .elevenlabs_key or $ELEVENLABS_API_KEY")
    return k

def req(path, method="GET", body=None, accept="application/json"):
    headers = {"xi-api-key": key(), "Accept": accept}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    r = urllib.request.Request(API + path, data=data, headers=headers, method=method)
    return urllib.request.urlopen(r, timeout=60)

def whoami():
    try:
        u = json.load(req("/user"))
    except urllib.error.HTTPError as e:
        sys.exit(f"Key REJECTED — HTTP {e.code}: {e.read().decode()[:200]}")
    sub = u.get("subscription", {})
    used = sub.get("character_count"); lim = sub.get("character_limit")
    print("Key OK ✓")
    print(f"  tier:       {sub.get('tier')}")
    print(f"  characters: {used} / {lim}  (remaining: {None if lim is None else lim-used})")

def voices():
    data = json.load(req("/voices"))
    vs = data.get("voices", [])
    print(f"{len(vs)} voices on the account:\n")
    rows = sorted(vs, key=lambda v: (v.get("category",""), v.get("name","")))
    for v in rows:
        lab = v.get("labels") or {}
        desc = ", ".join(f"{k}={lab[k]}" for k in
                         ("gender","accent","age","use_case","description") if lab.get(k))
        print(f"  {v.get('name',''):<18} {v.get('voice_id','')}  [{v.get('category','')}]")
        if desc:
            print(f"      {desc}")

def synth(text, voice_id, out, speed=1.0):
    body = {
        "text": text,
        "model_id": "eleven_multilingual_v2",
        "voice_settings": {
            "stability": 0.5, "similarity_boost": 0.75,
            "style": 0.0, "use_speaker_boost": True, "speed": float(speed),
        },
    }
    os.makedirs(os.path.dirname(out), exist_ok=True)
    resp = req(f"/text-to-speech/{voice_id}?output_format=mp3_44100_128",
               method="POST", body=body, accept="audio/mpeg")
    with open(out, "wb") as f:
        f.write(resp.read())
    print(f"wrote {out} ({os.path.getsize(out)} bytes)")

def tts(n, voice_id, speed=1.0):
    text = open(f"segments/seg{n}.txt").read().strip()
    synth(text, voice_id, f"el_audio/seg{n}.mp3", speed)

def sample(voice_id, label):
    # Representative line incl. a technical term, so you hear how it handles them.
    text = ("This is a tic-tac-toe game on the Midnight blockchain. "
            "But it plays at memory speed. The mover reveals one Merkle-tree leaf, "
            "and the opponent verifies it against the root.")
    synth(text, voice_id, f"samples/{label}.mp3")

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "whoami"
    if cmd == "whoami":
        whoami()
    elif cmd == "voices":
        voices()
    elif cmd == "tts":
        tts(sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else 1.0)
    elif cmd == "sample":
        sample(sys.argv[2], sys.argv[3])
    else:
        sys.exit(f"unknown command: {cmd}")
