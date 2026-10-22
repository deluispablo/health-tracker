"""Compose a face preview: the dial image rendered by the app plus the face geometry from generate.py.

Usage: python3 compose.py ../generate.py dial.png face.html HH MM
Then render face.html at 450x450 with any headless browser. The edge slots show sample values and
simple stand-in glyphs, since the real ones come from the watch's complication providers.
"""
import base64, math, runpy, sys
gen_path, dial_png, out_html, hh, mm = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5])
sys.argv = [gen_path, "/dev/null"]
g = runpy.run_path(gen_path)
C, K, f, pt = g["C"], g["K"], g["f"], g["pt"]
out = []
def arc(r, a0, a1, ccw=False):
    (x0, y0), (x1, y1) = pt(r, a0), pt(r, a1)
    large = 1 if abs(a1 - a0) > 180 else 0
    return f"M{f(x0)} {f(y0)}A{f(r)} {f(r)} 0 {large} {0 if ccw else 1} {f(x1)} {f(y1)}"
dial = base64.b64encode(open(dial_png, "rb").read()).decode()
out.append(f'<image href="data:image/png;base64,{dial}" x="0" y="0" width="450" height="450"/>')
R = g["R_BEZEL"]
out.append(f'<circle cx="{C}" cy="{C}" r="{f(R)}" fill="none" stroke="{g["LINE_STRONG"]}" stroke-width="{f(1.5*K*g["LW"])}"/>')
for ri, ro, w, c, a in g["ticks"]:
    (x0, y0), (x1, y1) = pt(ri, a), pt(ro, a)
    out.append(f'<line x1="{f(x0)}" y1="{f(y0)}" x2="{f(x1)}" y2="{f(y1)}" stroke="{c}" stroke-width="{f(w)}"/>')
# Generic glyphs (24x24 box) standing in for the system complication icons.
ICONS = {
 "battery": '<rect x="6" y="4" width="12" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2.4"/><rect x="9" y="1.5" width="6" height="2.5" fill="currentColor"/><rect x="8.5" y="11" width="7" height="8.5" fill="currentColor"/>',
 "steps": '<ellipse cx="8" cy="8" rx="3.4" ry="5" fill="currentColor"/><ellipse cx="16" cy="13" rx="3.4" ry="5" fill="currentColor"/><circle cx="8" cy="17" r="2.2" fill="currentColor"/><circle cx="16" cy="22" r="1.6" fill="currentColor"/>',
 "flame": '<path d="M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-5 3-6 0 2 1 3 2 3 0-3-1-6 1-9z" fill="currentColor"/>',
 "globe": '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" fill="none" stroke="currentColor" stroke-width="1.6"/>',
}
SAMPLES = {1: ("battery", "82", .82), 2: ("steps", "6420", .642), 3: ("flame", "1580", .79), 4: ("globe", "%02d:%02d" % ((hh + 9) % 24, mm), None)}
half, rg, fs, ico = 35.0, 208.0, 19, 25
deg = lambda px: px / (math.pi * rg / 180)
dpc = fs * 0.6 / (math.pi * rg / 180)
for sid, mid, _p, _t, color, *_ in g["slots"]:
    icon, text, frac = SAMPLES[sid]
    s, e = mid - half, mid + half
    bottom = 90 < mid < 270
    ico_deg = deg(ico + fs * 0.3)
    span = ico_deg + deg(len(text) * fs * 0.6)
    if frac is None:  # SHORT_TEXT: icon and text centred on the diagonal
        start = mid - span / 2 if not bottom else mid + span / 2
    else:
        start = s if not bottom else e
    sign = -1 if bottom else 1
    lead = ico_deg + len(text) * dpc + 2
    if frac is not None:
        if bottom:
            edge = e - lead
            out.append(f'<path d="{arc(rg, s, edge)}" fill="none" stroke="#ffffff" stroke-opacity=".2" stroke-width="4" stroke-linecap="round"/>')
            out.append(f'<path d="{arc(rg, edge - frac * (edge - s), edge)}" fill="none" stroke="{color}" stroke-width="5" stroke-linecap="round"/>')
        else:
            edge = s + lead
            out.append(f'<path d="{arc(rg, edge, e)}" fill="none" stroke="#ffffff" stroke-opacity=".2" stroke-width="4" stroke-linecap="round"/>')
            out.append(f'<path d="{arc(rg, edge, edge + frac * (e - edge))}" fill="none" stroke="{color}" stroke-width="5" stroke-linecap="round"/>')
    a_ico = start + sign * deg(ico / 2)
    x, y = pt(rg, a_ico)
    rot = a_ico + (180 if bottom else 0)
    out.append(f'<g transform="translate({f(x)} {f(y)}) rotate({f(rot)}) translate(-12.5 -12.5) scale({ico/24})" color="{color}">{ICONS[icon]}</g>')
    a0 = start + sign * ico_deg
    pid = f"slot{sid}"
    out.append(f'<path id="{pid}" d="{arc(rg, a0, a0 + sign * 80, ccw=bottom)}" fill="none"/>')
    out.append(f'<text font-family="Google Sans Text, Roboto, Helvetica, sans-serif" font-size="{fs}" font-weight="500" fill="{g["INK"]}" dominant-baseline="central"><textPath href="#{pid}">{text}</textPath></text>')
def hand(back, length, width, halo, color, angle):
    y1, y2 = C + back * K, C - length * K
    for w, c in ((halo * K, "#000000"), (width * K, color)):
        out.append(f'<line x1="{C}" y1="{f(y1)}" x2="{C}" y2="{f(y2)}" stroke="{c}" stroke-width="{f(w)}" stroke-linecap="round" transform="rotate({f(angle)} {C} {C})"/>')
HL = g["HOUR_LEN"]
hand(10, HL * 0.9, 6 / K, 11.4 / K, g["MUTED"], mm * 6)
hand(12, HL, 10 / K, 16 / K, g["PRIMARY"], (hh * 60 + mm) / 4)
r = g["hub_r"]
out.append(f'<circle cx="{C}" cy="{C}" r="{f(r)}" fill="{g["PRIMARY"]}" stroke="#000" stroke-width="{f(2*K)}"/>')
open(out_html, "w").write('<html><body style="margin:0;background:#000"><svg xmlns="http://www.w3.org/2000/svg" width="450" height="450" viewBox="0 0 450 450"><circle cx="225" cy="225" r="225" fill="#000"/>' + "".join(out) + "</svg></body></html>")
