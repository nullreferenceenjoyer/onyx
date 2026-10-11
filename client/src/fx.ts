// Интерактивные эффекты «Графита». Только оформление: без этого модуля приложение работает как прежде.
//  · волна от нажатия и пружинящее «вдавливание» кнопок, вкладок, строк;
//  · фоновая волна мягко следует за курсором.
// Учитываются настройки (html.no-motion, html.no-ripple) и системное «уменьшить движение».

const root = document.documentElement;
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
const on = () => !root.classList.contains('no-motion') && !reduce.matches;

const PRESS = '.btn, .icon-btn, .seg-btn, .tab, .tree-row, .menu-item, .vault-btn, .user-chip, .swatch, .skin-card, .search-item, .outline-item';
const FLAT = '.tree-row, .menu-item, .search-item, .outline-item, .tab, .skin-card';
const SPRING_UP = 'cubic-bezier(.3, 1.6, .5, 1)';
let pressed: HTMLElement | null = null;

function ripple(el: HTMLElement, x: number, y: number) {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return;
  let wrap = el.querySelector<HTMLElement>(':scope > .fx-rip-wrap');
  if (!wrap) {
    wrap = document.createElement('span');
    wrap.className = 'fx-rip-wrap';
    wrap.setAttribute('aria-hidden', 'true');
    el.appendChild(wrap);
  }
  const d = Math.hypot(Math.max(x - r.left, r.right - x), Math.max(y - r.top, r.bottom - y)) * 2;
  const s = document.createElement('span');
  s.className = 'fx-rip';
  s.style.cssText = `width:${d}px;height:${d}px;left:${x - r.left}px;top:${y - r.top}px`;
  s.addEventListener('animationend', () => s.remove(), { once: true });
  wrap.appendChild(s);
  setTimeout(() => s.remove(), 900);
}

export function initFx() {
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !on()) return;
    const el = (e.target as HTMLElement).closest?.<HTMLElement>(PRESS);
    if (!el || (el as HTMLButtonElement).disabled) return;
    if (!root.classList.contains('no-ripple')) ripple(el, e.clientX, e.clientY);
    // крупные строки не «вдавливаем» — только волна
    if (!el.matches(FLAT)) {
      pressed = el;
      el.animate([{ scale: 1 }, { scale: .95 }], { duration: 140, easing: 'ease-out', fill: 'forwards' });
    }
  }, { passive: true });

  const release = () => {
    if (!pressed) return;
    const el = pressed;
    pressed = null;
    el.getAnimations().forEach((a) => { if ((a.effect as KeyframeEffect | null)?.getKeyframes?.()[0]?.scale !== undefined) a.cancel(); });
    el.animate([{ scale: .95 }, { scale: 1 }], { duration: 420, easing: SPRING_UP });
  };
  for (const t of ['pointerup', 'pointercancel', 'dragstart']) document.addEventListener(t, release, { passive: true });

  if (!fine) return;
  // волна догоняет курсор с инерцией: цель задаёт мышь, кадр — плавное приближение
  const wave = document.querySelector<HTMLElement>('.wave');
  let wx = 0, wy = 0, tx = 0, ty = 0, raf = 0;
  const step = () => {
    wx += (tx - wx) * .06;
    wy += (ty - wy) * .06;
    wave?.style.setProperty('--wx', `${wx.toFixed(1)}px`);
    wave?.style.setProperty('--wy', `${wy.toFixed(1)}px`);
    raf = Math.abs(tx - wx) + Math.abs(ty - wy) > .3 ? requestAnimationFrame(step) : 0;
  };
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || innerWidth < 1000 || !on() || root.classList.contains('no-ambient')) return;
    tx = (e.clientX / innerWidth - .5) * 56;
    ty = (e.clientY / innerHeight - .5) * 36;
    if (!raf) raf = requestAnimationFrame(step);
  }, { passive: true });
}
