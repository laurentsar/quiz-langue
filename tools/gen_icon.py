#!/usr/bin/env python3
"""Génère toutes les icônes de Quiz Langue (PWA + Android) sans dépendance.

Design : monogramme « Q » blanc sur fond dégradé diagonal bleu nuit -> cyan,
le tout rendu en anti-aliasing analytique (signed distance fields).
"""
import math, os, struct, zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Couleurs du dégradé (raccord thème app #061525)
C0 = (14, 42, 82)     # navy  #0E2A52  (coin haut-gauche)
C1 = (24, 182, 201)   # cyan  #18B6C9  (coin bas-droite)
WHITE = (255, 255, 255)


def clamp(v, lo=0.0, hi=1.0):
    return lo if v < lo else hi if v > hi else v


def cover(d, aa):
    """Couverture 0..1 d'une SDF (d<0 = intérieur)."""
    return clamp(0.5 - d / aa)


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    t = 0.0 if l2 == 0 else clamp(((px - ax) * dx + (py - ay) * dy) / l2)
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def render(size, shape, q_scale):
    """shape: 'square' (coins arrondis), 'circle', 'fullbleed'."""
    s = float(size)
    aa = max(1.0, s / 256.0)
    cx = cy = s / 2.0
    half = s / 2.0
    cr = 0.22 * s                      # rayon des coins (square)
    R = q_scale * s                    # rayon extérieur de l'anneau Q
    stroke = 0.34 * R                  # épaisseur du trait
    rin = R - stroke                   # rayon intérieur
    inv = 1.0 / math.sqrt(2.0)
    # queue du Q (diagonale bas-droite)
    p1 = (cx + inv * 0.45 * R, cy + inv * 0.45 * R)
    p2 = (cx + inv * 1.18 * R, cy + inv * 1.18 * R)
    t_half = 0.5 * stroke

    px = bytearray(size * size * 4)
    i = 0
    for y in range(size):
        fy = y + 0.5
        for x in range(size):
            fx = x + 0.5
            # ---- masque de forme (alpha) ----
            if shape == 'fullbleed':
                a = 1.0
            elif shape == 'circle':
                a = cover(math.hypot(fx - cx, fy - cy) - half, aa)
            else:  # square arrondi
                qx = abs(fx - cx) - (half - cr)
                qy = abs(fy - cy) - (half - cr)
                d = math.hypot(max(qx, 0.0), max(qy, 0.0)) + min(max(qx, qy), 0.0) - cr
                a = cover(d, aa)

            # ---- fond dégradé diagonal ----
            t = clamp((fx + fy) / (2.0 * s))
            br = C0[0] + (C1[0] - C0[0]) * t
            bg = C0[1] + (C1[1] - C0[1]) * t
            bb = C0[2] + (C1[2] - C0[2]) * t

            # ---- monogramme Q ----
            dist = math.hypot(fx - cx, fy - cy)
            ring = min(cover(dist - R, aa), cover(rin - dist, aa))
            tail = cover(seg_dist(fx, fy, p1[0], p1[1], p2[0], p2[1]) - t_half, aa)
            q = max(ring, tail)

            r = br + (WHITE[0] - br) * q
            g = bg + (WHITE[1] - bg) * q
            b = bb + (WHITE[2] - bb) * q

            px[i] = int(r + 0.5)
            px[i + 1] = int(g + 0.5)
            px[i + 2] = int(b + 0.5)
            px[i + 3] = int(clamp(a) * 255 + 0.5)
            i += 4
    return px


def write_png(path, size, px):
    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))
    raw = bytearray()
    row = size * 4
    for y in range(size):
        raw.append(0)
        raw += px[y * row:(y + 1) * row]
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    out = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
           + chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b''))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(out)
    print(f"  {os.path.relpath(path, ROOT):60s} {size:>4}px  {len(out):>7,}o")


# (dossier densité): (taille launcher, taille foreground 108dp)
DENS = {'mdpi': (48, 108), 'hdpi': (72, 162), 'xhdpi': (96, 216),
        'xxhdpi': (144, 324), 'xxxhdpi': (192, 432)}
RES = os.path.join(ROOT, 'android/app/src/main/res')


def main():
    print("== PWA (www/img) ==")
    cache = {}
    for n in (192, 512):
        px = render(n, 'fullbleed', 0.31)
        cache[n] = px
        write_png(os.path.join(ROOT, f'www/img/icon-{n}.png'), n, px)

    print("== Android launcher / round / foreground ==")
    for d, (sl, sf) in DENS.items():
        write_png(os.path.join(RES, f'mipmap-{d}/ic_launcher.png'), sl,
                  render(sl, 'square', 0.34))
        write_png(os.path.join(RES, f'mipmap-{d}/ic_launcher_round.png'), sl,
                  render(sl, 'circle', 0.34))
        write_png(os.path.join(RES, f'mipmap-{d}/ic_launcher_foreground.png'), sf,
                  render(sf, 'fullbleed', 0.27))


if __name__ == '__main__':
    main()
