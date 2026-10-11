import { render } from 'preact';
import { App } from './components/App';
import { initFx } from './fx';
import { initLook } from './look';
import { init } from './store';
import './styles/base.css';
import './styles/app.css';
import './styles/editor.css';
import './styles/markdown.css';
import { initViewport } from './viewport';

initLook();
initViewport();
initFx();
render(<App />, document.getElementById('app')!);
init();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}
