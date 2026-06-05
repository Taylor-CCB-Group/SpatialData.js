import Sketch from '../../src/Sketch';
import HeadlessBlobsDemo from './HeadlessBlobsDemo';

function getDemoRoute(): 'sketch' | 'headless' {
  if (typeof window === 'undefined') {
    return 'sketch';
  }
  return window.location.pathname.replace(/\/+$/, '').endsWith('/headless') ? 'headless' : 'sketch';
}

function DemoNav({ route }: { route: 'sketch' | 'headless' }) {
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
      <main className="app-main">{route === 'headless' ? <HeadlessBlobsDemo /> : <Sketch />}</main>
    </div>
  );
}

export default App;
