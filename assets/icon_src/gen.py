import math, sys

def squircle(cx, cy, size, n=3.0, pts=90):
    e = 0.30*size; h = size/2
    corners = [(cx+h-e, cy-h+e, 0), (cx+h-e, cy+h-e, 90), (cx-h+e, cy+h-e, 180), (cx-h+e, cy-h+e, 270)]
    out=[]
    for (ox, oy, start) in corners:
        for i in range(pts+1):
            t = math.radians(start - 90 + 90*i/pts)
            c, s_ = math.cos(t), math.sin(t)
            out.append(f"{ox+e*math.copysign(abs(c)**(2/n),c):.2f},{oy+e*math.copysign(abs(s_)**(2/n),s_):.2f}")
    return "M"+" L".join(out)+" Z"

GRAD = [("0","#3A7BFF"),("0.32","#9A5CFF"),("0.64","#FF4F7A"),("1","#FFAE2B")]

def page_path(x, y, W, H, R, f):
    return (f"M{x+R:.1f},{y:.1f} L{x+W-f:.1f},{y:.1f} L{x+W:.1f},{y+f:.1f} L{x+W:.1f},{y+H-R:.1f} "
            f"Q{x+W:.1f},{y+H:.1f} {x+W-R:.1f},{y+H:.1f} L{x+R:.1f},{y+H:.1f} Q{x:.1f},{y+H:.1f} {x:.1f},{y+H-R:.1f} "
            f"L{x:.1f},{y+R:.1f} Q{x:.1f},{y:.1f} {x+R:.1f},{y:.1f} Z")

def rrect_path(x, y, W, H, R):
    return page_path(x, y, W, H, R, 0.0001).replace(f"L{x+W:.1f},{y+0.0001:.1f}", "")

