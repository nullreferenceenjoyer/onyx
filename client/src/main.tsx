import { render } from 'preact';
import { App } from './components/App';
import { PublicProfile, PublicShare } from './components/Public';
import { Toasts } from './components/ui';
import { initFx } from './fx';
import { initLook } from './look';
import { init } from './store';
import './styles/base.css';
import './styles/app.css';
import './styles/editor.css';
import './styles/markdown.css';
import './styles/social.css';
import { initViewport } from './viewport';

initLook();
initViewport();
initFx();
// страницы по ссылке открываются без входа и без загрузки хранилищ
const shared = /^\/s\/([\w-]+)\/?$/.exec(location.pathname);
const profile = /^\/u\/([^/]+)\/?$/.exec(location.pathname);
const root = document.getElementById('app')!;
if (shared) render(<><PublicShare token={shared[1]} /><Toasts /></>, root);
else if (profile) render(<><PublicProfile login={decodeURIComponent(profile[1])} /><Toasts /></>, root);
else { render(<App />, root); init(); }

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}
