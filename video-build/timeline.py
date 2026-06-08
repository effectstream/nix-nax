#!/usr/bin/env python3
"""Single source of truth for narration timing + text.

Start times are anchored to the REAL on-screen events measured from the
recording (not the script's original estimates):
  0:15 X deploys · 0:30 O joins · 0:44-0:51 moves+diagonal ·
  0:52-0:72 settling · 0:73 settle lands · 0:74+ claim/settled.

All segments play at natural pace (no acceleration). seg5 is lightly
trimmed because the moves on screen take ~8s, not the script's ~14s.
"""
TOTAL = 95.404

# id -> (start_seconds, [sentence cues for subtitles])
# full TTS text for a segment = " ".join(cues)
SEGMENTS = {
    1: (0.0, [
        "This is a tic-tac-toe game on the Midnight blockchain.",
        "But it plays at memory speed.",
    ]),
    2: (5.6, [
        "Normally, every move would be a separate blockchain transaction.",
        "That's about twenty-five seconds each.",
        "A nine-move game would take three minutes.",
    ]),
    3: (15.0, [
        "Instead, we move the gameplay off-chain.",
        "On the left, player X is deploying the contract.",
        "They submit only their own Merkle root — a commitment to all the moves they might ever make.",
        "The channel opens in a half-open state.",
    ]),
    4: (30.0, [
        "On the right, player O pastes the contract address and submits their own commitments from their own browser.",
        "Two transactions, one per player.",
        "Neither side can substitute the other's commitments.",
        "The channel is now live.",
    ]),
    # seg5 — trimmed: moves on screen take ~8s, so this covers them, no more.
    5: (44.0, [
        "From here, the chain goes quiet.",
        "Each move goes over a WebSocket — the mover reveals one Merkle-tree leaf,",
        "and the opponent verifies it against the root.",
    ]),
    6: (54.0, [
        "X completes the diagonal. The local game ends.",
        "Now X submits one settle transaction.",
        "The contract replays every move and verifies every token's Merkle path under the right player's root.",
        "One proof, for the whole game.",
    ]),
    7: (73.0, [
        "Settle lands.",
        "The chain now records five committed turns and X as the winner.",
        "A short challenge window opens — during which a longer, valid history could override this result.",
    ]),
    8: (85.0, [
        "The window expires.",
        "X claims the result.",
        "Status: settled.",
    ]),
    9: (89.5, [
        "One game. Four chain transactions.",
        "The rest, at memory speed.",
    ]),
}

def text(i):
    return " ".join(SEGMENTS[i][1])

def order():
    return sorted(SEGMENTS)
