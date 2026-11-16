// ===========================================================================
// Segmentor VJ tool
//
// How it works, in short:
//   * The five Segmentor styles are loaded as outline data (fonts/*.json,
//     made by scripts/segmentor_glyphs.py). Every axis AAAA–IIII is one
//     straight line from 0 to 1000, so a letter at any setting is simply
//     "default outline + value × axis delta", summed over the nine axes.
//   * Nine pads = nine axes. Hitting a pad (keyboard, mouse, MIDI or a
//     beat in the music) pushes its axis to the hit's strength, then it
//     falls back with a half-life of 250 ms, like the 2025 HTML version
//     (Segmentor-All-just-pad-mn.html: 20 ms hold, half-life 250 ms).
//   * Everything is drawn on one <canvas> each frame: background, camera,
//     the type, then effects. Recording films that canvas plus the sound.
// ===========================================================================

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const root = document.documentElement;
const body = document.body;

// --- Settings (remembered in this browser) ---------------------------------
const STORE = "segmentor-vj-v1";
const DEFAULT_KEYS = ["q", "w", "e", "a", "s", "d", "z", "x", "c"];
const settings = Object.assign({
  text: "Segmentor",
  style: 0,
  theme: "light",
  fill: false,              // outline (1 pt) by default
  stroke: 1,                // pt
  keys: DEFAULT_KEYS,
  notes: [60, 61, 62, 63, 64, 65, 66, 67, 68],   // MIDI notes, as in the 2025 version
  sounds: ["kick", "snare", "hatClosed", "tomLow", "clap", "hatOpen", "rim", "tomHigh", "crash"],
  volume: 0.8,
  decay: 250,
  size: 1,
}, load());
function load() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) { return {}; } }
function save() { try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch (e) { /* private mode */ } }

// --- Fonts -------------------------------------------------------------------
const STYLE_COUNT = 5;
const fonts = new Array(STYLE_COUNT);       // parsed fonts, filled as they load
const fontLoads = new Array(STYLE_COUNT);

function loadFont(i) {
  if (!fontLoads[i]) {
    fontLoads[i] = fetch(`fonts/segmentor-0${i + 1}.json`)
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then((data) => (fonts[i] = prepareFont(data)));
  }
  return fontLoads[i];
}

// Turn the JSON into typed arrays once, so drawing is quick.
function prepareFont(data) {
  const glyphs = new Map();
  for (const [ch, g] of Object.entries(data.glyphs)) {
    const p = Float32Array.from(g.p);
    const deltas = [];
    for (const [k, d] of Object.entries(g.d)) deltas.push({ axis: +k, p: Float32Array.from(d.p), w: d.w });
    let yMax = -Infinity, yMin = Infinity;
    for (let j = 1; j < p.length; j += 2) { yMax = Math.max(yMax, p[j]); yMin = Math.min(yMin, p[j]); }
    glyphs.set(ch, {
      w: g.w, ends: g.e, on: Uint8Array.from(g.f, (c) => c === "1"), p, deltas,
      out: new Float32Array(p.length), yMax, yMin,
    });
  }
  const H = glyphs.get("H");
  return { name: data.name, upm: data.upm, glyphs, capH: H ? H.yMax : data.upm * 0.7 };
}

// --- The nine axes -------------------------------------------------------------
// Each axis remembers its last hit; its value decays from there. "follow" is
// set by the audio input in Follow mode and acts as a floor.
const axes = Array.from({ length: 9 }, () => ({ hit: 0, at: -1e9, follow: 0, value: 0 }));
function updateAxes(now) {
  for (const a of axes) {
    const t = now - a.at;
    let v = t < 20 ? a.hit : a.hit * Math.pow(0.5, (t - 20) / settings.decay);
    if (v < 0.001) v = 0;
    a.value = Math.max(v, a.follow);
  }
}
let flash = 0;          // strobe effect: set on every hit, fades per frame
let lastHitAt = -1e9;   // for Laser trace and Scramble
function trigger(i, vel = 1, { sound = true } = {}) {
  const a = axes[i];
  if (!a) return;
  a.hit = clamp(vel);
  a.at = performance.now();
  flash = 1;
  lastHitAt = a.at;
  if (sound) playPad(i, vel);
  flashPad(i);
}

// --- Canvas --------------------------------------------------------------------
const stage = $("#stage");
const canvas = $("[data-canvas]");
const ctx = canvas.getContext("2d");
const prev = document.createElement("canvas");     // last frame, for feedback
const prevCtx = prev.getContext("2d");
const fx = document.createElement("canvas");       // scratch copy, for glitch/mirror
const fxCtx = fx.getContext("2d");
let W = 0, H = 0, DPR = 1;

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = Math.max(1, Math.round(stage.clientWidth * DPR));
  H = Math.max(1, Math.round(stage.clientHeight * DPR));
  for (const c of [canvas, prev, fx]) { c.width = W; c.height = H; }
}
new ResizeObserver(resize).observe(stage);
resize();

// --- Colours -------------------------------------------------------------------
const bg = { kind: "none", color: "#2b3fd6", ink: "#fafafa", pattern: "grid", media: null, mediaIsVideo: false };
function colours() {
  const dark = settings.theme === "dark";
  if (bg.kind === "color") return { back: bg.color, ink: bg.ink };
  return { back: dark ? "#000" : "#fff", ink: dark ? "#fff" : "#000" };
}

