#!/usr/bin/env python3
"""Pet skins — pluggable renderers for the omp desktop pet's BODY.

A skin owns everything below the bubbles/status/panel chrome. It receives the
shared pose dict computed by the pet's state machine and renders accordingly.

Modes (selected via `--skin TYPE[:PATH]` or persisted config):
  cat              procedural vector cat (default, zero assets)
  image:<png>      single character cutout + procedural transforms
  frames:<dir>     per-state PNG sequences  `<state>-<n>.png`, cycles at ~7fps
  live2d:<dir>     Cubism model dir (*.model3.json) rendered via live2d-py
                   into a GtkGLArea; optional motions.json maps pet states to
                   motions/expressions. Falls back to cat when live2d-py or
                   the model is unavailable.

All skins must degrade gracefully: bad asset → SkinUnavailable → caller falls
back to CatSkin with a log line. A broken skin must never kill the daemon.
"""
from __future__ import annotations

import glob
import json
import math
import os
import sys

import gi

gi.require_version("Gdk", "4.0")
gi.require_version("Gtk", "4.0")
from gi.repository import Gdk, GdkPixbuf, Gtk  # noqa: F401,E402

# Amethyst-glass adjacent palette (shared with the daemon chrome).
COL_BODY = (0.72, 0.62, 0.85, 0.92)
COL_BODY_DARK = (0.55, 0.45, 0.72, 1.0)
COL_OUTLINE = (0.38, 0.30, 0.52, 1.0)
COL_EYE = (0.18, 0.14, 0.26, 1.0)

BODY_BOX = 150.0  # skins render their subject inside ~this square


class SkinError(Exception):
    """Asset-level problem (bad file)."""


class SkinUnavailable(SkinError):
    """Dependency missing (e.g. live2d-py not installed) — try another skin."""


def rounded(ctx, x, y, w, h, r):  # noqa: ANN001
    ctx.new_sub_path()
    ctx.arc(x + w - r, y + r, r, -math.pi / 2, 0)
    ctx.arc(x + w - r, y + h - r, r, 0, math.pi / 2)
    ctx.arc(x + r, y + h - r, r, math.pi / 2, math.pi)
    ctx.arc(x + r, y + r, r, math.pi, 3 * math.pi / 2)
    ctx.close_path()


# --------------------------------------------------------------------------
# cat — the original procedural cat


