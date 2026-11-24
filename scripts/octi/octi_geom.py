"""Shared code of the octi scripts: export_layout.py draws with it, survey.py checks with it.

Sections of this module:
  codec and plane   `dec` / `enc` (the pack's polyline encoding), `PL` / `PLi` (the plane)
  polylines         arc-length walking, distances, Douglas-Peucker, segment meetings, grids
  octilinear        `octi2pl`, `octi3pl`, `octi_along`, `tidy`, `lattice`, `carry`
  reality checks    `alongside` (corridor), `side_samples` / `drawn_side`, `overlap_len`
  skeleton          `Skeleton` and `Run`: nodes, bundles and runs of a drawing

Coordinates. Real track comes as (lon, lat). Everything schematic is on "the plane":
(lon, web-mercator y in degrees). octi is octilinear in web mercator while the client draws
lon/lat on an equirectangular plane, so on the plane 0/45/90 degrees stay exact on screen
(the client projects the coastline the same way). One plane degree is about 111 km.
"""
import math, collections

# --- constants (plane degrees unless named _KM)
KM_PER_DEG = 111.0             # one plane degree in km (lengths reported by the survey)
CELL = 21660 / 111319.49       # octi's grid cell (-g 21660, web-mercator metres)
STEP = round(CELL / 4, 4)      # the lattice junctions and bends sit on: a quarter cell, and a
                               # multiple of the asset's 1e-4 precision, so it encodes exactly
GS = 0.25                      # cell of the spatial grids over polylines
REAL_SIMPLIFY = 0.003          # Douglas-Peucker tolerance for real track (~0.3 km)
CORRIDOR = 0.05                # real tracks this close (~5 km) share a corridor
SIDE_NEAR = 0.3                # tracks up to this far apart (~33 km) run "alongside" each other
SIDE_STEP = 0.05               # spacing of the side samples along a track
SIDE_MIN_KM = 5.0              # sections shorter than this take no side samples
SIDE_PARALLEL = 0.866          # |cos| of the largest angle (30 degrees) between tracks alongside
SIDE_UNCLEAR = 0.3             # a point less than this share of its distance off the line is "ahead/behind"
ON_LINE = 2e-4                 # a point this close to a line is on it (two asset units)
OVERLAP_TOL = 3e-4             # drawn lines this close are on top of each other (three asset units)
EPS = 1e-9                     # equal points / zero lengths


# --- codec and plane
def dec(s):
    """decode the pack's polyline string (precision 1e4, lat/lon order) into [(x, y)]"""
    pts = []; lat = lon = 0; i = 0; n = len(s)
    while i < n:
        for k in (0, 1):
            sh = r = 0
            while True:
                b = ord(s[i]) - 63; i += 1; r |= (b & 0x1f) << sh; sh += 5
                if b < 0x20: break
            v = ~(r >> 1) if r & 1 else r >> 1
            if k == 0: lat += v
            else: lon += v
        pts.append((lon / 1e4, lat / 1e4))
    return pts


def enc(pts):
    """encode [(x, y)] as the pack's polyline string (the inverse of `dec`)"""
    out = []; plat = plon = 0
    for lon, lat in pts:
        ilat = int(round(lat * 1e4)); ilon = int(round(lon * 1e4))
        for v in (ilat - plat, ilon - plon):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1f)) + 63)); v >>= 5
            out.append(chr(v + 63))
        plat, plon = ilat, ilon
    return ''.join(out)


def PL(p):
    """(lon, lat) -> the plane"""
    return (p[0], math.degrees(math.log(math.tan(math.pi / 4 + math.radians(p[1]) / 2))))


def PLi(p):
    """the plane -> (lon, lat)"""
    return (p[0], math.degrees(2 * math.atan(math.exp(math.radians(p[1]))) - math.pi / 2))


def key(p):
    """a point as a dictionary key (rounded to 1e-7)"""
    return (round(p[0], 7), round(p[1], 7))


