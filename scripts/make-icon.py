"""Generate deterministic platform application icons from Harbor's anchor mark."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent / 'resources'
scale = 4
image = Image.new('RGBA', (256 * scale, 256 * scale))
draw = ImageDraw.Draw(image)
def xy(points): return [(int(x * scale), int(y * scale)) for x, y in points]
draw.rounded_rectangle((32, 32, 992, 992), radius=208, fill='#151a21')
draw.ellipse((110*scale,41*scale,146*scale,77*scale), outline='#7c9cff',width=14*scale)
for points in [[(128,78),(128,214)],[(92,107),(164,107)],[(54,143),(54,173),(66,184),(95,197),(128,220),(161,197),(190,184),(202,173),(202,143)],[(38,157),(54,141),(72,157)],[(184,157),(202,141),(218,157)]]:
 draw.line(xy(points),fill='#7c9cff',width=14*scale,joint='curve')
 for x,y in [points[0],points[-1]]: draw.ellipse(((x-7)*scale,(y-7)*scale,(x+7)*scale,(y+7)*scale),fill='#7c9cff')
image.save(root/'icon.png')
image.save(root/'icon.ico', sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)])
image.save(root/'icon.icns')