class CatSkin:
    name = "cat"
    needs_gl = False

    def __init__(self) -> None:
        self.blink_until = 0.0
        self.next_blink = 0.0

    def load(self) -> None:  # noqa: B027 — optional hook
        pass

    def dispose(self) -> None:  # noqa: B027
        pass

    def on_tick(self, t: float) -> None:
        if t > self.next_blink:
            self.blink_until = t + 0.15
            self.next_blink = t + 2.5 + (t * 977 % 35) / 10.0  # deterministic jitter

    def draw_body(self, ctx, w: int, h: int, t: float, state: str,
                  pose: dict) -> None:  # noqa: ANN001
        breathe = 1.0 + 0.02 * math.sin(t * 2.1)
        jump = pose.get("jump", 0.0)
        tilt = pose.get("tilt", 0.0)
        squish = pose.get("squish", 1.0)
        cx, cy = w * 0.42, h * 0.58

        body_w, body_h = 92.0 * breathe, 64.0 * breathe * squish
        bx, by = cx - body_w / 2, cy - jump - body_h / 2

        ctx.save()
        ctx.translate(cx, cy - jump)
        ctx.rotate(tilt)
        ctx.translate(-cx, -(cy - jump))

        # tail — sine wag from the right flank
        wag = math.sin(t * pose.get("tail_speed", 2.2)) * pose.get("tail_amp", 16.0)
        ctx.set_line_width(7.0)
        ctx.set_line_cap(1)  # round
        ctx.set_source_rgba(*COL_BODY_DARK)
        ctx.move_to(bx + body_w - 8, by + body_h - 12)
        ctx.curve_to(
            bx + body_w + 26, by + body_h - 6 + wag * 0.4,
            bx + body_w + 34, by + body_h - 34 + wag,
            bx + body_w + 22, by + body_h - 48 + wag * 1.2,
        )
        ctx.stroke()

        # body
        rounded(ctx, bx, by, body_w, body_h, 26)
        ctx.set_source_rgba(*COL_BODY)
        ctx.fill_preserve()
        ctx.set_source_rgba(*COL_OUTLINE)
        ctx.set_line_width(2.0)
        ctx.stroke()

        # ears
        ear_h = 20.0 * squish
        for side in (-1, 1):
            ex = cx + side * 24
            ctx.move_to(ex - 12 * side, by + 10)
            ctx.line_to(ex + 2 * side, by - ear_h)
            ctx.line_to(ex + 13 * side, by + 8)
            ctx.close_path()
            ctx.set_source_rgba(*COL_BODY)
            ctx.fill_preserve()
            ctx.set_source_rgba(*COL_OUTLINE)
            ctx.set_line_width(2.0)
            ctx.stroke()

        self._face(ctx, cx, by, body_h, t, state, pose)
        self._paw(ctx, cx, cy, jump, body_h, t, pose)
        ctx.restore()

        if state == "done":
            self._sparkles(ctx, w, h, t)

    @staticmethod
    def _sparkles(ctx, w: int, h: int, t: float) -> None:  # noqa: ANN001
        for i in range(5):
            ph = (t * 1.4 + i * 0.37) % 1.0
            sx = w * 0.75 + 18 * math.sin(i * 2.4)
            sy = h * 0.32 - 40 * ph
            ctx.set_source_rgba(1.0, 0.9, 0.5, (1.0 - ph) * 0.9)
            ctx.arc(sx, sy, 2.2 + 1.6 * math.sin(i + t * 3), 0, 2 * math.pi)
            ctx.fill()

    def _face(self, ctx, cx: float, by: float, body_h: float, t: float,
              state: str, pose: dict) -> None:  # noqa: ANN001
        eye_y = by + body_h * 0.42
        look = pose.get("look", (0.0, 0.0))
        blink = t < self.blink_until or bool(pose.get("blink"))
        happy = pose.get("happy", False)
        dizzy = pose.get("dizzy", False)
        for side in (-1, 1):
            exx = cx + side * 17 + look[0]
            eyy = eye_y + look[1]
            if dizzy:
                ctx.set_source_rgba(*COL_EYE)
                ctx.set_line_width(2.4)
                a0 = t * 6 + (0 if side < 0 else math.pi)
                ctx.arc(exx, eyy, 5.2, a0, a0 + 4.6)
                ctx.stroke()
            elif blink:
                ctx.set_source_rgba(*COL_EYE)
                ctx.set_line_width(2.2)
                ctx.move_to(exx - 5, eyy)
                ctx.line_to(exx + 5, eyy)
                ctx.stroke()
            elif happy:
                ctx.set_source_rgba(*COL_EYE)
                ctx.set_line_width(2.6)
                ctx.arc(exx, eyy + 1.5, 5.0, math.pi, 2 * math.pi)
                ctx.stroke()
            else:
                ctx.set_source_rgba(*COL_EYE)
                ctx.arc(exx, eyy, 4.6, 0, 2 * math.pi)
                ctx.fill()

        nose_y = eye_y + 10
        ctx.set_source_rgba(*COL_EYE)
        ctx.arc(cx, nose_y, 1.8, 0, 2 * math.pi)
        ctx.fill()
        ctx.set_line_width(1.6)
        mouth = pose.get("mouth", "w")
        if mouth == "o":
            ctx.arc(cx, nose_y + 7, 3.4, 0, 2 * math.pi)
            ctx.stroke()
        elif mouth == "smile":
            ctx.arc(cx, nose_y + 3.5, 5.0, 0.15 * math.pi, 0.85 * math.pi)
            ctx.stroke()
        else:  # ω
            ctx.arc(cx - 3, nose_y + 4, 3.2, -0.15 * math.pi, 0.9 * math.pi)
            ctx.stroke()
            ctx.arc(cx + 3, nose_y + 4, 3.2, 0.1 * math.pi, 1.15 * math.pi)
            ctx.stroke()

        if pose.get("blush"):
            ctx.set_source_rgba(0.95, 0.55, 0.65, 0.55)
            for side in (-1, 1):
                ctx.arc(cx + side * 28, eye_y + 9, 5.0, 0, 2 * math.pi)
                ctx.fill()

    @staticmethod
    def _paw(ctx, cx: float, cy: float, jump: float, body_h: float,
             t: float, pose: dict) -> None:  # noqa: ANN001
        if not pose.get("tap"):
            return
        tap_y = cy - jump + body_h / 2 - 6 + 3.0 * abs(math.sin(t * 7))
        ctx.set_line_width(6.0)
        ctx.set_source_rgba(*COL_BODY_DARK)
        ctx.move_to(cx + 14, cy - jump + body_h / 2 - 14)
        ctx.line_to(cx + 20, tap_y)
        ctx.stroke()


