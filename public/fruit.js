// Bonus fruit, drawn by hand.
//
// These used to be system emoji, which meant the art was whatever font the
// device happened to ship — inconsistent, out of our control, and nothing
// like the parlour's mahogany-and-baize look. Worse, a platform without a
// colour glyph fell back to painting them in the ring's translucent cream,
// which is why players reported the fruit "not showing".
//
// So they are canvas paths now: enamel brooches on green felt. Flat jewel
// colour, one espresso outline in the same ink as the tile edges, one wet
// highlight. Each fruit is triple-coded — hue, mass and axis all differ —
// so they stay apart at a glance, at any zoom, for any eyes.

const INK = '#2a1109'; // espresso, a cousin of the tile edge
const LEAF = '#57a13c';
const LEAF_DK = '#2f6b23';
const STEM = '#7a5326';
const TAU = Math.PI * 2;

/** The colour each fruit broadcasts, used for its halo. */
export const FRUIT_HUE = {
  lemon: '#f2ce2b',
  cherry: '#e02845',
  chilli: '#f2561c',
  grape: '#9166dd',
  banana: '#f0a81f',
  kiwi: '#8dc63f',
  mushroom: '#e2554b',
};

function ink(ctx, w) {
  ctx.strokeStyle = INK;
  ctx.lineWidth = w;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
}

/**
 * Fill a shape, shade it from within, then outline it. The path is built
 * twice on purpose: restore() does not restore the current path, so the
 * shade's clip would otherwise leave the wrong shape under the stroke.
 */
function body(ctx, path, fill, shade, lw) {
  path();
  ctx.fillStyle = fill;
  ctx.fill();
  if (shade) {
    ctx.save();
    ctx.clip();
    shade();
    ctx.restore();
  }
  path();
  ink(ctx, lw);
}

export function drawLemon(ctx, cx, cy, r) {
  const lw = Math.max(1, r * 0.13);
  const fine = r > 7;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-0.22);
  body(ctx, () => {
    ctx.beginPath(); // a fat lens with pointed nubs
    ctx.moveTo(-r, 0);
    ctx.bezierCurveTo(-r * 0.62, -r * 0.86, r * 0.46, -r * 0.9, r, -r * 0.02);
    ctx.bezierCurveTo(r * 0.46, r * 0.88, -r * 0.62, r * 0.84, -r, 0);
    ctx.closePath();
  }, '#f2ce2b', fine && (() => {
    ctx.beginPath();
    ctx.ellipse(r * 0.2, r * 0.7, r * 0.95, r * 0.52, -0.15, 0, TAU);
    ctx.fillStyle = '#c8990f';
    ctx.fill();
  }), lw);
  if (fine) {
    ctx.beginPath();
    ctx.ellipse(-r * 0.34, -r * 0.36, r * 0.32, r * 0.14, -0.32, 0, TAU);
    ctx.fillStyle = 'rgba(255,252,220,0.75)';
    ctx.fill();
  }
  ctx.restore();
  if (r > 9) {
    ctx.beginPath(); // a leaf, so it has a top
    ctx.moveTo(cx + r * 0.2, cy - r * 0.5);
    ctx.quadraticCurveTo(cx + r * 0.76, cy - r * 1.12, cx + r * 0.98, cy - r * 0.58);
    ctx.quadraticCurveTo(cx + r * 0.58, cy - r * 0.4, cx + r * 0.2, cy - r * 0.5);
    ctx.closePath();
    ctx.fillStyle = LEAF;
    ctx.fill();
    ink(ctx, lw * 0.7);
  }
}

