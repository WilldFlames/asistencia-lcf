"""Genera los iconos de LCF Familias a partir del escudo usado en el inicio de sesión."""

import base64
import io
import re
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "public" / "index.html"
ICONS = ROOT / "public" / "icons"


def obtener_escudo() -> Image.Image:
    html = INDEX.read_text(encoding="utf-8")
    match = re.search(r'<img src="data:image/jpeg;base64,([^"]+)', html)
    if not match:
        raise RuntimeError("No se encontró el escudo del inicio de sesión.")
    return Image.open(io.BytesIO(base64.b64decode(match.group(1)))).convert("RGB")


def icono_cuadrado(escudo: Image.Image, size: int, margen: float) -> Image.Image:
    lienzo = Image.new("RGB", (size, size), "#08243d")
    draw = ImageDraw.Draw(lienzo)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=size // 5, fill="#08243d")

    diametro = int(size * (1 - 2 * margen))
    logo = escudo.resize((diametro, diametro), Image.Resampling.LANCZOS)
    mascara = Image.new("L", (diametro, diametro), 0)
    ImageDraw.Draw(mascara).ellipse((0, 0, diametro - 1, diametro - 1), fill=255)

    aro = max(2, size // 80)
    x = y = (size - diametro) // 2
    draw.ellipse((x - aro, y - aro, x + diametro + aro, y + diametro + aro), fill="#ffffff")
    lienzo.paste(logo, (x, y), mascara)
    return lienzo


def main() -> None:
    ICONS.mkdir(parents=True, exist_ok=True)
    escudo = obtener_escudo()
    icono_cuadrado(escudo, 32, 0.10).save(ICONS / "lcf-familias-32.png", optimize=True)
    icono_cuadrado(escudo, 180, 0.10).save(ICONS / "lcf-familias-180.png", optimize=True)
    icono_cuadrado(escudo, 192, 0.10).save(ICONS / "lcf-familias-192.png", optimize=True)
    icono_cuadrado(escudo, 512, 0.10).save(ICONS / "lcf-familias-512.png", optimize=True)
    # Android puede recortar los iconos maskable; el margen mayor mantiene el escudo completo.
    icono_cuadrado(escudo, 512, 0.20).save(ICONS / "lcf-familias-maskable-512.png", optimize=True)
    print(f"Iconos generados en {ICONS}")


if __name__ == "__main__":
    main()
