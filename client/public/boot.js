// Тема применяется до загрузки приложения, чтобы экран не мигал при открытии.
(function () {
  try {
    var s = JSON.parse(localStorage.getItem('onyx.settings') || '{}');
    var root = document.documentElement;
    var theme = s.theme || 'dark';
    if (theme === 'system') theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    root.dataset.theme = theme;
    if (s.skin) root.dataset.skin = s.skin;
    if (s.accent) root.style.setProperty('--accent-raw', s.accent);
  } catch (e) { /* настройки по умолчанию */ }
})();