export function drawCherry(ctx, cx, cy, r) {
  const lw = Math.max(1, r * 0.13);
  const fine = r > 7;
  const bl = { x: cx - r * 0.44, y: cy + r * 0.36, r: r * 0.5 };
  const br = { x: cx + r * 0.42, y: cy + r * 0.46, r: r * 0.44 };
  const top = { x: cx + r * 0.1, y: cy - r * 0.92 };
  ctx.beginPath(); // paired stems, behind the fruit
  ctx.moveTo(bl.x, bl.y - bl.r * 0.8);
  ctx.quadraticCurveTo(cx - r * 0.62, cy - r * 0.72, top.x, top.y);
  ctx.moveTo(br.x, br.y - br.r * 0.8);
  ctx.quadraticCurveTo(cx + r * 0.64, cy - r * 0.3, top.x, top.y);
  ctx.strokeStyle = STEM;
  ctx.lineWidth = Math.max(1.2, r * 0.13);
  ctx.lineCap = 'round';
  ctx.stroke();
  body(ctx, () => {
    ctx.beginPath(); // both berries in one path
    ctx.moveTo(bl.x + bl.r, bl.y);
    ctx.arc(bl.x, bl.y, bl.r, 0, TAU);
    ctx.moveTo(br.x + br.r, br.y);
    ctx.arc(br.x, br.y, br.r, 0, TAU);
  }, '#e02845', fine && (() => {
    ctx.beginPath();
    ctx.arc(cx + r * 0.12, cy + r * 1.18, r * 0.98, 0, TAU);
    ctx.fillStyle = '#9e142d';
    ctx.fill();
  }), lw);
  if (fine) {
    ctx.beginPath();
    ctx.ellipse(bl.x - bl.r * 0.34, bl.y - bl.r * 0.42, bl.r * 0.3, bl.r * 0.17, -0.6, 0, TAU);
    ctx.moveTo(br.x, br.y);
    ctx.ellipse(br.x - br.r * 0.3, br.y - br.r * 0.44, br.r * 0.26, br.r * 0.15, -0.6, 0, TAU);
    ctx.fillStyle = 'rgba(255,232,232,0.75)';
    ctx.fill();
  }
  if (r > 9) {
    ctx.beginPath();
    ctx.moveTo(top.x, top.y + r * 0.06);
    ctx.quadraticCurveTo(cx + r * 0.92, cy - r * 1.18, cx + r * 0.98, cy - r * 0.66);
    ctx.quadraticCurveTo(cx + r * 0.5, cy - r * 0.6, top.x, top.y + r * 0.06);
    ctx.closePath();
    ctx.fillStyle = LEAF;
    ctx.fill();
    ink(ctx, lw * 0.7);
  }
}

export function drawChilli(ctx, cx, cy, r) {
  const lw = Math.max(1, r * 0.13);
  const fine = r > 7;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(0.3);
  body(ctx, () => {
    ctx.beginPath(); // fat shoulder tapering to a curled tip
    ctx.moveTo(-r * 0.4, -r * 0.66);
    ctx.bezierCurveTo(r * 0.54, -r * 0.44, r * 0.88, r * 0.3, r * 0.32, r * 1.0);
    ctx.bezierCurveTo(r * 0.42, r * 0.3, r * 0.02, -r * 0.02, -r * 0.78, -r * 0.26);
    ctx.closePath();
  }, '#f2561c', fine && (() => {
    ctx.beginPath();
    ctx.moveTo(r * 0.16, -r * 0.9);
    ctx.bezierCurveTo(r * 1.0, -r * 0.2, r * 1.0, r * 0.5, r * 0.32, r * 1.2);
    ctx.lineTo(r * 1.4, r * 1.4);
    ctx.lineTo(r * 1.4, -r * 0.9);
    ctx.closePath();
    ctx.fillStyle = '#b03005';
    ctx.fill();
  }), lw);
  if (fine) {
    ctx.beginPath();
    ctx.moveTo(-r * 0.18, -r * 0.32);
    ctx.quadraticCurveTo(r * 0.34, 0, r * 0.26, r * 0.56);
    ctx.strokeStyle = 'rgba(255,236,214,0.65)';
    ctx.lineWidth = lw * 0.9;
    ctx.lineCap = 'round';
    ctx.stroke();
  }
  ctx.beginPath(); // green calyx
  ctx.moveTo(-r * 0.32, -r * 0.76);
  ctx.quadraticCurveTo(-r * 0.94, -r * 0.9, -r * 0.88, -r * 0.18);
  ctx.quadraticCurveTo(-r * 0.5, -r * 0.46, -r * 0.32, -r * 0.76);
  ctx.closePath();
  ctx.fillStyle = LEAF_DK;
  ctx.fill();
  ink(ctx, lw * 0.7);
  ctx.beginPath(); // stalk
  ctx.moveTo(-r * 0.62, -r * 0.66);
  ctx.lineTo(-r * 0.82, -r * 1.02);
  ctx.strokeStyle = LEAF;
  ctx.lineWidth = Math.max(1.2, lw * 1.1);
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();
}

const BERRIES = [
  [-0.52, -0.32], [0, -0.4], [0.52, -0.32],
  [-0.28, 0.2], [0.28, 0.2],
  [0, 0.7],
];

