// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectRelay, localRelay } from "../src/api/ws.ts";

class MockWebSocket {
  static readonly OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  events = new Map<string, Array<(event: any) => void>>();
  constructor(readonly url: string) { MockWebSocket.instances.push(this); }
  addEventListener(type: string, listener: (event: any) => void) {
    this.events.set(type, [...(this.events.get(type) ?? []), listener]);
  }
  emit(type: string, event: any = {}) {
    for (const listener of this.events.get(type) ?? []) listener(event);
  }
  open() { this.readyState = MockWebSocket.OPEN; this.emit("open"); }
  send(message: string) { this.sent.push(message); }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  MockWebSocket.instances = [];
  vi.stubGlobal("window", { location: { protocol: "https:", host: "example.invalid" } });
  vi.stubGlobal("WebSocket", MockWebSocket);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("relay disposal", () => {
  it("cancels a pending network reconnect when the client closes", () => {
    const client = connectRelay("game-one", "x", vi.fn(), vi.fn());
    const original = MockWebSocket.instances[0];
    original.open();
    original.close();
    client.close();

    vi.advanceTimersByTime(5_000);

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(client.status).toBe("closed");
  });

  it("cancels pending local delivery to a disposed endpoint", () => {
    const receiveX = vi.fn();
    const x = localRelay("game-two", "x", receiveX, vi.fn());
    const o = localRelay("game-two", "o", vi.fn(), vi.fn());
    vi.runOnlyPendingTimers();

    o.send({ type: "event", addr: "game-two", kind: "before-close" });
    x.close();
    vi.runOnlyPendingTimers();

    expect(receiveX).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "before-close" }));
    o.close();
  });

  it("ignores sends after a local client is closed", () => {
    const receiveO = vi.fn();
    const x = localRelay("game-three", "x", vi.fn(), vi.fn());
    const o = localRelay("game-three", "o", receiveO, vi.fn());
    vi.runOnlyPendingTimers();
    receiveO.mockClear();
    x.close();

    x.send({ type: "event", addr: "game-three", kind: "after-close" });
    vi.runOnlyPendingTimers();

    expect(receiveO).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "after-close" }));
    o.close();
  });
});