# --------------------------------------------------------------------------
# image — one character cutout, animated by transforms


class ImageSkin:
    """Single transparent-background PNG; the state machine drives transforms."""
    name = "image"
    needs_gl = False

    def __init__(self, path: str) -> None:
        self.path = os.path.expanduser(path)
        self.pix: GdkPixbuf.Pixbuf | None = None

    def load(self) -> None:
        if not os.path.isfile(self.path):
            raise SkinError(f"image skin: no such file {self.path}")
        self.pix = GdkPixbuf.Pixbuf.new_from_file(self.path)
        # fit into BODY_BOX while preserving aspect
        pw, ph = self.pix.get_width(), self.pix.get_height()
        scale = min(BODY_BOX / max(pw, 1), BODY_BOX / max(ph, 1), 4.0)
        self.draw_w, self.draw_h = max(8, pw * scale), max(8, ph * scale)

    def dispose(self) -> None:  # noqa: B027
        pass

    def draw_body(self, ctx, w: int, h: int, t: float, state: str,
                  pose: dict) -> None:  # noqa: ANN001
        if self.pix is None:
            return
        cx, cy = w * 0.42, h * 0.60 - pose.get("jump", 0.0)
        breathe = 1.0 + 0.02 * math.sin(t * 2.1)
        scale = breathe * pose.get("squish", 1.0)
        dw, dh = self.draw_w * scale, self.draw_h * scale

        alpha = 0.65 if state in ("idle", "aborted") else (
            0.85 if state == "waiting" else 1.0
        )
        ctx.save()
        ctx.translate(cx, cy)
        ctx.rotate(pose.get("tilt", 0.0))
        Gdk.cairo_set_source_pixbuf(ctx, self.pix, -dw / 2, -dh / 2)
        ctx.rectangle(-dw / 2, -dh / 2, dw, dh)
        ctx.clip()
        # clip() consumed the path — paint the source within the clip region.
        ctx.paint_with_alpha(alpha)
        ctx.restore()

        if state == "error":  # alarm halo — readable without pixel tint tricks
            ctx.set_source_rgba(0.97, 0.46, 0.56, 0.35 + 0.15 * math.sin(t * 8))
            rounded(ctx, cx - dw / 2 - 8, cy - dh / 2 - 8, dw + 16, dh + 16, 14)
            ctx.set_line_width(3.0)
            ctx.stroke()


# --------------------------------------------------------------------------
# frames — per-state PNG sequences


FRAME_ALIASES = {
    "done": ["done", "idle"],
    "error": ["error", "idle"],
    "waiting": ["waiting", "ask", "idle"],
    "retry": ["retry", "tool", "idle"],
    "compact": ["compact", "tool", "idle"],
    "thinking": ["thinking", "think", "idle"],
    "tool": ["tool", "working", "idle"],
    "aborted": ["aborted", "idle"],
    "idle": ["idle", "stand"],
}