export function drawGrape(ctx, cx, cy, r) {
  const lw = Math.max(1, r * 0.11);
  const br = r * 0.34;
  ctx.beginPath(); // stalk
  ctx.moveTo(cx, cy - r * 0.5);
  ctx.quadraticCurveTo(cx + r * 0.16, cy - r * 0.86, cx - r * 0.06, cy - r * 1.02);
  ctx.strokeStyle = STEM;
  ctx.lineWidth = Math.max(1.2, r * 0.12);
  ctx.lineCap = 'round';
  ctx.stroke();
  // Six berries as one compound path: the divisions come free from each
  // full circle being stroked over its neighbour.
  body(ctx, () => {
    ctx.beginPath();
    for (const [bx, by] of BERRIES) {
      ctx.moveTo(cx + bx * r + br, cy + by * r);
      ctx.arc(cx + bx * r, cy + by * r, br, 0, TAU);
    }
  }, '#9166dd', r > 7 && (() => {
    ctx.beginPath();
    ctx.arc(cx, cy + r * 1.5, r * 1.15, 0, TAU);
    ctx.fillStyle = '#6b45ad';
    ctx.fill();
  }), lw);
  if (r > 7) {
    ctx.beginPath();
    for (const [bx, by] of BERRIES.slice(0, 3)) {
      ctx.moveTo(cx + bx * r, cy + by * r);
      ctx.ellipse(cx + bx * r - br * 0.3, cy + by * r - br * 0.36, br * 0.32, br * 0.18, -0.6, 0, TAU);
    }
    ctx.fillStyle = 'rgba(242,232,255,0.7)';
    ctx.fill();
  }
  if (r > 9) {
    ctx.beginPath();
    ctx.moveTo(cx + r * 0.02, cy - r * 0.78);
    ctx.quadraticCurveTo(cx + r * 0.92, cy - r * 1.16, cx + r * 0.88, cy - r * 0.5);
    ctx.quadraticCurveTo(cx + r * 0.4, cy - r * 0.52, cx + r * 0.02, cy - r * 0.78);
    ctx.closePath();
    ctx.fillStyle = LEAF;
    ctx.fill();
    ink(ctx, lw * 0.8);
  }
}

export function drawBanana(ctx, cx, cy, r) {
  const lw = Math.max(1, r * 0.13);
  const fine = r > 7;
  ctx.save();
  ctx.translate(cx, cy - r * 0.14);
  ctx.rotate(-0.1);
  body(ctx, () => {
    ctx.beginPath(); // deep belly, shallow back
    ctx.moveTo(-r * 0.88, -r * 0.52);
    ctx.bezierCurveTo(-r * 0.78, r * 0.78, r * 0.78, r * 0.78, r * 0.88, -r * 0.52);
    ctx.bezierCurveTo(r * 0.56, -r * 0.06, -r * 0.56, -r * 0.06, -r * 0.88, -r * 0.52);
    ctx.closePath();
  }, '#f0a81f', fine && (() => {
    ctx.beginPath();
    ctx.moveTo(-r * 1.1, r * 0.2);
    ctx.bezierCurveTo(-r * 0.7, r * 0.8, r * 0.7, r * 0.8, r * 1.1, r * 0.2);
    ctx.lineTo(r * 1.1, r * 1.2);
    ctx.lineTo(-r * 1.1, r * 1.2);
    ctx.closePath();
    ctx.fillStyle = '#c97e07';
    ctx.fill();
  }), lw);
  if (fine) {
    ctx.beginPath();
    ctx.moveTo(-r * 0.58, -r * 0.24);
    ctx.quadraticCurveTo(0, r * 0.36, r * 0.58, -r * 0.24);
    ctx.strokeStyle = 'rgba(255,246,206,0.65)';
    ctx.lineWidth = lw * 0.9;
    ctx.lineCap = 'round';
    ctx.stroke();
  }
  ctx.beginPath(); // browned tips
  ctx.moveTo(-r * 0.86 + lw, -r * 0.56);
  ctx.arc(-r * 0.86, -r * 0.56, lw * 0.95, 0, TAU);
  ctx.moveTo(r * 0.86 + lw, -r * 0.56);
  ctx.arc(r * 0.86, -r * 0.56, lw * 0.95, 0, TAU);
  ctx.fillStyle = '#5a3a12';
  ctx.fill();
  ctx.restore();
}

