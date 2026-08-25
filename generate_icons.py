# -*- coding: utf-8 -*-
"""
哔哩哔哩 Cookies 登录助手 - 图标生成脚本
用法: python generate_icons.py
需要: pip install Pillow
"""
import os
from PIL import Image, ImageDraw, ImageFont

SIZES = [16, 48, 128]
OUT_DIR = os.path.join(os.path.dirname(__file__), "icons")


def draw_icon(size):
    """绘制一个圆角方形背景 + 白色字母 B 的图标"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 圆角矩形背景（渐变近似：用两色叠加）
    radius = size // 4
    # 主色
    draw.rounded_rectangle(
        [0, 0, size - 1, size - 1],
        radius=radius,
        fill=(251, 114, 153, 255),  # #fb7299
    )

    # 字母 B
    font_size = int(size * 0.62)
    try:
        font = ImageFont.truetype("arialbd.ttf", font_size)
    except Exception:
        font = ImageFont.load_default()

    text = "B"
    # 计算居中
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    x = (size - tw) / 2 - bbox[0]
    y = (size - th) / 2 - bbox[1] - size * 0.02

    draw.text((x, y), text, font=font, fill=(255, 255, 255, 255))
    return img


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        img = draw_icon(size)
        path = os.path.join(OUT_DIR, f"icon{size}.png")
        img.save(path)
        print(f"已生成: {path}")


if __name__ == "__main__":
    main()