def svg(mode="mac", detail="full", P=""):
    T = 824 if mode=="mac" else 1024
    cx = cy = 512
    k = 1.0 if mode=="mac" else 1.08
    if mode!="mac" and detail=="simple": k = 1.0
    tile = squircle(cx, cy, T)
    big = detail=="simple"
    W, H, R = (370 if big else 330)*k, (500 if big else 446)*k, (30 if big else 26)*k
    f = (118 if big else 104)*k
    fx, fy, fa = cx + 44*k, cy + 6*k, 6
    bx, by, ba = cx - 74*k, cy - 14*k, -8
    stops = "".join(f'<stop offset="{o}" stop-color="{c}"/>' for o,c in GRAD)
    g=[f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
<defs>
 <linearGradient id="{P}bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#24212B"/><stop offset="1" stop-color="#0B0A0E"/></linearGradient>
 <radialGradient id="{P}bloom" cx="0.5" cy="0.46" r="0.5"><stop offset="0" stop-color="#FF4F7A" stop-opacity="0.26"/><stop offset="0.25" stop-color="#C255D9" stop-opacity="0.15"/><stop offset="0.5" stop-color="#9A5CFF" stop-opacity="0.07"/><stop offset="0.75" stop-color="#9A5CFF" stop-opacity="0.02"/><stop offset="1" stop-color="#9A5CFF" stop-opacity="0"/></radialGradient>
 <linearGradient id="{P}rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.22"/><stop offset="0.3" stop-color="#fff" stop-opacity="0.04"/><stop offset="1" stop-color="#fff" stop-opacity="0.08"/></linearGradient>
 <linearGradient id="{P}paint" x1="0" y1="1" x2="1" y2="0">{stops}</linearGradient>
 <linearGradient id="{P}sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.26"/><stop offset="0.4" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.10"/></linearGradient>
 <linearGradient id="{P}paper" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FBFAF7"/><stop offset="1" stop-color="#D9D5CD"/></linearGradient>
 <linearGradient id="{P}flap" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#FFE9DA"/><stop offset="1" stop-color="#FFFFFF"/></linearGradient>
 <filter id="{P}tileshadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity="0.5"/></filter>
 <filter id="{P}cardshadow" x="-40%" y="-30%" width="180%" height="160%"><feDropShadow dx="0" dy="{14*k:.1f}" stdDeviation="{18*k:.1f}" flood-color="#000" flood-opacity="0.55"/></filter>
 <filter id="{P}flapshadow" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="{-6*k:.1f}" dy="{8*k:.1f}" stdDeviation="{8*k:.1f}" flood-color="#2A0B2E" flood-opacity="0.45"/></filter>
 <clipPath id="{P}tclip"><path d="{tile}"/></clipPath>
</defs>''']
    if mode=="mac":
        g.append(f'<path d="{tile}" fill="#000" filter="url(#{P}tileshadow)"/>')
    g.append(f'<path d="{tile}" fill="url(#{P}bg)"/>')
    g.append(f'<g clip-path="url(#{P}tclip)"><rect width="1024" height="1024" fill="url(#{P}bloom)"/></g>')
    # back page
    x, y = -W/2, -H/2
    g.append(f'<g transform="translate({bx:.1f} {by:.1f}) rotate({ba})"><path d="{page_path(x,y,W,H,R,0.01)}" fill="url(#{P}paper)" filter="url(#{P}cardshadow)"/>')
    if not big:
        for i,(ww,op) in enumerate([(150,.30),(210,.18),(190,.18),(120,.18)]):
            g.append(f'<rect x="{x+40*k:.1f}" y="{y+(62+i*40)*k:.1f}" width="{ww*k:.1f}" height="{16*k:.1f}" rx="{8*k:.1f}" fill="#55525D" fill-opacity="{op}"/>')
    g.append('</g>')
    # front page
    g.append(f'<g transform="translate({fx:.1f} {fy:.1f}) rotate({fa})">')
    pp = page_path(x,y,W,H,R,f)
    g.append(f'<path d="{pp}" fill="url(#{P}paint)" filter="url(#{P}cardshadow)"/>')
    g.append(f'<path d="{pp}" fill="url(#{P}sheen)"/>')
    g.append(f'<path d="{pp}" fill="none" stroke="#fff" stroke-opacity="0.35" stroke-width="{3*k:.1f}" transform="translate(0 0)"/>')
    r=14*k
    flap=f"M{x+W-f:.1f},{y:.1f} L{x+W-f:.1f},{y+f-r:.1f} Q{x+W-f:.1f},{y+f:.1f} {x+W-f+r:.1f},{y+f:.1f} L{x+W:.1f},{y+f:.1f} Z"
    g.append(f'<path d="{flap}" fill="url(#{P}flap)" filter="url(#{P}flapshadow)"/>')
    p=44*k
    if big:
        g.append(f'<rect x="{x+p:.1f}" y="{y+p+6*k:.1f}" width="{170*k:.1f}" height="{46*k:.1f}" rx="{23*k:.1f}" fill="#fff" fill-opacity="0.96"/>')
        g.append(f'<rect x="{x+p:.1f}" y="{y+p+84*k:.1f}" width="{260*k:.1f}" height="{30*k:.1f}" rx="{15*k:.1f}" fill="#fff" fill-opacity="0.6"/>')
    else:
        g.append(f'<rect x="{x+p:.1f}" y="{y+p+6*k:.1f}" width="{150*k:.1f}" height="{30*k:.1f}" rx="{15*k:.1f}" fill="#fff" fill-opacity="0.96"/>')
        for i,(ww,op) in enumerate([(236,.62),(200,.62),(150,.62)]):
            g.append(f'<rect x="{x+p:.1f}" y="{y+p+(70+i*36)*k:.1f}" width="{ww*k:.1f}" height="{18*k:.1f}" rx="{9*k:.1f}" fill="#fff" fill-opacity="{op}"/>')
        b = y+H
        pts=[(0,0),(10,-48),(34,-84),(46,-70),(58,-56),(26,8),(36,10),(52,12),(66,-40),(82,-36),(98,-32),(86,0),(102,0),(122,0),(132,-32),(152,-30),(172,-28),(166,-4),(186,-6),(208,-8),(228,-26),(250,-20)]
        ox, oy = x+p+2*k, b-92*k
        P2=[(ox+u*k, oy+v*k) for u,v in pts]
        sig=f"M{P2[0][0]:.1f},{P2[0][1]:.1f} "+" ".join(f"C{P2[i][0]:.1f},{P2[i][1]:.1f} {P2[i+1][0]:.1f},{P2[i+1][1]:.1f} {P2[i+2][0]:.1f},{P2[i+2][1]:.1f}" for i in range(1,len(P2)-2,3))
        g.append(f'<path d="{sig}" fill="none" stroke="#fff" stroke-width="{12*k:.1f}" stroke-linecap="round" stroke-linejoin="round"/>')
        g.append(f'<rect x="{x+p:.1f}" y="{b-58*k:.1f}" width="{W-2*p:.1f}" height="{6*k:.1f}" rx="{3*k:.1f}" fill="#fff" fill-opacity="0.45"/>')
    g.append('</g>')
    g.append(f'<path d="{tile}" fill="none" stroke="url(#{P}rim)" stroke-width="{3*(T/824):.1f}" clip-path="url(#{P}tclip)"/>')
    g.append('</svg>')
    return "\n".join(g)

if __name__=="__main__":
    open(sys.argv[3],"w").write(svg(sys.argv[1], sys.argv[2]))
