"""生成文件类型图标：assets/file/*.ico（多尺寸）+ 一张对照图。

样式按市面通行约定来，便于一眼认出；但每枚都是自己画的几何，不复制任何厂商图样：
  markdown  M + 下箭头（>=48px 画 M，小尺寸只留加粗箭头）
  html      </>（小尺寸简化为 <>）
  text      一道粗标题线 + 两道细正文线
  pdf       整页红底 + 白色折角（>=64px 加白色 PDF 字样）
  code      一对花括号 { }
  table     深色表头 + 两行单元格
  image     不带书页框，只留图片标识（相框 + 山 + 太阳）

用法（需要 Pillow）：python tools/make-file-icons.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "file")
SIZES = [16, 24, 32, 48, 64, 128, 256]
SS = 4

PAPER = (252, 251, 249)
PAPER_EDGE = (170, 178, 188)
FOLD = (226, 230, 235)
INK = (176, 185, 195)
INK_STRONG = (118, 128, 140)
AMBER = (198, 124, 12)
TEAL = (14, 124, 134)
TEAL_DARK = (10, 92, 100)
NAVY = (30, 43, 70)
RED = (186, 58, 44)
RED_DARK = (154, 44, 33)

PAGE = (0.17, 0.09, 0.83, 0.91)


def page_box(size, box=PAGE):
    return tuple(int(size * value) for value in box)


def font(px, bold=True):
    name = "segoeuib.ttf" if bold else "segoeui.ttf"
    try:
        return ImageFont.truetype(f"C:/Windows/Fonts/{name}", px)
    except OSError:
        return None


def draw_page(canvas, bold, fill=PAPER, edge=PAPER_EDGE, fold=FOLD):
    """带折角的纸页；返回 (x0, y0, x1, y1, fold)。"""
    s = canvas.width
    draw = ImageDraw.Draw(canvas)
    x0, y0, x1, y1 = page_box(s)
    cut = int(s * (0.26 if bold else 0.20))
    radius = int(s * 0.045)
    width = max(1, int(s * (0.05 if bold else 0.032)))
    body = [(x0 + radius, y0), (x1 - cut, y0), (x1, y0 + cut), (x1, y1 - radius), (x1, y1),
            (x0, y1), (x0, y0 + radius), (x0, y0)]
    draw.polygon(body, fill=fill)
    draw.line(body[1:5], fill=edge, width=width, joint="curve")
    draw.line([body[5], body[6]], fill=edge, width=width, joint="curve")
    draw.polygon([(x1 - cut, y0), (x1, y0 + cut), (x1 - cut, y0 + cut)], fill=fold)
    draw.line([(x1 - cut, y0), (x1, y0 + cut)], fill=edge, width=width)
    return x0, y0, x1, y1, cut


def centred_text(canvas, text, px, colour, cy, cx=None):
    s = canvas.width
    active = font(int(px))
    if active is None:
        return
    draw = ImageDraw.Draw(canvas)
    box = draw.textbbox((0, 0), text, font=active)
    x = (s - (box[2] - box[0])) / 2 - box[0] if cx is None else cx - (box[2] - box[0]) / 2 - box[0]
    y = cy - (box[3] - box[1]) / 2 - box[1]
    draw.text((x, y), text, font=active, fill=colour)


def mark_markdown(canvas, bold):
    s = canvas.width
    draw = ImageDraw.Draw(canvas)
    if not bold:
        centred_text(canvas, "M", s * 0.44, AMBER, s * 0.50, s * 0.38)
    width = int(s * (0.10 if not bold else 0.14))
    cx = int(s * (0.66 if not bold else 0.50))
    top, bottom = int(s * 0.34), int(s * 0.66)
    draw.line([(cx, top), (cx, bottom)], fill=AMBER, width=width)
    head = int(s * (0.11 if not bold else 0.14))
    draw.polygon([(cx - head, bottom - int(head * 0.6)), (cx + head, bottom - int(head * 0.6)), (cx, bottom + int(head * 0.7))], fill=AMBER)


def mark_html(canvas, bold):
    s = canvas.width
    draw = ImageDraw.Draw(canvas)
    if bold:
        centred_text(canvas, "<>", s * 0.52, TEAL, s * 0.52)
        return
    centred_text(canvas, "</>", s * 0.44, TEAL, s * 0.52)


def mark_text(canvas, bold):
    s = canvas.width
    draw = ImageDraw.Draw(canvas)
    heading = int(s * (0.07 if not bold else 0.09))
    draw.rounded_rectangle([int(s * 0.28), int(s * 0.34), int(s * 0.72), int(s * 0.34) + heading],
                          radius=heading // 2, fill=INK_STRONG)
    body = int(s * (0.05 if not bold else 0.07))
    for index in range(2):
        top = int(s * (0.50 + index * 0.13))
        draw.rounded_rectangle([int(s * 0.28), top, int(s * 0.72), top + body], radius=body // 2, fill=INK)


def mark_pdf(canvas, bold):
    s = canvas.width
    x0, y0, x1, y1, cut = draw_page(canvas, bold, fill=RED, edge=RED_DARK, fold=(240, 214, 210))
    if not bold:
        centred_text(canvas, "PDF", s * 0.24, PAPER, (y0 + y1) / 2 + s * 0.04)
    else:
        draw = ImageDraw.Draw(canvas)
        bar = int(s * 0.08)
        for index in range(2):
            top = int(s * (0.56 + index * 0.16))
            draw.rounded_rectangle([int(s * 0.30), top, int(s * 0.70), top + bar], radius=bar // 2, fill=PAPER)


def mark_code(canvas, bold):
    s = canvas.width
    draw = ImageDraw.Draw(canvas)
    size = s * (0.46 if not bold else 0.56)
    centred_text(canvas, "{ }", size, NAVY, s * 0.52)


def mark_table(canvas, bold):
    s = canvas.width
    draw = ImageDraw.Draw(canvas)
    left, right = int(s * 0.27), int(s * 0.73)
    top = int(s * 0.34)
    header = int(s * (0.10 if bold else 0.09))
    draw.rounded_rectangle([left, top, right, top + header], radius=int(s * 0.02), fill=TEAL_DARK)
    row = int(s * (0.075 if bold else 0.065))
    gap = int(s * 0.03)
    for index in range(2):
        row_top = top + header + gap + index * (row + gap)
        draw.rounded_rectangle([left, row_top, right, row_top + row], radius=int(s * 0.02), fill=TEAL)


def mark_image(canvas, bold):
    """不带书页框：整枚图标就是图片标识本身。"""
    s = canvas.width
    draw = ImageDraw.Draw(canvas)
    margin = int(s * (0.10 if not bold else 0.07))
    frame = [margin, int(s * 0.22), s - margin, int(s * 0.78)]
    width = max(1, int(s * (0.055 if bold else 0.045)))
    draw.rounded_rectangle(frame, radius=int(s * 0.09), fill=(236, 241, 245), outline=TEAL_DARK, width=width)
    inner_top = frame[1] + width
    inner_bottom = frame[3] - width
    draw.polygon([(frame[0] + width, inner_bottom), (int(s * 0.42), inner_top + int(s * 0.18)), (int(s * 0.60), inner_bottom)], fill=TEAL)
    draw.polygon([(int(s * 0.52), inner_bottom), (int(s * 0.68), inner_top + int(s * 0.30)), (int(s * 0.86), inner_bottom)], fill=TEAL_DARK)
    radius = int(s * (0.075 if bold else 0.065))
    draw.ellipse([int(s * 0.63), inner_top + int(s * 0.06), int(s * 0.63) + radius * 2, inner_top + int(s * 0.06) + radius * 2], fill=AMBER)


TYPES = {
    "markdown": mark_markdown,
    "html": mark_html,
    "text": mark_text,
    "pdf": mark_pdf,
    "code": mark_code,
    "table": mark_table,
    "image": mark_image,
}
# image 不带纸页；其余先画纸页再画记号
WITH_PAGE = {"markdown", "html", "text", "pdf", "code", "table"}


def render(name, size):
    mark = TYPES[name]
    bold = size <= 32
    big = size * SS
    canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    if name in WITH_PAGE:
        draw_page(canvas, bold)
    mark(canvas, bold)
    return canvas.resize((size, size), Image.LANCZOS)


os.makedirs(OUT, exist_ok=True)
frames = {}
for name in TYPES:
    images = [render(name, size) for size in SIZES]
    path = os.path.join(OUT, f"{name}.ico")
    images[-1].save(path, format="ICO", sizes=[(size, size) for size in SIZES], append_images=images[:-1])
    frames[name] = images
    print(path)

columns = len(TYPES)
sheet = Image.new("RGB", (columns * 130 + 20, 320), (255, 255, 255))
draw = ImageDraw.Draw(sheet)
label = font(13, bold=False)
for index, (name, images) in enumerate(frames.items()):
    x = 20 + index * 130
    sheet.paste(images[SIZES.index(64)], (x, 44), images[SIZES.index(64)])
    sheet.paste(images[SIZES.index(32)], (x + 72, 56), images[SIZES.index(32)])
    sheet.paste(images[SIZES.index(16)], (x + 72, 100), images[SIZES.index(16)])
    zoom = images[SIZES.index(16)].resize((48, 48), Image.NEAREST)
    sheet.paste(zoom, (x + 8, 112), zoom)
    if label:
        draw.text((x + 4, 20), name, fill=(24, 28, 36), font=label)
        draw.text((x + 8, 168), "64 / 32 / 16 / 16x3", fill=(96, 104, 114), font=label)
draw.rectangle([10, 200, columns * 130 + 10, 310], fill=(32, 32, 38))
for index, (name, images) in enumerate(frames.items()):
    x = 20 + index * 130
    sheet.paste(images[SIZES.index(48)], (x, 222), images[SIZES.index(48)])
    sheet.paste(images[SIZES.index(16)], (x + 72, 238), images[SIZES.index(16)])
    if label:
        draw.text((x + 8, 280), "on dark", fill=(232, 234, 238), font=label)
preview = os.path.join(ROOT, "artifacts", "file-icons-preview.png")
sheet.save(preview)
print(preview)
