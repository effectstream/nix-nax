// This file is part of effectstream/nix-nax.
// Copyright (c) 2026 the Nix-Nax authors
// SPDX-License-Identifier: MIT OR Apache-2.0

// 3D game surface — three.js. Futuristic table with a neon 4×4 grid; pieces
// are square-based pyramids (ConeGeometry with 4 radial segments) in three
// sizes; each player's remaining pyramids are lined up OUTSIDE the table on
// their side and double as the size picker. Moves are animated: placements
// descend from above, removals lift off and fly back to the owner's reserve.
//
// Place mode uses a "held" piece: the selected size lifts out of the reserve
// and floats under the cursor over the board (green over a legal cell, red
// otherwise), so you can see exactly where it will land. A piece is therefore
// always in one of three places: the reserve tray, your cursor, or the board.
//
// The component owns an imperative scene controller; React props flow into
// it on every render (board diffing drives the animations).

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { reserveIndex, SIZES, type Mark } from "../../../src/sdk/game/rules.ts";

export type BoardMode = "view" | "place" | "remove";

export interface Board3DProps {
  board: Uint8Array;              // 64 (cell*4+layer -> mark)
  reserves: Uint8Array;           // 8 ((mark-1)*4+size -> count)
  myMark: Mark;
  mode: BoardMode;
  actionableCells?: Set<number>;
  selectedSize?: number;
  onSelectSize?: (size: number) => void;
  onCellClick?: (cell: number) => void;
  active?: boolean;
  spectator?: boolean;            // lobby preview: no fixed side, slow auto-orbit
}

// ── Layout constants ────────────────────────────────────────────────────────

const CELL = 2.2;                          // grid pitch
const TILE = 2.0;                          // visible tile size
const HALF_GRID = 2 * CELL;                // grid extent from centre (4.4)
const PIECE_DIMS = [
  { r: 0.32, h: 0.48 },                    // 0 = smallest
  { r: 0.50, h: 0.78 },                    // 1
  { r: 0.68, h: 1.06 },                    // 2
  { r: 0.86, h: 1.34 },                    // 3 = largest (still fits a 2.0 tile)
];
const X_COLOR = 0xff8d8d;
const O_COLOR = 0x6fb3ff;
const TEAL = 0x16e0c8;
const AMBER = 0xffb84d;
const BAD = 0xff5566;

// Table is sized to comfortably frame the grid AND hold both reserve rows
// (now 4 lanes per side).
const TABLE_W = 17.6;
const TABLE_D = 15.4;

const cellX = (c: number) => ((c % 4) - 1.5) * CELL;
const cellZ = (c: number) => (Math.floor(c / 4) - 1.5) * CELL;

// Reserve rows sit just outside the grid: mark 1 (X) near side (+z), mark 2 (O)
// far side (−z). Within a row each size is its own lane; lanes are spaced from
// the actual piece radii so NO two pieces touch (the old fixed 0.95 step let
// the normal/large pyramids overlap — only the small had a real margin).
const reserveZ = (mark: number) => (mark === 1 ? 5.9 : -5.9);
const PIECE_MARGIN = 0.16;                 // clear gap between same-size pieces
const LANE_GAP = 0.5;                      // gap between size groups
const laneStep = (size: number) => 2 * PIECE_DIMS[size].r + PIECE_MARGIN;
const laneHalf = (size: number) => laneStep(size) + PIECE_DIMS[size].r;
// One lane per size; block-centred. Generic over PIECE_DIMS.length (4 now).
const LANE_CENTER = (() => {
  const widths = PIECE_DIMS.map((_, s) => 2 * laneHalf(s));
  const total = widths.reduce((a, b) => a + b, 0) + (PIECE_DIMS.length - 1) * LANE_GAP;
  let cur = -total / 2;
  const centers: number[] = [];
  for (let s = 0; s < PIECE_DIMS.length; s++) {
    centers[s] = cur + widths[s] / 2;
    cur += widths[s] + LANE_GAP;
  }
  return centers;
})();
const reserveX = (size: number, i: number) => LANE_CENTER[size] + (i - 1) * laneStep(size);

// ── Tiny tween system (driven by the render loop) ───────────────────────────

