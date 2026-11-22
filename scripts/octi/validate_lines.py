# usage: python3 -I validate_lines.py octi_out.json mapping.json shared.json
# Independent check of map_sections.py: every mapped piece's octi edge should carry the
# section's own (first) pack line, which octi propagates separately from the '#c' tags.
import json, sys, collections
out = json.load(open(sys.argv[1]))['features']; mp = json.load(open(sys.argv[2])); pack = json.load(open(sys.argv[3]))
E = [{l['id'] for l in out[fi]['properties'].get('lines', [])} for fi, _ in mp['edges']]
c = collections.Counter()
for si, r in mp['sections'].items():
    if r['st'] != 'mapped': continue
    ls = pack['sections'][int(si)].get('l') or []
    want = 'L%d' % ls[0] if ls else 'Lnone'
    kind = 'recovered' if r.get('rec') else 'extended' if r.get('ext') else 'tagged'
    for k, *_ in r['p']:
        c[(kind, want in E[k])] += 1
print({'%s/%s' % (k, 'line-ok' if ok else 'line-missing'): v for (k, ok), v in sorted(c.items())})
