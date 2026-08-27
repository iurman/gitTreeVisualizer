import { describe, expect, it } from 'vitest';
import { GrowthSonifier, type GrowthEvent, type SoundEngine } from './engine.js';

/* The growth cursor drives the sound, so the seek behaviour is the contract:
 * every event fires exactly once, in order, and only when growth passes it. A
 * score whose events all sat at height zero shipped once, and the whole
 * sonification went silent because seeking to the start consumed all of it. */

function recorder() {
  const fired: string[] = [];
  const sound = {
    leaf: () => fired.push('leaf'),
    limb: () => fired.push('limb'),
    ring: () => fired.push('ring'),
  } as unknown as SoundEngine;
  return { fired, sound };
}

const leafAt = (h: number): { h: number; ev: GrowthEvent } => ({
  h,
  ev: { kind: 'leaf', leaf: { size: 0.5, depth: 1, isMerge: false } },
});

const score = (n: number) => Array.from({ length: n }, (_, i) => leafAt(i / (n - 1)));

describe('GrowthSonifier', () => {
  it('fires each event once, as growth passes it', () => {
    const { fired, sound } = recorder();
    const s = new GrowthSonifier();
    s.load(score(101), false);
    s.reset(0);

    s.advance(0.5, sound);
    const atHalf = fired.length;
    expect(atHalf).toBeGreaterThan(40);
    expect(atHalf).toBeLessThan(60);

    s.advance(1, sound);
    expect(fired).toHaveLength(101);

    // Advancing again past the end changes nothing.
    s.advance(1, sound);
    expect(fired).toHaveLength(101);
  });

  it('does not replay the past when the score is rebuilt mid-growth', () => {
    const { fired, sound } = recorder();
    const s = new GrowthSonifier();
    s.load(score(101), false);
    // A streamed page arrives when growth is already half done.
    s.reset(0.5);
    s.advance(1, sound);
    expect(fired.length).toBeLessThan(60);
    expect(fired.length).toBeGreaterThan(40);
  });

  it('re-seeks when growth is scrubbed backwards', () => {
    const { fired, sound } = recorder();
    const s = new GrowthSonifier();
    s.load(score(101), false);
    s.reset(0);
    s.advance(1, sound);
    expect(fired).toHaveLength(101);

    // Scrubbing back and forward replays, rather than staying silent forever.
    s.advance(0, sound);
    s.advance(1, sound);
    expect(fired.length).toBeGreaterThan(101);
  });

  it('stays silent while growth has not reached anything', () => {
    const { fired, sound } = recorder();
    const s = new GrowthSonifier();
    s.load(score(50), false);
    s.reset(0);
    s.advance(0, sound);
    // Only what sits exactly at zero, not the whole score.
    expect(fired.length).toBeLessThanOrEqual(1);
  });

  it('suppresses minor rings when they are dense, and never the major ones', () => {
    const calls: boolean[] = [];
    const sound = { ring: (major: boolean, dense: boolean) => calls.push(major || !dense) } as unknown as SoundEngine;
    const s = new GrowthSonifier();
    s.load(
      [
        { h: 0.1, ev: { kind: 'ring', major: false } },
        { h: 0.2, ev: { kind: 'ring', major: true } },
      ],
      true,
    );
    s.reset(0);
    s.advance(1, sound);
    expect(calls).toEqual([false, true]);
  });
});