interface Tween {
  obj: THREE.Object3D;
  from: THREE.Vector3;
  to: THREE.Vector3;
  start: number;
  dur: number;
  arc?: number;                 // extra mid-flight height
  onDone?: () => void;
}
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

// ── Scene controller ────────────────────────────────────────────────────────

interface Controller {
  update(props: Board3DProps): void;
  dispose(): void;
}

function makePyramid(mark: number, size: number): THREE.Mesh {
  const { r, h } = PIECE_DIMS[size];
  const geo = new THREE.ConeGeometry(r, h, 4, 1);
  geo.rotateY(Math.PI / 4); // square base aligned with the grid
  const color = mark === 1 ? X_COLOR : O_COLOR;
  const mat = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.32,
    metalness: 0.55,
    roughness: 0.3,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData = { mark, size };
  return mesh;
}

function disposeMesh(m: THREE.Mesh) {
  (m.material as THREE.Material).dispose();
  m.geometry.dispose();
}

function createController(mount: HTMLDivElement): Controller {
  let props: Board3DProps | null = null;
  let prevBoard = new Uint8Array(64);
  let disposed = false;

  // Renderer / scene / camera.
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05070e);
  scene.fog = new THREE.Fog(0x05070e, 48, 190);

  const camera = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 240);
  camera.position.set(0, 16.4, 22);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, -0.6, 0);
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 11;
  controls.maxDistance = 36;
  controls.minPolarAngle = 0.55;
  controls.maxPolarAngle = 1.36;
  controls.autoRotateSpeed = 0.3;

  // Lights.
  const ambient = new THREE.AmbientLight(0xbfd4ff, 0.5);
  const key = new THREE.DirectionalLight(0xffffff, 1.0);
  key.position.set(6, 14, 8);
  const glowX = new THREE.PointLight(X_COLOR, 22, 26);
  glowX.position.set(0, 2.4, 7.6);
  const glowO = new THREE.PointLight(O_COLOR, 22, 26);
  glowO.position.set(0, 2.4, -7.6);
  scene.add(ambient, key, glowX, glowO);

  // ── Deep-space backdrop ─────────────────────────────────────────────────
  // Drifting asteroid field, a starfield shell, and a distant planet — the
  // table floats in space. World-space, so orbiting the camera parallaxes it.
  const disposables: { dispose(): void }[] = [];
  const rand = (a: number, b: number) => a + Math.random() * (b - a);

  {
    // Starfield: points on a large shell. Each star is a soft round sprite (a
    // radial-gradient texture, not the default square), with per-star
    // brightness variation and an occasional warm-yellow or cool-blue tint.
    const starTex = (() => {
      const s = 64;
      const cv = document.createElement("canvas");
      cv.width = cv.height = s;
      const ctx = cv.getContext("2d")!;
      const grd = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      grd.addColorStop(0, "rgba(255,255,255,1)");
      grd.addColorStop(0.45, "rgba(255,255,255,0.7)");
      grd.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, s, s);
      return new THREE.CanvasTexture(cv);
    })();
    const N = 2400;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const c = new THREE.Color();
    for (let i = 0; i < N; i++) {
      const theta = 2 * Math.PI * Math.random();
      const phi = Math.acos(2 * Math.random() - 1);
      const r = rand(85, 160);
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.cos(phi);
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
      const t = Math.random();
      let hue: number, sat: number;
      if (t < 0.56) { hue = 0.6; sat = rand(0.0, 0.08); }                 // ~white
      else if (t < 0.79) { hue = rand(0.55, 0.63); sat = rand(0.3, 0.6); } // cool blue
      else { hue = rand(0.09, 0.14); sat = rand(0.3, 0.55); }             // warm yellow
      c.setHSL(hue, sat, rand(0.4, 1.0));                                 // brightness varies
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    const m = new THREE.PointsMaterial({
      size: 1.5, sizeAttenuation: true, vertexColors: true, map: starTex,
      transparent: true, opacity: 1.0, fog: false, depthWrite: false,
    });
    scene.add(new THREE.Points(g, m));
    disposables.push(g, m, starTex);
  }

  // Distant celestial bodies with a soft back-lit atmosphere. One is placed
  // ahead of each player's side (X looks toward −z, O toward +z) so both see a
  // focal backdrop; the lobby's slow orbit sweeps past both.
  const makePlanet = (
    radius: number, x: number, y: number, z: number,
    color: number, emissive: number, atmo: number, atmoR: number,
  ) => {
    const pg = new THREE.SphereGeometry(radius, 40, 40);
    const pm = new THREE.MeshStandardMaterial({ color, emissive, emissiveIntensity: 0.5, roughness: 1, metalness: 0 });
    const planet = new THREE.Mesh(pg, pm);
    planet.position.set(x, y, z);
    const ag = new THREE.SphereGeometry(atmoR, 40, 40);
    const am = new THREE.MeshBasicMaterial({ color: atmo, transparent: true, opacity: 0.14, side: THREE.BackSide, fog: false });
    const shell = new THREE.Mesh(ag, am);
    shell.position.set(x, y, z);
    scene.add(planet, shell);
    disposables.push(pg, pm, ag, am);
  };
  makePlanet(13, -15, 1, -54, 0x223a57, 0x12365a, 0x3aa0ff, 14.6);  // blue planet — X's side
  makePlanet(7, 17, 3, 50, 0x4a3b2e, 0x3a2a18, 0xffb877, 7.9);      // amber moon — O's side

  const asteroids = new THREE.Group();
  {
    const rockMat = new THREE.MeshStandardMaterial({
      color: 0x7b8493, roughness: 0.95, metalness: 0.08, flatShading: true,
    });
    disposables.push(rockMat);
    for (let i = 0; i < 18; i++) {
      const g = new THREE.IcosahedronGeometry(rand(0.35, 1.5), 0);
      disposables.push(g);
      const m = new THREE.Mesh(g, rockMat);
      const r = rand(17, 42), ang = Math.random() * Math.PI * 2;
      m.position.set(Math.cos(ang) * r, rand(-9, 17), Math.sin(ang) * r);
      m.rotation.set(rand(0, Math.PI), rand(0, Math.PI), rand(0, Math.PI));
      m.scale.set(1, rand(0.7, 1.0), rand(0.8, 1.0));
      m.userData.sx = rand(-0.004, 0.004);
      m.userData.sy = rand(-0.004, 0.004);
      asteroids.add(m);
    }
    scene.add(asteroids);
  }

  // Table platform — the dark slab that frames the grid and holds the reserves.
  const table = new THREE.Mesh(
    new THREE.BoxGeometry(TABLE_W, 0.5, TABLE_D),
    new THREE.MeshStandardMaterial({ color: 0x2a2f37, metalness: 0.6, roughness: 0.5 }),
  );
  table.position.y = -0.27;
  scene.add(table);
  // Outer rim glow.
  const rim = new THREE.Mesh(
    new THREE.BoxGeometry(TABLE_W + 0.5, 0.12, TABLE_D + 0.5),
    new THREE.MeshStandardMaterial({ color: 0x16344f, emissive: TEAL, emissiveIntensity: 0.25 }),
  );
  rim.position.y = -0.5;
  scene.add(rim);
  // Reserve trays: subtly inset strips marking each player's row.
  for (const mark of [1, 2]) {
    const apron = new THREE.Mesh(
      new THREE.BoxGeometry(TABLE_W - 1.0, 0.16, 2.7),
      new THREE.MeshStandardMaterial({
        color: 0x0a111e,
        emissive: mark === 1 ? X_COLOR : O_COLOR,
        emissiveIntensity: 0.06,
        metalness: 0.7,
        roughness: 0.5,
      }),
    );
    apron.position.set(0, -0.14, reserveZ(mark));
    scene.add(apron);
  }

  // Neon grid lines.
  const gridMat = new THREE.LineBasicMaterial({ color: TEAL, transparent: true, opacity: 0.65 });
  const gridGeo = new THREE.BufferGeometry();
  const pts: number[] = [];
  for (let i = 0; i <= 4; i++) {
    const v = -HALF_GRID + i * CELL;
    pts.push(-HALF_GRID, 0.012, v, HALF_GRID, 0.012, v);
    pts.push(v, 0.012, -HALF_GRID, v, 0.012, HALF_GRID);
  }
  gridGeo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  scene.add(new THREE.LineSegments(gridGeo, gridMat));

  // Cell tiles (raycast targets + highlights).
  const tiles: THREE.Mesh[] = [];
  for (let c = 0; c < 16; c++) {
    const tile = new THREE.Mesh(
      new THREE.BoxGeometry(TILE, 0.06, TILE),
      new THREE.MeshStandardMaterial({
        color: 0x13203a,
        emissive: 0x000000,
        emissiveIntensity: 0.0,
        transparent: true,
        opacity: 0.92,
      }),
    );
    tile.position.set(cellX(c), -0.015, cellZ(c));
    tile.userData = { kind: "cell", cell: c };
    scene.add(tile);
    tiles.push(tile);
  }

  // Piece registries.
  const boardPieces = new Map<string, THREE.Mesh>();   // `${cell}:${layer}`
  const reservePieces: THREE.Mesh[] = [];
  const tweens: Tween[] = [];

  const pieceRestY = (size: number) => PIECE_DIMS[size].h / 2 + 0.02;
  const reserveY = (size: number) => PIECE_DIMS[size].h / 2 - 0.06;

  function addBoardPiece(cell: number, layer: number, mark: number, animateFrom?: THREE.Vector3) {
    const mesh = makePyramid(mark, layer);
    const rest = new THREE.Vector3(cellX(cell), pieceRestY(layer), cellZ(cell));
    mesh.position.copy(animateFrom ?? rest);
    scene.add(mesh);
    boardPieces.set(`${cell}:${layer}`, mesh);
    if (animateFrom) {
      tweens.push({ obj: mesh, from: animateFrom.clone(), to: rest, start: performance.now(), dur: 520 });
    }
  }

  // ── Held piece (place mode) ───────────────────────────────────────────────
  // While in place mode the selected size is "in hand": removed from the
  // reserve row and floated under the cursor. A turn starts with nothing
  // selected — `holding` only becomes true once the player clicks one of their
  // own reserve pieces (no auto-grab), and a click on the board / Esc drops it.
  let heldMesh: THREE.Mesh | null = null;
  let holding = false;
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const groundHit = new THREE.Vector3();
  const ndc = new THREE.Vector2(0, -0.3);  // last pointer in NDC
  let pointerInside = false;

  const heldAvailable = (p: Board3DProps) =>
    (p.reserves[reserveIndex(p.myMark, p.selectedSize ?? 0)] ?? 0) > 0;

  function ensureHeld(size: number, mark: number) {
    if (heldMesh && heldMesh.userData.size === size && heldMesh.userData.mark === mark) return;
    clearHeld();
    heldMesh = makePyramid(mark, size);
    heldMesh.userData = { kind: "held", size, mark };
    const mat = heldMesh.material as THREE.MeshStandardMaterial;
    mat.transparent = true;
    mat.opacity = 0.9;
    scene.add(heldMesh);
  }
  function clearHeld() {
    if (heldMesh) {
      scene.remove(heldMesh);
      disposeMesh(heldMesh);
      heldMesh = null;
    }
  }

  // Which cell (if any) the cursor is over, from a ground-plane hit.
  function cellFromGround(x: number, z: number): { cell: number; inside: boolean } {
    const col = Math.round(x / CELL + 1.5);
    const row = Math.round(z / CELL + 1.5);
    const inside =
      col >= 0 && col <= 3 && row >= 0 && row <= 3 &&
      Math.abs(x) <= HALF_GRID + 0.3 && Math.abs(z) <= HALF_GRID + 0.3;
    return { cell: row * 4 + col, inside };
  }

  function positionHeld(now: number) {
    if (!heldMesh || !props) return;
    const size = heldMesh.userData.size as number;
    const ownColor = props.myMark === 1 ? X_COLOR : O_COLOR;
    const mat = heldMesh.material as THREE.MeshStandardMaterial;
    const bob = Math.sin(now / 260) * 0.12;
    // tint both the diffuse color and the emissive so the legal/illegal state
    // reads at a glance (the piece's own coral/blue would otherwise dominate).
    const tint = (hex: number, intensity: number) => {
      mat.color.setHex(hex);
      mat.emissive.setHex(hex);
      mat.emissiveIntensity = intensity;
    };
    raycaster.setFromCamera(ndc, camera);
    const hit = pointerInside ? raycaster.ray.intersectPlane(groundPlane, groundHit) : null;
    if (hit) {
      const { cell, inside } = cellFromGround(groundHit.x, groundHit.z);
      if (inside) {
        // Snap to the exact spot the piece will land — resting on the cell —
        // with only a small bob so it still reads as a live preview.
        heldMesh.position.set(cellX(cell), pieceRestY(size) + 0.2 + bob * 0.5, cellZ(cell));
        const ok = !!props.actionableCells?.has(cell);
        tint(ok ? TEAL : BAD, ok ? 0.95 : 0.7);
        return;
      }
      heldMesh.position.set(
        THREE.MathUtils.clamp(groundHit.x, -TABLE_W / 2 + 1, TABLE_W / 2 - 1),
        pieceRestY(size) + 1.5 + bob,
        THREE.MathUtils.clamp(groundHit.z, -TABLE_D / 2 + 1, TABLE_D / 2 - 1),
      );
      tint(ownColor, 0.5);
      return;
    }
    // Cursor off the canvas: rest the piece hovering over its own lane.
    heldMesh.position.set(reserveX(size, 1), reserveY(size) + 1.4 + bob, reserveZ(props.myMark));
    tint(ownColor, 0.5);
  }

  function rebuildReserves() {
    if (!props) return;
    const { reserves, myMark, selectedSize, mode } = props;
    const placeMode = mode === "place";
    for (const m of reservePieces) {
      scene.remove(m);
      disposeMesh(m);
    }
    reservePieces.length = 0;
    for (const mark of [1, 2] as const) {
      for (let size = 0; size < SIZES; size++) {
        let count = reserves[reserveIndex(mark, size)];
        // A held piece is one the player has lifted out of this row.
        if (holding && mark === myMark && size === selectedSize) count = Math.max(0, count - 1);
        for (let i = 0; i < count; i++) {
          const mesh = makePyramid(mark, size);
          mesh.position.set(reserveX(size, i), reserveY(size), reserveZ(mark));
          mesh.userData = { kind: "reserve", mark, size };
          if (mark === myMark && placeMode && holding && selectedSize === size) {
            (mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.85; // held lane glows
          }
          scene.add(mesh);
          reservePieces.push(mesh);
        }
      }
    }
  }

  // Full rebuild of board pieces from a board array (no animation).
  function rebuildBoard(board: Uint8Array) {
    for (const m of boardPieces.values()) {
      scene.remove(m);
      disposeMesh(m);
    }
    boardPieces.clear();
    for (let c = 0; c < 16; c++) {
      for (let layer = 0; layer < SIZES; layer++) {
        const mark = board[c * SIZES + layer];
        if (mark !== 0) addBoardPiece(c, layer, mark);
      }
    }
  }

  // Diff-driven update: animate the (single) added/removed piece.
  function applyBoard(board: Uint8Array) {
    let added: { cell: number; layer: number; mark: number } | null = null;
    let removed: { cell: number; layer: number; mark: number } | null = null;
    let changes = 0;
    for (let c = 0; c < 16; c++) {
      for (let layer = 0; layer < SIZES; layer++) {
        const before = prevBoard[c * SIZES + layer];
        const after = board[c * SIZES + layer];
        if (before === after) continue;
        changes++;
        if (before === 0 && after !== 0) added = { cell: c, layer, mark: after };
        else if (before !== 0 && after === 0) removed = { cell: c, layer, mark: before };
        else { added = { cell: c, layer, mark: after }; removed = { cell: c, layer, mark: before }; }
      }
    }
    prevBoard = new Uint8Array(board);
    if (changes === 0) return;
    if (changes > 1 || (added && removed)) {
      // Restores / bulk changes: rebuild without choreography.
      rebuildBoard(board);
      return;
    }
    if (added) {
      // Placement: descend from above.
      const from = new THREE.Vector3(cellX(added.cell), 6.5, cellZ(added.cell));
      addBoardPiece(added.cell, added.layer, added.mark, from);
    }
    if (removed) {
      // Removal: lift + fly back to the OWNER's reserve row.
      const key = `${removed.cell}:${removed.layer}`;
      const mesh = boardPieces.get(key);
      boardPieces.delete(key);
      if (mesh) {
        const to = new THREE.Vector3(
          reserveX(removed.layer, 1),
          reserveY(removed.layer),
          reserveZ(removed.mark),
        );
        tweens.push({
          obj: mesh,
          from: mesh.position.clone(),
          to,
          start: performance.now(),
          dur: 680,
          arc: 3.2,
          onDone: () => {
            scene.remove(mesh);
            disposeMesh(mesh);
            rebuildReserves();
          },
        });
      }
    }
  }

  // Highlights for the current mode.
  function applyHighlights() {
    if (!props) return;
    const { mode, actionableCells, active } = props;
    // In place mode, legal cells only light up once a piece is in hand — so a
    // turn starts with no cells highlighted until the player grabs a piece.
    const placeReady = mode !== "place" || holding;
    for (const tile of tiles) {
      const mat = tile.material as THREE.MeshStandardMaterial;
      const c = tile.userData.cell as number;
      const on = !!active && !!actionableCells?.has(c) && mode !== "view" && placeReady;
      if (on) {
        mat.emissive.setHex(mode === "place" ? TEAL : AMBER);
        mat.emissiveIntensity = 0.5;
      } else {
        mat.emissive.setHex(0x000000);
        mat.emissiveIntensity = 0;
      }
    }
  }

  // Picking.
  const raycaster = new THREE.Raycaster();
  function setNdc(ev: PointerEvent) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  }
  // Resolve what the cursor is over. One of my reserve pieces wins first; then a
  // cell. While holding we snap to the cell via the ground plane (same math as
  // the held piece) so the click target == where the held piece is shown —
  // robust to the gaps between the thin tile meshes. Otherwise we ray the tiles.
  type Picked = { kind: "reserve"; size: number } | { kind: "cell"; cell: number } | null;
  function resolvePick(): Picked {
    if (!props) return null;
    raycaster.setFromCamera(ndc, camera);
    const resHit = raycaster.intersectObjects(reservePieces, false)[0];
    if (resHit && props.mode === "place" && resHit.object.userData.mark === props.myMark) {
      return { kind: "reserve", size: resHit.object.userData.size as number };
    }
    let cell = -1;
    if (holding) {
      if (raycaster.ray.intersectPlane(groundPlane, groundHit)) {
        const f = cellFromGround(groundHit.x, groundHit.z);
        if (f.inside) cell = f.cell;
      }
    } else {
      const tileHit = raycaster.intersectObjects(tiles, false)[0];
      if (tileHit) cell = tileHit.object.userData.cell as number;
    }
    return cell >= 0 ? { kind: "cell", cell } : null;
  }
  function onClick(ev: PointerEvent) {
    if (ev.button !== 0 || !props?.active) return;
    setNdc(ev);
    pointerInside = true;
    const p = resolvePick();
    if (!p) return;
    // Click one of my reserve pieces → grab that size (lift it to the cursor).
    if (p.kind === "reserve") {
      holding = true;
      props.onSelectSize?.(p.size);
      ensureHeld(p.size, props.myMark);
      rebuildReserves();
      applyHighlights();
      return;
    }
    // Click a legal cell → act. In place mode you must be holding a piece
    // first; remove mode acts directly on an opponent's top.
    if (p.kind === "cell" && props.actionableCells?.has(p.cell) && (props.mode !== "place" || holding)) {
      props.onCellClick?.(p.cell);
    }
  }
  function dropHeld() {
    if (!holding) return;
    holding = false;
    clearHeld();
    rebuildReserves();
    applyHighlights();
  }
  function onContext(ev: MouseEvent) {
    ev.preventDefault();
    dropHeld();
  }
  function onKey(ev: KeyboardEvent) {
    if (ev.key === "Escape") dropHeld();
  }
  function onMove(ev: PointerEvent) {
    setNdc(ev);
    pointerInside = true;
    if (!props?.active) { renderer.domElement.style.cursor = "default"; return; }
    const p = resolvePick();
    const cellClickable =
      p?.kind === "cell" && !!props.actionableCells?.has(p.cell) && (props.mode !== "place" || holding);
    const clickable = p?.kind === "reserve" || cellClickable;
    renderer.domElement.style.cursor = clickable ? "pointer" : (holding ? "grabbing" : "default");
  }
  function onLeave() { pointerInside = false; }
  renderer.domElement.addEventListener("pointerdown", onClick);
  renderer.domElement.addEventListener("pointermove", onMove);
  renderer.domElement.addEventListener("pointerleave", onLeave);
  renderer.domElement.addEventListener("contextmenu", onContext);
  window.addEventListener("keydown", onKey);

  // Resize to container.
  function resize() {
    // Fill the mount completely (full-bleed canvas).
    const w = Math.max(mount.clientWidth, 320);
    const h = Math.max(mount.clientHeight, 360);
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(mount);
  resize();

  // Render loop.
  let raf = 0;
  function frame(now: number) {
    if (disposed) return;
    // Tweens.
    for (let i = tweens.length - 1; i >= 0; i--) {
      const tw = tweens[i];
      const t = Math.min((now - tw.start) / tw.dur, 1);
      const e = easeOutCubic(t);
      tw.obj.position.lerpVectors(tw.from, tw.to, e);
      if (tw.arc) tw.obj.position.y += Math.sin(Math.PI * e) * tw.arc;
      if (t >= 1) {
        tw.obj.position.copy(tw.to);
        tweens.splice(i, 1);
        tw.onDone?.();
      }
    }
    // Idle shimmer on actionable tiles.
    const pulse = 0.42 + 0.18 * Math.sin(now / 280);
    for (const tile of tiles) {
      const mat = tile.material as THREE.MeshStandardMaterial;
      if (mat.emissiveIntensity > 0) mat.emissiveIntensity = pulse;
    }
    // Drift the asteroid field.
    for (const a of asteroids.children) {
      a.rotation.x += (a.userData.sx as number);
      a.rotation.y += (a.userData.sy as number);
    }
    positionHeld(now);
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  let cameraInit = false;
  let lastReserveKey = "";

  return {
    update(next: Board3DProps) {
      // First render: point the camera at the local player's side of the
      // table (X near, O far); the lobby preview slowly orbits instead.
      if (!cameraInit) {
        cameraInit = true;
        if (next.spectator) {
          camera.position.set(0, 16.4, 22);
          controls.autoRotate = true;
        } else if (next.myMark === 2) {
          camera.position.set(0, 16.4, -22);
        } else {
          camera.position.set(0, 16.4, 22);
        }
        controls.update();
      }

      // Spectator/no-team view (the lobby) shows full colour, not the dimmed
      // "it's not your turn" look that in-game inactivity uses.
      const lightsOn = next.spectator === true || next.active !== false;
      ambient.intensity = lightsOn ? 0.5 : 0.3;
      key.intensity = lightsOn ? 1.0 : 0.5;
      glowX.intensity = lightsOn ? 22 : 8;
      glowO.intensity = lightsOn ? 22 : 8;

      props = next;

      // Held-piece state machine (place mode only). No auto-grab: a turn starts
      // with nothing selected; the player picks a reserve piece to begin.
      const placeActive = !!next.active && next.mode === "place";
      if (!placeActive) {
        holding = false;
        clearHeld();
      } else if (holding && heldAvailable(next)) {
        ensureHeld(next.selectedSize ?? 0, next.myMark);
      } else {
        clearHeld();
      }

      applyBoard(next.board);

      const reserveKey =
        `${next.reserves.join(",")}|${next.selectedSize}|${next.mode}|${next.myMark}|${holding ? 1 : 0}`;
      if (reserveKey !== lastReserveKey && tweens.length === 0) {
        lastReserveKey = reserveKey;
        rebuildReserves();
      }
      applyHighlights();
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onClick);
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("pointerleave", onLeave);
      renderer.domElement.removeEventListener("contextmenu", onContext);
      window.removeEventListener("keydown", onKey);
      for (const d of disposables) d.dispose();
      controls.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    },
  };
}

// ── React wrapper ───────────────────────────────────────────────────────────

export default function Board3D(props: Board3DProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const ctrlRef = useRef<Controller | null>(null);

  useEffect(() => {
    if (!mountRef.current) return;
    const ctrl = createController(mountRef.current);
    ctrlRef.current = ctrl;
    return () => {
      ctrl.dispose();
      ctrlRef.current = null;
    };
  }, []);

  useEffect(() => {
    ctrlRef.current?.update(props);
  });

  return <div ref={mountRef} className="board3d" style={{ width: "100%", height: "100%" }} />;
}
