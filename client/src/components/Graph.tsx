import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api } from '../api';
import { Icon } from '../icons';
import { activeId, byId, files, mainView, nodes as treeNodes, openFile, openLink, openMenu, resolveLink, settings, vaultId } from '../store';
import { displayName, ls } from '../util';

// Граф связей: заметки — узлы, ссылки [[…]] — рёбра. Раскладка — силовая (d3-force), отрисовка — canvas.

interface GNode extends SimulationNodeDatum { id: string; label: string; missing: boolean; attach: boolean; deg: number; r: number }
type GLink = SimulationLinkDatum<GNode>;
interface Opts { orphans: boolean; missing: boolean; attachments: boolean }
interface RawLinks { id: string; targets: string[] }

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function buildGraph(raw: RawLinks[], opts: Opts, scope: 'all' | 'local', depth: number, center: string | null) {
  const map = new Map<string, GNode>();
  for (const f of files.value) {
    if (f.binary && !opts.attachments) continue;
    map.set(f.id, { id: f.id, label: displayName(f.name), missing: false, attach: f.binary, deg: 0, r: 4 });
  }
  const seen = new Set<string>();
  let links: { source: string; target: string }[] = [];
  for (const row of raw) {
    if (!map.has(row.id)) continue;
    for (const t of row.targets) {
      const hit = resolveLink(t);
      let target = hit?.id;
      if (hit && !map.has(hit.id)) continue; // вложение, а вложения скрыты
      if (!hit) {
        if (!opts.missing) continue;
        const name = t.split('/').pop()!.trim();
        target = `?${name.toLowerCase()}`;
        if (!map.has(target)) map.set(target, { id: target, label: name, missing: true, attach: false, deg: 0, r: 4 });
      }
      if (!target || target === row.id) continue;
      const key = row.id < target ? `${row.id}|${target}` : `${target}|${row.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source: row.id, target });
    }
  }

  // локальный граф: только то, до чего от открытой заметки не больше depth шагов
  if (scope === 'local') {
    const near = new Set<string>();
    if (center && map.has(center)) {
      near.add(center);
      let frontier = [center];
      for (let d = 0; d < depth; d++) {
        const next: string[] = [];
        for (const l of links) {
          for (const [a, b] of [[l.source, l.target], [l.target, l.source]]) {
            if (frontier.includes(a) && !near.has(b)) { near.add(b); next.push(b); }
          }
        }
        frontier = next;
      }
    }
    for (const id of [...map.keys()]) if (!near.has(id)) map.delete(id);
    links = links.filter((l) => map.has(l.source) && map.has(l.target));
  }

  for (const l of links) { map.get(l.source)!.deg++; map.get(l.target)!.deg++; }
  if (!opts.orphans && scope === 'all') for (const [id, n] of map) if (!n.deg) map.delete(id);
  for (const n of map.values()) n.r = 3.5 + Math.sqrt(n.deg) * 1.7;
  return { nodes: [...map.values()], links };
}

export function GraphView() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [raw, setRaw] = useState<RawLinks[] | null>(null);
  const [scope, setScope] = useState<'all' | 'local'>('all');
  const [depth, setDepth] = useState(1);
  const [opts, setOpts] = useState<Opts>(() => ls.get('onyx.graph', { orphans: true, missing: true, attachments: false }));
  const [query, setQuery] = useState('');
  const tree = treeNodes.value;
  const center = activeId.value;
  const look = settings.value;

  // состояние вне Preact: камера, наведение, позиции узлов между перестроениями
  const eng = useRef({
    nodes: [] as GNode[], links: [] as GLink[], sim: null as Simulation<GNode, GLink> | null, k: 1, tx: 0, ty: 0, w: 0, h: 0,
    hover: null as GNode | null, near: new Set<string>(), pos: new Map<string, { x: number; y: number }>(), query: '', center: null as string | null,
    dirty: true, touched: false, colors: { accent: '', text: '', muted: '', faint: '', line: '', bg: '' }, adj: new Map<string, Set<string>>(),
  }).current;

  useEffect(() => {
    let alive = true;
    // при правках дерево меняется часто — перечитываем связи с задержкой
    const t = setTimeout(() => {
      api('GET', `/vaults/${vaultId.value}/graph`).then((r) => { if (alive) setRaw(r.links); }).catch(() => { if (alive) setRaw([]); });
    }, raw ? 1200 : 0);
    return () => { alive = false; clearTimeout(t); };
  }, [tree, vaultId.value]);

  const graph = useMemo(() => (raw ? buildGraph(raw, opts, scope, depth, center) : null), [raw, opts, scope, depth, scope === 'local' ? center : null, files.value]);

  useEffect(() => {
    eng.colors = { accent: css('--accent'), text: css('--text'), muted: css('--muted'), faint: css('--faint'), line: css('--border-strong'), bg: css('--surface') };
    eng.dirty = true;
  }, [look.theme, look.skin, look.accent]);
  useEffect(() => { eng.query = query.trim().toLowerCase(); eng.center = center; eng.dirty = true; }, [query, center]);

  // ---- раскладка
  useEffect(() => {
    if (!graph) return;
    for (const n of eng.nodes) if (n.x !== undefined) eng.pos.set(n.id, { x: n.x, y: n.y! });
    let known = 0;
    for (const n of graph.nodes) {
      const p = eng.pos.get(n.id);
      if (p) { n.x = p.x; n.y = p.y; known++; }
    }
    eng.nodes = graph.nodes;
    eng.links = graph.links.map((l) => ({ ...l }));
    eng.adj = new Map();
    for (const l of graph.links) {
      if (!eng.adj.has(l.source)) eng.adj.set(l.source, new Set());
      if (!eng.adj.has(l.target)) eng.adj.set(l.target, new Set());
      eng.adj.get(l.source)!.add(l.target);
      eng.adj.get(l.target)!.add(l.source);
    }
    eng.hover = null;
    eng.sim?.stop();
    const fresh = known < graph.nodes.length * 0.5;
    if (fresh) eng.touched = false;
    let ticks = 0;
    eng.sim = forceSimulation<GNode, GLink>(eng.nodes)
      .force('link', forceLink<GNode, GLink>(eng.links).id((d) => d.id).distance(78).strength(0.4))
      .force('charge', forceManyBody<GNode>().strength(-260).distanceMax(600))
      .force('x', forceX<GNode>(0).strength(0.06))
      .force('y', forceY<GNode>(0).strength(0.06))
      .force('collide', forceCollide<GNode>((d) => d.r + 14))
      .alpha(fresh ? 1 : 0.35)
      .on('tick', () => {
        eng.dirty = true;
        // пока раскладка складывается — держим граф вписанным в окно; дальше камерой управляет человек
        if (!eng.touched && ++ticks % 12 === 0) fit(true);
      })
      .on('end', () => { if (!eng.touched) fit(true); });
    eng.dirty = true;
    return () => { eng.sim?.stop(); };
  }, [graph]);

  const fit = (auto = false) => {
    if (!eng.nodes.length || !eng.w) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of eng.nodes) { x0 = Math.min(x0, n.x ?? 0); x1 = Math.max(x1, n.x ?? 0); y0 = Math.min(y0, n.y ?? 0); y1 = Math.max(y1, n.y ?? 0); }
    const k = Math.max(0.15, Math.min(1.5, Math.min(eng.w / (x1 - x0 + 150), eng.h / (y1 - y0 + 130))));
    eng.k = k;
    eng.tx = -((x0 + x1) / 2) * k;
    eng.ty = -((y0 + y1) / 2) * k;
    if (!auto) eng.touched = false;
    eng.dirty = true;
  };

  // ---- отрисовка и управление
  useEffect(() => {
    const el = canvas.current!;
    const ctx = el.getContext('2d')!;
    let raf = 0;
    const dpr = () => Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
      const r = el.getBoundingClientRect();
      eng.w = r.width; eng.h = r.height;
      el.width = Math.round(r.width * dpr()); el.height = Math.round(r.height * dpr());
      eng.dirty = true;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    const toWorld = (sx: number, sy: number) => ({ x: (sx - eng.w / 2 - eng.tx) / eng.k, y: (sy - eng.h / 2 - eng.ty) / eng.k });
    const nodeAt = (sx: number, sy: number, slack: number): GNode | null => {
      const p = toWorld(sx, sy);
      let best: GNode | null = null, bd = Infinity;
      for (const n of eng.nodes) {
        const d = Math.hypot((n.x ?? 0) - p.x, (n.y ?? 0) - p.y) - n.r;
        if (d < slack / eng.k && d < bd) { bd = d; best = n; }
      }
      return best;
    };

    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (!eng.dirty) return;
      eng.dirty = false;
      const { k, tx, ty, w, h, colors: c } = eng;
      const s = dpr();
      ctx.setTransform(s, 0, 0, s, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.setTransform(s * k, 0, 0, s * k, s * (w / 2 + tx), s * (h / 2 + ty));
      const focus = eng.hover;
      const near = focus ? eng.adj.get(focus.id) : undefined;
      const lit = (n: GNode) => !focus || n === focus || !!near?.has(n.id);
      const matches = (n: GNode) => !!eng.query && n.label.toLowerCase().includes(eng.query);

      ctx.lineWidth = 1 / k;
      for (const l of eng.links) {
        const a = l.source as GNode, b = l.target as GNode;
        const on = focus && (a === focus || b === focus);
        ctx.globalAlpha = focus ? (on ? 0.9 : 0.08) : 0.55;
        ctx.strokeStyle = on ? c.accent : c.line;
        ctx.beginPath(); ctx.moveTo(a.x!, a.y!); ctx.lineTo(b.x!, b.y!); ctx.stroke();
      }
      for (const n of eng.nodes) {
        const isCenter = n.id === eng.center, hit = matches(n);
        ctx.globalAlpha = lit(n) && (!eng.query || hit) ? 1 : 0.16;
        ctx.beginPath(); ctx.arc(n.x!, n.y!, n.r, 0, Math.PI * 2);
        if (n.missing) { ctx.strokeStyle = c.faint; ctx.setLineDash([2 / k, 2 / k]); ctx.stroke(); ctx.setLineDash([]); }
        else { ctx.fillStyle = isCenter || n === focus || hit ? c.accent : n.attach ? c.faint : near?.has(n.id) ? c.text : c.muted; ctx.fill(); }
        if (isCenter) { ctx.globalAlpha *= 0.3; ctx.beginPath(); ctx.arc(n.x!, n.y!, n.r + 5 / k, 0, Math.PI * 2); ctx.fillStyle = c.accent; ctx.fill(); }
      }

      // подписи — в экранных координатах, чтобы текст оставался чётким при любом масштабе
      ctx.setTransform(s, 0, 0, s, 0, 0);
      ctx.font = `500 11.5px ${css('--font-ui') || 'sans-serif'}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const zoomAlpha = Math.max(0, Math.min(1, (k - 0.42) / 0.3));
      const crowded = eng.nodes.length > 350;
      const placed: [number, number, number, number][] = [];
      const order = [...eng.nodes].sort((p, q) => q.deg - p.deg);
      const rank = (n: GNode) => (n === focus || n.id === eng.center ? 2 : (focus && near?.has(n.id)) || matches(n) ? 1 : 0);
      order.sort((p, q) => rank(q) - rank(p));
      for (const n of order) {
        const strong = n === focus || n.id === eng.center || (focus && near?.has(n.id)) || matches(n);
        const a = strong ? 1 : focus || eng.query ? 0 : crowded && n.deg < 3 ? zoomAlpha * (k > 1.5 ? 1 : 0) : zoomAlpha;
        if (a < 0.05) continue;
        const sx = n.x! * k + w / 2 + tx, sy = n.y! * k + h / 2 + ty + n.r * k + 4;
        if (sx < -80 || sx > w + 80 || sy < -20 || sy > h + 20) continue;
        ctx.globalAlpha = a;
        const text = n.label.length > 34 ? n.label.slice(0, 32) + '…' : n.label;
        const tw = ctx.measureText(text).width / 2 + 3;
        const box: [number, number, number, number] = [sx - tw, sy - 1, sx + tw, sy + 14];
        if (placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) { if (!strong) continue; } else placed.push(box);
        if (strong) { ctx.lineWidth = 3; ctx.strokeStyle = c.bg; ctx.strokeText(text, sx, sy); }
        ctx.fillStyle = strong ? c.text : c.muted;
        ctx.fillText(text, sx, sy);
      }
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(draw);

    // ---- указатель: узел — перетаскивание или переход, пустое место — панорама, два пальца — масштаб
    const pts = new Map<number, { x: number; y: number }>();
    let drag: { node: GNode; moved: boolean } | null = null;
    let pan = false, pinch = 0;
    const local = (e: PointerEvent | WheelEvent) => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const zoomAt = (sx: number, sy: number, factor: number) => {
      const k = Math.max(0.12, Math.min(6, eng.k * factor));
      const p = toWorld(sx, sy);
      eng.tx = sx - eng.w / 2 - p.x * k;
      eng.ty = sy - eng.h / 2 - p.y * k;
      eng.k = k; eng.touched = true; eng.dirty = true;
    };
    const down = (e: PointerEvent) => {
      if (e.button > 0) return;
      el.setPointerCapture(e.pointerId);
      const p = local(e);
      pts.set(e.pointerId, p);
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
        if (drag) { drag.node.fx = null; drag.node.fy = null; drag = null; }
        pan = false;
        return;
      }
      const hit = nodeAt(p.x, p.y, e.pointerType === 'mouse' ? 5 : 14);
      if (hit) { drag = { node: hit, moved: false }; eng.hover = hit; eng.dirty = true; } else pan = true;
    };
    const move = (e: PointerEvent) => {
      const p = local(e);
      const prev = pts.get(e.pointerId);
      if (prev && pts.size === 2) {
        pts.set(e.pointerId, p);
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinch);
        pinch = d;
        return;
      }
      if (drag && prev) {
        if (!drag.moved && Math.hypot(p.x - prev.x, p.y - prev.y) < 4) return;
        if (!drag.moved) { drag.moved = true; eng.touched = true; eng.sim?.alphaTarget(0.25).restart(); }
        const wp = toWorld(p.x, p.y);
        drag.node.fx = wp.x; drag.node.fy = wp.y;
        pts.set(e.pointerId, p);
      } else if (pan && prev) {
        eng.tx += p.x - prev.x; eng.ty += p.y - prev.y; eng.touched = true; eng.dirty = true;
        pts.set(e.pointerId, p);
      } else if (e.pointerType === 'mouse') {
        const hit = nodeAt(p.x, p.y, 5);
        if (hit !== eng.hover) { eng.hover = hit; eng.dirty = true; el.style.cursor = hit ? 'pointer' : 'grab'; }
      }
    };
    const up = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      pinch = 0;
      if (drag) {
        const { node, moved } = drag;
        node.fx = null; node.fy = null;
        eng.sim?.alphaTarget(0);
        drag = null;
        if (!moved && e.type === 'pointerup') {
          if (node.missing) openLink(node.label); else openFile(node.id);
        }
        if (e.pointerType !== 'mouse') { eng.hover = null; eng.dirty = true; }
      }
      pan = false;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016)));
    };
    const leave = () => { if (!drag && eng.hover) { eng.hover = null; eng.dirty = true; } };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', leave);
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('dblclick', () => fit());
    return () => { cancelAnimationFrame(raf); ro.disconnect(); eng.sim?.stop(); };
  }, []);

  const toggle = (key: keyof Opts) => { const next = { ...opts, [key]: !opts[key] }; setOpts(next); ls.set('onyx.graph', next); };
  const zoom = (f: number) => { const k = Math.max(0.12, Math.min(6, eng.k * f)); eng.tx *= k / eng.k; eng.ty *= k / eng.k; eng.k = k; eng.touched = true; eng.dirty = true; };
  const centerNode = center ? byId.value.get(center) : undefined;
  const empty = graph && !graph.nodes.length;

  return (
    <section class="view-layer graph" aria-label="Граф связей">
      <header class="head">
        <button type="button" class="icon-btn" title="Назад к заметке" aria-label="Назад" onClick={() => { mainView.value = 'doc'; }}><Icon name="chevronLeft" /></button>
        <div class="crumbs"><span class="crumb-name" style="cursor:default">Граф связей</span>
          {graph ? <span class="status is-muted only-desktop"><span>{graph.nodes.filter((n) => !n.missing && !n.attach).length} заметок · {graph.links.length} связей</span></span> : null}
        </div>
        <div class="seg">
          <button type="button" class={`seg-btn${scope === 'all' ? ' is-active' : ''}`} onClick={() => setScope('all')}>Весь</button>
          <button type="button" class={`seg-btn${scope === 'local' ? ' is-active' : ''}`} title="Только связи открытой заметки" onClick={() => setScope('local')}>Вокруг заметки</button>
        </div>
        <button type="button" class="icon-btn" title="Что показывать" aria-label="Что показывать" onClick={(e) => openMenu(e.currentTarget as HTMLElement, [
          { title: 'Показывать' },
          { label: 'Заметки без связей', checked: opts.orphans, onClick: () => toggle('orphans') },
          { label: 'Ещё не созданные заметки', checked: opts.missing, onClick: () => toggle('missing') },
          { label: 'Вложения (картинки, файлы)', checked: opts.attachments, onClick: () => toggle('attachments') },
        ])}><Icon name="settings" /></button>
      </header>
      <div class="graph-body">
        <canvas ref={canvas} class="graph-canvas" />
        <div class="graph-tools graph-search">
          <Icon name="search" size={15} />
          <input class="input" type="search" placeholder="Найти на графе" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
        </div>
        {scope === 'local' ? (
          <div class="graph-tools graph-depth">
            <span>{centerNode ? displayName(centerNode.name) : 'заметка не открыта'}</span>
            <div class="seg">{[1, 2, 3].map((d) => <button type="button" key={d} class={`seg-btn${depth === d ? ' is-active' : ''}`} title={`Глубина связей: ${d}`} onClick={() => setDepth(d)}>{d}</button>)}</div>
          </div>
        ) : null}
        <div class="graph-tools graph-zoom">
          <button type="button" class="icon-btn" title="Крупнее" aria-label="Крупнее" onClick={() => zoom(1.3)}><Icon name="plus" size={16} /></button>
          <button type="button" class="icon-btn" title="Мельче" aria-label="Мельче" onClick={() => zoom(1 / 1.3)}><Icon name="minus" size={16} /></button>
          <button type="button" class="icon-btn" title="Вписать в окно (двойной щелчок)" aria-label="Вписать в окно" onClick={() => fit()}><Icon name="fit" size={16} /></button>
        </div>
        {!graph ? <div class="graph-note">Собираем связи…</div> : null}
        {empty ? (
          <div class="graph-note">
            {scope === 'local' && !centerNode ? 'Откройте заметку, чтобы увидеть её связи.' : 'Связей пока нет. Свяжите заметки ссылками [[Название]] — и они появятся здесь.'}
          </div>
        ) : null}
      </div>
    </section>
  );
}
