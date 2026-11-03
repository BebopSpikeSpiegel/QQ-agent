"""Re-colour the pixel-art Spike avatar in Claude's palette and add Claude sparks.

Usage: python -I scripts/persona/claudify-avatar.py <src.jpg> <out_dir>

The source is a 100x100 pixel-art image upscaled to 940 px (9.4 px per pixel)
and saved as JPEG. Every edit happens on the rebuilt 100x100 grid, then a
nearest-neighbour upscale keeps the output crisp.

Writes two variants:
  A  ivory background, coral collar, coral halftone and sparks
  B  coral background, ivory collar, ivory halftone and sparks
"""
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

GRID, CELL = 100, 9.4

IVORY, IVORY_HI = (0xF0, 0xEE, 0xE6), (0xFA, 0xF9, 0xF5)
CORAL, CORAL_HI, CORAL_LO, CORAL_DK = (0xD9, 0x77, 0x57), (0xEC, 0x9F, 0x84), (0xB8, 0x5C, 0x3F), (0x6B, 0x2F, 0x1E)
CORAL_MID, CORAL_TINT, EMBER = (0xC6, 0x65, 0x47), (0xE9, 0xB4, 0x9C), (0xF0, 0x6A, 0x3E)


def hexc(s):
    return tuple(int(s[i:i + 2], 16) for i in (1, 3, 5))


def rebuild_grid(path):
    """Median of each cell's centre, then merge JPEG-drifted near-duplicate colours."""
    im = np.asarray(Image.open(path).convert('RGB')).astype(np.float64)
    nat = np.zeros((GRID, GRID, 3), np.uint8)
    for r in range(GRID):
        for c