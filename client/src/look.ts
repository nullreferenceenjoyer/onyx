import { effect } from '@preact/signals';
import { settings } from './store';
import type { Settings } from './types';
import { contrastOn } from './util';

export const ACCENTS = [
  { name: 'Изумруд', hex: '#3ddc97' },
  { name: 'Небо', hex: '#4cc3ff' },
  { name: 'Индиго', hex: '#7b83ff' },
  { name: 'Аметист', hex: '#a78bfa' },
  { name: 'Фуксия', hex: '#ee82e2' },
  { name: 'Коралл', hex: '#ff6b7d' },
  { name: 'Янтарь', hex: '#ffa04d' },
  { name: 'Лимон', hex: '#e8d44d' },
];

export const SKINS: { id: Settings['skin']; name: string; hint: string }[] = [
  { id: 'graphite', name: 'Графит', hint: 'Нейтральный, почти чёрный' },
  { id: 'midnight', name: 'Полночь', hint: 'Холодный синий' },
  { id: 'paper', name: 'Бумага', hint: 'Тёплый, для долгого чтения' },
];

const FONTS: Record<Settings['uiFont'], string> = {
  manrope: "'Manrope', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  system: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  serif: "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Times New Roman', serif",
  mono: "'JetBrains Mono', ui-monospace, 'Cascadia Code', SFMono-Regular, Menlo, Consolas, monospace",
};

const systemLight = matchMedia('(prefers-color-scheme: light)');

function apply(s: Settings) {
  const root = document.documentElement;
  const theme = s.theme === 'system' ? (systemLight.matches ? 'light' : 'dark') : s.theme;
  root.dataset.theme = theme;
  root.dataset.skin = s.skin;
  root.classList.toggle('no-motion', !s.motion);
  root.classList.toggle('no-ripple', !s.ripple);
  root.classList.toggle('no-glass', !s.glass);
  root.classList.toggle('no-ambient', !s.ambient);
  root.classList.toggle('full-width', !s.lineWidth);
  const st = root.style;
  st.setProperty('--accent-raw', s.accent);
  st.setProperty('--on-accent', theme === 'light' ? '#ffffff' : contrastOn(s.accent));
  st.setProperty('--font-ui', FONTS[s.uiFont] ?? FONTS.manrope);
  st.setProperty('--font-text', FONTS[s.textFont] ?? FONTS.manrope);
  st.setProperty('--fs-text', `${s.fontSize}px`);
  st.setProperty('--line-width', s.lineWidth ? `${s.lineWidth}px` : 'none');
  st.setProperty('--radius', `${s.radius}px`);
  st.setProperty('--radius-sm', `${Math.round(s.radius * 0.66)}px`);

  let css = document.getElementById('custom-css') as HTMLStyleElement | null;
  if (!css) { css = document.createElement('style'); css.id = 'custom-css'; document.head.appendChild(css); }
  if (css.textContent !== s.customCss) css.textContent = s.customCss;

  // цвет системной панели телефона совпадает с фоном приложения
  requestAnimationFrame(() => {
    const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg || '#0a0b0d');
  });
}

export function initLook() {
  effect(() => apply(settings.value));
  systemLight.addEventListener('change', () => apply(settings.value));
}
