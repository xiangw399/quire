"""生成 Quire 的应用图标：assets/app.ico（多尺寸）+ assets/icon.png（512）+ assets/icon.svg。

设计：叠页 + 书签。三张纸错开叠放，最上一张夹一枚琥珀色书签；深蓝渐变圆角方块打底，
配色取自应用界面本身（深蓝 #1E2B46→#111829、纸白 #F8F6F1、琥珀 #C67C0C）。
小尺寸（<=32px）走简化画法：去掉纸面文字线与细边，只留剪影，否则 16px 会糊成一团。

用法（需要 Pillow）：python tools/make-icons.py
iOS/macOS 的 icns 不在范围内：本项目只出 Windows 安装包。
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
SIZES = [16, 24, 32, 48, 64, 128, 256]
SS = 4  # 超采样倍数：先画大图再缩小，边缘才干净

NAVY_TOP = (30, 43, 70)
NAVY_BOTTOM = (17, 24, 41)
PAPER = (248, 246, 241)
PAPER_SHADE = (219, 216, 209)
AMBER = (198, 124, 12)
INK_LINE = (203, 209, 216)


def navy_tile(size):
    """圆角方块底：竖向渐变的深蓝。"""
    column = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / max(1, size - 1)
        column.putpixel((0, y), tuple(round(NAVY_TOP[i] + (NAVY_BOTTOM[i] - NAVY_TOP[i]) * t) for i in range(3)))
    tile = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.225), fill=255)
    tile.paste(column.resize((size, size), Image.BILINEAR), (0, 0), mask)
    return tile


def draw_quire(canvas, detail):
    s = canvas.width
    draw = ImageDraw.Draw(canvas)
    width, height = int(s * 0.44), int(s * 0.52)
    for dx, dy, shade in [(-0.10, 0.055, PAPER_SHADE), (-0.05, 0.028, PAPER), (0.0, 0.0, PAPER)]:
        x, y = int(s * (0.28 + dx)), int(s * (0.21 + dy))
        draw.rounded_rectangle([x, y, x + width, y + height], radius=int(s * 0.03), fill=shade)
    x, y = int(s * 0.28), int(s * 0.21)
    if detail:
        for index in range(3):
            top = y + int(height * (0.32 + index * 0.17))
            draw.rounded_rectangle(
                [x + int(s * 0.06), top, x + width - int(s * 0.14), top + int(s * 0.026)],
                radius=int(s * 0.013),
                fill=INK_LINE,
            )
    ribbon = int(s * (0.11 if not detail else 0.082))
    ribbon_x = x + int(width * 0.60)
    draw.polygon(
        [
            (ribbon_x, y),
            (ribbon_x + ribbon, y),
            (ribbon_x + ribbon, y + int(s * 0.30)),
            (ribbon_x + ribbon // 2, y + int(s * 0.245)),
            (ribbon_x, y + int(s * 0.30)),
        ],
        fill=AMBER,
    )


def render(size):
    big = size * SS
    canvas = navy_tile(big)
    draw_quire(canvas, size > 32)
    return canvas.resize((size, size), Image.LANCZOS)


frames = [render(size) for size in SIZES]
largest = frames[-1]
ico_path = os.path.join(ASSETS, "app.ico")
largest.save(ico_path, format="ICO", sizes=[(size, size) for size in SIZES], append_images=frames[:-1])
frames[-1].save(os.path.join(ASSETS, "icon.png"))

with Image.open(ico_path) as check:
    print(f"{ico_path}: {check.size[0]}px 基准，帧尺寸 {sorted(check.ico.sizes())}")
print(os.path.join(ASSETS, "icon.png"))