function isDark(c) {
  const h = c.replace("#", "");
  const n = h.length === 3 ? h.split("").map((x) => parseInt(x + x, 16)) : [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.299 * n[0] + 0.587 * n[1] + 0.114 * n[2] < 128;
}

// --- Drawing the type ---------------------------------------------------------
// A glyph at the current axis values: default + Σ value × delta.
function shape(g) {
  const out = g.out;
  out.set(g.p);
  let w = g.w;
  for (const d of g.deltas) {
    const v = axes[d.axis].value;
    if (!v) continue;
    const dp = d.p;
    for (let j = 0; j < dp.length; j++) out[j] += dp[j] * v;
    w += d.w * v;
  }
  return w;
}

// TrueType outlines: quadratic curves, where two off-curve points in a row
// have an invisible on-curve point halfway between them.
function tracePath(path, g, tx) {
  const pts = g.out, on = g.on;
  let start = 0;
  for (const end of g.ends) {
    const n = end - start + 1;
    if (n < 2) { start = end + 1; continue; }
    const X = (k) => pts[2 * (start + ((k + n) % n))];
    const Y = (k) => pts[2 * (start + ((k + n) % n)) + 1];
    const ON = (k) => on[start + ((k + n) % n)];
    // find a starting on-curve point (or make one between two off points)
    let first = -1;
    for (let k = 0; k < n; k++) if (ON(k)) { first = k; break; }
    let sx, sy;
    if (first < 0) { first = 0; sx = (X(0) + X(1)) / 2; sy = (Y(0) + Y(1)) / 2; }
    else { sx = X(first); sy = Y(first); }
    path.moveTo(...tx(sx, sy));
    let cx = null, cy = null;
    for (let s = 1; s <= n; s++) {
      const k = first + s;
      const x = X(k), y = Y(k);
      if (ON(k)) {
        if (cx === null) path.lineTo(...tx(x, y));
        else { path.quadraticCurveTo(...tx(cx, cy), ...tx(x, y)); cx = null; }
      } else if (cx === null) { cx = x; cy = y; }
      else {
        const mx = (cx + x) / 2, my = (cy + y) / 2;
        path.quadraticCurveTo(...tx(cx, cy), ...tx(mx, my));
        cx = x; cy = y;
      }
    }
    if (cx !== null) path.quadraticCurveTo(...tx(cx, cy), ...tx(sx, sy));
    path.closePath();
    start = end + 1;
  }
}

// Lay the text out centred on the stage. The size is chosen from the
// default (rest) shapes so it does not jump while playing; the letters may
// grow beyond that when the axes open up.
let caretPos = null;
function layout(font, text) {
  const lines = text.split("\n");
  const glyphOf = (ch) => font.glyphs.get(ch) || font.glyphs.get("?");
  let restW = 1;
  for (const line of lines) {
    let w = 0;
    for (const ch of line) { const g = glyphOf(ch); if (g) w += g.w; }
    restW = Math.max(restW, w);
  }
  const lineH = font.upm * 1.05;
  const blockH = font.capH + (lines.length - 1) * lineH;
  const s = Math.min((W * 0.86) / restW, (H * 0.62) / blockH, (H * 0.5) / font.upm) * settings.size;
  return { lines, glyphOf, s, lineH, top: H / 2 - (blockH * s) / 2 + font.capH * s };
}

// Build the outline of the whole text as one Path2D, with the shape
// effects applied to every point:
//   per letter: Wave, 3D spin;  whole text: Perspective, Bass bounce.
function buildPath(font, text, t, energy) {
  const L = layout(font, text);
  const path = new Path2D();
  const caret = { x: W / 2, y: L.top };
  const cx = W / 2, cy = H / 2;
  const waveAmt = fxOn.wave ? fxAmt.wave : 0;
  const spin = fxOn.spin ? fxAmt.spin : 0;
  const persp = fxOn.persp ? fxAmt.persp * (0.8 * Math.sin(t * 0.7) + energy * 0.6) : 0;
  const bounce = fxOn.bounce ? 1 + fxAmt.bounce * bass() * 0.45 : 1;
  const glob = (X, Y) => {
    if (persp) X = cx + (X - cx) * (1 + persp * ((Y - cy) / (H / 2)));
    if (bounce !== 1) { X = cx + (X - cx) * bounce; Y = cy + (Y - cy) * bounce; }
    return [X, Y];
  };
  let index = 0, gi = 0, left = Infinity, right = -Infinity;
  L.lines.forEach((line, li) => {
    const shaped = [];
    let lineW = 0;
    for (const ch of line) {
      const g = L.glyphOf(ch);
      if (!g) { shaped.push(null); continue; }
      const w = shape(g);
      shaped.push({ g, w, pts: g.out.slice() });
      lineW += w;
    }
    let x = W / 2 - (lineW * L.s) / 2;
    left = Math.min(left, x); right = Math.max(right, x + lineW * L.s);
    const base = L.top + li * L.lineH * L.s;
    const mid = base - (font.capH * L.s) / 2;
    if (caretIndex !== null && caretIndex === index) { caret.x = x; caret.y = base; }
    shaped.forEach((sg) => {
      index++;
      if (sg) {
        const ox = x, half = (sg.w * L.s) / 2, gcx = ox + half;
        // 3D spin: each letter turns round its own vertical axis, the
        // turn travelling along the word (a cascade); hits add a flip.
        const ang = spin ? spin * (Math.sin(t * 2.2 - gi * 0.45) * 1.3 + energy * Math.PI) : 0;
        const cos = Math.cos(ang), sin = Math.sin(ang);
        const tx = (px, py) => {
          let X = ox + px * L.s, Y = base - py * L.s;
          if (waveAmt) X += Math.sin(Y / (55 * DPR) + t * 5) * waveAmt * 40 * DPR * (0.25 + energy);
          if (spin) {
            const rel = (X - gcx) / (half || 1);
            X = gcx + (X - gcx) * cos;
            Y = mid + (Y - mid) * (1 + 0.25 * sin * rel);
          }
          return glob(X, Y);
        };
        sg.g.out.set(sg.pts);
        tracePath(path, sg.g, tx);
        x += sg.w * L.s;
        gi++;
      }
      if (caretIndex !== null && caretIndex === index) { caret.x = x; caret.y = base; }
    });
    index++;          // the newline
  });
  const top = L.top - font.capH * L.s, bottom = L.top + (L.lines.length - 1) * L.lineH * L.s;
  caretPos = { x: caret.x, y: caret.y, h: font.capH * L.s };
  return { path, top, bottom, left: isFinite(left) ? left : W / 2, right: isFinite(right) ? right : W / 2, capH: font.capH * L.s };
}

// Plain fill or outline (1 pt = 1.333 css px)
function paint(c, path, colour, fill) {
  if (fill) { c.fillStyle = colour; c.fill(path, "nonzero"); }
  else {
    c.strokeStyle = colour;
    c.lineWidth = settings.stroke * (4 / 3) * DPR;
    c.lineJoin = "round";
    c.stroke(path);
  }
}

// Low end: the music's three lowest bands when listening, else pads 1–3.
function bass() {
  if (input.on) return (input.levels[0] + input.levels[1] + input.levels[2]) / 3;
  return Math.max(axes[0].value, axes[1].value, axes[2].value);
}

// The type itself, with the "light" and "fill" effects.
function paintType(c, P, ink, back, t, now, energy) {
  const dark = isDark(back);
  let col = ink;
  c.save();
  // Neon: a cycling neon colour, a glow, and random electrical stutters
  if (fxOn.neon) {
    col = `hsl(${(t * 40) % 360}, 100%, ${dark ? 62 : 48}%)`;
    if (Math.random() < 0.06 * fxAmt.neon + energy * 0.12 * fxAmt.neon) c.globalAlpha = 0.15 + Math.random() * 0.4;
    c.shadowColor = col;
    c.shadowBlur = (8 + 22 * fxAmt.neon) * DPR;
  }
  // Bloom: a soft halo that blows out on strong hits
  if (fxOn.bloom && energy > 0.01) {
    c.save();
    c.shadowColor = col;
    c.shadowBlur = (20 + energy * 110) * fxAmt.bloom * DPR;
    c.globalAlpha *= Math.min(1, 0.3 + energy);
    c.fillStyle = col;
    c.fill(P.path);
    c.fill(P.path);
    c.restore();
  }
  if (fxOn.chrome) paintChrome(c, P, t, energy);
  else if (fxOn.spectrum) paintSpectrum(c, P, col, t);
  else if (fxOn.laser) {
    // Laser trace: after each hit the outline draws itself again
    const p = clamp((now - lastHitAt) / (150 + (1 - fxAmt.laser) * 1000));
    const len = P.capH * 5;
    c.setLineDash([Math.max(0.5, p * len), len * 4]);
    if (!fxOn.neon) { c.shadowColor = col; c.shadowBlur = 6 * DPR; }
    paint(c, P.path, col, false);
    c.setLineDash([]);
  } else paint(c, P.path, col, settings.fill);
  c.restore();
}

// Chrome: an extruded, mirror-like metal letter (always filled)
function paintChrome(c, P, t, energy) {
  const depth = Math.round((6 + 22 * fxAmt.chrome) * (1 + energy * 0.7));
  for (let k = depth; k > 0; k--) {
    const f = k / depth, v = Math.round(20 + 70 * (1 - f));
    c.save();
    c.translate(k * 0.9 * DPR, k * 0.9 * DPR);
    c.fillStyle = `rgb(${v},${v + 4},${v + 10})`;
    c.fill(P.path);
    c.restore();
  }
  const h = P.bottom - P.top || 1;
  const g = c.createLinearGradient(0, P.top - h * 0.1, 0, P.bottom + h * 0.1);
  const shine = 0.47 + Math.sin(t * 1.3) * 0.08;      // the horizon moves a little
  g.addColorStop(0, "#ffffff");
  g.addColorStop(Math.max(0.05, shine - 0.25), "#c9ced6");
  g.addColorStop(shine, "#3b4048");
  g.addColorStop(Math.min(0.95, shine + 0.05), "#8d95a1");
  g.addColorStop(1, "#f5f7fa");
  c.fillStyle = g;
  c.fill(P.path);
  c.strokeStyle = "rgba(255,255,255,0.85)";
  c.lineWidth = DPR;
  c.stroke(P.path);
}

// Spectrum fill: the sound's frequency bars (or the nine pads) inside the letters
const specBins = new Uint8Array(1024);
function paintSpectrum(c, P, col, t) {
  let bars;
  if (input.on && input.analyser) {
    input.analyser.getByteFrequencyData(specBins);
    const n = 48, max = Math.min(specBins.length, input.analyser.frequencyBinCount);
    bars = Array.from({ length: n }, (_, i) => {
      const lo = Math.floor(Math.pow(max, i / n)), hi = Math.max(lo + 1, Math.floor(Math.pow(max, (i + 1) / n)));
      let m = 0;
      for (let b = lo; b < hi && b < max; b++) m = Math.max(m, specBins[b]);
      return m / 255;
    });
  } else {
    bars = [];
    for (let i = 0; i < 9; i++) for (let k = 0; k < 4; k++)
      bars.push(clamp(axes[i].value * (0.8 + 0.2 * Math.sin(t * 9 + i * 3 + k)) + 0.04 * fxAmt.spectrum));
  }
  const pad = P.capH * 0.3;
  const x0 = P.left - pad, x1 = P.right + pad, y0 = P.top - pad, y1 = P.bottom + pad * 1.5;
  const bw = (x1 - x0) / bars.length;
  c.save();
  c.clip(P.path, "nonzero");
  c.fillStyle = col;
  bars.forEach((v, i) => {
    const h = (y1 - y0) * v * (0.4 + fxAmt.spectrum * 0.8);
    c.fillRect(x0 + i * bw, y1 - h, Math.max(1, bw * 0.78), h);
  });
  c.restore();
  const keep = settings.stroke;
  settings.stroke = Math.min(keep, 1);
  paint(c, P.path, col, false);
  settings.stroke = keep;
}

// Scramble: after each hit the letters shuffle through random characters
// and lock into place one by one, left to right.
function scrambled(font, text, now) {
  const dur = 120 + fxAmt.scramble * 700;
  const since = now - lastHitAt;
  if (since > dur) return text;
  const pool = scramblePool(font);
  const chars = [...text];
  const n = chars.length || 1;
  return chars.map((ch, i) => (ch === "\n" || ch === " " || since > (dur * (i + 1)) / n)
    ? ch : pool[Math.floor(Math.random() * pool.length)]).join("");
}
const pools = new Map();
function scramblePool(font) {
  if (!pools.has(font)) pools.set(font, [...font.glyphs.keys()].filter((c) => /[A-Za-z0-9#$%&*+=?@]/.test(c)));
  return pools.get(font);
}

// Code rain: falling columns of characters behind the type
const rain = { cols: [] };
function drawRain(c, ink, t, energy) {
  const size = Math.round(18 * DPR);
  const n = Math.ceil(W / size);
  if (rain.cols.length !== n) rain.cols = Array.from({ length: n }, () => ({ y: Math.random() * H, v: 0.4 + Math.random() * 1.4 }));
  const chars = [...(settings.text.replace(/\s/g, "") || "SEGMENTOR")].concat(["0", "1"]);
  const trail = 14;
  c.save();
  c.font = `${size}px Segmentor, monospace`;
  c.textAlign = "center";
  c.fillStyle = ink;
  rain.cols.forEach((col, i) => {
    col.y += col.v * (1.5 + energy * 14) * (0.4 + fxAmt.rain) * DPR;
    if (col.y - trail * size > H) { col.y = -Math.random() * H * 0.5; col.v = 0.4 + Math.random() * 1.4; }
    for (let k = 0; k < trail; k++) {
      const y = col.y - k * size;
      if (y < -size || y > H + size) continue;
      c.globalAlpha = (k === 0 ? 0.9 : 0.55 * (1 - k / trail)) * (0.25 + fxAmt.rain * 0.6);
      const ch = k === 0 ? chars[Math.floor(Math.random() * chars.length)]
        : chars[(i * 7 + Math.floor(col.y / size) - k + chars.length * 99) % chars.length];
      c.fillText(ch, i * size + size / 2, y);
    }
  });
  c.restore();
}

// Echo: copies of the last frames' outlines, fading out
const echoes = [];
let echoTick = 0;

// BPM strobe: flashes on the beat (BPM slider, or tap T in time)
const tempo = { bpm: 120, origin: 0, taps: [] };
function tapTempo() {
  const now = performance.now();
  tempo.taps = tempo.taps.filter((x) => now - x < 2500);
  tempo.taps.push(now);
  if (tempo.taps.length >= 2) {
    const d = (tempo.taps[tempo.taps.length - 1] - tempo.taps[0]) / (tempo.taps.length - 1);
    tempo.bpm = Math.round(clamp(60000 / d, 40, 240));
    const r = $("[data-bpm]"), o = $("[data-bpm-out]");
    if (r) { r.value = tempo.bpm; o.textContent = tempo.bpm; }
  }
  tempo.origin = now;
}

// --- Background ------------------------------------------------------------------
function cover(c, src, sw, sh, mirror = false) {
  if (!sw || !sh) return;
  const r = Math.max(W / sw, H / sh);
  const w = sw * r, h = sh * r;
  c.save();
  if (mirror) { c.translate(W, 0); c.scale(-1, 1); }
  c.drawImage(src, (W - w) / 2, (H - h) / 2, w, h);
  c.restore();
}

function drawPattern(c, ink, t, energy) {
  const u = Math.round((40 + energy * 30) * DPR);
  c.save();
  c.globalAlpha = 0.14 + energy * 0.5;
  c.strokeStyle = c.fillStyle = ink;
  c.lineWidth = DPR;
  const cx = W / 2, cy = H / 2;
  switch (bg.pattern) {
    case "grid":
      c.beginPath();
      for (let x = (cx % u); x < W; x += u) { c.moveTo(x, 0); c.lineTo(x, H); }
      for (let y = (cy % u); y < H; y += u) { c.moveTo(0, y); c.lineTo(W, y); }
      c.stroke(); break;
    case "lines":
      c.beginPath();
      for (let y = ((cy + t * 30 * DPR) % u); y < H; y += u / 2) { c.moveTo(0, y); c.lineTo(W, y); }
      c.stroke(); break;
    case "dots": {
      const r = (1.5 + energy * 6) * DPR;
      for (let x = cx % u; x < W; x += u) for (let y = cy % u; y < H; y += u) {
        c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
      }
      break;
    }
    case "checker":
      c.globalAlpha *= 0.6;
      for (let x = 0, i = 0; x < W; x += u, i++) for (let y = 0, j = 0; y < H; y += u, j++)
        if ((i + j) % 2) c.fillRect(x, y, u, u);
      break;
    case "rings": {
      c.beginPath();
      const max = Math.hypot(W, H) / 2;
      for (let r = (t * 40 * DPR) % u; r < max; r += u) { c.moveTo(cx + r, cy); c.arc(cx, cy, r, 0, Math.PI * 2); }
      c.stroke(); break;
    }
    case "diagonal":
      c.beginPath();
      for (let x = -H + ((t * 20 * DPR) % u); x < W; x += u / 1.5) { c.moveTo(x, H); c.lineTo(x + H, 0); }
      c.stroke(); break;
  }
  c.restore();
}

// --- Effects -------------------------------------------------------------------
const EFFECTS = [
  { group: "MOTION" },
  { id: "spin", name: "3D spin", amt: 0.5 },
  { id: "persp", name: "Perspective", amt: 0.5 },
  { id: "wave", name: "Wave", amt: 0.5 },
  { id: "bounce", name: "Bass bounce", amt: 0.5, hint: "pads 1–3 or the lows" },
  { id: "shake", name: "Shake", amt: 0.4 },
  { group: "GLITCH" },
  { id: "rgb", name: "RGB split", amt: 0.5 },
  { id: "glitch", name: "Block glitch", amt: 0.5 },
  { id: "smear", name: "Pixel smear", amt: 0.5, hint: "past half: also vertical" },
  { id: "scramble", name: "Scramble", amt: 0.4 },
  { group: "LIGHT" },
  { id: "neon", name: "Neon flicker", amt: 0.5 },
  { id: "laser", name: "Laser trace", amt: 0.5 },
  { id: "bloom", name: "Bloom", amt: 0.6 },
  { id: "chrome", name: "Chrome", amt: 0.5 },
  { group: "SOUND" },
  { id: "spectrum", name: "Spectrum fill", amt: 0.6, hint: "INPUT on: the music" },
  { id: "bpm", name: "BPM strobe", amt: 0.6, bpm: true },
  { id: "strobe", name: "Hit strobe", amt: 0.5 },
  { group: "TRAILS" },
  { id: "trails", name: "Trails", amt: 0.6 },
  { id: "feedback", name: "Feedback", amt: 0.6 },
  { id: "echo", name: "Echo", amt: 0.6 },
  { group: "SCREEN" },
  { id: "rain", name: "Code rain", amt: 0.5 },
  { id: "mirror", name: "Mirror", amt: 0.5, hint: "past half: four-way" },
  { id: "invert", name: "Invert", amt: 1 },
];
const fxOn = Object.fromEntries(EFFECTS.filter((e) => e.id).map((e) => [e.id, false]));
const fxAmt = Object.fromEntries(EFFECTS.filter((e) => e.id).map((e) => [e.id, e.amt]));

// --- Frame -------------------------------------------------------------------------
let editing = false;
let caretIndex = null;
const typeInput = $("[data-type-input]");
let lastT = performance.now();

let frameMs = 0;
function frame(now) {
  const t0 = performance.now();
  requestAnimationFrame(frame);
  const t = now / 1000;
  lastT = now;
  readAudio(now);
  updateAxes(now);
  const energy = axes.reduce((m, a) => Math.max(m, a.value), 0);
  const { back, ink } = colours();
  const font = fonts[settings.style];

  // 1. background (see-through when Trails is on, so old frames linger)
  ctx.save();
  ctx.globalAlpha = fxOn.trails ? 1 - fxAmt.trails * 0.92 : 1;
  ctx.fillStyle = back;
  ctx.fillRect(0, 0, W, H);
  if (bg.kind === "pattern") drawPattern(ctx, ink, t, energy);
  if (bg.kind === "file" && bg.media) {
    const m = bg.media;
    cover(ctx, m, bg.mediaIsVideo ? m.videoWidth : m.naturalWidth, bg.mediaIsVideo ? m.videoHeight : m.naturalHeight);
  }
  if (camera.on && camera.video.readyState >= 2) {
    ctx.globalAlpha *= camera.opacity;
    cover(ctx, camera.video, camera.video.videoWidth, camera.video.videoHeight, camera.mirror);
  }
  ctx.restore();

  if (fxOn.rain) drawRain(ctx, ink, t, energy);

  // 2. feedback: last frame, slightly larger and turned, behind the type
  if (fxOn.feedback) {
    ctx.save();
    ctx.globalAlpha = 0.55 + fxAmt.feedback * 0.4;
    ctx.translate(W / 2, H / 2);
    ctx.rotate((0.004 + energy * 0.02) * fxAmt.feedback);
    const z = 1 + (0.01 + energy * 0.05) * fxAmt.feedback;
    ctx.scale(z, z);
    ctx.drawImage(prev, -W / 2, -H / 2);
    ctx.restore();
  }

  // 3. the type
  if (font) {
    const text = fxOn.scramble ? scrambled(font, settings.text, now) : settings.text;
    const P = buildPath(font, text, t, energy);
    const shake = fxOn.shake ? fxAmt.shake * energy * 40 * DPR : 0;
    const sx = shake ? (Math.random() - 0.5) * shake : 0, sy = shake ? (Math.random() - 0.5) * shake : 0;
    ctx.save();
    ctx.translate(sx, sy);
    if (fxOn.echo) {
      echoes.forEach((p, k) => {
        ctx.save();
        ctx.globalAlpha = ((k + 1) / (echoes.length + 1)) * fxAmt.echo * 0.7;
        const z = 1 + (echoes.length - k) * 0.012 * fxAmt.echo;
        ctx.translate(W / 2, H / 2); ctx.scale(z, z); ctx.translate(-W / 2, -H / 2);
        paint(ctx, p, ink, false);
        ctx.restore();
      });
      if (++echoTick % 3 === 0) { echoes.push(P.path); if (echoes.length > 8) echoes.shift(); }
    } else echoes.length = 0;
    if (fxOn.rgb && energy > 0.01) {
      const off = fxAmt.rgb * (4 + energy * 30) * DPR;
      ctx.save();
      ctx.globalCompositeOperation = isDark(back) ? "screen" : "multiply";
      ctx.translate(-off, 0); paint(ctx, P.path, "#ff0040", settings.fill);
      ctx.translate(2 * off, 0); paint(ctx, P.path, "#00e5ff", settings.fill);
      ctx.restore();
    }
    paintType(ctx, P, ink, back, t, now, energy);
    // caret while typing
    if (editing && caretPos && Math.floor(t * 1.8) % 2 === 0) {
      ctx.fillStyle = ink;
      ctx.fillRect(caretPos.x + 2 * DPR, caretPos.y - caretPos.h, Math.max(1, 1.5 * DPR), caretPos.h * 1.15);
    }
    ctx.restore();
  } else {
    ctx.fillStyle = ink;
    ctx.font = `${14 * DPR}px Segmentor, monospace`;
    ctx.textAlign = "center";
    ctx.fillText("loading…", W / 2, H / 2);
  }

  // 4. post effects
  if (fxOn.mirror) {
    fxCtx.clearRect(0, 0, W, H);
    fxCtx.drawImage(canvas, 0, 0);
    ctx.save();
    ctx.translate(W, 0); ctx.scale(-1, 1);
    ctx.drawImage(fx, 0, 0, W / 2, H, 0, 0, W / 2, H);       // left half → right
    ctx.restore();
    if (fxAmt.mirror > 0.5) {
      fxCtx.drawImage(canvas, 0, 0);
      ctx.save();
      ctx.translate(0, H); ctx.scale(1, -1);
      ctx.drawImage(fx, 0, 0, W, H / 2, 0, 0, W, H / 2);     // top half → bottom
      ctx.restore();
    }
  }
  if (fxOn.glitch && energy > 0.02) {
    fxCtx.clearRect(0, 0, W, H);
    fxCtx.drawImage(canvas, 0, 0);
    const n = Math.ceil(fxAmt.glitch * energy * 10);
    for (let k = 0; k < n; k++) {
      const y = Math.random() * H, h = (4 + Math.random() * 70) * DPR;
      const dx = (Math.random() - 0.5) * fxAmt.glitch * energy * 160 * DPR;
      ctx.drawImage(fx, 0, y, W, h, dx, y, W, h);
    }
  }
  if (fxOn.smear && energy > 0.02) {
    // Pixel smear: one column (or row) of pixels stretched across the screen
    fxCtx.clearRect(0, 0, W, H);
    fxCtx.drawImage(canvas, 0, 0);
    const n = Math.ceil(fxAmt.smear * energy * 6);
    for (let k = 0; k < n; k++) {
      if (fxAmt.smear > 0.5 && Math.random() < 0.4) {
        const x = Math.random() * W, w = (10 + Math.random() * 120) * DPR, y0 = Math.random() * H;
        ctx.drawImage(fx, x, y0, w, 1, x, y0, w, H - y0);
      } else {
        const y = Math.random() * H, h = (10 + Math.random() * 120) * DPR, x0 = Math.random() * W;
        ctx.drawImage(fx, x0, y, 1, h, x0, y, W - x0, h);
      }
    }
  }
  if (fxOn.bpm) {
    const beat = 60000 / tempo.bpm;
    const phase = (((now - tempo.origin) % beat) + beat) % beat / beat;
    if (phase < 0.14) {
      ctx.save();
      ctx.globalCompositeOperation = "difference";
      ctx.globalAlpha = fxAmt.bpm * (1 - phase / 0.14);
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  }
  if (fxOn.strobe && flash > 0.05) {
    ctx.save();
    ctx.globalCompositeOperation = "difference";
    ctx.globalAlpha = flash * fxAmt.strobe;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
  flash *= 0.6;
  if (fxOn.invert) {
    ctx.save();
    ctx.globalCompositeOperation = "difference";
    ctx.globalAlpha = fxAmt.invert;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // keep this frame for Feedback
  if (fxOn.feedback) { prevCtx.clearRect(0, 0, W, H); prevCtx.drawImage(canvas, 0, 0); }
  updateMeters();
  frameMs = frameMs * 0.9 + (performance.now() - t0) * 0.1;
}

// --- Sound: a small synthesised drum kit ----------------------------------------
// No samples to download: every sound is made with oscillators and noise.
// Each pad can also load its own sample (wav/mp3/aiff) from the computer.
let audio = null;           // { ctx, master, recDest, noise }
function getAudio() {
  // Safari pauses ("interrupted") the sound when the output device changes,
  // the Mac sleeps or another app takes the audio; wake it up on the next hit.
  if (audio) { if (audio.ctx.state !== "running" && audio.ctx.state !== "closed") audio.ctx.resume().catch(() => {}); return audio; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  // ask for the smallest audio buffer the computer allows (fastest response)
  let ac;
  try { ac = new AC({ latencyHint: 0 }); } catch (e) { ac = new AC(); }
  const master = ac.createGain();
  master.gain.value = settings.volume;
  master.connect(ac.destination);
  const recDest = ac.createMediaStreamDestination ? ac.createMediaStreamDestination() : null;
  if (recDest) master.connect(recDest);
  const noise = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
  const nd = noise.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  const meter = ac.createAnalyser();          // for the sound status line
  meter.fftSize = 1024;
  master.connect(meter);
  audio = { ctx: ac, master, recDest, noise, meter, peak: 0, error: "" };
  window.segmentorAudio = audio;               // handy for debugging in the console
  ac.addEventListener("statechange", () => {
    if (ac.state !== "running") alertHint("Sound paused by the browser — hit a pad or click to wake it.");
  });
  return audio;
}

function env(ac, out, t, peak, decay, attack = 0.001) {
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  g.connect(out);
  return g;
}
function osc(ac, type, f0, f1, t, dur, dest) {
  const o = ac.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  o.connect(dest); o.start(t); o.stop(t + dur + 0.05);
  return o;
}
function noise(a, t, dur, dest, filters = []) {
  const s = a.ctx.createBufferSource();
  s.buffer = a.noise;
  let node = s;
  for (const [type, freq, q = 0.7] of filters) {
    const f = a.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    node.connect(f); node = f;
  }
  node.connect(dest);
  s.start(t, Math.random()); s.stop(t + dur + 0.05);
}
function shaper(ac, amount) {
  const ws = ac.createWaveShaper();
  const n = 1024, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(x * amount); }
  ws.curve = curve;
  return ws;
}

const SOUNDS = {
  kick: { name: "Kick", play(a, o, t, v) {
    osc(a.ctx, "sine", 150, 42, t, 0.14, env(a.ctx, o, t, v, 0.45));
    noise(a, t, 0.01, env(a.ctx, o, t, v * 0.3, 0.01), [["lowpass", 3000]]);
  } },
  kick808: { name: "808 Kick", play(a, o, t, v) {
    const ws = shaper(a.ctx, 2); ws.connect(env(a.ctx, o, t, v * 0.9, 1.1));
    osc(a.ctx, "sine", 90, 38, t, 0.25, ws);
  } },
  sub: { name: "Sub drop", play(a, o, t, v) { osc(a.ctx, "sine", 110, 32, t, 0.9, env(a.ctx, o, t, v, 1.0)); } },
  snare: { name: "Snare", play(a, o, t, v) {
    osc(a.ctx, "triangle", 230, 160, t, 0.08, env(a.ctx, o, t, v * 0.6, 0.1));
    noise(a, t, 0.25, env(a.ctx, o, t, v * 0.7, 0.2), [["highpass", 1200]]);
  } },
  snareTight: { name: "Tight snare", play(a, o, t, v) {
    osc(a.ctx, "triangle", 330, 220, t, 0.05, env(a.ctx, o, t, v * 0.5, 0.05));
    noise(a, t, 0.12, env(a.ctx, o, t, v * 0.8, 0.09), [["bandpass", 4000, 0.8]]);
  } },
  clap: { name: "Clap", play(a, o, t, v) {
    for (const d of [0, 0.011, 0.023]) noise(a, t + d, 0.02, env(a.ctx, o, t + d, v * 0.6, 0.012), [["bandpass", 1300, 1.2]]);
    noise(a, t + 0.03, 0.3, env(a.ctx, o, t + 0.03, v * 0.6, 0.22), [["bandpass", 1300, 1.2]]);
  } },
  rim: { name: "Rimshot", play(a, o, t, v) {
    osc(a.ctx, "triangle", 1700, 1600, t, 0.03, env(a.ctx, o, t, v * 0.7, 0.03));
    noise(a, t, 0.02, env(a.ctx, o, t, v * 0.4, 0.015), [["highpass", 3000]]);
  } },
  clave: { name: "Clave", play(a, o, t, v) { osc(a.ctx, "sine", 2500, 2400, t, 0.06, env(a.ctx, o, t, v * 0.6, 0.05)); } },
  hatClosed: { name: "Closed hat", play(a, o, t, v) {
    noise(a, t, 0.06, env(a.ctx, o, t, v * 0.5, 0.045), [["highpass", 7500], ["peaking", 10000, 1]]);
  } },
  hatOpen: { name: "Open hat", play(a, o, t, v) {
    noise(a, t, 0.45, env(a.ctx, o, t, v * 0.45, 0.38), [["highpass", 7000]]);
  } },
  shaker: { name: "Shaker", play(a, o, t, v) {
    noise(a, t, 0.12, env(a.ctx, o, t, v * 0.4, 0.07, 0.02), [["bandpass", 6500, 1]]);
  } },
  ride: { name: "Ride", play(a, o, t, v) {
    noise(a, t, 1.2, env(a.ctx, o, t, v * 0.25, 1.0), [["highpass", 5000]]);
    for (const f of [520, 785, 1250]) osc(a.ctx, "square", f, f, t, 0.9, env(a.ctx, o, t, v * 0.03, 0.8));
  } },
  crash: { name: "Crash", play(a, o, t, v) {
    noise(a, t, 1.8, env(a.ctx, o, t, v * 0.55, 1.6), [["highpass", 3500]]);
  } },
  tomLow: { name: "Low tom", play(a, o, t, v) { osc(a.ctx, "sine", 120, 70, t, 0.4, env(a.ctx, o, t, v, 0.45)); } },
  tomMid: { name: "Mid tom", play(a, o, t, v) { osc(a.ctx, "sine", 170, 105, t, 0.35, env(a.ctx, o, t, v, 0.38)); } },
  tomHigh: { name: "High tom", play(a, o, t, v) { osc(a.ctx, "sine", 240, 150, t, 0.3, env(a.ctx, o, t, v, 0.32)); } },
  cowbell: { name: "Cowbell", play(a, o, t, v) {
    const f = a.ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 800; f.connect(env(a.ctx, o, t, v * 0.5, 0.35));
    osc(a.ctx, "square", 540, 540, t, 0.35, f); osc(a.ctx, "square", 800, 800, t, 0.35, f);
  } },
  zap: { name: "Zap", play(a, o, t, v) { osc(a.ctx, "sawtooth", 1800, 60, t, 0.16, env(a.ctx, o, t, v * 0.35, 0.18)); } },
  stab: { name: "Chord stab", play(a, o, t, v) {
    const f = a.ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.setValueAtTime(4000, t);
    f.frequency.exponentialRampToValueAtTime(400, t + 0.4); f.connect(env(a.ctx, o, t, v * 0.18, 0.45));
    for (const n of [220, 261.6, 329.6, 440]) osc(a.ctx, "sawtooth", n, n, t, 0.45, f);
  } },
  sweep: { name: "Noise sweep", play(a, o, t, v) {
    const f = a.ctx.createBiquadFilter(); f.type = "bandpass"; f.Q.value = 3;
    f.frequency.setValueAtTime(400, t); f.frequency.exponentialRampToValueAtTime(9000, t + 0.5);
    f.connect(env(a.ctx, o, t, v * 0.6, 0.55, 0.05));
    noise(a, t, 0.6, f);
  } },
  none: { name: "— none —", play() {} },
};
const samples = new Array(9).fill(null);       // user samples (AudioBuffer), this visit only

function playPad(i, vel) {
  const a = getAudio();
  if (!a) return;
  const t = a.ctx.currentTime;          // now: no extra scheduling delay
  if (samples[i]) {
    const s = a.ctx.createBufferSource();
    s.buffer = samples[i].buffer;
    const g = a.ctx.createGain(); g.gain.value = vel;
    s.connect(g); g.connect(a.master); s.start(t);
    return;
  }
  try {
    (SOUNDS[settings.sounds[i]] || SOUNDS.none).play(a, a.master, t, vel);
    a.error = "";
  } catch (e) {
    a.error = `${settings.sounds[i]}: ${e.message}`;
    console.error("Segmentor sound", e);
  }
}

// Sound status (DRUMPAD): is the browser's sound running, and is anything
// coming out? Helps to find out why it is silent.
const soundStatus = $("[data-sound-status]");
const meterBuf = new Float32Array(1024);
function updateSoundStatus() {
  if (!soundStatus || soundStatus.closest("[hidden]")) return;
  if (!audio) { soundStatus.textContent = "Sound: not started yet (hit a pad)."; return; }
  audio.meter.getFloatTimeDomainData(meterBuf);
  let p = 0;
  for (let k = 0; k < meterBuf.length; k++) p = Math.max(p, Math.abs(meterBuf[k]));
  audio.peak = Math.max(p, audio.peak * 0.9);
  const bars = "▮".repeat(Math.round(Math.min(1, audio.peak) * 12)).padEnd(12, "·");
  const lat = Math.round(((audio.ctx.baseLatency || 0) + (audio.ctx.outputLatency || 0)) * 1000);
  soundStatus.textContent = `Sound: ${audio.ctx.state} · ${Math.round(audio.ctx.sampleRate / 100) / 10} kHz · volume ${Math.round(settings.volume * 100)}% · out ${bars} · audio delay ${lat} ms · drawing ${frameMs.toFixed(1)} ms/frame` +
    (audio.error ? ` · error: ${audio.error}` : "");
}
setInterval(updateSoundStatus, 100);
$("[data-sound-test]")?.addEventListener("click", () => {
  const a = getAudio();
  if (!a) { soundStatus.textContent = "This browser has no Web Audio."; return; }
  const o = a.ctx.createOscillator(), g = a.ctx.createGain();
  const t = a.ctx.currentTime;
  o.frequency.value = 440;
  g.gain.setValueAtTime(0.3, t);
  g.gain.linearRampToValueAtTime(0, t + 0.5);
  o.connect(g); g.connect(a.master);
  o.start(t); o.stop(t + 0.55);
});

// --- Pads (menu) -------------------------------------------------------------------
const PAD_COLOURS = ["#ff3ea5", "#ffe600", "#00e5ff", "#00d26a", "#ff5a1f", "#8c5cff", "#ff2a1a", "#2b3fd6"];
const randomColour = () => PAD_COLOURS[Math.floor(Math.random() * PAD_COLOURS.length)];
const padButtons = [];
let learning = null;        // index of the pad waiting for a key or MIDI note

function keyLabel(k) { return k === " " ? "space" : k; }

function buildPads() {
  const list = $("[data-pad-list]");
  const pads = $("[data-pads]");
  list.replaceChildren(); pads.replaceChildren(); padButtons.length = 0;
  for (let i = 0; i < 9; i++) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="name">PAD${i + 1}</span><button type="button" class="key-chip"></button><span class="note"></span>`;
    const chip = li.querySelector(".key-chip");
    chip.textContent = keyLabel(settings.keys[i] || "–");
    li.querySelector(".note").textContent = `MIDI ${settings.notes[i] ?? "–"} · axis ${"ABCDEFGHI"[i]}`;
    chip.addEventListener("click", () => startLearning(i));
    list.append(li);

    const b = document.createElement("button");
    b.type = "button";
    b.textContent = keyLabel(settings.keys[i] || "");
    b.addEventListener("pointerdown", (e) => { e.preventDefault(); trigger(i, 1); });
    pads.append(b);
    padButtons.push(b);
  }
}
function startLearning(i) {
  learning = learning === i ? null : i;
  $$(".pad-list .key-chip").forEach((c, k) => {
    c.classList.toggle("is-learning", k === learning);
    if (k === learning) c.textContent = "…";
    else c.textContent = keyLabel(settings.keys[k] || "–");
  });
}
function finishLearning(update) {
  const i = learning;
  update(i);
  // a key or note can only belong to one pad
  learning = null;
  save();
  buildPads();
}
function flashPad(i) {
  const b = padButtons[i];
  if (!b) return;
  b.classList.add("is-hit");
  b.style.backgroundColor = randomColour();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    b.classList.remove("is-hit");
    b.style.backgroundColor = "";
  }));
}

function buildStyles() {
  const box = $("[data-styles]");
  box.replaceChildren();
  for (let i = 0; i < STYLE_COUNT; i++) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = String(i + 1).padStart(2, "0");
    b.addEventListener("click", () => setStyle(i));
    box.append(b);
  }
  markStyle();
}
function markStyle() {
  $$("[data-styles] button").forEach((b, i) => b.setAttribute("aria-pressed", String(i === settings.style)));
}
function setStyle(i) {
  settings.style = ((i % STYLE_COUNT) + STYLE_COUNT) % STYLE_COUNT;
  save(); markStyle();
  loadFont(settings.style).catch(() => {});
}

function buildSounds() {
  const list = $("[data-sound-list]");
  list.replaceChildren();
  for (let i = 0; i < 9; i++) {
    const li = document.createElement("li");
    const sel = document.createElement("select");
    for (const [id, s] of Object.entries(SOUNDS)) sel.append(new Option(s.name, id));
    sel.value = settings.sounds[i] || "none";
    sel.addEventListener("change", () => { settings.sounds[i] = sel.value; samples[i] = null; save(); buildSounds(); trigger(i, 1); });
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = `PAD${i + 1}`;
    const load = document.createElement("label");
    load.className = "load";
    load.title = "Use your own sound file for this pad (kept until you leave the page)";
    load.innerHTML = samples[i] ? `<span class="sample-on">${samples[i].name.slice(0, 10)}</span>` : "file…";
    const input = Object.assign(document.createElement("input"), { type: "file", accept: "audio/*" });
    input.addEventListener("change", async () => {
      const file = input.files[0];
      if (!file) return;
      const a = getAudio();
      try {
        const buffer = await new Promise((res, rej) => {
          file.arrayBuffer().then((ab) => a.ctx.decodeAudioData(ab, res, rej), rej);
        });
        samples[i] = { buffer, name: file.name };
        buildSounds();
        trigger(i, 1);
      } catch (e) { alertHint("That file could not be read as sound."); }
    });
    load.append(input);
    li.append(name, sel, load);
    list.append(li);
  }
}

// --- Keyboard -----------------------------------------------------------------------
function isFormField(el) {
  return el && (el.tagName === "SELECT" || (el.tagName === "INPUT" && !["range", "checkbox", "button", "color", "file"].includes(el.type)));
}
document.addEventListener("keydown", (e) => {
  if (editing) {
    if (e.key === "Escape") { e.preventDefault(); stopEditing(); }
    return;                 // typing: the textarea gets the keys
  }
  if (isFormField(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  getAudio();
  if (learning !== null) {
    e.preventDefault();
    if (key === "Escape") { startLearning(learning); return; }
    finishLearning((i) => {
      settings.keys = settings.keys.map((k) => (k === key ? "" : k));
      settings.keys[i] = key;
    });
    return;
  }
  const pad = settings.keys.indexOf(key);
  if (pad >= 0) {
    e.preventDefault();
    if (!e.repeat) trigger(pad, 1);
    return;
  }
  if (/^[1-5]$/.test(key)) { setStyle(+key - 1); return; }
  if (key === "t") { tapTempo(); return; }
  if (key === "ArrowRight") { setStyle(settings.style + 1); e.preventDefault(); return; }
  if (key === "ArrowLeft") { setStyle(settings.style - 1); e.preventDefault(); return; }
  if (key === "Escape" && body.classList.contains("perform")) setPerform(false);
  if (key === "Enter" && e.target === body) { startEditing(); e.preventDefault(); }
});

// --- Typing your own word ----------------------------------------------------------
function startEditing() {
  editing = true;
  typeInput.value = settings.text;
  typeInput.focus({ preventScroll: true });
  const end = typeInput.value.length;
  typeInput.setSelectionRange(end, end);
  caretIndex = end;
  setHint("Typing · Enter for a new line · Esc to play");
}
function stopEditing() {
  editing = false;
  caretIndex = null;
  typeInput.blur();
  setHint(defaultHint);
}
typeInput.addEventListener("input", () => {
  settings.text = typeInput.value;
  caretIndex = typeInput.selectionStart;
  save();
});
for (const ev of ["keyup", "select", "click"])
  typeInput.addEventListener(ev, () => { caretIndex = typeInput.selectionStart; });
document.addEventListener("selectionchange", () => { if (editing) caretIndex = typeInput.selectionStart; });
typeInput.addEventListener("blur", () => { if (editing) { editing = false; caretIndex = null; setHint(defaultHint); } });
canvas.addEventListener("pointerdown", (e) => {
  getAudio();
  if (body.classList.contains("perform")) return;
  e.preventDefault();
  startEditing();
});

const hintEl = $("[data-hint]");
const defaultHint = hintEl.textContent;
function setHint(s) { hintEl.textContent = s; }
let hintTimer;
function alertHint(s) { setHint(s); clearTimeout(hintTimer); hintTimer = setTimeout(() => setHint(editing ? hintEl.textContent : defaultHint), 4000); }

// --- Menu ------------------------------------------------------------------------------
const back = $("[data-back]");
function openPanel(name) {
  $$("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== name));
  back.hidden = name === "main";
}
$$("[data-open]").forEach((b) => b.addEventListener("click", () => openPanel(b.dataset.open)));
back.addEventListener("click", () => openPanel("main"));
// glitchy hover colours, as in the presentation
$$(".menu button, .menu a").forEach((el) =>
  el.addEventListener("pointerenter", () => root.style.setProperty("--hover", randomColour())));

$$("[data-toggle-menu]").forEach((b) => b.addEventListener("click", () => {
  if (body.classList.contains("perform")) setPerform(false);
  else body.classList.toggle("menu-hidden");
}));
if (window.matchMedia("(max-width: 700px)").matches) body.classList.add("menu-hidden");

// Perform mode: full screen, only the type. Safari still uses webkit names.
function fullscreenElement() { return document.fullscreenElement || document.webkitFullscreenElement; }
function setPerform(on) {
  if (editing) stopEditing();
  body.classList.toggle("perform", on);
  $("[data-action=perform]").classList.toggle("is-on", on);
  if (on && !fullscreenElement()) {
    const req = root.requestFullscreen || root.webkitRequestFullscreen;
    if (req) try { const p = req.call(root); if (p && p.catch) p.catch(() => {}); } catch (e) { /* not allowed */ }
  } else if (!on && fullscreenElement()) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) try { const p = exit.call(document); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ }
  }
}
for (const ev of ["fullscreenchange", "webkitfullscreenchange"])
  document.addEventListener(ev, () => { if (!fullscreenElement() && body.classList.contains("perform")) setPerform(false); });
$("[data-action=perform]").addEventListener("click", () => setPerform(true));

// Light/dark and fill/outline squares
function applyTheme() {
  root.dataset.theme = settings.theme;
  body.classList.toggle("is-fill", settings.fill);
}
$("[data-theme-toggle]").addEventListener("click", () => { settings.theme = settings.theme === "dark" ? "light" : "dark"; applyTheme(); save(); });
$("[data-fill]").addEventListener("click", () => { settings.fill = !settings.fill; applyTheme(); save(); });

// --- Effects panel ----------------------------------------------------------------------
function buildEffects() {
  const box = $("[data-effects]");
  for (const e of EFFECTS) {
    if (e.group) {
      const h = document.createElement("h3");
      h.className = "fx-group";
      h.textContent = e.group;
      box.append(h);
      continue;
    }
    const row = document.createElement("label");
    row.className = "effect";
    row.innerHTML = `<input type="checkbox"><span>${e.name}${e.hint ? ` <small class="hint">(${e.hint})</small>` : ""}</span><input type="range" min="0" max="1" step="0.01">`;
    const [check, range] = row.querySelectorAll("input");
    range.value = fxAmt[e.id];
    check.addEventListener("change", () => (fxOn[e.id] = check.checked));
    range.addEventListener("input", () => { fxAmt[e.id] = +range.value; if (!check.checked) { check.checked = true; fxOn[e.id] = true; } });
    box.append(row);
    if (e.bpm) {
      const b = document.createElement("div");
      b.className = "row bpm-row";
      b.innerHTML = `BPM <input type="range" min="40" max="240" step="1" value="${tempo.bpm}" data-bpm><output data-bpm-out>${tempo.bpm}</output><button type="button" class="btn" data-tap title="Tap in time (or press T)">Tap</button>`;
      const r = b.querySelector("[data-bpm]"), o = b.querySelector("[data-bpm-out]");
      r.addEventListener("input", () => { tempo.bpm = +r.value; o.textContent = r.value; });
      b.querySelector("[data-tap]").addEventListener("click", tapTempo);
      box.append(b);
    }
  }
}
const decayIn = $("[data-decay]"), sizeIn = $("[data-size]"), strokeIn = $("[data-stroke]"), strokeOut = $("[data-stroke-out]");
decayIn.value = settings.decay; sizeIn.value = settings.size; strokeIn.value = settings.stroke;
strokeOut.textContent = settings.stroke + " pt";
decayIn.addEventListener("input", () => { settings.decay = +decayIn.value; save(); });
sizeIn.addEventListener("input", () => { settings.size = +sizeIn.value; save(); });
strokeIn.addEventListener("input", () => { settings.stroke = +strokeIn.value; strokeOut.textContent = settings.stroke + " pt"; save(); });
const volumeIn = $("[data-volume]");
volumeIn.value = settings.volume;
volumeIn.addEventListener("input", () => { settings.volume = +volumeIn.value; if (audio) audio.master.gain.value = settings.volume; save(); });

// --- Background panel ----------------------------------------------------------------------
const SWATCHES = [
  ["#2b3fd6", "#fafafa"], ["#ff3ea5", "#000000"], ["#ffe600", "#000000"],
  ["#00d26a", "#000000"], ["#ff2a1a", "#000000"], ["#000000", "#ff3ea5"],
  ["#000000", "#00e5ff"], ["#fafafa", "#ff2a1a"], ["#ff5a1f", "#fafafa"],
  ["#8c5cff", "#ffe600"], ["#00e5ff", "#000000"], ["#1a1a1a", "#ffe600"],
];
const PATTERNS = [["grid", "Grid"], ["lines", "Lines"], ["dots", "Dots"], ["checker", "Checker"], ["rings", "Rings"], ["diagonal", "Diagonal"]];
const bgColorIn = $("[data-bg-color]"), inkColorIn = $("[data-ink-color]");
function setBgKind(kind) {
  bg.kind = kind;
  $$("[data-bg-kind] button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.kind === kind)));
  $$("[data-bg-sub]").forEach((d) => (d.hidden = d.dataset.bgSub !== kind));
}
$$("[data-bg-kind] button").forEach((b) => b.addEventListener("click", () => setBgKind(b.dataset.kind)));
for (const [back, ink] of SWATCHES) {
  const b = document.createElement("button");
  b.type = "button";
  b.style.background = back;
  b.innerHTML = `<span style="background:${ink}"></span>`;
  b.addEventListener("click", () => { bg.color = bgColorIn.value = back; bg.ink = inkColorIn.value = ink; });
  $("[data-swatches]").append(b);
}
bgColorIn.addEventListener("input", () => (bg.color = bgColorIn.value));
inkColorIn.addEventListener("input", () => (bg.ink = inkColorIn.value));
for (const [id, name] of PATTERNS) {
  const b = document.createElement("button");
  b.type = "button"; b.textContent = name;
  b.setAttribute("aria-pressed", String(id === bg.pattern));
  b.addEventListener("click", () => {
    bg.pattern = id;
    $$("[data-patterns] button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  });
  $("[data-patterns]").append(b);
}
$("[data-bg-file]").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (bg.media && bg.media.src) { if (bg.mediaIsVideo) bg.media.pause(); URL.revokeObjectURL(bg.media.src); }
  const url = URL.createObjectURL(file);
  if (file.type.startsWith("video/")) {
    const v = Object.assign(document.createElement("video"), { src: url, muted: true, loop: true, playsInline: true, autoplay: true });
    v.setAttribute("playsinline", "");
    v.play().catch(() => {});
    bg.media = v; bg.mediaIsVideo = true;
  } else {
    const img = new Image();
    img.src = url;
    bg.media = img; bg.mediaIsVideo = false;
  }
  $("[data-bg-file-name]").textContent = file.name;
});

// --- Camera --------------------------------------------------------------------------------
const camera = { on: false, stream: null, video: document.createElement("video"), mirror: true, opacity: 1 };
camera.video.muted = true;
camera.video.playsInline = true;
camera.video.setAttribute("playsinline", "");
const camBtn = $("[data-camera-toggle]"), camSel = $("[data-camera-device]");
async function startCamera() {
  stopCamera();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { alertHint("This browser has no camera access (it needs https)."); return; }
  try {
    const video = camSel.value ? { deviceId: { exact: camSel.value } } : { width: { ideal: 1920 }, height: { ideal: 1080 } };
    camera.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    camera.video.srcObject = camera.stream;
    await camera.video.play();
    camera.on = true;
    camBtn.textContent = "Stop camera"; camBtn.classList.add("is-on");
    fillDevices("videoinput", camSel);
  } catch (e) { alertHint("No camera: permission refused or no device."); }
}
function stopCamera() {
  if (camera.stream) camera.stream.getTracks().forEach((t) => t.stop());
  camera.stream = null; camera.on = false;
  camBtn.textContent = "Start camera"; camBtn.classList.remove("is-on");
}
camBtn.addEventListener("click", () => (camera.on ? stopCamera() : startCamera()));
camSel.addEventListener("change", () => { if (camera.on) startCamera(); });
$("[data-camera-mirror]").addEventListener("change", (e) => (camera.mirror = e.target.checked));
$("[data-camera-opacity]").addEventListener("input", (e) => (camera.opacity = +e.target.value));

async function fillDevices(kind, select) {
  try {
    const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === kind);
    const current = select.value;
    select.replaceChildren(new Option("Default", ""));
    list.forEach((d, i) => select.append(new Option(d.label || `${kind === "videoinput" ? "Camera" : "Input"} ${i + 1}`, d.deviceId)));
    select.value = current;
  } catch (e) { /* ignore */ }
}

// --- Audio input: the music plays the type --------------------------------------------------
// The sound is split into nine frequency bands, low (pad 1) to high (pad 9).
// Hits: a sudden jump in a band hits that axis. Follow: the axis follows
// the loudness of its band.
const input = { on: false, stream: null, src: null, analyser: null, data: null, bands: [], levels: new Array(9).fill(0),
  avg: new Array(9).fill(0), last: new Array(9).fill(0), mode: "hits", sens: 0.55 };
const audioBtn = $("[data-audio-toggle]"), audioSel = $("[data-audio-device]");
async function startInput() {
  stopInput();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { alertHint("This browser has no audio input access (it needs https)."); return; }
  const a = getAudio();
  try {
    const constraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    if (audioSel.value) constraints.deviceId = { exact: audioSel.value };
    input.stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
    input.src = a.ctx.createMediaStreamSource(input.stream);
    input.analyser = a.ctx.createAnalyser();
    input.analyser.fftSize = 2048;
    input.analyser.smoothingTimeConstant = 0.2;
    input.src.connect(input.analyser);
    if (a.recDest) { input.toRec = a.ctx.createGain(); input.src.connect(input.toRec); input.toRec.connect(a.recDest); }
    input.data = new Float32Array(input.analyser.frequencyBinCount);
    // nine bands, spaced evenly on a log scale from 40 Hz to 14 kHz
    const hzPerBin = a.ctx.sampleRate / input.analyser.fftSize;
    input.bands = Array.from({ length: 9 }, (_, i) => {
      const lo = 40 * Math.pow(14000 / 40, i / 9), hi = 40 * Math.pow(14000 / 40, (i + 1) / 9);
      return [Math.max(1, Math.floor(lo / hzPerBin)), Math.max(2, Math.ceil(hi / hzPerBin))];
    });
    input.on = true;
    audioBtn.textContent = "Stop listening"; audioBtn.classList.add("is-on");
    fillDevices("audioinput", audioSel);
  } catch (e) { alertHint("No audio input: permission refused or no device."); }
}
function stopInput() {
  if (input.stream) input.stream.getTracks().forEach((t) => t.stop());
  if (input.src) input.src.disconnect();
  input.stream = null; input.src = null; input.on = false;
  axes.forEach((a) => (a.follow = 0));
  input.levels.fill(0);
  audioBtn.textContent = "Listen"; audioBtn.classList.remove("is-on");
}
audioBtn.addEventListener("click", () => (input.on ? stopInput() : startInput()));
audioSel.addEventListener("change", () => { if (input.on) startInput(); });
$$("[data-audio-mode] button").forEach((b) => b.addEventListener("click", () => {
  input.mode = b.dataset.mode;
  $$("[data-audio-mode] button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  if (input.mode !== "follow") axes.forEach((a) => (a.follow = 0));
}));
$("[data-audio-sens]").addEventListener("input", (e) => (input.sens = +e.target.value));

function readAudio(now) {
  if (!input.on) return;
  input.analyser.getFloatFrequencyData(input.data);
  const floor = -80 + (0.5 - input.sens) * 40;      // more sensitive = lower floor
  input.bands.forEach(([lo, hi], i) => {
    let sum = 0, n = 0;
    for (let b = lo; b < hi && b < input.data.length; b++) { sum += Math.pow(10, input.data[b] / 10); n++; }
    const db = n ? 10 * Math.log10(sum / n + 1e-12) : -120;
    const lvl = clamp((db - floor) / 50);
    input.levels[i] = lvl;
    if (input.mode === "follow") axes[i].follow = Math.pow(lvl, 1.4);
    else {
      const jump = lvl - input.avg[i];
      if (jump > 0.1 + (1 - input.sens) * 0.15 && lvl > 0.2 && now - input.last[i] > 90) {
        trigger(i, clamp(0.4 + jump * 2), { sound: false });
        input.last[i] = now;
      }
    }
    input.avg[i] = input.avg[i] * 0.9 + lvl * 0.1;
  });
}
const meters = Array.from({ length: 9 }, () => document.createElement("span"));
$("[data-meters]").append(...meters);
function updateMeters() {
  if ($("[data-panel=input]").hidden) return;
  meters.forEach((m, i) => (m.style.height = Math.max(2, (input.on ? input.levels[i] : axes[i].value) * 100) + "%"));
}

// --- MIDI (Chrome, Edge, Firefox; Safari has no Web MIDI) --------------------------------------
const midiStatus = $("[data-midi-status]"), midiBtn = $("[data-midi-connect]");
if (!navigator.requestMIDIAccess) {
  midiStatus.textContent = "This browser has no MIDI (Safari doesn't support it). Use the keyboard, or open this page in Chrome to play with a MIDI drum pad such as the SPD-SX.";
  midiBtn.hidden = true;
} else {
  midiStatus.textContent = "Pads send notes 60–68 by default (pad 1–9); program change switches style. Click a pad's key in DRUMPAD, then hit a pad to learn its note.";
}
function onMidi(e) {
  const [st, d1, d2] = e.data;
  const cmd = st & 0xf0;
  if (cmd === 0x90 && d2 > 0) {
    if (learning !== null) {
      finishLearning((i) => {
        settings.notes = settings.notes.map((n) => (n === d1 ? null : n));
        settings.notes[i] = d1;
      });
      return;
    }
    const pad = settings.notes.indexOf(d1);
    if (pad >= 0) trigger(pad, d2 / 127);
  } else if (cmd === 0xc0) setStyle(d1 % STYLE_COUNT);
}
midiBtn.addEventListener("click", async () => {
  try {
    const access = await navigator.requestMIDIAccess();
    const hook = () => {
      const names = [];
      access.inputs.forEach((inp) => { inp.onmidimessage = onMidi; names.push(inp.name); });
      midiStatus.textContent = names.length ? "Connected: " + names.join(", ") : "No MIDI device found. Plug one in.";
    };
    hook();
    access.onstatechange = hook;
    midiBtn.hidden = true;
    getAudio();
  } catch (e) { midiStatus.textContent = "MIDI access was refused."; }
});

// --- Record --------------------------------------------------------------------------------------
// Films the canvas (60 fps) with the pad sounds and the audio input, and
// downloads the file when you stop: .mp4 in Safari, .mp4 or .webm in Chrome.
const rec = { recorder: null, chunks: [], start: 0, timer: null };
const recLabel = $("[data-rec-label]"), recDot = $("[data-rec-dot]"), recTime = $("[data-rec-time]");
function pickType() {
  if (!window.MediaRecorder) return null;
  const types = ["video/mp4;codecs=avc1,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  return types.find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || "";
}
function startRecording() {
  const type = pickType();
  if (type === null || !canvas.captureStream) { alertHint("Recording isn't supported in this browser."); return; }
  const a = getAudio();
  const stream = canvas.captureStream(60);
  if (a && a.recDest) a.recDest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  try {
    rec.recorder = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: 12e6 } : undefined);
  } catch (e) { rec.recorder = new MediaRecorder(stream); }
  rec.chunks = [];
  rec.recorder.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
  rec.recorder.onstop = () => {
    const mime = rec.recorder.mimeType || type || "video/webm";
    const blob = new Blob(rec.chunks, { type: mime });
    const d = new Date(), pad = (n) => String(n).padStart(2, "0");
    const name = `segmentor-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${mime.includes("mp4") ? "mp4" : "webm"}`;
    const url = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    alertHint("Saved " + name);
  };
  rec.recorder.start(1000);
  rec.start = performance.now();
  recDot.hidden = false;
  recLabel.textContent = "STOP RECORDING";
  $("[data-action=record]").classList.add("is-on");
  rec.timer = setInterval(() => {
    const s = Math.floor((performance.now() - rec.start) / 1000);
    recTime.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }, 250);
}
function stopRecording() {
  if (rec.recorder && rec.recorder.state !== "inactive") rec.recorder.stop();
  clearInterval(rec.timer);
  recDot.hidden = true; recTime.textContent = "00:00";
  recLabel.textContent = "RECORD";
  $("[data-action=record]").classList.remove("is-on");
}
$("[data-action=record]").addEventListener("click", () => (rec.recorder && rec.recorder.state === "recording" ? stopRecording() : startRecording()));

// Wake the sound after switching tabs/apps or sleep.
for (const ev of ["focus", "pageshow"]) window.addEventListener(ev, () => { if (audio) getAudio(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden && audio) getAudio(); });
document.addEventListener("pointerdown", () => { if (audio) getAudio(); }, true);

// --- Start ------------------------------------------------------------------------------------------
applyTheme();
buildPads();
buildStyles();
buildSounds();
buildEffects();
loadFont(settings.style).catch(() => setHint("The Segmentor data could not be loaded."));
// load the other styles quietly in the background, so switching is instant
setTimeout(() => { for (let i = 0; i < STYLE_COUNT; i++) loadFont(i).catch(() => {}); }, 1500);
requestAnimationFrame(frame);
