#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PDF engine selection.

Order of preference:
1. ``pypdfium2`` when it can be imported (Windows packaged wheel, or a DSH
   runtime that ships it). One engine for both platforms when it is available.
2. macOS CoreGraphics (``ocr_quartz``) when pypdfium2 cannot be loaded. The DSH
   runtime is hardened-signed, so a packaged libpdfium cannot be mapped into it.
3. Otherwise no engine: the caller reports a capability gap instead of guessing.
"""
from __future__ import annotations

import importlib
import sys


class PdfEngine:
    name = ""
    version = ""

    def open(self, path: str):
        raise NotImplementedError

    @property
    def label(self) -> str:
        return "%s@%s" % (self.name, self.version) if self.version else self.name


class _PdfiumDocument:
    def __init__(self, pdfium, document, engine: "PdfiumEngine"):
        self._pdfium = pdfium
        self._document = document
        self.engine = engine

    @property
    def page_count(self) -> int:
        return len(self._document)

    def render(self, page_no: int, dpi: int):
        from PIL import Image

        page = self._document[page_no - 1]
        bitmap = page.render(scale=dpi / 72.0)
        image = bitmap.to_pil()
        if image.mode != "RGB":
            image = image.convert("RGB")
        rotation = 0
        try:
            rotation = int(page.get_rotation()) % 360
        except Exception:  # noqa: BLE001 - rotation is evidence, not a blocker
            rotation = 0
        return image, rotation

    def close(self) -> None:
        self._document.close()


class PdfiumEngine(PdfEngine):
    name = "pdfium"

    def __init__(self, module):
        self._module = module
        # pypdfium2 5.x exposes PYPDFIUM_INFO; older releases used V_PYPDFIUM2.
        info = getattr(module, "PYPDFIUM_INFO", None)
        self.version = str(
            getattr(info, "tag", "")
            or getattr(info, "version", "")
            or getattr(module, "V_PYPDFIUM2", "")
            or "")

    def open(self, path: str):
        return _PdfiumDocument(self._module, self._module.PdfDocument(path), self)


class _QuartzDocument:
    def __init__(self, renderer, engine: "QuartzEngine"):
        self._renderer = renderer
        self.engine = engine

    @property
    def page_count(self) -> int:
        return self._renderer.page_count

    def render(self, page_no: int, dpi: int):
        from PIL import Image

        width, height, rgba, rotation = self._renderer.render(page_no, dpi / 72.0)
        return Image.frombytes("RGBA", (width, height), rgba).convert("RGB"), rotation

    def close(self) -> None:
        self._renderer.close()


class QuartzEngine(PdfEngine):
    name = "quartz"
    version = "macos"

    def __init__(self, module):
        self._module = module

    def open(self, path: str):
        return _QuartzDocument(self._module.QuartzRenderer(path), self)


def select_pdf_engine():
    """Return ``(engine, notes)``; ``engine`` is None when nothing can render."""
    notes = []
    try:
        module = importlib.import_module("pypdfium2")
        return PdfiumEngine(module), notes
    except Exception as error:  # noqa: BLE001 - fall through with the reason
        notes.append("pypdfium2 不可用：%s" % error)
    if sys.platform == "darwin":
        try:
            quartz = importlib.import_module("ocr_quartz")
            if quartz.available():
                return QuartzEngine(quartz), notes
            notes.append("CoreGraphics 不可用")
        except Exception as error:  # noqa: BLE001
            notes.append("CoreGraphics 加载失败：%s" % error)
    return None, notes
