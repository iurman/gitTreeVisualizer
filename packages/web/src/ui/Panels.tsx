import { LENSES, type LensName } from '@gittree/core';
import { useViewer, useViewerState } from './useViewer.js';

const MODES: { id: 'tree3d' | 'tree2d' | 'byAuthor' | 'byChurn' | 'timeline'; label: string; caption?: string }[] = [
  { id: 'tree3d', label: 'Tree' },
  { id: 'tree2d', label: 'Flat' },
  { id: 'byAuthor', label: 'By author', caption: 'Rearranged by contributor. Not the repository’s own structure.' },
  { id: 'byChurn', label: 'By churn', caption: 'Real branches, ordered and sized by lines changed.' },
  { id: 'timeline', label: 'Timeline' },
];

export function ModeBar() {
  const viewer = useViewer();
  const s = useViewerState();
  const active = MODES.find((m) => m.id === s.mode);

  return (
    <div className="modebar">
      <div className="segmented" role="group" aria-label="View">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={s.mode === m.id ? 'on' : ''}
            aria-pressed={s.mode === m.id}
            onClick={() => viewer.setMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
      {active?.caption ? <p className="caption">{active.caption}</p> : null}
    </div>
  );
}

export function LensBar() {
  const viewer = useViewer();
  const s = useViewerState();
  const current = LENSES.find((l) => l.name === s.lens);

  return (
    <div className="lensbar">
      <p className="eyebrow">Lens</p>
      <div className="segmented vertical" role="group" aria-label="Lens">
        {LENSES.map((l) => {
          const disabled = l.name === 'fileType' && !s.fileTypeAvailable;
          return (
            <button
              key={l.name}
              type="button"
              className={s.lens === l.name ? 'on' : ''}
              aria-pressed={s.lens === l.name}
              disabled={disabled}
              title={
                disabled
                  ? 'GitHub’s API does not report which files a commit touched. Available in directory mode.'
                  : l.caption
              }
              onClick={() => void viewer.setLens(l.name as LensName)}
            >
              {l.label}
            </button>
          );
        })}
      </div>
      {current ? <p className="caption">{current.caption}</p> : null}
    </div>
  );
}

export function DetailPanel() {
  const viewer = useViewer();
  const s = useViewerState();
  if (!s.selected) return null;
  const node = viewer.nodeFor(s.selected);
  if (!node) return null;
  const limb = viewer.limbFor(s.selected);
  const c = node.commit;
  const url = node.synthetic
    ? null
    : `https://github.com/${s.snapshotName}/commit/${c.oid}`;

  return (
    <aside className="detail" aria-label="Commit detail">
      <button type="button" className="close" onClick={() => viewer.select(null)} aria-label="Close">
        ×
      </button>
      <p className="eyebrow">{limb ? limb.label : 'commit'}</p>
      <h2 className="display small">{c.subject}</h2>
      <dl className="mono">
        <div>
          <dt>sha</dt>
          <dd>{node.synthetic ? 'reconstructed' : c.oid.slice(0, 10)}</dd>
        </div>
        <div>
          <dt>author</dt>
          <dd>{c.author}</dd>
        </div>
        <div>
          <dt>date</dt>
          <dd>{new Date(node.time).toISOString().replace('T', ' ').slice(0, 16)}</dd>
        </div>
        <div>
          <dt>diff</dt>
          <dd>
            <span className="add">+{c.additions.toLocaleString('en-US')}</span>{' '}
            <span className="del">−{c.deletions.toLocaleString('en-US')}</span> in {c.filesChanged} files
          </dd>
        </div>
      </dl>
      {node.synthetic ? (
        <p className="caption warn">
          This commit was reconstructed from pull request #{c.prNumber}. The original was squashed away and no longer
          exists to link to.
        </p>
      ) : (
        <a className="link" href={url!} target="_blank" rel="noreferrer">
          Open on GitHub ↗
        </a>
      )}
      <p className="caption">
        Arrow keys walk the graph: ↑ parent, ↓ child, ← → siblings.
      </p>
    </aside>
  );
}

export function PoiList() {
  const viewer = useViewer();
  const s = useViewerState();
  if (!s.pois.length) return null;

  return (
    <nav className="poi" aria-label="Points of interest">
      <p className="eyebrow">Places to go</p>
      <ul>
        {s.pois.map((p) => (
          <li key={`${p.kind}-${p.oid}`}>
            <button type="button" onClick={() => viewer.goToPoi(p)}>
              <span className="poi-title">{p.title}</span>
              <span className="poi-detail mono">{p.detail}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function Badges() {
  const s = useViewerState();
  return (
    <div className="badges">
      {s.source ? <span className="badge mono">{s.source === 'github' ? 'github' : 'local'}</span> : null}
      {s.truncated ? (
        <span className="badge mono warn" title="Only the most recent commits were read.">
          truncated
        </span>
      ) : null}
      {s.squashReconstructed ? (
        <span className="badge warn">
          This repository squash-merges. Branches are reconstructed from pull requests.
        </span>
      ) : null}
      {s.directoryMode ? (
        <span className="badge warn">
          No branch structure survives in this history. The skeleton is the file tree at HEAD; commits drive growth.
        </span>
      ) : null}
    </div>
  );
}
