import { describe, expect, it } from 'vitest';
import { Raster, lookup, paletteLut } from './raster.js';
import { hexToRgb, PALETTE } from '../palette.js';

/* Not assertions about speed, which would be flaky. These print the numbers the
 * optimisation decisions were made from, and assert only that the work happens
 * at all. Run with `vitest bench.bench` and read the output. */
describe('render cost', () => {
  it('fills the palette lookup table on demand rather than up front', () => {
    // What the eager version cost: every cell resolved before the first frame.
    const all = performance.now();
    for (let key = 0; key < 32768; key++) lookup(key);
    const eager = performance.now() - all;
    console.log(`palette LUT, all 32768 cells: ${eager.toFixed(1)} ms`);
    expect(paletteLut().length).toBe(32768);
  });

  it('rasterizes a frame of leaves and limbs', () => {
    const r = new Raster();
    r.resize(480, 270);
    const bg = hexToRgb(PALETTE[1]);
    const c = hexToRgb(PALETTE[12]);
    const FRAMES = 30;
    let first = 0;
    const t = performance.now();
    for (let f = 0; f < FRAMES; f++) {
      if (f === 1) first = performance.now() - t;
      r.clear(bg);
      // 143 limbs x 21 segments x 3 bands, as tapered quads.
      for (let i = 0; i < 143 * 21 * 3; i++) {
        const x = (i * 7) % 460;
        const y = (i * 13) % 250;
        r.fillTri(x, y, 50, x + 3, y, 50, x + 3, y + 8, 52, c[0], c[1], c[2]);
        r.fillTri(x, y, 50, x + 3, y + 8, 52, x, y + 8, 52, c[0], c[1], c[2]);
      }
      // 1,400 leaves, a few pixels each.
      for (let i = 0; i < 1400; i++) {
        const x = (i * 17) % 470;
        const y = (i * 29) % 260;
        r.fillRect(x, y, 3, 40, c[0], c[1], c[2]);
      }
      r.present();
    }
    const ms = (performance.now() - t) / FRAMES;
    console.log(`raster first frame: ${first.toFixed(2)} ms`);
    console.log(`raster frame: ${ms.toFixed(2)} ms  (${(1000 / ms).toFixed(0)} fps ceiling)`);
    expect(ms).toBeGreaterThan(0);
  });
});