class FramesSkin:
    """Directory of `<group>-<n>.png` groups; group names follow pet states."""
    name = "frames"
    needs_gl = False

    FPS = 7.0

    def __init__(self, directory: str) -> None:
        self.directory = os.path.expanduser(directory)
        self.groups: dict[str, list[GdkPixbuf.Pixbuf]] = {}

    def load(self) -> None:
        if not os.path.isdir(self.directory):
            raise SkinError(f"frames skin: no such directory {self.directory}")
        found: dict[str, list[tuple[int, str]]] = {}
        for path in sorted(glob.glob(os.path.join(self.directory, "*.png"))):
            base = os.path.splitext(os.path.basename(path))[0]
            stem, _, num = base.rpartition("-")
            if not stem or not num.isdigit():
                stem, num = base, "0"
            found.setdefault(stem.lower(), []).append((int(num), path))
        if not found:
            raise SkinError(f"frames skin: no PNGs under {self.directory}")
        max_side = BODY_BOX
        for stem, items in found.items():
            items.sort()
            frames = []
            for _n, path in items:
                pix = GdkPixbuf.Pixbuf.new_from_file(path)
                pw, ph = pix.get_width(), pix.get_height()
                scale = min(max_side / max(pw, 1), max_side / max(ph, 1), 4.0)
                frames.append(
                    GdkPixbuf.Pixbuf.scale_simple(
                        pix, max(8, int(pw * scale)), max(8, int(ph * scale)),
                        GdkPixbuf.InterpType.BILINEAR,
                    )
                )
            self.groups[stem] = frames
        if "idle" not in self.groups:
            raise SkinError(f"frames skin: need at least an idle-* sequence in {self.directory}")

    def dispose(self) -> None:  # noqa: B027
        pass

    def _sequence(self, state: str) -> list[GdkPixbuf.Pixbuf]:
        for candidate in FRAME_ALIASES.get(state, [state, "idle"]):
            key = candidate.lower()
            if key in self.groups:
                return self.groups[key]
        return next(iter(self.groups.values()))

    def draw_body(self, ctx, w: int, h: int, t: float, state: str,
                  pose: dict) -> None:  # noqa: ANN001
        seq = self._sequence(state)
        frame = seq[int(t * self.FPS) % len(seq)]
        cx, cy = w * 0.42, h * 0.60 - pose.get("jump", 0.0)
        breathe = 1.0 + 0.015 * math.sin(t * 2.1)
        scale = breathe * pose.get("squish", 1.0)
        dw, dh = frame.get_width() * scale, frame.get_height() * scale

        alpha = 0.65 if state in ("idle", "aborted") else 1.0
        ctx.save()
        ctx.translate(cx, cy)
        ctx.rotate(pose.get("tilt", 0.0))
        Gdk.cairo_set_source_pixbuf(ctx, frame, -dw / 2, -dh / 2)
        ctx.rectangle(-dw / 2, -dh / 2, dw, dh)
        ctx.clip()
        # clip() consumed the path — paint the source within the clip region.
        ctx.paint_with_alpha(alpha)
        ctx.restore()


# --------------------------------------------------------------------------
# live2d — Cubism model via live2d-py (optional dependency)


DEFAULT_MOTION_MAP = {
    "thinking": {},
    "tool": {},
    "waiting": {},
    "retry": {},
    "compact": {},
    "done": {},
    "error": {},
}