export function drawKiwi(ctx, cx, cy, r) {
  const lw = Math.max(1, r * 0.11);
  ctx.beginPath(); // fuzzy rind
  ctx.arc(cx, cy, r * 0.94, 0, TAU);
  ctx.fillStyle = '#7d5a2c';
  ctx.fill();
  ink(ctx, lw);
  ctx.beginPath(); // flesh
  ctx.arc(cx, cy, r * 0.78, 0, TAU);
  ctx.fillStyle = '#8dc63f';
  ctx.fill();
  if (r > 10) {
    ctx.beginPath(); // radial streaks
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * TAU + 0.3;
      ctx.moveTo(cx + Math.cos(a) * r * 0.3, cy + Math.sin(a) * r * 0.3);
      ctx.lineTo(cx + Math.cos(a) * r * 0.74, cy + Math.sin(a) * r * 0.74);
    }
    ctx.strokeStyle = 'rgba(236,248,212,0.45)';
    ctx.lineWidth = Math.max(1, r * 0.07);
    ctx.stroke();
  }
  if (r > 7) {
    ctx.beginPath(); // eight seeds, one fill
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + 0.2;
      const sx = cx + Math.cos(a) * r * 0.5;
      const sy = cy + Math.sin(a) * r * 0.5;
      ctx.moveTo(sx + r * 0.11, sy);
      ctx.ellipse(sx, sy, r * 0.11, r * 0.075, a, 0, TAU);
    }
    ctx.fillStyle = '#231007';
    ctx.fill();
  }
  ctx.beginPath(); // pale core
  ctx.arc(cx, cy, r * 0.26, 0, TAU);
  ctx.fillStyle = '#f0f7da';
  ctx.fill();
  if (r > 7) {
    ctx.beginPath(); // glassy sheen
    ctx.arc(cx, cy, r * 0.6, Math.PI * 1.06, Math.PI * 1.5);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = r * 0.3;
    ctx.lineCap = 'round';
    ctx.stroke();
  }
}

/**
 * A fly agaric: red cap, white spots, pale stalk. The one fruit that does
 * something to the board rather than to your rack, so it wants to look a
 * little dangerous.
 */
export function drawMushroom(ctx, cx, cy, r) {
  const lw = Math.max(1, r * 0.1);
  const top = cy - r * 0.16;
  ctx.beginPath(); // stalk
  ctx.moveTo(cx - r * 0.26, top);
  ctx.bezierCurveTo(cx - r * 0.3, cy + r * 0.6, cx - r * 0.2, cy + r * 0.82, cx, cy + r * 0.82);
  ctx.bezierCurveTo(cx + r * 0.2, cy + r * 0.82, cx + r * 0.3, cy + r * 0.6, cx + r * 0.26, top);
  ctx.closePath();
  ctx.fillStyle = '#f2e6cd';
  ctx.fill();
  ink(ctx, lw);
  ctx.beginPath(); // cap
  ctx.moveTo(cx - r * 0.95, top);
  ctx.bezierCurveTo(cx - r * 0.95, cy - r * 1.1, cx + r * 0.95, cy - r * 1.1, cx + r * 0.95, top);
  ctx.closePath();
  ctx.fillStyle = '#e2554b';
  ctx.fill();
  ink(ctx, lw);
  if (r > 7) {
    ctx.save();
    ctx.beginPath(); // spots, clipped to the cap
    ctx.moveTo(cx - r * 0.95, top);
    ctx.bezierCurveTo(cx - r * 0.95, cy - r * 1.1, cx + r * 0.95, cy - r * 1.1, cx + r * 0.95, top);
    ctx.closePath();
    ctx.clip();
    ctx.beginPath();
    for (const [sx, sy, sr] of [[-0.5, -0.34, 0.2], [0.12, -0.52, 0.16], [0.56, -0.26, 0.14], [-0.06, -0.16, 0.12]]) {
      ctx.moveTo(cx + (sx + sr) * r, cy + sy * r);
      ctx.arc(cx + sx * r, cy + sy * r, sr * r, 0, TAU);
    }
    ctx.fillStyle = '#fbf3e2';
    ctx.fill();
    ctx.restore();
  }
  if (r > 9) {
    ctx.beginPath(); // the gills' shadow under the cap
    ctx.moveTo(cx - r * 0.9, top);
    ctx.lineTo(cx + r * 0.9, top);
    ctx.strokeStyle = 'rgba(35,16,7,0.45)';
    ctx.lineWidth = r * 0.12;
    ctx.stroke();
  }
}