def gkm(a, b):
    """distance in km between two (lon, lat) points"""
    return math.hypot((a[0] - b[0]) * 111.32 * math.cos(math.radians((a[1] + b[1]) / 2)), (a[1] - b[1]) * 110.57)


def glen(q):
    """length in km of a (lon, lat) polyline"""
    return sum(gkm(q[i], q[i + 1]) for i in range(len(q) - 1))


# --- polylines
def plen(q):
    """length of a polyline"""
    return sum(math.dist(q[i], q[i + 1]) for i in range(len(q) - 1))


def cumlen(q):
    """arc length at every vertex of q"""
    c = [0.0]
    for i in range(len(q) - 1): c.append(c[-1] + math.dist(q[i], q[i + 1]))
    return c


def walk(q, cum, t):
    """the point at arc length t along q"""
    for i in range(len(q) - 1):
        if cum[i + 1] >= t - 1e-12:
            d = cum[i + 1] - cum[i]; r = 0 if d == 0 else (t - cum[i]) / d
            return (q[i][0] + (q[i + 1][0] - q[i][0]) * r, q[i][1] + (q[i + 1][1] - q[i][1]) * r)
    return q[-1]


def cut(q, cum, t0, t1):
    """q between arc lengths t0 <= t1, interior vertices included"""
    return [walk(q, cum, t0)] + [q[i] for i in range(len(q)) if t0 < cum[i] < t1] + [walk(q, cum, t1)]


def midpoint(q):
    """the point half way along q"""
    c = cumlen(q); return walk(q, c, c[-1] / 2)


def pseg(p, a, b):
    """distance from p to segment ab"""
    dx, dy = b[0] - a[0], b[1] - a[1]; l2 = dx * dx + dy * dy
    t = 0 if l2 == 0 else max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
    return math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1])


def pdist(p, q):
    """distance from p to polyline q"""
    return min(pseg(p, q[i], q[i + 1]) for i in range(len(q) - 1))


def nearest(p, q):
    """the point of polyline q nearest to p: (distance, arc length there, segment index)"""
    best = (1e18, 0.0, 0); acc = 0.0
    for i in range(len(q) - 1):
        a, b = q[i], q[i + 1]; dx, dy = b[0] - a[0], b[1] - a[1]; l2 = dx * dx + dy * dy
        t = 0 if l2 == 0 else max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
        d = math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]); l = math.sqrt(l2)
        if d < best[0]: best = (d, acc + t * l, i)
        acc += l
    return best


def dpi(q, tol):
    """Douglas-Peucker: indices of the kept vertices"""
    if len(q) < 3: return list(range(len(q)))
    keep = [False] * len(q); keep[0] = keep[-1] = True; st = [(0, len(q) - 1)]
    while st:
        i, j = st.pop(); best, bd = -1, tol
        for k in range(i + 1, j):
            d = pseg(q[k], q[i], q[j])
            if d > bd: bd, best = d, k
        if best > 0: keep[best] = True; st += [(i, best), (best, j)]
    return [i for i, k in enumerate(keep) if k]


def dp(q, tol):
    """Douglas-Peucker: q simplified within tol"""
    return [q[i] for i in dpi(q, tol)]


def dedup(q):
    """q without repeated consecutive points"""
    o = []
    for p in q:
        if not o or math.dist(o[-1], p) > EPS: o.append(p)
    return o


