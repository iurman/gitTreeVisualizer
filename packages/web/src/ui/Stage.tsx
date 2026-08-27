import { useEffect, useRef } from 'react';
import { useViewer, useViewerState } from './useViewer.js';

/* The canvas, and every pointer and keyboard interaction that belongs to it.
 * Arrow keys walk the graph when the canvas has focus; the timeline scopes the
 * same keys to the window when it has focus instead. */

export function Stage() {
  const viewer = useViewer();
  const s = useViewerState();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const moved = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    viewer.mount(canvas);

    const ro = new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(r.width));
      canvas.height = Math.max(1, Math.floor(r.height));
      viewer.resize(r.width, r.height);
    });
    ro.observe(wrap);
    return () => {
      ro.disconnect();
      viewer.unmount();
    };
  }, [viewer]);

  const ndc = (e: { clientX: number; clientY: number }) => {
    const el = canvasRef.current!;
    const r = el.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1)] as const;
  };

  return (
    <div className="stage" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        aria-label="The repository, drawn as a tree. Use arrow keys to walk between commits."
        onPointerDown={(e) => {
          dragging.current = true;
          moved.current = false;
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          viewer.onPointerDown(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (dragging.current) {
            moved.current = true;
            viewer.onPointerDrag(e.clientX, e.clientY);
          } else if (s.phase === 'ready') {
            const [x, y] = ndc(e);
            viewer.pointerMove(x, y);
          }
        }}
        onPointerUp={(e) => {
          dragging.current = false;
          viewer.onPointerUp();
          if (!moved.current) {
            const [x, y] = ndc(e);
            viewer.pointerClick(x, y);
          }
        }}
        onWheel={(e) => viewer.onWheel(e.deltaY)}
        onKeyDown={(e) => {
          const map: Record<string, 'parent' | 'child' | 'prev' | 'next'> = {
            ArrowUp: 'parent',
            ArrowDown: 'child',
            ArrowLeft: 'prev',
            ArrowRight: 'next',
          };
          if (e.shiftKey && map[e.key]) {
            e.preventDefault();
            viewer.nudgeCamera(e.key === 'ArrowLeft' ? -0.15 : e.key === 'ArrowRight' ? 0.15 : 0, e.key === 'ArrowUp' ? 0.1 : e.key === 'ArrowDown' ? -0.1 : 0);
            return;
          }
          if (map[e.key]) {
            e.preventDefault();
            viewer.skipGrowth();
            viewer.walk(map[e.key]);
          } else if (e.key === 'Escape') {
            viewer.select(null);
          } else if (e.key === ' ') {
            e.preventDefault();
            viewer.skipGrowth();
          }
        }}
      />
      {s.hovered && s.hovered !== s.selected ? <HoverTip /> : null}
    </div>
  );
}

function HoverTip() {
  const viewer = useViewer();
  const s = useViewerState();
  const node = s.hovered ? viewer.nodeFor(s.hovered) : null;
  if (!node) return null;
  return (
    <div className="tip" role="status">
      <span className="tip-subject">{node.commit.subject}</span>
      <span className="mono tip-meta">
        {node.commit.author} · {new Date(node.time).toISOString().slice(0, 10)} ·{' '}
        <span className="add">+{node.commit.additions}</span> <span className="del">−{node.commit.deletions}</span>
      </span>
    </div>
  );
}