export const FRUIT_DRAW = {
  lemon: drawLemon,
  cherry: drawCherry,
  chilli: drawChilli,
  grape: drawGrape,
  banana: drawBanana,
  kiwi: drawKiwi,
  mushroom: drawMushroom,
};

// A dark dimple pressed into the felt with a wash of the fruit's own colour
// around it: raises local contrast without adding brightness, so the fruit
// separates from the baize while the ivory letters stay the brightest thing
// on the board. Cached per hue — building a gradient per frame costs ~57x
// more than drawing the sprite, and shadowBlur is worse still.
const halos = new Map();
function halo(hue) {
  let sprite = halos.get(hue);
  if (sprite) return sprite;
  const S = 128;
  sprite = document.createElement('canvas');
  sprite.width = sprite.height = S;
  const g = sprite.getContext('2d');
  const h = S / 2;
  const ramp = g.createRadialGradient(h, h, 0, h, h, h);
  ramp.addColorStop(0.0, 'rgba(5,20,12,0.46)');
  ramp.addColorStop(0.4, 'rgba(5,20,12,0.34)');
  ramp.addColorStop(0.55, `${hue}47`);
  ramp.addColorStop(1.0, `${hue}00`);
  g.fillStyle = ramp;
  g.fillRect(0, 0, S, S);
  halos.set(hue, sprite);
  return sprite;
}

/** The flourish when a fruit first appears: a ring and a four-point twinkle. */
export function drawSpawn(ctx, cx, cy, r, u) {
  const e = 1 - (1 - u) ** 3;
  ctx.beginPath();
  ctx.arc(cx, cy, r * (0.7 + e * 0.75), 0, TAU);
  ctx.strokeStyle = `rgba(247,234,208,${0.55 * (1 - u)})`;
  ctx.lineWidth = Math.max(0.5, r * 0.18 * (1 - u));
  ctx.stroke();
  const k = r * (0.7 + e * 0.6);
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const th = (i * TAU) / 4 + 0.5 + e * 0.5;
    ctx.moveTo(cx + Math.cos(th) * k, cy + Math.sin(th) * k);
    ctx.lineTo(cx + Math.cos(th + 0.14) * k * 0.6, cy + Math.sin(th + 0.14) * k * 0.6);
    ctx.lineTo(cx + Math.cos(th) * k * 0.35, cy + Math.sin(th) * k * 0.35);
    ctx.lineTo(cx + Math.cos(th - 0.14) * k * 0.6, cy + Math.sin(th - 0.14) * k * 0.6);
    ctx.closePath();
  }
  ctx.fillStyle = `rgba(255,243,214,${0.9 * (1 - u)})`;
  ctx.fill();
}

/**
 * How much a fruit is scaled up during its first moments: springs open to a
 * slight overshoot, then eases back to full size. The two halves have to
 * meet at 1.14, or the fruit visibly snaps at the join.
 */
export const spawnScale = (u) =>
  u < 0.55 ? 0.25 + 0.89 * (u / 0.55) : 1.14 - 0.14 * ((u - 0.55) / 0.45);

/**
 * Draw one fruit whole: halo, the shadow it casts on the felt, then the
 * fruit itself. `spawn` is 0..1 through its arrival flourish, or null.
 */
export function drawFruit(ctx, type, cx, cy, r, { spawn = null, alpha = 1, t = 0, seed = 0 } = {}) {
  const draw = FRUIT_DRAW[type];
  if (!draw) return;
  ctx.save();
  if (alpha !== 1) ctx.globalAlpha = alpha;
  const d = r * 3;
  ctx.drawImage(halo(FRUIT_HUE[type]), cx - d / 2, cy - d / 2, d, d);
  // A slow bob and sway on its own phase. Position, never brightness:
  // peripheral vision barely registers a 2px drift but flicker is agony.
  const bob = Math.sin(t * 1.9 + seed) * r * 0.07;
  const sway = Math.cos(t * 1.3 + seed * 1.7) * r * 0.04;
  cx += sway;
  cy += bob;
  const scale = spawn === null ? 1 : spawnScale(spawn);
  ctx.beginPath(); // contact shadow: it lies on the felt, it doesn't float
  ctx.ellipse(cx, cy + r * 1.02, r * 0.78 * scale, r * 0.2, 0, 0, TAU);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fill();
  if (scale === 1) {
    draw(ctx, cx, cy, r);
  } else {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    draw(ctx, 0, 0, r);
    ctx.restore();
  }
  if (spawn !== null) drawSpawn(ctx, cx, cy, r, spawn);
  ctx.restore();
}
