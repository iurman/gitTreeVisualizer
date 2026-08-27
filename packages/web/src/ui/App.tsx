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

      {s.webglFailed && s.repo ? (
        <div className="fallback">
          <img src={`/api/silhouette/${s.repo.owner}/${s.repo.name}`} alt={`${s.snapshotName} drawn as a tree`} />
          <p className="caption">
            Your browser could not start WebGL, so this is a flat drawing of the same tree, made on the server.
          </p>
        </div>
      ) : null}

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

      {(s.phase === 'loading' || s.phase === 'seed') && !begun ? (
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