def xkind(a, b, c, d):
    """segments ab and cd: 0 apart or touching, 1 proper crossing, 2 collinear overlap"""
    o = lambda p, q, r: (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    d1, d2, d3, d4 = o(c, d, a), o(c, d, b), o(a, b, c), o(a, b, d); e = 1e-12
    if abs(d1) < e and abs(d2) < e:
        ax = 0 if abs(b[0] - a[0]) >= abs(b[1] - a[1]) else 1
        lo, hi = sorted((a[ax], b[ax])); lo2, hi2 = sorted((c[ax], d[ax]))
        return 2 if min(hi, hi2) - max(lo, lo2) > 1e-7 else 0
    return 1 if ((d1 > e and d2 < -e) or (d1 < -e and d2 > e)) and ((d3 > e and d4 < -e) or (d3 < -e and d4 > e)) else 0


def meet(P, Q):
    """how polylines P and Q meet: (they cross, they overlap)"""
    x = o = False
    for i in range(len(P) - 1):
        for j in range(len(Q) - 1):
            k = xkind(P[i], P[i + 1], Q[j], Q[j + 1])
            if k == 1: x = True
            elif k == 2: o = True
    return x, o


def cells(P, size=GS):
    """the grid cells (of `size`) that the bounding boxes of P's segments touch"""
    out = set()
    for i in range(len(P) - 1):
        (x0, y0), (x1, y1) = P[i], P[i + 1]
        for cx in range(int(math.floor(min(x0, x1) / size)), int(math.floor(max(x0, x1) / size)) + 1):
            for cy in range(int(math.floor(min(y0, y1) / size)), int(math.floor(max(y0, y1) / size)) + 1): out.add((cx, cy))
    return out


def seg_grid(Q, ids, size=GS):
    """cell -> [(id, segment index)] over the polylines Q[id]"""
    g = collections.defaultdict(list)
    for s in ids:
        q = Q[s]
        for i in range(len(q) - 1):
            for c in cells(q[i:i + 2], size): g[c].append((s, i))
    return g


# --- octilinear routing
def lattice(p):
    """the lattice point nearest to p"""
    return (round(p[0] / STEP) * STEP, round(p[1] / STEP) * STEP)


def octi2pl(a, b):
    """<=2-leg octilinear path a->b: the diagonal leg first"""
    dx, dy = b[0] - a[0], b[1] - a[1]; d = min(abs(dx), abs(dy))
    m = (a[0] + math.copysign(d, dx), a[1] + math.copysign(d, dy))
    return [a] + ([m] if EPS < d and (abs(dx) - d > EPS or abs(dy) - d > EPS) else []) + [b]


def octi3pl(a, b):
    """3-leg octilinear paths a->b on the lattice: the 2-leg path's first leg split around the second"""
    out = []
    for q in (octi2pl(a, b), octi2pl(b, a)[::-1]):
        if len(q) < 3: continue
        n = round(max(abs(q[1][0] - q[0][0]), abs(q[1][1] - q[0][1])) / STEP)
        if n < 2: continue
        h = (n // 2) / n; m = (q[0][0] + (q[1][0] - q[0][0]) * h, q[0][1] + (q[1][1] - q[0][1]) * h)
        out.append([a, m, (m[0] + q[2][0] - q[1][0], m[1] + q[2][1] - q[1][1]), b])
    return out


def tidy(q, ring=False):
    """q without loops (it returns to a point it visited), reversals and straight-through
    vertices; the ends stay. A ring (q ends where it starts) keeps its one loop."""
    out = []
    for i, p in enumerate(q):
        for j in range(len(out)):
            if math.dist(out[j], p) < 1e-7 and not (ring and j == 0 and i == len(q) - 1): out = out[:j]; break
        out.append(p)
    changed = True
    while changed and len(out) > 2:
        changed = False
        for i in range(1, len(out) - 1):
            a, b, c = out[i - 1], out[i], out[i + 1]
            ab, bc = math.dist(a, b), math.dist(b, c)
            if ab < EPS or bc < EPS or abs((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) < 1e-6 * ab * bc:
                del out[i]; changed = True; break
    return out if len(out) >= 2 else [out[0], out[0]]


def carry(P, A, B):
    """P moved so that it starts at A and ends at B: every point shifts by the offset of the
    two ends, blended along P"""
    c = cumlen(P); L = c[-1] or 1.0
    dA = (A[0] - P[0][0], A[1] - P[0][1]); dB = (B[0] - P[-1][0], B[1] - P[-1][1])
    return [(p[0] + dA[0] + (dB[0] - dA[0]) * t / L, p[1] + dA[1] + (dB[1] - dA[1]) * t / L) for p, t in zip(P, c)]


def octi_along(P, tol):
    """octilinear polyline along P: P's Douglas-Peucker vertices, moved onto the lattice,
    joined by <=2-leg routes, each bent to the side P runs on; the ends are exact"""
    idx = dpi(P, tol); out = [P[0]]; V = [P[0]] + [lattice(P[i]) for i in idx[1:-1]] + [P[-1]]
    for (i, j), a, b in zip(zip(idx, idx[1:]), V, V[1:]):
        c1, c2 = octi2pl(a, b), octi2pl(b, a)[::-1]
        if len(c1) == 3 and max(pdist(p, c2) for p in P[i:j + 1]) < max(pdist(p, c1) for p in P[i:j + 1]): c1 = c2
        out += c1[1:]
    return tidy(out, ring=True)


# --- reality checks: a drawing against the real track
def alongside(P, Q, width=CORRIDOR):
    """the share of the shorter of P, Q that runs within `width` of the other"""
    if plen(P) > plen(Q): P, Q = Q, P
    c = cumlen(P); n = max(2, int(c[-1] / (width / 2)) + 1)
    return sum(pdist(walk(P, c, c[-1] * i / n), Q) <= width for i in range(n + 1)) / (n + 1)


def side(p, q, a, b):
    """which side of the direction a->b the point p lies on, seen from q: +1 left, -1 right,
    0 on the line, None when unclear (p is mostly ahead of or behind q)"""
    tx, ty = b[0] - a[0], b[1] - a[1]; l = math.hypot(tx, ty); vx, vy = p[0] - q[0], p[1] - q[1]
    if l == 0: return None
    cr = (tx * vy - ty * vx) / l
    if abs(cr) < ON_LINE: return 0
    return None if abs(cr) < SIDE_UNCLEAR * math.hypot(vx, vy) else (1 if cr > 0 else -1)


def side_samples(real, ids):
    """Where real tracks run alongside each other, and on which side. For points every
    SIDE_STEP along each track s: every other track t passing between CORRIDOR and
    SIDE_NEAR away, within 30 degrees of parallel, beside the point (not beyond t's ends).
    Returns {s: [(u, t, f, sign)]}: fraction u along s, fraction f along t, side of s's point."""
    grid = seg_grid(real, ids); R = int(math.ceil(SIDE_NEAR / GS)); out = {}
    cum = {s: cumlen(real[s]) for s in ids}
    for s in ids:
        P = real[s]; c = cum[s]; n = max(1, int(round(c[-1] / SIDE_STEP))); rows = []
        for k in range(n):
            u = (k + 0.5) / n; p = walk(P, c, u * c[-1]); _, _, i = nearest(p, P)
            dx, dy = P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]; dl = math.hypot(dx, dy)
            cx, cy = int(math.floor(p[0] / GS)), int(math.floor(p[1] / GS))
            for t in sorted({t for gx in range(-R, R + 1) for gy in range(-R, R + 1) for t, _ in grid.get((cx + gx, cy + gy), ()) if t != s}):
                Q = real[t]; d, l, j = nearest(p, Q); L = cum[t][-1]
                if not (CORRIDOR < d <= SIDE_NEAR) or L == 0 or l <= EPS or l >= L - EPS: continue
                ex, ey = Q[j + 1][0] - Q[j][0], Q[j + 1][1] - Q[j][1]; el = math.hypot(ex, ey)
                if dl == 0 or el == 0 or abs(dx * ex + dy * ey) < SIDE_PARALLEL * dl * el: continue
                sg = side(p, walk(Q, cum[t], l), Q[j], Q[j + 1])
                if sg: rows.append((u, t, l / L, sg))
        if rows: out[s] = rows
    return out


def drawn_side(A, cA, u, B, cB, f):
    """the side (see `side`) of drawing A's point at fraction u, from drawing B at fraction f;
    cA, cB are their `cumlen`"""
    if cB[-1] == 0 or cA[-1] == 0: return None
    q = walk(B, cB, f * cB[-1]); _, _, j = nearest(q, B)
    return side(walk(A, cA, u * cA[-1]), q, B[j], B[j + 1])


def overlap_len(P, Q, tol=OVERLAP_TOL):
    """the length over which polylines P and Q are drawn on top of each other (within tol)"""
    tot = 0.0
    for i in range(len(P) - 1):
        a, b = P[i], P[i + 1]; dx, dy = b[0] - a[0], b[1] - a[1]; l = math.hypot(dx, dy)
        if l < EPS: continue
        for j in range(len(Q) - 1):
            c, d = Q[j], Q[j + 1]
            if abs((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) > tol * l or abs((d[0] - a[0]) * dy - (d[1] - a[1]) * dx) > tol * l: continue
            t0, t1 = sorted((((c[0] - a[0]) * dx + (c[1] - a[1]) * dy) / l, ((d[0] - a[0]) * dx + (d[1] - a[1]) * dy) / l))
            tot += max(0.0, min(l, t1) - max(0.0, t0))
    return tot


# --- the skeleton of a drawing
class Run:
    """A chain of bundles through stations, from junction to junction (or free end).
    Bundle b[i] lies between nodes n[i] and n[i + 1]; `secs` are all its sections; `real` is
    its real track on the plane; frac[i] is the share of the real length at node n[i];
    `octi` is the drawing it had when the skeleton was built."""
    def __init__(self, sk, b, n):
        self.sk = sk; self.b = b; self.n = n
        self.secs = [s for bk in b for s in sk.bund[bk]]; self.skip = set(self.secs)
        real = []; km = []
        for bk, frm in zip(b, n):
            s = sk.bund[bk][0]; real += sk.geoP[s] if sk.ends[s][0] == frm else sk.geoP[s][::-1]
            km.append(max(sum(plen(sk.geoP[t]) for t in sk.bund[bk]) / len(sk.bund[bk]), EPS))
        self.real = dedup(real); self.frac = [0.0]
        for k in km: self.frac.append(self.frac[-1] + k / sum(km))
        self.frac[-1] = 1.0
        self.cand = None; self.route = None; self.octi = self.drawing()

    def flipped(self):
        """the same run walked from its other end"""
        r = Run(self.sk, self.b[::-1], self.n[::-1]); r.octi = self.octi[::-1]; return r

    def drawing(self):
        """the run as its sections are drawn now"""
        q = []
        for bk, frm in zip(self.b, self.n):
            s = self.sk.bund[bk][0]; q += self.sk.sch[s] if self.sk.ends[s][0] == frm else self.sk.sch[s][::-1]
        return dedup(q)

    def pieces(self, R):
        """route R cut at the run's nodes, by real distance: one piece per bundle"""
        c = cumlen(R)
        return [cut(R, c, u0 * c[-1], u1 * c[-1]) for u0, u1 in zip(self.frac, self.frac[1:])]


class Skeleton:
    """Nodes, bundles and runs of a drawing `sch` (plane polylines per section, None = not
    drawn) of the real tracks `geoP` (plane).
      node    a schematic point where sections end; its id is `key(point)` at build time,
              `pos[id]` is where it is drawn (the caller may move it)
      bundle  the sections between the same two nodes whose real tracks share a corridor
              (two lines sharing every station, a "ladder"); drawn as one line.
              Id: (node a, node b, index), a <= b
      run     a chain of bundles through nodes where exactly two bundles meet; see `Run`
    `ends[s]` are the two node ids of section s, `nonzero` the sections between two different
    nodes, `real[s]` their simplified real track."""
    def __init__(self, sch, geoP):
        self.sch = sch; self.geoP = geoP
        self.drawn = [s for s in range(len(sch)) if sch[s] is not None]
        self.ends = {s: (key(sch[s][0]), key(sch[s][-1])) for s in self.drawn}
        self.nonzero = [s for s in self.drawn if self.ends[s][0] != self.ends[s][1]]
        self.real = {s: dp(geoP[s], REAL_SIMPLIFY) for s in self.nonzero}
        self._bbox = {s: (min(p[0] for p in q), min(p[1] for p in q), max(p[0] for p in q), max(p[1] for p in q)) for s, q in self.real.items()}
        self._cross = {}; self._corridor = {}
        self.bund = self._bundles()
        self.binc = collections.defaultdict(list)          # node -> its bundles
        for bk in sorted(self.bund): self.binc[bk[0]].append(bk); self.binc[bk[1]].append(bk)
        self.deg2 = {k for k, L in self.binc.items() if len(L) == 2}
        self.pos = {}
        for s in self.nonzero:
            self.pos.setdefault(self.ends[s][0], sch[s][0]); self.pos.setdefault(self.ends[s][1], sch[s][-1])
        self.runs = self._runs()
        self.run_of = {s: i for i, r in enumerate(self.runs) for s in r.secs}

    def _apart(self, a, b, pad):
        A, B = self._bbox[a], self._bbox[b]
        return A[0] > B[2] + pad or B[0] > A[2] + pad or A[1] > B[3] + pad or B[1] > A[3] + pad

    def really_cross(self, a, b):
        """the real tracks of sections a and b cross"""
        k = (a, b) if a <= b else (b, a)
        if k not in self._cross: self._cross[k] = not self._apart(a, b, 0) and meet(self.real[k[0]], self.real[k[1]])[0]
        return self._cross[k]

    def corridor(self, a, b):
        """the real tracks of sections a and b share a corridor for half of the shorter one"""
        k = (a, b) if a <= b else (b, a)
        if k not in self._corridor: self._corridor[k] = not self._apart(a, b, CORRIDOR) and alongside(self.real[k[0]], self.real[k[1]]) >= 0.5
        return self._corridor[k]

    def _bundles(self):
        by_pair = collections.defaultdict(list); bund = {}
        for s in self.nonzero: by_pair[tuple(sorted(self.ends[s]))].append(s)
        for pr in sorted(by_pair):
            subs = []
            for s in by_pair[pr]:
                for sb in subs:
                    if self.corridor(sb[0], s): sb.append(s); break
                else: subs.append([s])
            for i, sb in enumerate(subs): bund[pr + (i,)] = sb
        return bund

    def _chase(self, bk0, at):
        """the bundles after bk0 beyond node `at`, through degree-2 nodes:
        ([bundles], [nodes reached], it came back to bk0: a ring without a junction)"""
        bs = []; ns = []; bk = bk0
        while at in self.deg2:
            bk = [x for x in self.binc[at] if x != bk][0]
            if bk == bk0: return bs, ns, True
            at = bk[1] if at == bk[0] else bk[0]; bs.append(bk); ns.append(at)
        return bs, ns, False

    def _runs(self):
        runs = []; seen = set()
        for bk0 in sorted(self.bund):
            if bk0 in seen: continue
            bb, nb, ring = self._chase(bk0, bk0[0])
            if ring: b = bb + [bk0]; n = [bk0[0]] + nb + [bk0[0]]
            else:
                bf, nf, _ = self._chase(bk0, bk0[1]); b = bb[::-1] + [bk0] + bf; n = nb[::-1] + [bk0[0], bk0[1]] + nf
            seen.update(b); runs.append(Run(self, b, n))
        return runs