class Live2DSkin:
    """Cubism (.model3.json) character rendered OFFSCREEN via EGL.

    Gdk only offers core-profile desktop GL or GLES through GtkGLArea, but the
    Cubism renderer speaks GLSL 120 (compatibility profile). So we create our
    own EGL pbuffer + OpenGL 2.1-compat context, render there, and blit the
    pixels back as a Cairo image surface. needs_gl stays False — the regular
    DrawingArea path renders the body like any other skin.

    Optional `motions.json` next to the model maps pet states:
      {"thinking": {"motion": ["Idle", 0]}, "done": {"expression": "..."}}
    """
    name = "live2d"
    needs_gl = False

    RENDER_W, RENDER_H = int(BODY_BOX), int(BODY_BOX)

    def __init__(self, model_dir: str) -> None:
        self.model_dir = os.path.expanduser(model_dir)
        self.live2d = None
        self.model = None
        self.motion_map: dict = {}
        self.current_state: str | None = None
        self.moc_path: str | None = None
        self._egl = None  # (dpy, surf, ctx)
        self._surface = None  # cairo.ImageSurface
        try:
            import numpy  # noqa: F401
            self._numpy = numpy
        except ImportError:
            self._numpy = None

    def _egl_setup(self) -> None:
        from OpenGL.EGL import (
            eglGetDisplay, eglInitialize, eglChooseConfig, eglBindAPI,
            eglCreatePbufferSurface, eglCreateContext, eglMakeCurrent,
            EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RED_SIZE, EGL_GREEN_SIZE,
            EGL_BLUE_SIZE, EGL_ALPHA_SIZE, EGL_NONE, EGL_OPENGL_API,
            EGL_CONTEXT_MAJOR_VERSION, EGL_CONTEXT_MINOR_VERSION,
            EGL_WIDTH, EGL_HEIGHT, EGL_DEFAULT_DISPLAY,
        )
        import ctypes
        w, h = self.RENDER_W, self.RENDER_H
        dpy = eglGetDisplay(EGL_DEFAULT_DISPLAY)
        if not dpy:
            raise SkinError("live2d skin: eglGetDisplay failed")
        major, minor = ctypes.c_long(), ctypes.c_long()
        if not eglInitialize(dpy, major, minor):
            raise SkinError("live2d skin: eglInitialize failed")
        cfg = ctypes.c_void_p()
        n = ctypes.c_long()
        cfg_attr = (ctypes.c_int * 11)(
            EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RED_SIZE, 8,
            EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8, EGL_NONE)
        if not eglChooseConfig(dpy, cfg_attr, ctypes.byref(cfg), 1, n) or n.value != 1:
            raise SkinError("live2d skin: no suitable EGL config")
        eglBindAPI(EGL_OPENGL_API)
        pb = (ctypes.c_int * 5)(EGL_WIDTH, w, EGL_HEIGHT, h, EGL_NONE)
        surf = eglCreatePbufferSurface(dpy, cfg, pb)
        ctx_attr = (ctypes.c_int * 5)(EGL_CONTEXT_MAJOR_VERSION, 2,
                                      EGL_CONTEXT_MINOR_VERSION, 1, EGL_NONE)
        ctx = eglCreateContext(dpy, cfg, None, ctx_attr)
        if not eglMakeCurrent(dpy, surf, surf, ctx):
            raise SkinError("live2d skin: eglMakeCurrent failed")
        self._egl = (dpy, surf, ctx)

    def load(self) -> None:
        """Light validation — heavy GL init happens in gl_init()."""
        try:
            import live2d.v3 as l2d  # type: ignore[import-not-found]
        except ImportError as exc:
            raise SkinUnavailable(
                f"live2d skin needs the live2d-py package ({exc}); falling back to cat"
            ) from exc
        moc = sorted(glob.glob(os.path.join(self.model_dir, "*.model3.json")))
        if not moc:
            raise SkinError(f"live2d skin: no .model3.json in {self.model_dir}")
        self.live2d = l2d
        self.moc_path = moc[0]
        map_path = os.path.join(self.model_dir, "motions.json")
        if os.path.isfile(map_path):
            try:
                with open(map_path, encoding="utf-8") as f:
                    self.motion_map = json.load(f)
            except (OSError, json.JSONDecodeError):
                self.motion_map = {}

    def gl_init(self) -> None:
        """Create the offscreen context and load the model into it."""
        assert self.live2d is not None and self.moc_path is not None
        self._egl_setup()
        self.live2d.init()
        self.live2d.glInit()
        self.model = self.live2d.LAppModel()
        self.model.LoadModelJson(self.moc_path)
        self.model.Resize(self.RENDER_W, self.RENDER_H)
        self.live2d.clearBuffer(0.0, 0.0, 0.0, 0.0)

    def resize(self, w: int, h: int) -> None:  # noqa: ARG002 — fixed pbuffer
        pass

    def dispose(self) -> None:
        self.model = None
        self.live2d = None
        self._surface = None
        self._egl = None

    def on_state(self, state: str) -> None:
        """Apply motion/expression mapping when the pet state changes."""
        if self.model is None or state == self.current_state:
            return
        self.current_state = state
        entry = self.motion_map.get(state) or {}
        expression = entry.get("expression")
        motion = entry.get("motion")
        try:
            if expression:
                self.model.SetExpression(expression)
            if isinstance(motion, (list, tuple)) and len(motion) >= 1:
                index = int(motion[1]) if len(motion) > 1 else 0
                priority = getattr(self.live2d.MotionPriority, "FORCE", 3)
                self.model.StartMotion(str(motion[0]), index, priority)
        except Exception:  # noqa: BLE001 — a wrong motion id must never kill us
            pass

    def _render_pixels(self) -> bytes | None:
        """Render one frame offscreen; return flipped premultiplied BGRA bytes."""
        from OpenGL.GL import glReadPixels, GL_RGBA, GL_UNSIGNED_BYTE
        dpy, surf, ctx = self._egl
        from OpenGL.EGL import eglMakeCurrent
        eglMakeCurrent(dpy, surf, surf, ctx)
        self.live2d.clearBuffer(0.0, 0.0, 0.0, 0.0)
        self.model.Update()
        self.model.Draw()
        w, h = self.RENDER_W, self.RENDER_H
        data = glReadPixels(0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE)
        dump = os.environ.get("L2D_DUMP")
        if dump:
            from PIL import Image
            img = Image.frombytes("RGBA", (w, h), bytes(data))
            img.save(dump)
            print(f"[l2d] dumped {w}x{h} -> {dump}", flush=True)
        if self._numpy is None:
            return None  # numpy-less fallback: skip body rather than stall
        if data is None or len(data) == 0:
            return None
        numpy = self._numpy
        arr = numpy.frombuffer(data, dtype=numpy.uint8).reshape(h, w, 4)
        arr = arr[::-1]  # GL is bottom-up
        rgb = arr[:, :, :3].astype(numpy.uint16)
        a8 = arr[:, :, 3:]
        premul = (rgb * a8 // 255).astype(numpy.uint8)
        # cairo ARGB32 on little-endian = bytes B,G,R,A
        return numpy.concatenate([premul[:, :, 2:], premul[:, :, 1:2],
                                  premul[:, :, 0:1], a8], axis=-1).tobytes()

    def draw_body(self, ctx, w: int, h: int, t: float, state: str,
                  pose: dict) -> None:  # noqa: ANN001
        import sys
        import cairo

        if self.model is None:
            try:
                self.gl_init()
            except Exception as exc:  # noqa: BLE001
                if not getattr(self, "_init_failed", False):
                    print(f"omp-pet: live2d init failed: {exc}",
                          file=sys.stderr, flush=True)
                    self._init_failed = True
                return
        raw = self._render_pixels()
        if raw is None:
            return
        rw, rh = self.RENDER_W, self.RENDER_H
        surface = cairo.ImageSurface.create_for_data(
            bytearray(raw), cairo.Format.ARGB32, rw, rh, rw * 4)
        cx, cy = w * 0.42, h * 0.60 - pose.get("jump", 0.0)
        breathe = 1.0 + 0.02 * math.sin(t * 2.1)
        scale = breathe * pose.get("squish", 1.0)
        dw, dh = rw * scale, rh * scale
        alpha = 0.65 if state in ("idle", "aborted") else (
            0.85 if state == "waiting" else 1.0)

        ctx.save()
        ctx.translate(cx, cy)
        ctx.rotate(pose.get("tilt", 0.0))
        ctx.scale(scale, scale)
        ctx.set_source_surface(surface, -rw / 2, -rh / 2)
        ctx.paint_with_alpha(alpha)
        ctx.restore()


# --------------------------------------------------------------------------


def parse_skin_spec(spec: str) -> tuple[str, str | None]:
    """'cat' | 'image:/path.png' | 'frames:/dir' | 'live2d:/dir' → (type, path)."""
    kind, _sep, path = spec.partition(":")
    kind = kind.strip().lower()
    if kind == "cat":
        return "cat", None
    if kind in ("image", "frames", "live2d"):
        path = path.strip()
        if not path:
            raise SkinError(f"skin '{kind}' needs a path: {spec}")
        return kind, path
    raise SkinError(f"unknown skin '{spec}' (cat|image|frames|live2d)")


def create_skin(spec: str):
    """Build+load the requested skin; any failure falls back to CatSkin.

    Returns (skin, notice) where notice explains a fallback, or None.
    """
    try:
        kind, path = parse_skin_spec(spec)
        if kind == "cat" or path is None:
            skin = CatSkin()
        elif kind == "image":
            skin = ImageSkin(path)
        elif kind == "frames":
            skin = FramesSkin(path)
        else:
            skin = Live2DSkin(path)
        skin.load()
        return skin, None
    except SkinError as exc:
        fallback = CatSkin()
        fallback.load()
        return fallback, str(exc)
