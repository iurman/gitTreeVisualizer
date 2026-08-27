import { useCallback, useEffect, useRef, useState } from 'react';
import { UNIT_ORDER, ringUnitEnabled, type RingUnit } from '@gittree/core';
import { useViewer, useViewerState } from './useViewer.js';

/* -------------------------------------------------------------------------- */
/* The specimen rule                                                           */
/*                                                                            */
/* A commit-density histogram spanning the repository's whole life. It is the  */
/* minimap, the range brush and the growth scrubber in one strip, because they */
/* are all the same axis. Density is drawn first so a reader can see where the */
/* interesting periods are before selecting one.                               */
/* -------------------------------------------------------------------------- */

type Drag =
  | { kind: 'brush'; from: number }
  | { kind: 'move'; grab: number; width: number }
  | { kind: 'edge'; edge: 'start' | 'end' }
  | { kind: 'scrub' }
  | null;

const iso = (t: number) => new Date(t).toISOString();

export function Timeline() {
  const viewer = useViewer();
  const s = useViewerState();
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const [snap, setSnap] = useState(false);

  const fullStart = Date.parse(s.fullWindow.start);
  const fullEnd = Date.parse(s.fullWindow.end);
  const span = Math.max(1, fullEnd - fullStart);
  const winStart = (Date.parse(s.window.start) - fullStart) / span;
  const winEnd = (Date.parse(s.window.end) - fullStart) / span;

  const posOf = useCallback((clientX: number): number => {
    const el = trackRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  }, []);

  const snapTo = useCallback(
    (f: number): number => {
      if (!snap) return f;
      const t = fullStart + f * span;
      const unitMs = { hour: 3.6e6, day: 8.64e7, week: 6.048e8, month: 2.629746e9, year: 3.1556952e10 }[s.ringUnit];
      return Math.max(0, Math.min(1, (Math.round(t / unitMs) * unitMs - fullStart) / span));
    },
    [snap, fullStart, span, s.ringUnit],
  );

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const f = posOf(e.clientX);
      if (drag.kind === 'scrub') {
        viewer.skipGrowth();
        viewer.setGrowth(f);
        return;
      }
      if (drag.kind === 'brush') {
        const a = snapTo(Math.min(drag.from, f));
        const b = snapTo(Math.max(drag.from, f));
        if (b - a > 0.004) viewer.setWindow({ start: iso(fullStart + a * span), end: iso(fullStart + b * span) });
        return;
      }
      if (drag.kind === 'move') {
        const start = Math.max(0, Math.min(1 - drag.width, snapTo(f - drag.grab)));
        viewer.setWindow({ start: iso(fullStart + start * span), end: iso(fullStart + (start + drag.width) * span) });
        return;
      }
      const other = drag.edge === 'start' ? winEnd : winStart;
      const a = Math.min(snapTo(f), other - 0.004);
      const b = Math.max(snapTo(f), other + 0.004);
      viewer.setWindow({
        start: iso(fullStart + (drag.edge === 'start' ? a : Math.min(other, b - 0.004)) * span),
        end: iso(fullStart + (drag.edge === 'start' ? Math.max(other, a + 0.004) : b) * span),
      });
    };
    const up = () => setDrag(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [drag, posOf, snapTo, viewer, fullStart, span, winStart, winEnd]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const unitMs = { hour: 3.6e6, day: 8.64e7, week: 6.048e8, month: 2.629746e9, year: 3.1556952e10 }[s.ringUnit];
    const start = Date.parse(s.window.start);
    const end = Date.parse(s.window.end);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const d = (e.key === 'ArrowRight' ? 1 : -1) * unitMs;
      if (e.shiftKey) viewer.setWindow({ start: s.window.start, end: iso(Math.max(start + unitMs, end + d)) });
      else viewer.setWindow({ start: iso(start + d), end: iso(end + d) });
    } else if (e.key === '[' || e.key === ']') {
      e.preventDefault();
      viewer.stepRingUnit(e.key === '[' ? -1 : 1);
    }
  };

  const windowed = winStart > 0.001 || winEnd < 0.999;

  return (
    <div className="rule">
      <div className="rule-row">
        <div className="ring-control" role="group" aria-label="Ring granularity">
          {UNIT_ORDER.map((u: RingUnit) => {
            const enabled = ringUnitEnabled(u, s.window);
            return (
              <button
                key={u}
                type="button"
                className={`ring-unit${s.ringUnit === u ? ' on' : ''}${s.ringAuto === u ? ' auto' : ''}`}
                disabled={!enabled}
                title={enabled ? `Draw a ring every ${u}` : `Too many rings to read across this range`}
                onClick={() => viewer.setRingUnit(u)}
              >
                {u.slice(0, 1).toUpperCase()}
                <span className="ring-unit-full">{u.slice(1)}</span>
              </button>
            );
          })}
        </div>

        <div
          className="track"
          ref={trackRef}
          tabIndex={0}
          role="slider"
          aria-label="History range and growth"
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={Number(s.growth.toFixed(2))}
          onKeyDown={onKeyDown}
          onDoubleClick={() => viewer.resetWindow()}
          onPointerDown={(e) => {
            setSnap(e.shiftKey);
            const f = posOf(e.clientX);
            // Selecting a range is the primary action, so a plain drag brushes
            // one. Alt-drag scrubs growth, and once a range exists, dragging
            // inside it pans. This is the order the hint below promises.
            const inside = windowed && f >= winStart && f <= winEnd;
            if (e.altKey) {
              setDrag({ kind: 'scrub' });
              viewer.skipGrowth();
              viewer.setGrowth(f);
            } else if (inside) {
              setDrag({ kind: 'move', grab: f - winStart, width: winEnd - winStart });
            } else {
              setDrag({ kind: 'brush', from: f });
            }
          }}
        >
          <div className="density" aria-hidden="true">
            {s.density.map((d, i) => (
              <span key={i} style={{ height: `${8 + d * 92}%` }} />
            ))}
          </div>

          <div className="mask" style={{ left: 0, width: `${winStart * 100}%` }} aria-hidden="true" />
          <div className="mask" style={{ left: `${winEnd * 100}%`, right: 0 }} aria-hidden="true" />

          <div className="grown" style={{ width: `${(winStart + (winEnd - winStart) * s.growth) * 100}%` }} aria-hidden="true" />

          <button
            type="button"
            className="handle"
            aria-label="Range start"
            style={{ left: `${winStart * 100}%` }}
            onPointerDown={(e) => {
              e.stopPropagation();
              setSnap(e.shiftKey);
              setDrag({ kind: 'edge', edge: 'start' });
            }}
          />
          <button
            type="button"
            className="handle"
            aria-label="Range end"
            style={{ left: `${winEnd * 100}%` }}
            onPointerDown={(e) => {
              e.stopPropagation();
              setSnap(e.shiftKey);
              setDrag({ kind: 'edge', edge: 'end' });
            }}
          />
        </div>

        <div className="rule-readout mono">
          <span>{new Date(s.window.start).toISOString().slice(0, 10)}</span>
          <span className="sep">→</span>
          <span>{new Date(s.window.end).toISOString().slice(0, 10)}</span>
        </div>
      </div>

      <div className="rule-hint">
        {windowed ? (
          <button type="button" className="link" onClick={() => viewer.resetWindow()}>
            Showing part of the history. Reset to all of it.
          </button>
        ) : (
          <span>Drag to select a range. Alt-drag to scrub growth. Shift snaps to {s.ringUnit}s.</span>
        )}
        {s.stumpCommits > 0 ? (
          <span className="mono stump">{s.stumpCommits.toLocaleString('en-US')} commits before this range</span>
        ) : null}
        {s.cutCommits > 0 ? (
          <span className="mono stump">{s.cutCommits.toLocaleString('en-US')} after</span>
        ) : null}
      </div>
    </div>
  );
}
