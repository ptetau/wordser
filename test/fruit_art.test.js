import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FRUIT_EMOJI } from '../public/engine/game.js';
import { FRUIT_DRAW, FRUIT_HUE, drawSpawn, spawnScale } from '../public/fruit.js';

/**
 * A canvas context that records what was asked of it. Enough for the fruit
 * drawings, which only ever use paths, fills and strokes.
 */
function stubContext() {
  const calls = [];
  const state = { fillStyle: '', strokeStyle: '', lineWidth: 0, globalAlpha: 1 };
  const record = (name) => (...args) => calls.push({ name, args, fill: state.fillStyle });
  return new Proxy(
    {
      calls,
      beginPath: record('beginPath'),
      moveTo: record('moveTo'),
      lineTo: record('lineTo'),
      arc: record('arc'),
      ellipse: record('ellipse'),
      quadraticCurveTo: record('quadraticCurveTo'),
      bezierCurveTo: record('bezierCurveTo'),
      closePath: record('closePath'),
      fill: record('fill'),
      stroke: record('stroke'),
      clip: record('clip'),
      save: record('save'),
      restore: record('restore'),
      translate: record('translate'),
      rotate: record('rotate'),
      scale: record('scale'),
      drawImage: record('drawImage'),
      fillText: record('fillText'),
      fillRect: record('fillRect'),
    },
    {
      get: (t, k) => (k in t ? t[k] : state[k]),
      set: (t, k, v) => ((state[k] = v), true),
    },
  );
}

const TYPES = ['lemon', 'cherry', 'chilli', 'grape', 'banana', 'kiwi'];

test('every fruit the engine can hand out has art and a colour', () => {
  assert.deepEqual(Object.keys(FRUIT_EMOJI).sort(), TYPES.slice().sort());
  for (const type of TYPES) {
    assert.equal(typeof FRUIT_DRAW[type], 'function', `${type} has no drawing`);
    assert.match(FRUIT_HUE[type], /^#[0-9a-f]{6}$/, `${type} has no halo colour`);
  }
});

test('no fruit is drawn with text — that is the bug that hid them', () => {
  for (const type of TYPES) {
    const ctx = stubContext();
    FRUIT_DRAW[type](ctx, 50, 50, 20);
    const text = ctx.calls.filter((c) => c.name === 'fillText');
    assert.deepEqual(text, [], `${type} still draws a glyph`);
  }
});

test('each fruit paints a real shape, and paints it opaquely', () => {
  for (const type of TYPES) {
    const ctx = stubContext();
    FRUIT_DRAW[type](ctx, 50, 50, 20);
    const fills = ctx.calls.filter((c) => c.name === 'fill');
    const strokes = ctx.calls.filter((c) => c.name === 'stroke');
    assert.ok(fills.length >= 2, `${type} barely fills anything (${fills.length})`);
    assert.ok(strokes.length >= 1, `${type} has no outline`);
    // The body colour must be solid: a translucent fill is what made the
    // old fruit invisible against the baize.
    assert.ok(
      fills.some((f) => /^#[0-9a-f]{6}$/i.test(f.fill)),
      `${type} never fills with a solid colour`,
    );
  }
});

test('the fruit stay inside their cell', () => {
  // Art is bounded by r; the cell half-width is r / 0.32 ≈ 3.1r, and the
  // last-move ring sits at 0.46 of the cell. Nothing may reach it.
  for (const type of TYPES) {
    const ctx = stubContext();
    const r = 20;
    FRUIT_DRAW[type](ctx, 0, 0, r);
    let reach = 0;
    let clipped = 0; // shading paths are clipped to the body, so they can't spill
    for (const { name, args } of ctx.calls) {
      if (name === 'clip') clipped++;
      if (name === 'restore' && clipped) clipped--;
      if (clipped) continue;
      if (name === 'translate' || name === 'rotate' || name === 'scale') continue;
      const coords = args.slice(0, 2).filter((n) => typeof n === 'number');
      for (const n of coords) reach = Math.max(reach, Math.abs(n));
    }
    assert.ok(reach <= r * 1.45, `${type} reaches ${(reach / r).toFixed(2)}r`);
  }
});

test('detail drops away as the fruit gets small', () => {
  for (const type of TYPES) {
    const big = stubContext();
    const small = stubContext();
    FRUIT_DRAW[type](big, 50, 50, 20);
    FRUIT_DRAW[type](small, 50, 50, 5); // zoomed right out
    assert.ok(
      small.calls.length < big.calls.length,
      `${type} draws just as much at 5px as at 20px`,
    );
    assert.ok(small.calls.some((c) => c.name === 'fill'), `${type} vanishes when small`);
  }
});

test('the arrival flourish starts small, overshoots, and settles', () => {
  assert.ok(spawnScale(0) < 0.3, 'should start tiny');
  assert.ok(spawnScale(0.55) > 1.1, 'should overshoot');
  // ...and the two halves must meet, or it snaps mid-flourish.
  assert.ok(Math.abs(spawnScale(0.5499) - spawnScale(0.5501)) < 0.01, 'discontinuous');
  assert.ok(Math.abs(spawnScale(1) - 1) < 0.001, 'should settle at full size');

  const ctx = stubContext();
  drawSpawn(ctx, 0, 0, 20, 0.5);
  assert.ok(ctx.calls.some((c) => c.name === 'stroke'), 'no ring');
  assert.ok(ctx.calls.some((c) => c.name === 'fill'), 'no twinkle');
});
