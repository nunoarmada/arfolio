"""Generate the Arfolio master SVGs. Needs: fonttools, brotli, uharfbuzz (run in a throwaway venv).
Usage: python build-svgs.py <path to geist-latin-wght-normal.woff2> <out dir>"""
import sys, tempfile, os
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.transformPen import TransformPen
import uharfbuzz as hb

SRC, OUT = sys.argv[1], sys.argv[2]
ARCH = 'M4 20V12A8 8 0 0 1 20 12V20H16V12A4 4 0 0 0 8 12V20Z'
WEIGHT = 'M9.75 16A2.25 2.25 0 1 0 14.25 16A2.25 2.25 0 1 0 9.75 16Z'
GLYPH = ARCH + WEIGHT
COBALT, COBALT2, INK, SNOW = '#2F5BC2', '#5853B6', '#0F1216', '#F2F3F5'
RADIUS = 0.22

f = instantiateVariableFont(TTFont(SRC), {'wght': 600})
tmp = os.path.join(tempfile.mkdtemp(), 'geist600.ttf'); f.flavor = None; f.save(tmp)
f = TTFont(tmp); upm = f['head'].unitsPerEm; gs = f.getGlyphSet(); order = f.getGlyphOrder(); cap = f['OS/2'].sCapHeight
buf = hb.Buffer(); buf.add_str('Arfolio'); buf.guess_segment_properties()
hf = hb.Font(hb.Face(hb.Blob.from_file_path(tmp))); hb.shape(hf, buf, {'kern': True, 'liga': False})
x = 0; parts = []; bp = BoundsPen(gs); ink = [1e9, 0]
for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
    g = gs[order[info.codepoint]]
    pen = SVGPathPen(gs, lambda v: f'{v:.1f}'.rstrip('0').rstrip('.'))
    g.draw(TransformPen(pen, (1, 0, 0, -1, x + pos.x_offset, 0))); parts.append(pen.getCommands())
    b = BoundsPen(gs); g.draw(b)
    if b.bounds:
        ink[0] = min(ink[0], x + pos.x_offset + b.bounds[0]); ink[1] = max(ink[1], x + pos.x_offset + b.bounds[2])
    x += pos.x_advance - 0.02 * upm
WM = ''.join(parts)   # font units, y down, baseline at 0, tracking -0.02em applied
ink_w = (ink[1] - ink[0]) / upm  # in em
ink_x0 = ink[0] / upm

def r(n): return f'{n:.3f}'.rstrip('0').rstrip('.')
def w(name, s): open(os.path.join(OUT, name), 'w').write(s)
NS = 'xmlns="http://www.w3.org/2000/svg"'

w('glyph.svg', f'<svg {NS} viewBox="0 0 24 24" width="24" height="24" role="img" aria-label="Arfolio"><path fill="currentColor" fill-rule="nonzero" d="{GLYPH}"/></svg>\n')
w('glyph-tile.svg', f'<svg {NS} viewBox="0 0 24 24" width="96" height="96" role="img" aria-label="Arfolio"><rect width="24" height="24" rx="{r(24*RADIUS)}" fill="{COBALT}"/>'
  f'<path fill="#fff" transform="translate(4.8 4.8) scale(0.6)" d="{GLYPH}"/></svg>\n')

# wordmark: viewBox = ink box with 0.2em side padding; size 100 units font-size
FS = 100; sc = FS / upm; pad = 0.2 * FS
wm_w = ink_w * FS + 2 * pad; wm_h = 0.71 * FS + 2 * pad  # cap height 0.71; descender-free word
base_y = pad + cap * sc
def wordmark(fill, title='Arfolio'):
    return (f'<svg {NS} viewBox="0 0 {r(wm_w)} {r(wm_h)}" width="{r(wm_w)}" height="{r(wm_h)}" role="img" aria-label="{title}">'
            f'<path fill="{fill}" transform="translate({r(pad - ink_x0*FS)} {r(base_y)}) scale({r(sc)})" d="{WM}"/></svg>\n')
w('wordmark.svg', wordmark(INK))
w('wordmark-dark.svg', wordmark(SNOW))

# lockup, tile height H=64: text 0.56H, gap 0.375H, clear space 0.5H
H = 64; T = 0.56 * H; tsc = T / upm; gap = 0.375 * H; cs = 0.5 * H
text_x = cs + H + gap - ink_x0 * T; tw = ink_w * T
W = cs + H + gap + tw + cs; Ht = H + 2 * cs
capmid = cap * tsc / 2; base = cs + H / 2 + capmid
def lockup(text_fill, tile=COBALT):
    return (f'<svg {NS} viewBox="0 0 {r(W)} {r(Ht)}" width="{r(W*2)}" height="{r(Ht*2)}" role="img" aria-label="Arfolio">'
            f'<rect x="{r(cs)}" y="{r(cs)}" width="{H}" height="{H}" rx="{r(H*RADIUS)}" fill="{tile}"/>'
            f'<path fill="#fff" transform="translate({r(cs+H*0.2)} {r(cs+H*0.2)}) scale({r(H*0.6/24)})" d="{GLYPH}"/>'
            f'<path fill="{text_fill}" transform="translate({r(text_x)} {r(base)}) scale({r(tsc)})" d="{WM}"/></svg>\n')
w('lockup.svg', lockup(INK))
w('lockup-dark.svg', lockup(SNOW))
print('lockup', r(W), r(Ht), 'wordmark', r(wm_w), r(wm_h))
