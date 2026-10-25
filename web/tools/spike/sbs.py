# side-by-side crop of the map area: python3 -I sbs.py canvasDir deckDir outDir name...
import sys
from PIL import Image, ImageDraw
a, b, out = sys.argv[1:4]
for n in sys.argv[4:]:
    f = n + "@2x.png"
    L = Image.open(f"{a}/{f}").convert("RGB")
    R = Image.open(f"{b}/{f}").convert("RGB")
    box = (0, 580, 2560, 1600)  # map region (2x CSS px)
    L = L.crop(box); R = R.crop(box)
    w, h = L.size
    # keep the PNGs small: scale to 0.5, stack vertically
    L = L.resize((w // 2, h // 2)); R = R.resize((w // 2, h // 2))
    im = Image.new("RGB", (w // 2, h + 2 + 40), "white")
    d = ImageDraw.Draw(im)
    d.text((8, 4), "Canvas", fill="black"); im.paste(L, (0, 20))
    d.text((8, 20 + h // 2 + 4), "deck.gl", fill="black"); im.paste(R, (0, 40 + h // 2))
    im = im.convert("P", palette=Image.ADAPTIVE, colors=128)
    im.save(f"{out}/{n}.png", optimize=True)
    print(n, im.size)
