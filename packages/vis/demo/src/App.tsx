import { lazy, Suspense } from 'react';
import Sketch from '../../src/Sketch';
import HeadlessBlobsDemo from './HeadlessBlobsDemo';

const CodecFixtureDemo = lazy(() => import('./CodecFixtureDemo'));
const MultiCanvasDemo = lazy(() => import('./MultiCanvasDemo'));

type DemoRoute = 'sketch' | 'headless' | 'codec' | 'multicanvas';

function getDemoRoute(): DemoRoute {
  if (typeof window === 'undefined') {
    return 'sketch';
  }
  const pathname = window.location.pathname.replace(/\/+$/, '');
  if (pathname.endsWith('/headless')) return 'headless';
  if (pathname.endsWith('/codec')) return 'codec';
  if (pathname.endsWith('/multicanvas')) return 'multicanvas';
  return 'sketch';
}

function DemoNav({ route }: { route: DemoRoute }) {
  const linkStyle = (active: boolean) => ({
    color: active ? '#fff' : '#8af',
    fontWeight: active ? 600 : 400,
    textDecoration: 'none',
    fontSize: 13,
  });

  return (
    <nav style={{ display: 'flex', gap: 16, marginTop: 6 }}>
      <a href="/" style={linkStyle(route === 'sketch')}>
        Sketch (full UI)
      </a>
      <a href="/headless" style={linkStyle(route === 'headless')}>
        Headless blobs
      </a>
      <a href="/codec" style={linkStyle(route === 'codec')}>
        Codec fixture
      </a>
      <a href="/multicanvas" style={linkStyle(route === 'multicanvas')}>
        Multi-canvas (WebGPU)
      </a>
    </nav>
  );
}

function App() {
  const route = getDemoRoute();

  return (
    <div className="app-root">
      <header className="app-header">
        <h1>@spatialdata/vis Demo</h1>
        <DemoNav route={route} />
      </header>
      <main className="app-main">
        {route === 'headless' ? (
          <HeadlessBlobsDemo />
        ) : route === 'multicanvas' ? (
          <Suspense fallback={null}>
            <MultiCanvasDemo />
          </Suspense>
        ) : route === 'codec' ? (
          <Suspense
            fallback={<div style={{ padding: 16, color: '#888' }}>Loading codec demo...</div>}
          >
            <CodecFixtureDemo />
          </Suspense>
        ) : (
          <Sketch />
        )}
      </main>
    </div>
  );
}

export default App;
