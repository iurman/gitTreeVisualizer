import { useState } from 'react';
import { useViewer, useViewerState } from './useViewer.js';

export function SearchBox() {
  const viewer = useViewer();
  const s = useViewerState();

  return (
    <form
      className="search"
      onSubmit={(e) => {
        e.preventDefault();
        viewer.submitSearch();
      }}
      role="search"
    >
      <label className="visually-hidden" htmlFor="q">
        Search commits
      </label>
      <input
        id="q"
        className="mono"
        value={s.search}
        placeholder="subject, author or sha"
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => viewer.setSearch(e.target.value)}
      />
      {s.search.trim().length > 1 ? (
        <span className="hits mono" aria-live="polite">
          {s.searchHits.toLocaleString('en-US')} match{s.searchHits === 1 ? '' : 'es'}
        </span>
      ) : null}
    </form>
  );
}

export function AudioControls() {
  const viewer = useViewer();
  const s = useViewerState();
  const [open, setOpen] = useState(false);

  return (
    <div className="audio">
      <button
        type="button"
        className={`icon${s.muted ? ' off' : ''}`}
        aria-pressed={s.muted}
        aria-label={s.muted ? 'Turn sound on' : 'Turn sound off'}
        onClick={() => viewer.toggleMute()}
      >
        {s.muted ? '×))' : '·))'}
      </button>
      <button
        type="button"
        className="icon"
        aria-expanded={open}
        aria-label="Settings"
        onClick={() => setOpen((o) => !o)}
      >
        ⋯
      </button>
      {open ? (
        <div className="popover" role="dialog" aria-label="Settings">
          <label>
            Volume
            <input
              type="range"
              min={0}
              max={1}
              step={0.02}
              value={s.volume}
              onChange={(e) => viewer.setVolume(Number(e.target.value))}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={s.reduceMotion}
              onChange={(e) => viewer.setReduceMotion(e.target.checked)}
            />
            Shorten transitions
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={s.orbitEnabled}
              onChange={(e) => viewer.setOrbitEnabled(e.target.checked)}
            />
            Drag to orbit
          </label>
          <p className="caption mono">{s.fps} fps</p>
        </div>
      ) : null}
    </div>
  );
}

export function Seed({ onBegin }: { onBegin: () => void }) {
  const s = useViewerState();
  const ready = s.fetched > 0;

  return (
    <div className="seed">
      <div className="seed-card">
        <p className="eyebrow mono">{s.snapshotName}</p>
        {s.description ? <p className="lede">{s.description}</p> : null}
        <p className="seed-count mono">
          {ready ? `${s.fetched.toLocaleString('en-US')} commits read` : 'Reading history…'}
          {s.stats ? ` · ${s.stats.limbs.toLocaleString('en-US')} limbs · ${s.stats.authors} contributors` : ''}
        </p>
        <button type="button" className="primary big" onClick={onBegin} disabled={!ready} autoFocus>
          Grow the tree
        </button>
        <p className="caption">Sound is on. Growth takes about {Math.round(Math.min(26, Math.max(9, 6 + (s.stats?.commits ?? 0) / 260)))} seconds, and any click ends it early.</p>
      </div>
    </div>
  );
}

export function ErrorScreen({ onBack }: { onBack: () => void }) {
  const s = useViewerState();
  return (
    <div className="seed">
      <div className="seed-card">
        <p className="eyebrow">Nothing to grow</p>
        <p className="lede">{s.error?.message}</p>
        {s.error?.hint ? <p className="caption">{s.error.hint}</p> : null}
        <button type="button" className="primary" onClick={onBack}>
          Try another repository
        </button>
      </div>
    </div>
  );
}
