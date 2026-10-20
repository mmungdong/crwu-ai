#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""macOS PDF rasteriser built on the system CoreGraphics framework.

Why this exists: the DSH workspace Python is a hardened, Developer-ID signed
runtime. macOS library validation refuses to map third-party native libraries
(such as a packaged libpdfium.dylib) into that process, so pypdfium2 cannot be
loaded there on any employee machine. CoreGraphics ships with macOS, is signed
by Apple, and needs no download or installation.

Rendering is intentionally narrow: page count and full-page RGBA pixels. PNG
encoding and image handling stay in the shared Pillow path.
"""
from __future__ import annotations

import ctypes
import os
import sys

_FRAMEWORKS = "/System/Library/Frameworks/"


class QuartzUnavailable(Exception):
    pass


class _CGPoint(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]


class _CGSize(ctypes.Structure):
    _fields_ = [("width", ctypes.c_double), ("height", ctypes.c_double)]


class _CGRect(ctypes.Structure):
    _fields_ = [("origin", _CGPoint), ("size", _CGSize)]


class _CGAffineTransform(ctypes.Structure):
    _fields_ = [
        ("a", ctypes.c_double), ("b", ctypes.c_double),
        ("c", ctypes.c_double), ("d", ctypes.c_double),
        ("tx", ctypes.c_double), ("ty", ctypes.c_double),
    ]


_CROP_BOX = 1
_RGBA_PREMULTIPLIED_LAST_BIG_ENDIAN = 1 | (4 << 12)
_deps = None


def _load():
    global _deps
    if _deps is not None:
        return _deps
    if sys.platform != "darwin":
        raise QuartzUnavailable("CoreGraphics rendering is macOS-only")
    try:
        cg = ctypes.CDLL(_FRAMEWORKS + "CoreGraphics.framework/CoreGraphics")
        cf = ctypes.CDLL(_FRAMEWORKS + "CoreFoundation.framework/CoreFoundation")
    except OSError as error:
        raise QuartzUnavailable("CoreGraphics/CoreFoundation 不可用：%s" % error)

    cf.CFURLCreateFromFileSystemRepresentation.argtypes = [
        ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int, ctypes.c_bool,
    ]
    cf.CFURLCreateFromFileSystemRepresentation.restype = ctypes.c_void_p
    cf.CFRelease.argtypes = [ctypes.c_void_p]
    cf.CFRelease.restype = None

    cg.CGPDFDocumentCreateWithURL.argtypes = [ctypes.c_void_p]
    cg.CGPDFDocumentCreateWithURL.restype = ctypes.c_void_p
    cg.CGPDFDocumentGetNumberOfPages.argtypes = [ctypes.c_void_p]
    cg.CGPDFDocumentGetNumberOfPages.restype = ctypes.c_size_t
    cg.CGPDFDocumentGetPage.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
    cg.CGPDFDocumentGetPage.restype = ctypes.c_void_p
    cg.CGPDFPageGetBoxRect.argtypes = [ctypes.c_void_p, ctypes.c_int]
    cg.CGPDFPageGetBoxRect.restype = _CGRect
    cg.CGPDFPageGetRotationAngle.argtypes = [ctypes.c_void_p]
    cg.CGPDFPageGetRotationAngle.restype = ctypes.c_int
    cg.CGColorSpaceCreateDeviceRGB.restype = ctypes.c_void_p
    cg.CGBitmapContextCreate.argtypes = [
        ctypes.c_void_p, ctypes.c_size_t, ctypes.c_size_t, ctypes.c_size_t,
        ctypes.c_size_t, ctypes.c_void_p, ctypes.c_uint32,
    ]
    cg.CGBitmapContextCreate.restype = ctypes.c_void_p
    cg.CGContextSetRGBFillColor.argtypes = [
        ctypes.c_void_p, ctypes.c_double, ctypes.c_double, ctypes.c_double, ctypes.c_double,
    ]
    cg.CGContextFillRect.argtypes = [ctypes.c_void_p, _CGRect]
    cg.CGPDFPageGetDrawingTransform.argtypes = [ctypes.c_void_p, ctypes.c_int, _CGRect, ctypes.c_int, ctypes.c_bool]
    cg.CGPDFPageGetDrawingTransform.restype = _CGAffineTransform
    cg.CGContextConcatCTM.argtypes = [ctypes.c_void_p, _CGAffineTransform]
    cg.CGContextScaleCTM.argtypes = [ctypes.c_void_p, ctypes.c_double, ctypes.c_double]
    cg.CGContextDrawPDFPage.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    cg.CGContextFlush.argtypes = [ctypes.c_void_p]
    _deps = (cg, cf)
    return _deps


def available() -> bool:
    try:
        _load()
        return True
    except QuartzUnavailable:
        return False


class QuartzRenderer:
    """One open document; call ``close`` when finished."""

    def __init__(self, path: str):
        cg, cf = _load()
        self._cg = cg
        self._cf = cf
        encoded = os.fsencode(os.path.abspath(path))
        url = cf.CFURLCreateFromFileSystemRepresentation(None, encoded, len(encoded), False)
        if not url:
            raise QuartzUnavailable("无法为 PDF 创建文件 URL")
        try:
            self._document = cg.CGPDFDocumentCreateWithURL(url)
        finally:
            cf.CFRelease(url)
        if not self._document:
            raise QuartzUnavailable("CoreGraphics 打不开这份 PDF（可能已损坏或加密）")

    @property
    def page_count(self) -> int:
        return int(self._cg.CGPDFDocumentGetNumberOfPages(self._document))

    def _page(self, page_no: int):
        page = self._cg.CGPDFDocumentGetPage(self._document, page_no)
        if not page:
            raise QuartzUnavailable("第 %s 页不存在" % page_no)
        return page

    def page_box(self, page_no: int):
        page = self._page(page_no)
        box = self._cg.CGPDFPageGetBoxRect(page, _CROP_BOX)
        if box.size.width <= 0 or box.size.height <= 0:
            box = self._cg.CGPDFPageGetBoxRect(page, 0)
        rotation = int(self._cg.CGPDFPageGetRotationAngle(page)) % 360
        return float(box.size.width), float(box.size.height), rotation

    def render(self, page_no: int, scale: float):
        """Return ``(width, height, rgba_bytes, rotation)`` for one page."""
        cg = self._cg
        page = self._page(page_no)
        box = cg.CGPDFPageGetBoxRect(page, _CROP_BOX)
        if box.size.width <= 0 or box.size.height <= 0:
            box = cg.CGPDFPageGetBoxRect(page, 0)
        rotation = int(cg.CGPDFPageGetRotationAngle(page)) % 360
        rotated_width, rotated_height = (
            (box.size.height, box.size.width) if rotation % 180 else (box.size.width, box.size.height))
        if rotated_width <= 0 or rotated_height <= 0:
            raise QuartzUnavailable("第 %s 页的页面尺寸无效" % page_no)
        width = max(1, int(round(rotated_width * scale)))
        height = max(1, int(round(rotated_height * scale)))

        buffer = ctypes.create_string_buffer(width * height * 4)
        color_space = cg.CGColorSpaceCreateDeviceRGB()
        context = cg.CGBitmapContextCreate(
            buffer, width, height, 8, width * 4, color_space, _RGBA_PREMULTIPLIED_LAST_BIG_ENDIAN)
        try:
            if not context:
                raise QuartzUnavailable("无法创建第 %s 页的位图上下文" % page_no)
            cg.CGContextSetRGBFillColor(context, 1.0, 1.0, 1.0, 1.0)
            cg.CGContextFillRect(context, _CGRect(_CGPoint(0, 0), _CGSize(width, height)))
            # Fit the rotated page box into the bitmap without an extra margin,
            # then let CoreGraphics apply the page's /Rotate value.
            transform = cg.CGPDFPageGetDrawingTransform(
                page, _CROP_BOX, _CGRect(_CGPoint(0, 0), _CGSize(rotated_width, rotated_height)), 0, True)
            cg.CGContextScaleCTM(context, scale, scale)
            cg.CGContextConcatCTM(context, transform)
            cg.CGContextDrawPDFPage(context, page)
            cg.CGContextFlush(context)
            return width, height, bytes(buffer.raw), rotation
        finally:
            if context:
                self._cf.CFRelease(context)
            if color_space:
                self._cf.CFRelease(color_space)

    def close(self) -> None:
        if getattr(self, "_document", None):
            self._cf.CFRelease(self._document)
            self._document = None

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()
