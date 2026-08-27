import { useCallback, useEffect, useMemo, useState } from 'react';
import { Viewer } from '../state/viewer.js';
import { ViewerContext, useViewer, useViewerState } from './useViewer.js';
import { Landing } from './Landing.jsx';
import { Stage } from './Stage.jsx';
import { Timeline } from './Timeline.jsx';
import { Gutter } from './Gutter.jsx';
import { AudioControls, ErrorScreen, SearchBox, Seed } from './Controls.jsx';
import { Badges, DetailPanel, LensBar, ModeBar, PoiList } from './Panels.jsx';
import { parseRepoInput } from '../state/repo.js';

export function App() {
  const viewer = useMemo(() => new Viewer(), []);
  const [route, setRoute] = useState(() => location.pathname);

  useEffect(() => {
    const onPop = () => setRoute(location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((path: string) => {
    history.pushState(null, '', path);
    setRoute(path);
  }, []);

  const ref = useMemo(() => parseRepoInput(route.replace(/^\//, '')), [route]);

  useEffect(() => {
    if (ref) void viewer.load(ref);
  }, [ref?.owner, ref?.name, viewer]);

  return (
    <ViewerContext.Provider value={viewer}>
      {ref ? <Shell onBack={() => navigate('/')} /> : <Landing onOpen={(o, n) => navigate(`/${o}/${n}`)} />}
    </ViewerContext.Provider>
  );
}

/**
 * The last resort, and now genuinely last: it takes a browser that refuses both
 * WebGL and 2D canvas drawing to reach this. A browser with only WebGL blocked
 * — Brave and Firefox both do that under their fingerprinting protections —
 * gets the software renderer instead, which is the whole product rather than a
 * picture of it.
 */
function Fallback() {
  const s = useViewerState();
  const [failed, setFailed] = useState(false);
  if (!s.repo) return null;

  return (
    <div className="fallback">
      {failed ? (
        <p className="lede">That tree could not be drawn on the server either.</p>
      ) : (
        <img
          src={`/api/silhouette/${s.repo.owner}/${s.repo.name}`}
          alt={`${s.snapshotName} drawn as a tree`}
          onError={() => setFailed(true)}
        />
      )}
      <p className="caption">
        This browser would not give the page a canvas to draw on at all, so this is a flat drawing of the same tree,
        made on the server. Allowing canvas or WebGL for this site brings back the growth animation.
      </p>
    </div>
  );
}

function Shell({ onBack }: { onBack: () => void }) {
  const s = useViewerState();
  const viewer = useViewer();
  const [begun, setBegun] = useState(false);

  // A repository change resets the gate, so a second deep link still gets its
  // own deliberate start.
  useEffect(() => setBegun(false), [s.snapshotName]);

  const showChrome = s.phase === 'ready' || s.phase === 'growing';

  return (
    <div className={`shell${s.narrow ? ' narrow' : ''}`}>
      <Stage />

      {/* The fallback covers the canvas, so it must not also cover an error: if
          the repository could not be read there is no tree to draw flat, and
          the reason is the thing worth showing. */}
      {s.rendererFailed && s.repo && s.phase !== 'error' ? <Fallback /> : null}

      <header className="topbar">
        <a
          className="wordmark display"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            onBack();
          }}
        >
          tree
        </a>
        <div className="repo-id">
          <span className="mono name">{s.snapshotName}</span>
          {s.stats ? (
            <span className="mono counts">
              {s.stats.commits.toLocaleString('en-US')} commits · {s.stats.merges.toLocaleString('en-US')} merges ·{' '}
              {s.stats.limbs.toLocaleString('en-US')} limbs
            </span>
          ) : null}
        </div>
        <SearchBox />
        <AudioControls />
      </header>

      <Badges />
      {showChrome ? <Gutter /> : null}

      {showChrome ? (
        <>
          <div className="left-rail">
            <ModeBar />
            <LensBar />
          </div>
          <div className="right-rail">
            <PoiList />
          </div>
          <DetailPanel />
          <Timeline />
        </>
      ) : null}

      {(s.phase === 'loading' || s.phase === 'seed') && !begun && !s.rendererFailed ? (
        <Seed
          onBegin={() => {
            setBegun(true);
            viewer.begin();
          }}
        />
      ) : null}
      {s.phase === 'error' ? <ErrorScreen onBack={onBack} /> : null}
    </div>
  );
}
