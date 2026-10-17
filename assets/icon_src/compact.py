import sys
from gen import page_path
def compact(P=""):
    # 64-unit full-bleed, simplified; numbers in 1024 space under scale(.0625)
    k=0.98; W,H,R,f=370*k,500*k,30*k,118*k
    fx,fy,bx,by=512+40*k,512+4*k,512-80*k,512-14*k
    x,y=-W/2,-H/2
    pp=page_path(x,y,W,H,R,f); bp=page_path(x,y,W,H,R,0.01); r=14*k
    flap=f"M{x+W-f:.0f},{y:.0f} L{x+W-f:.0f},{y+f-r:.0f} Q{x+W-f:.0f},{y+f:.0f} {x+W-f+r:.0f},{y+f:.0f} L{x+W:.0f},{y+f:.0f} Z"
    sh=lambda d: f'<path d="{d}" fill="#000" fill-opacity=".38" transform="translate(0 18)"/>'
    p=44*k
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs>'
     f'<linearGradient id="{P}bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#24212B"/><stop offset="1" stop-color="#0B0A0E"/></linearGradient>'
     f'<radialGradient id="{P}bloom" cx=".5" cy=".46" r=".5"><stop offset="0" stop-color="#FF4F7A" stop-opacity=".26"/><stop offset=".5" stop-color="#9A5CFF" stop-opacity=".07"/><stop offset="1" stop-color="#9A5CFF" stop-opacity="0"/></radialGradient>'
     f'<linearGradient id="{P}paint" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#3A7BFF"/><stop offset=".32" stop-color="#9A5CFF"/><stop offset=".64" stop-color="#FF4F7A"/><stop offset="1" stop-color="#FFAE2B"/></linearGradient>'
     f'<linearGradient id="{P}sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".26"/><stop offset=".4" stop-color="#fff" stop-opacity="0"/></linearGradient>'
     f'<linearGradient id="{P}paper" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FBFAF7"/><stop offset="1" stop-color="#D9D5CD"/></linearGradient>'
     f'<linearGradient id="{P}flap" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#FFE9DA"/><stop offset="1" stop-color="#FFFFFF"/></linearGradient>'
     f'<clipPath id="{P}clip"><rect width="64" height="64" rx="14.4"/></clipPath></defs>'
     f'<g clip-path="url(#{P}clip)"><rect width="64" height="64" fill="url(#{P}bg)"/><rect width="64" height="64" fill="url(#{P}bloom)"/>'
     '<g transform="scale(.0625)">'
     f'<g transform="translate({bx:.0f} {by:.0f}) rotate(-8)">{sh(bp)}<path d="{bp}" fill="url(#{P}paper)"/></g>'
     f'<g transform="translate({fx:.0f} {fy:.0f}) rotate(6)">{sh(pp)}<path d="{pp}" fill="url(#{P}paint)"/><path d="{pp}" fill="url(#{P}sheen)"/>'
     f'<path d="{flap}" fill="#2A0B2E" fill-opacity=".35" transform="translate(-6 8)"/><path d="{flap}" fill="url(#{P}flap)"/>'
     f'<rect x="{x+p:.0f}" y="{y+p+6*k:.0f}" width="{170*k:.0f}" height="{46*k:.0f}" rx="{23*k:.0f}" fill="#fff" fill-opacity=".96"/>'
     f'<rect x="{x+p:.0f}" y="{y+p+84*k:.0f}" width="{260*k:.0f}" height="{30*k:.0f}" rx="{15*k:.0f}" fill="#fff" fill-opacity=".6"/></g>'
     '</g></g><rect x=".4" y=".4" width="63.2" height="63.2" rx="14" fill="none" stroke="#fff" stroke-opacity=".12" stroke-width=".8"/></svg>')
if __name__=="__main__":
    print(compact(sys.argv[1] if len(sys.argv)>1 else ""), end="")
