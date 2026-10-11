import type { MarkdownConfig } from '@lezer/markdown';

// Расширения разметки поверх CommonMark + GFM: [[вики-ссылки]], ![[вставки]], ==выделение==, #теги

const LB = 91, RB = 93, BANG = 33, EQ = 61, HASH = 35, NL = 10;

export const Wikilink: MarkdownConfig = {
  defineNodes: ['Wikilink', 'Embed', 'WikilinkMark'],
  parseInline: [{
    name: 'Wikilink',
    before: 'Link',
    parse(cx, next, pos) {
      const embed = next === BANG;
      const open = embed ? pos + 1 : pos;
      if (cx.char(open) !== LB || cx.char(open + 1) !== LB) return -1;
      for (let i = open + 2; i < cx.end; i++) {
        const c = cx.char(i);
        if (c === NL || c === LB) return -1;
        if (c === RB) {
          if (cx.char(i + 1) !== RB || i === open + 2) return -1;
          return cx.addElement(cx.elt(embed ? 'Embed' : 'Wikilink', pos, i + 2, [
            cx.elt('WikilinkMark', pos, open + 2),
            cx.elt('WikilinkMark', i, i + 2),
          ]));
        }
      }
      return -1;
    },
  }],
};

const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' };
export const Highlight: MarkdownConfig = {
  defineNodes: ['Highlight', 'HighlightMark'],
  parseInline: [{
    name: 'Highlight',
    after: 'Emphasis',
    parse(cx, next, pos) {
      if (next !== EQ || cx.char(pos + 1) !== EQ || cx.char(pos + 2) === EQ) return -1;
      const before = cx.slice(pos - 1, pos), after = cx.slice(pos + 2, pos + 3);
      const spaceBefore = !before || /\s/.test(before), spaceAfter = !after || /\s/.test(after);
      return cx.addDelimiter(HighlightDelim, pos, pos + 2, !spaceAfter, !spaceBefore);
    },
  }],
};

export const Hashtag: MarkdownConfig = {
  defineNodes: ['Hashtag'],
  parseInline: [{
    name: 'Hashtag',
    parse(cx, next, pos) {
      if (next !== HASH) return -1;
      if (pos > cx.offset && !/[\s(]/.test(cx.slice(pos - 1, pos))) return -1;
      const m = /^[\p{L}\p{N}_/-]+/u.exec(cx.slice(pos + 1, Math.min(cx.end, pos + 80)));
      if (!m || /^\d+$/.test(m[0])) return -1;
      return cx.addElement(cx.elt('Hashtag', pos, pos + 1 + m[0].length));
    },
  }],
};
