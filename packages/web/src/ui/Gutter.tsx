import { useViewerState } from './useViewer.js';

/* -------------------------------------------------------------------------- */
/* The core sample                                                             */
/*                                                                            */
/* The signature element. A dendrochronologist reads a tree by pulling a core  */
/* with an increment borer and laying the rings out flat; this strip is that   */
/* core, taken from the tree on screen. It is the ring legend, the growth      */
/* read-out and the vertical minimap at once, and it makes the ring-unit       */
/* control legible by showing what the choice actually does to the trunk.      */
/* -------------------------------------------------------------------------- */

export function Gutter() {
  const s = useViewerState();
  if (!s.rings.length && s.growth >= 1) return null;

  const majors = s.rings.filter((r) => r.major);
  const labelled = majors.length > 1 ? majors : s.rings;

  return (
    <aside className="gutter" aria-hidden="true">
      <div className="core">
        {s.rings.map((r, i) => (
          <span
            key={i}
            className={`core-ring${r.major ? ' major' : ''}${r.t > s.growth ? ' ungrown' : ''}`}
            style={{ bottom: `${r.t * 100}%` }}
          />
        ))}
        <span className="core-growth" style={{ height: `${s.growth * 100}%` }} />
        {s.stumpCommits > 0 ? <span className="core-stump" /> : null}
      </div>
      <div className="core-labels mono">
        {labelled
          .filter((_, i) => i % Math.ceil(labelled.length / 7 || 1) === 0)
          .map((r, i) => (
            <span key={i} style={{ bottom: `${r.t * 100}%` }}>
              {r.label}
            </span>
          ))}
      </div>
      <p className="core-caption mono">{s.ringUnit} rings</p>
    </aside>
  );
}
