#!/usr/bin/env python3
"""omp desktop pet — ambient task-state companion for the omp coding agent.

An independent GTK4 overlay window (wayland layer-shell, TOP layer) that
mirrors what one or more omp sessions are doing. Sessions push state through
the pet-bridge extension over $XDG_RUNTIME_DIR/omp-pet.sock; this daemon
listens, aggregates per-session views, and renders a small procedural cat
whose pose follows the aggregate state.

Design contract (KDE notifications are disabled globally on this machine —
the pet IS the notification channel):
  - working states (thinking/tool/retry/compact) are calm ambient motion;
  - attention states are PERSISTENT until clicked, superseded, or SEEN:
      settle ok   → celebrate ("✓ 完成")   — replaces completion notify
      settle err  → alert    ("✗ 出错")     — replaces error notify
      waiting     → ask      ("? 等待审批") — replaces ask notify
      a "focus" frame (terminal tab/window regained focus — DEC 1004 report
      forwarded by pet-bridge) clears just that session's attention: the
      user switched to the session and has seen the pose.
  - idle long enough → sleep pose with floating zzz.
  - background sessions (hello with bg — task subagents re-binding
    pet-bridge inside the parent process, print runs) are ambient-only:
    never attention poses, never the ×N badge, nested under their parent
    (same pid) in the supervision panel. Their outcome is the parent's
    business, not a user notification.

Interaction:
  pointer hits the *drawn* silhouette (character + bubbles/status), not the
  240×230 window box — empty pixels are click-through on Wayland. Hovering
  the silhouette opens the supervision panel; leaving the silhouette hides
  it (the painted panel is not an input target). click on the silhouette =
  acknowledge ALL attention / pet; drag = move (re-anchors, full-window
  capture for the gesture); switch to a session's terminal tab = acknowledge
  THAT session (auto); right-click = context menu → 退出 (quit the daemon);
  pokes arrive from pet_poke tool, /pet command, alt+p → bubble + wiggle.

Usage: omp_pet.py [--socket PATH] [--margin-x N] [--margin-y N] [--replay FILE]

Run through ./omppet — it LD_PRELOADs libgtk4-layer-shell, without which the
layer surface init fails ("linked after libwayland") and the window degrades
to a plain toplevel.
"""
from __future__ import annotations

import argparse
import asyncio
from collections.abc import Callable
import json
import math
import os
import random
import signal
import sys
import threading
import time

import cairo
import gi


gi.require_version("Gdk", "4.0")
gi.require_version("Gtk", "4.0")
gi.require_version("Gtk4LayerShell", "1.0")
from gi.repository import Gdk, GLib, Gio, Gtk, Pango, PangoCairo  # noqa: E402
from gi.repository import Gtk4LayerShell as LayerShell  # noqa: E402

import skins  # local: pet skin plugins (same directory)

WIN_W, WIN_H = 240, 230
FPS_MS = 80  # ~12fps — plenty for wag/blink/bubble pulse
HIT_PAD = 4  # dilate the silhouette so hover isn't twitchy on hair edges
IDLE_SLEEP_S = 180.0
STATE_FILE = os.path.join(
    os.environ.get("XDG_STATE_HOME", os.path.expanduser("~/.local/state")), "omp-pet.json"
)

# Amethyst-glass adjacent palette (no solid backgrounds — transparent window).
COL_BODY = (0.72, 0.62, 0.85, 0.92)
COL_BODY_DARK = (0.55, 0.45, 0.72, 1.0)
COL_OUTLINE = (0.38, 0.30, 0.52, 1.0)
COL_EYE = (0.18, 0.14, 0.26, 1.0)
COL_BUBBLE_BG = (0.13, 0.11, 0.19, 0.88)
COL_BUBBLE_FG = (0.93, 0.91, 0.98, 1.0)
COL_OK = (0.62, 0.86, 0.55, 1.0)
COL_ERR = (0.97, 0.46, 0.56, 1.0)
COL_ASK = (0.98, 0.80, 0.44, 1.0)
COL_DIM = (0.65, 0.62, 0.75, 0.9)

WORKING_STATES = {"thinking", "tool", "retry", "compact"}
STATE_LABELS = {
    "thinking": "思考中",
    "compact": "压缩上下文",
    "retry": "重试中",
    "waiting": "等待审批",
}

REACTIONS = {
    "pet": [
        "(=^･ω･^=) 呼噜噜……",
        "^ω^ 蹭了蹭你的手心",
        "喵呜～ 尾巴卷成了一个小问号",
        "(=✧ω✧=) 耳朵抖了一下，很受用",
    ],
    "feed": [
        "咔嚓咔嚓…… 小鱼干真香！",
        "(￣﹃￣) 还想再来一条",
        "叼起小鱼干藏到了角落里",
    ],
    "play": [
        "(ﾟ∀ﾟ)!! 毛线球！扑！",
        "追着自己的尾巴转了三圈，晕",
        "啪嗒！按住了逗猫棒，得意地看了你一眼",
    ],
}


def default_socket_path() -> str:
    sock = os.environ.get("OMP_PET_SOCKET")
    if sock:
        return sock
    runtime = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    return os.path.join(runtime, "omp-pet.sock")


# --------------------------------------------------------------------------
# Model


STATE_GLYPHS = {
    "waiting": "?", "done": "✓", "error": "✗",
    "thinking": "⚙", "tool": "⚙", "retry": "⚙", "compact": "⚙",
}


def scan_omp_processes() -> list[dict]:
    """Read-only sweep of /proc for live omp agent processes (any vintage)."""
    found: list[dict] = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        pid = int(entry)
        try:
            with open(f"/proc/{entry}/cmdline", "rb") as f:
                parts = f.read().split(b"\0")
        except OSError:
            continue
        if not parts or not parts[0]:
            continue  # kernel thread
        argv0 = os.path.basename(parts[0].decode("utf-8", "replace"))
        if argv0 not in ("omp", "omp-patched"):
            continue
        cmdline = b" ".join(parts).decode("utf-8", "replace")
        if "__omp_worker_" in cmdline or "--smoke-test" in cmdline:
            continue  # helper workers re-entering the CLI entrypoint
        try:
            with open(f"/proc/{entry}/stat", encoding="utf-8") as f:
                state = f.read().rsplit(")", 1)[-1].split()[0]
        except (OSError, IndexError):
            state = "?"
        if state == "Z":
            continue
        try:
            proj = os.path.basename(os.path.realpath(f"/proc/{entry}/cwd"))
        except OSError:
            proj = "?"
        found.append({"pid": pid, "proj": proj})
    return found


class SessionView:
    """State of one connected omp session."""

    def __init__(self, label: str, proj: str) -> None:
        self.label = label or proj or "?"
        self.proj = proj
        self.state = "idle"  # idle|thinking|tool|waiting|retry|compact|done|error|aborted
        self.tool: str | None = None
        self.detail: str | None = None
        self.pid: int | None = None
        self.bg = False  # background session (task subagent / print run)
        self.since = time.monotonic()        # age of current state frame
        self.turn_since: float | None = None  # start of the RUNNING TURN

    def clock(self, now: float) -> str:
        """mm:ss for the in-progress turn (falls back to state age)."""
        base = self.turn_since if self.turn_since is not None else self.since
        total = max(0, int(now - base))
        return f"{total // 60}:{total % 60:02d}"

    @property
    def attention(self) -> str | None:
        """States that persist until acknowledged — the notification replacement.

        Background sessions never hold attention: they are internal progress
        the user cannot attend to directly (no tab to switch to), and their
        outcome surfaces through the parent session's own state.
        """
        if self.bg:
            return None
        return self.state if self.state in ("waiting", "done", "error") else None


def save_state(data: dict) -> None:
    try:
        os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
        merged = {}
        try:
            with open(STATE_FILE, encoding="utf-8") as f:
                merged = json.load(f)
        except (OSError, json.JSONDecodeError):
            pass
        merged.update(data)
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(merged, f)
    except OSError:
        pass


def load_saved_position() -> tuple[int, int, bool, bool]:
    """(margin_x, margin_y, anchor_right, anchor_bottom)."""
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return (
            int(data.get("margin_x", 16)),
            int(data.get("margin_y", 16)),
            bool(data.get("anchor_right", True)),
            bool(data.get("anchor_bottom", True)),
        )
    except (OSError, ValueError, json.JSONDecodeError):
        return 16, 16, True, True


class PetModel:
    """Aggregate of all connected sessions + display selection. GTK-thread only."""

    def __init__(self) -> None:
        self.sessions: dict[int, SessionView] = {}
        self.poke_bubbles: list[tuple[str, float]] = []  # (text, expiry)
        self.system_pids: dict[int, dict] = {}   # /proc-scanned omp processes
        self.panel_visible = False               # hover supervision panel
        self.mood = 0
        try:
            with open(STATE_FILE, encoding="utf-8") as f:
                self.mood = int(json.load(f).get("mood", 0))
        except (OSError, ValueError, json.JSONDecodeError):
            self.mood = 0

    # -- frame application (scheduled onto the GTK loop via idle_add) -------

    def apply_frame(self, conn_id: int, frame: dict) -> bool:
        kind = frame.get("t")
        if kind == "hello":
            view = SessionView(str(frame.get("session", "")), str(frame.get("proj", "")))
            try:
                view.pid = int(frame.get("pid") or 0) or None
            except (TypeError, ValueError):
                view.pid = None
            view.bg = bool(frame.get("bg", False))
            self.sessions[conn_id] = view
        elif kind == "state":
            view = self.sessions.get(conn_id)
            if view:
                was_terminal = view.state not in WORKING_STATES | {"waiting"}
                view.state = str(frame.get("s", "thinking"))
                view.tool = frame.get("tool")
                view.detail = frame.get("detail")
                now = time.monotonic()
                if frame.get("fresh") or (was_terminal and view.turn_since is None):
                    view.turn_since = now
                elif was_terminal:
                    view.turn_since = now
                if view.turn_since is None:
                    view.turn_since = now
                view.since = now
        elif kind == "settle":
            view = self.sessions.get(conn_id)
            if view:
                aborted = bool(frame.get("aborted", False))
                ok = bool(frame.get("ok", True))
                # An esc-abort is intentional — calm idle, not an alert pose.
                view.state = "aborted" if aborted else ("done" if ok else "error")
                view.since = time.monotonic()
        elif kind == "focus":
            # Terminal focus report (DEC 1004): the user switched back to
            # this session's tab/window and has seen the attention pose —
            # the per-session analogue of acknowledge_all's click.
            view = self.sessions.get(conn_id)
            if view and (view.attention or view.state == "aborted"):
                view.state = "idle"
                view.since = time.monotonic()
        elif kind == "bye":
            self.sessions.pop(conn_id, None)
        return False

    def drop_conn(self, conn_id: int) -> bool:
        self.sessions.pop(conn_id, None)
        return False

    def rescan(self) -> bool:
        """Poll /proc for running omp processes — read-only supervision."""
        self.system_pids = {proc["pid"]: proc for proc in scan_omp_processes()}
        return True

    def total_live(self) -> int:
        """Foreground session count for the ×N badge. Background views run
        inside their parent's process (task subagents) and must not inflate
        it; orphan background pids (print runs) still count as live work."""
        pids = set(self.system_pids)
        pids |= {v.pid for v in self.sessions.values() if v.pid and not v.bg}
        foreground = [v for v in self.sessions.values() if not v.bg]
        return max(len(pids), len(foreground))

    def supervision_rows(self) -> list[tuple[str, str, str, bool]]:
        """(glyph, label, detail, nested) rows for the hover panel.

        Foreground sessions sort by attention priority; background sessions
        (task subagents bridging from the same pid) nest under their parent.
        An orphan background session (print run, or its parent conn dropped)
        gets a top-level row marked 后台.
        """
        now = time.monotonic()
        foreground = [v for v in self.sessions.values() if not v.bg]
        background = [v for v in self.sessions.values() if v.bg]
        fg_by_pid = {v.pid: v for v in foreground if v.pid}
        children: dict[int, list[SessionView]] = {}
        orphans: list[SessionView] = []
        for view in background:
            parent = fg_by_pid.get(view.pid) if view.pid else None
            if parent is not None:
                children.setdefault(parent.pid, []).append(view)
            else:
                orphans.append(view)

        def row_for(view: SessionView, nested: bool) -> tuple[int, str, str, str, bool]:
            glyph = STATE_GLYPHS.get(view.state, "·")
            clock = view.clock(now)
            if view.state == "waiting" and view.tool == "ask":
                detail = f"等待回答 · {clock}"
            elif view.state in WORKING_STATES or view.state == "waiting":
                detail = f"{view.tool or STATE_LABELS.get(view.state, view.state)} · {clock}"
            elif view.state == "done":
                detail = "后台 · 完成" if nested else view.label
            elif view.state == "error":
                detail = "后台 · 出错" if nested else view.label
            elif view.state == "aborted":
                detail = "后台 · 中止" if nested else "空闲"
            else:
                detail = "空闲"
            if nested and (view.state in WORKING_STATES or view.state == "waiting"):
                detail = f"后台 · {detail}"
            prio = {"waiting": 0, "error": 1, "done": 2}.get(
                view.attention,
                3 if view.state in WORKING_STATES else 4,
            )
            return (prio, glyph, view.label, detail, nested)

        def prio_of(view: SessionView) -> int:
            return {"waiting": 0, "error": 1, "done": 2}.get(
                view.attention,
                3 if view.state in WORKING_STATES else 4,
            )

        rows: list[tuple[int, str, str, str, bool]] = []
        for view in sorted(foreground, key=prio_of):
            rows.append(row_for(view, False))
            for child in sorted(children.get(view.pid or -1, []), key=lambda v: -v.since):
                rows.append(row_for(child, True))
        for view in sorted(orphans, key=lambda v: -v.since):
            rows.append(row_for(view, True))
        bridged = {v.pid for v in self.sessions.values() if v.pid}
        for pid, proc in sorted(self.system_pids.items()):
            if pid not in bridged:
                rows.append((5, "○", f"pid {pid}", f"{proc['proj']} · 未桥接", False))
        return [(g, l, d, n) for _p, g, l, d, n in rows]

    def add_poke_bubble(self, text: str, ttl: float = 3.5) -> None:
        self.poke_bubbles.append((text, time.monotonic() + ttl))

    def mood_up(self) -> None:
        self.mood = min(100, self.mood + 1)
        save_state({"mood": self.mood})

    def acknowledge_all(self) -> None:
        """Click on an attention pose clears every settled/waiting highlight."""
        for view in self.sessions.values():
            if view.attention or view.state == "aborted":
                view.state = "idle"
                view.since = time.monotonic()

    # -- display selection ----------------------------------------------------

    def primary(self) -> tuple[str | None, SessionView | None]:
        """(attention_kind, view) for the thing worth showing right now."""
        now = time.monotonic()
        self.poke_bubbles = [(t, e) for (t, e) in self.poke_bubbles if e > now]
        views = list(self.sessions.values())
        if not views:
            return None, None
        prio = {"waiting": 0, "error": 1, "done": 2}
        attentive = sorted(
            (v for v in views if v.attention),
            key=lambda v: (prio[v.attention], -v.since),
        )
        if attentive:
            return attentive[0].attention, attentive[0]
        working = sorted(
            (v for v in views if v.state in WORKING_STATES and not v.bg),
            key=lambda v: -v.since,
        )
        if not working:
            # No foreground session is running — background work (a queued
            # task subagent, a print run) is still worth showing ambiently.
            working = sorted((v for v in views if v.state in WORKING_STATES), key=lambda v: -v.since)
        if working:
            return None, working[0]
        views.sort(key=lambda v: (v.bg, -v.since))
        return None, views[0]

    def live_count(self) -> int:
        return self.total_live()


# --------------------------------------------------------------------------
# Renderer


def rounded(ctx, x, y, w, h, r):  # noqa: ANN001
    ctx.new_sub_path()
    ctx.arc(x + w - r, y + r, r, -math.pi / 2, 0)
    ctx.arc(x + w - r, y + h - r, r, 0, math.pi / 2)
    ctx.arc(x + r, y + h - r, r, math.pi / 2, math.pi)
    ctx.arc(x + r, y + r, r, math.pi, 3 * math.pi / 2)
    ctx.close_path()


def speech_path(ctx, x, y, w, h, r, tail_x, tail_h=7.0, tail_w=13.0):  # noqa: ANN001
    """Rounded rect with a downward triangular tail. tail_x is relative to x."""
    r = min(r, w / 2.0, h / 2.0)
    tw = min(tail_w, w * 0.45)
    tx = min(max(tail_x, r + tw / 2.0), w - r - tw / 2.0)
    ctx.new_path()
    ctx.move_to(x + r, y)
    ctx.line_to(x + w - r, y)
    ctx.arc(x + w - r, y + r, r, -math.pi / 2, 0)
    ctx.line_to(x + w, y + h - r)
    ctx.arc(x + w - r, y + h - r, r, 0, math.pi / 2)
    ctx.line_to(x + tx + tw / 2.0, y + h)
    ctx.line_to(x + tx, y + h + tail_h)
    ctx.line_to(x + tx - tw / 2.0, y + h)
    ctx.line_to(x + r, y + h)
    ctx.arc(x + r, y + h - r, r, math.pi / 2, math.pi)
    ctx.line_to(x, y + r)
    ctx.arc(x + r, y + r, r, math.pi, 3 * math.pi / 2)
    ctx.close_path()


class PetArea(Gtk.DrawingArea):
    def __init__(self, model: PetModel, skin) -> None:
        super().__init__()
        self.model = model
        self.skin = skin
        self.last_state: str | None = None
        self.wiggle_until = 0.0
        self._input_region: cairo.Region | None = None
        # Input region cache: skip expensive silhouette render when pose+state unchanged
        self._region_cache: dict[tuple, cairo.Region] = {}
        self._last_region_key: tuple | None = None

    def tick(self) -> bool:
        on_tick = getattr(self.skin, "on_tick", None)
        if on_tick is not None:
            on_tick(time.monotonic())
        self.queue_render_if_gl()
        self.queue_draw()
        return True

    def queue_render_if_gl(self) -> None:
        parent = self.get_parent()
        if isinstance(parent, Gtk.GLArea):
            parent.queue_render()

    def wiggle(self) -> None:
        self.wiggle_until = time.monotonic() + 0.6

    def _text(self, ctx, text, x, y, size, color, align_center=False,
              align_right=False, bold=False, max_w=None):  # noqa: ANN001
        layout = PangoCairo.create_layout(ctx)
        desc = Pango.FontDescription()
        desc.set_size(int(size * Pango.SCALE))
        if bold:
            desc.set_weight(Pango.Weight.BOLD)
        layout.set_font_description(desc)
        layout.set_text(text, -1)
        if max_w:
            layout.set_width(int(max_w * Pango.SCALE))
            layout.set_ellipsize(Pango.EllipsizeMode.END)
        lw, _lh = layout.get_pixel_size()
        if align_center:
            px = x - lw / 2
        elif align_right:
            px = x - lw
        else:
            px = x
        ctx.set_source_rgba(*color)
        ctx.move_to(px, y)
        PangoCairo.show_layout(ctx, layout)

    def _layout(self, ctx, text, size, bold=False, max_w=None):  # noqa: ANN001
        layout = PangoCairo.create_layout(ctx)
        desc = Pango.FontDescription()
        desc.set_size(int(size * Pango.SCALE))
        if bold:
            desc.set_weight(Pango.Weight.BOLD)
        layout.set_font_description(desc)
        layout.set_text(text, -1)
        if max_w:
            layout.set_width(int(max_w * Pango.SCALE))
            layout.set_ellipsize(Pango.EllipsizeMode.END)
        lw, lh = layout.get_pixel_size()
        return layout, lw, lh

    def _count_chip_geom(self, w: int, h: int, n: int) -> tuple[float, float, float, float]:
        """Shoulder-anchored pill. Returns (x, y, bw, bh)."""
        nstr = "99+" if n > 99 else str(n)
        bw = 18.0 if len(nstr) == 1 else 10.0 + 7.0 * len(nstr)
        bh = 18.0
        cx, cy = w * 0.42, h * 0.60
        return cx + 16.0, cy - 44.0 - bh / 2.0, bw, bh

    def _draw_count_chip(self, ctx, w: int, h: int, n: int) -> None:  # noqa: ANN001
        x, y, bw, bh = self._count_chip_geom(w, h, n)
        nstr = "99+" if n > 99 else str(n)
        rr = bh / 2.0
        rounded(ctx, x + 0.7, y + 1.1, bw, bh, rr)
        ctx.set_source_rgba(0.0, 0.0, 0.0, 0.28)
        ctx.fill()
        rounded(ctx, x, y, bw, bh, rr)
        ctx.set_source_rgba(0.56, 0.40, 0.78, 0.95)
        ctx.fill_preserve()
        ctx.set_source_rgba(0.93, 0.91, 0.98, 0.42)
        ctx.set_line_width(1.0)
        ctx.stroke()
        layout, lw, lh = self._layout(ctx, nstr, 10.0, bold=True)
        ctx.set_source_rgba(*COL_BUBBLE_FG)
        ctx.move_to(x + (bw - lw) / 2.0, y + (bh - lh) / 2.0 - 0.5)
        PangoCairo.show_layout(ctx, layout)

    def _toast_spec(self, state: str, view) -> tuple[str, str, str, tuple] | None:
        if state == "done":
            return "完成", (view.label if view else ""), "✓", COL_OK
        if state == "error":
            return "出错", (view.label if view else ""), "!", COL_ERR
        if state == "waiting":
            asking = view is not None and view.tool == "ask"
            title = "等待回答" if asking else "等待审批"
            return title, "", "?", COL_ASK
        return None

    def _toast_geom(self, ctx, w: int, h: int, title: str, subtitle: str):  # noqa: ANN001
        disc, gap, pad_x, pad_y = 16.0, 7.0, 8.0, 6.5
        title_l, tw, th = self._layout(ctx, title, 11.0, bold=True, max_w=128)
        sub_l, sw, sh = (None, 0.0, 0.0)
        if subtitle:
            sub_l, sw, sh = self._layout(ctx, subtitle, 9.0, max_w=128)
        text_w = max(tw, sw)
        text_h = th + (2.5 + sh if subtitle else 0.0)
        bw = pad_x + disc + gap + text_w + pad_x
        bh = pad_y + max(disc, text_h) + pad_y
        tail_h = 7.0
        cx, cy = w * 0.42, h * 0.60
        tip_x, tip_y = cx + 16.0, cy - 64.0
        bx = min(max(tip_x - 20.0, 4.0), max(w - bw - 4.0, 4.0))
        by = max(tip_y - tail_h - bh, 3.0)
        tail_x = min(max(tip_x - bx, 14.0), bw - 14.0)
        return bx, by, bw, bh, tail_x, tail_h, title_l, sub_l, disc, gap, pad_x, pad_y, tw, th, sw, sh

    def _draw_toast(self, ctx, w: int, h: int, title: str, subtitle: str,
                    glyph: str, color: tuple, t: float, pulse: bool) -> None:  # noqa: ANN001
        (bx, by, bw, bh, tail_x, tail_h, title_l, sub_l, disc, gap,
         pad_x, pad_y, tw, th, _sw, sh) = self._toast_geom(ctx, w, h, title, subtitle)
        glow = 0.62 + 0.38 * (0.5 + 0.5 * math.sin(t * 5.2)) if pulse else 1.0
        speech_path(ctx, bx + 1.0, by + 1.6, bw, bh, 10.0, tail_x, tail_h)
        ctx.set_source_rgba(0.0, 0.0, 0.0, 0.30)
        ctx.fill()
        speech_path(ctx, bx, by, bw, bh, 10.0, tail_x, tail_h)
        ctx.set_source_rgba(0.10, 0.08, 0.15, 0.90)
        ctx.fill_preserve()
        ctx.set_source_rgba(color[0], color[1], color[2], 0.38 + 0.34 * glow)
        ctx.set_line_width(1.0)
        ctx.stroke()
        dx = bx + pad_x + disc / 2.0
        dy = by + bh / 2.0
        ctx.arc(dx, dy, disc / 2.0, 0, 2 * math.pi)
        ctx.set_source_rgba(color[0], color[1], color[2], 0.50 + 0.50 * glow)
        ctx.fill()
        g_l, gw, gh = self._layout(ctx, glyph, 9.5, bold=True)
        ctx.set_source_rgba(1.0, 1.0, 1.0, 0.96)
        ctx.move_to(dx - gw / 2.0, dy - gh / 2.0 - 0.4)
        PangoCairo.show_layout(ctx, g_l)
        tx = bx + pad_x + disc + gap
        ty = by + (bh - (th + (2.5 + sh if sub_l is not None else 0.0))) / 2.0
        ctx.set_source_rgba(*COL_BUBBLE_FG)
        ctx.move_to(tx, ty)
        PangoCairo.show_layout(ctx, title_l)
        if sub_l is not None:
            ctx.set_source_rgba(*COL_DIM)
            ctx.move_to(tx, ty + th + 2.5)
            PangoCairo.show_layout(ctx, sub_l)

    def _speech_geom(self, ctx, w: int, h: int, text: str, ay: float):  # noqa: ANN001
        layout, tw, th = self._layout(ctx, text, 10.5, bold=True, max_w=140)
        pad_x, pad_y, tail_h = 8.0, 5.0, 6.0
        bw, bh = tw + pad_x * 2, th + pad_y * 2
        cx = w * 0.42
        bx = min(max(cx + 8.0, 4.0), max(w - bw - 4.0, 4.0))
        by = max(ay - bh - tail_h, 4.0)
        tail_x = min(max(cx + 12.0 - bx, 12.0), bw - 12.0)
        return bx, by, bw, bh, tail_x, tail_h, layout, pad_x, pad_y

    def _draw_speech(self, ctx, w: int, h: int, text: str, ay: float,
                     color: tuple) -> None:  # noqa: ANN001
        bx, by, bw, bh, tail_x, tail_h, layout, pad_x, pad_y = self._speech_geom(
            ctx, w, h, text, ay)
        speech_path(ctx, bx + 0.8, by + 1.3, bw, bh, 8.0, tail_x, tail_h)
        ctx.set_source_rgba(0.0, 0.0, 0.0, 0.25)
        ctx.fill()
        speech_path(ctx, bx, by, bw, bh, 8.0, tail_x, tail_h)
        ctx.set_source_rgba(0.10, 0.08, 0.15, 0.88)
        ctx.fill_preserve()
        ctx.set_source_rgba(color[0], color[1], color[2], 0.50)
        ctx.set_line_width(1.0)
        ctx.stroke()
        ctx.set_source_rgba(*COL_BUBBLE_FG)
        ctx.move_to(bx + pad_x, by + pad_y)
        PangoCairo.show_layout(ctx, layout)

    def _draw_panel(self, ctx, w: int, h: int) -> None:  # noqa: ANN001
        rows = self.model.supervision_rows()
        pad = 6.0
        max_visible = 8
        total_rows = len(rows)
        # Scrollable panel: show up to max_visible rows with overflow indicator
        visible_rows = rows[:max_visible]
        has_overflow = total_rows > max_visible
        
        ph = 30.0 + 16.0 * len(visible_rows) + (14.0 if has_overflow else 0.0) + pad
        rounded(ctx, pad, pad, w - pad * 2, min(ph, h - pad * 2), 10)
        ctx.set_source_rgba(0.08, 0.07, 0.12, 0.93)
        ctx.fill_preserve()
        ctx.set_source_rgba(*COL_OUTLINE)
        ctx.set_line_width(1.2)
        ctx.stroke()
        total = self.model.total_live()
        self._text(ctx, f"会话监管 · {total}", w / 2, 12, 11.5, COL_BUBBLE_FG,
                   align_center=True, bold=True)
        y = 34.0
        for glyph, label, detail, nested in visible_rows:
            color = COL_OK if glyph == "✓" else COL_ERR if glyph == "✗" else (
                COL_ASK if glyph == "?" else COL_DIM
            )
            if nested:
                self._text(ctx, "↳", 22, y, 10.5, COL_DIM)
                self._text(ctx, label, 40, y, 10.5, COL_DIM, max_w=w * 0.36)
            else:
                self._text(ctx, glyph, 14, y, 10.5, color)
                self._text(ctx, label, 32, y, 10.5, COL_BUBBLE_FG, max_w=w * 0.40)
            self._text(ctx, detail, w - 14, y, 9.5, COL_DIM,
                       align_right=True, max_w=w * 0.44)
            y += 16.0
        
        if has_overflow:
            # Overflow indicator: dimmed "+" with count
            overflow_count = total_rows - max_visible
            self._text(ctx, f"+ {overflow_count} 更多…", w / 2, y, 9.5, COL_DIM,
                       align_center=True)

    def draw_overlay(self, _area, ctx, w: int, h: int, _data=None) -> None:  # noqa: ANN001
        """Chrome-only draw func for the GtkOverlay layer above a GL body."""
        t = time.monotonic()
        attention, view = self.model.primary()
        state = attention or (view.state if view else "idle")
        sleeping = state in ("idle", "aborted") and (
            view is None or t - view.since > IDLE_SLEEP_S
        )
        panel_open = self.model.panel_visible or bool(os.environ.get("OMP_PET_PANEL"))
        self.draw_chrome(ctx, w, h, t, state, view, sleeping, panel_open)
        self._publish_input_region(w, h, t, state, {}, view, sleeping, panel_open)

    def on_draw(self, _area, ctx, w: int, h: int) -> None:  # noqa: ANN001
        t = time.monotonic()
        attention, view = self.model.primary()
        state = attention or (view.state if view else "idle")
        panel_open = self.model.panel_visible or bool(os.environ.get("OMP_PET_PANEL"))
        sleeping = state in ("idle", "aborted") and (
            view is None or t - view.since > IDLE_SLEEP_S
        )

        pose: dict = {}

        if sleeping:
            pose.update(mouth="w", blink=True)
        elif state == "done":
            hop = abs(math.sin(t * 5.0))
            pose.update(jump=14 * hop, happy=True, blush=True, mouth="smile",
                        tail_speed=9.0, tail_amp=22.0, squish=1.0 - 0.06 * hop)
        elif state == "error":
            pose.update(dizzy=True, mouth="o", tail_speed=1.0, tail_amp=4.0,
                        tilt=0.08 * math.sin(t * 10))
        elif state == "waiting":
            pose.update(look=(0.0, -2.5), mouth="o", tail_speed=1.2, tail_amp=6.0)
        elif state == "retry":
            pose.update(mouth="w", tail_speed=3.0, tail_amp=10.0,
                        tilt=0.05 * math.sin(t * 12))
        elif state == "compact":
            pose.update(mouth="o", look=(3.0, 2.0), tail_speed=2.0, tail_amp=8.0)
        elif state == "tool":
            pose.update(look=(2.5, -1.5), tail_speed=4.5, tail_amp=14.0,
                        tilt=0.03 * math.sin(t * 8))
        elif state == "thinking":
            pose.update(look=(-2.5, -2.5), tap=True, tail_speed=2.0, tail_amp=8.0)
        else:  # plain awake idle
            pose.update(tail_speed=2.2, tail_amp=16.0)

        if t < self.wiggle_until:
            pose["tilt"] = pose.get("tilt", 0.0) + 0.12 * math.sin((self.wiggle_until - t) * 25)

        if state != self.last_state:
            on_state = getattr(self.skin, "on_state", None)
            if on_state is not None:
                on_state(state)
            self.last_state = state
        self.skin.draw_body(ctx, w, h, t, state, pose, max(1, int(self.get_scale_factor())))

        self.draw_chrome(ctx, w, h, t, state, view, sleeping, panel_open)
        self._publish_input_region(w, h, t, state, pose, view, sleeping, panel_open)

    def draw_chrome(self, ctx, w: int, h: int, t: float, state: str,
                    view, sleeping: bool, panel_open: bool) -> None:  # noqa: ANN001
        if sleeping:  # floating zzz
            cx = w * 0.42
            cy = h * 0.58
            for i in range(3):
                ph = (t * 0.5 + i * 0.33) % 1.0
                zx = cx + 40 + 14 * ph
                zy = cy - 46 - 26 * ph
                dim = (*COL_DIM[:3], (1.0 - ph) * 0.8)
                self._text(ctx, "z" * (i % 2 + 1), zx, zy, 11 + i * 2, dim)

        # status line under the cat (suppressed while the panel is open);
        # attention states use the toast instead of repeating the same line.
        if not panel_open and view and state in WORKING_STATES:
            line = view.tool or STATE_LABELS.get(view.state, view.state)
            self._text(ctx, f"{line} · {view.clock(t)}",
                       w / 2, h - 34, 10.5, COL_DIM, align_center=True, max_w=w - 16)
            if view.detail and state == "tool":
                self._text(ctx, view.detail, w / 2, h - 20, 9.0, COL_DIM,
                           align_center=True, max_w=w - 16)
        elif sleeping and not panel_open:
            self._text(ctx, "zzz… 有任务会叫醒我", w / 2, h - 24, 9.5, COL_DIM,
                       align_center=True, max_w=w - 16)

        if not panel_open:
            spec = self._toast_spec(state, view)
            if spec is not None:
                title, subtitle, glyph, color = spec
                self._draw_toast(ctx, w, h, title, subtitle, glyph, color, t, True)
            poke_ay = 70.0 if spec is not None else 58.0
            for text, _exp in self.model.poke_bubbles:
                self._draw_speech(ctx, w, h, text, poke_ay, COL_OK)
                poke_ay += 22.0
            n = self.model.total_live()
            if n > 1:
                self._draw_count_chip(ctx, w, h, n)

        if panel_open:
            self._draw_panel(ctx, w, h)

    def _scratch_ctx(self):
        ctx = getattr(self, "_scratch_cr", None)
        if ctx is None:
            self._scratch_surf = cairo.ImageSurface(cairo.Format.ARGB32, 8, 8)
            self._scratch_cr = cairo.Context(self._scratch_surf)
            ctx = self._scratch_cr
        return ctx

    def _chrome_hit_rects(self, w: int, h: int, t: float, state: str,  # noqa: ARG002
                          view, sleeping: bool, panel_open: bool) -> list[tuple[float, float, float, float]]:
        """Window-local rects for toasts / chip / status — not the hover panel."""
        rects: list[tuple[float, float, float, float]] = []
        cr = self._scratch_ctx()
        if not panel_open and view and state in WORKING_STATES:
            band = 36.0 if (view.detail and state == "tool") else 22.0
            sw = min(w - 16.0, 140.0)
            rects.append(((w - sw) / 2, h - 40.0, sw, band))
        elif sleeping and not panel_open:
            sw = min(w - 16.0, 140.0)
            rects.append(((w - sw) / 2, h - 30.0, sw, 18.0))
        if panel_open:
            return rects
        spec = self._toast_spec(state, view)
        if spec is not None:
            title, subtitle, _g, _c = spec
            bx, by, bw, bh, _tx, tail_h, *_rest = self._toast_geom(cr, w, h, title, subtitle)
            rects.append((bx, by, bw, bh + tail_h))
        poke_ay = 70.0 if spec is not None else 58.0
        for text, _exp in self.model.poke_bubbles:
            bx, by, bw, bh, _tx, tail_h, *_r = self._speech_geom(cr, w, h, text, poke_ay)
            rects.append((bx, by, bw, bh + tail_h))
            poke_ay += 22.0
        n = self.model.total_live()
        if n > 1:
            rects.append(self._count_chip_geom(w, h, n))
        return rects

    @staticmethod
    def _dilate_region(region: cairo.Region, pad: int) -> cairo.Region:
        if pad <= 0:
            return region
        out = region.copy()
        for dx, dy in (
            (-pad, 0), (pad, 0), (0, -pad), (0, pad),
            (-pad, -pad), (-pad, pad), (pad, -pad), (pad, pad),
        ):
            extra = region.copy()
            extra.translate(dx, dy)
            out.union(extra)
        return out

    def _region_cache_key(self, state: str, pose: dict, panel_open: bool) -> tuple:
        """Cache key for input region — covers all params that affect silhouette."""
        return (
            state,
            pose.get("jump", 0.0),
            pose.get("squish", 1.0),
            pose.get("tilt", 0.0),
            panel_open,
        )

    def _silhouette_region(self, w: int, h: int, t: float, state: str,
                           pose: dict, view, sleeping: bool,
                           panel_open: bool) -> cairo.Region:
        cache_key = self._region_cache_key(state, pose, panel_open)
        if cache_key in self._region_cache:
            return self._region_cache[cache_key]
        
        mw, mh = max(1, int(w)), max(1, int(h))
        mask = cairo.ImageSurface(cairo.Format.ARGB32, mw, mh)
        mctx = cairo.Context(mask)
        paint = getattr(self.skin, "paint_hit_mask", self.skin.draw_body)
        try:
            paint(mctx, w, h, t, state, pose, max(1, int(self.get_scale_factor())))
        except TypeError:
            paint(mctx, w, h, t, state, pose)
        mctx.set_source_rgba(0, 0, 0, 1)
        for x, y, rw, rh in self._chrome_hit_rects(w, h, t, state, view, sleeping, panel_open):
            mctx.rectangle(x, y, rw, rh)
            mctx.fill()
        region = Gdk.cairo_region_create_from_surface(mask)
        if os.environ.get("PET_HIT_DUMP") and not getattr(self, "_hit_dumped", False):
            mask.write_to_png("/tmp/pet-hitmask.png")
            ext = region.get_extents()
            corners = {
                "TL": region.contains_point(2, 2),
                "TR": region.contains_point(mw - 3, 2),
                "BL": region.contains_point(2, mh - 3),
                "BR": region.contains_point(mw - 3, mh - 3),
                "body": region.contains_point(int(w * 0.42), int(h * 0.60)),
            }
            print(f"[hit] rects={region.num_rectangles()} "
                  f"ext={ext.x},{ext.y} {ext.width}x{ext.height} win={mw}x{mh} "
                  f"corners={corners}",
                  flush=True)
            self._hit_dumped = True
        dilated = self._dilate_region(region, HIT_PAD)
        
        # Cache with size limit (prevent unbounded growth from pose variations)
        if len(self._region_cache) > 32:
            self._region_cache.clear()
        self._region_cache[cache_key] = dilated
        return dilated

    def _publish_input_region(self, w: int, h: int, t: float, state: str,
                              pose: dict, view, sleeping: bool,
                              panel_open: bool) -> None:
        """Wayland wl_surface input region: empty pixels click through.

        Hovering the silhouette opens the panel; leaving it hides the panel.
        The panel itself is not added to the hit region — otherwise moving
        off the character onto the overlay would keep the pointer captured.
        Drag and the right-click menu still take the whole window so the
        gesture/popover cannot lose the pointer. Wayland cannot do
        hover-without-click: clicks on the silhouette still land here.
        """
        native = self.get_native()
        if native is None:
            return
        surface = native.get_surface()
        if surface is None:
            return
        mw, mh = max(1, int(w)), max(1, int(h))
        dragging = bool(getattr(native, "_drag_active", False))
        menu = getattr(native, "_menu", None)
        menu_open = bool(menu is not None and menu.get_visible())
        if dragging or menu_open:
            region = cairo.Region(cairo.RectangleInt(0, 0, mw, mh))
        else:
            region = self._silhouette_region(
                w, h, t, state, pose, view, sleeping, panel_open)
        if self._input_region is not None and self._input_region.equal(region):
            return
        self._input_region = region
        surface.set_input_region(region)


# --------------------------------------------------------------------------
# Window


class PetWindow(Gtk.Window):
    def __init__(self, model: PetModel, skin, margin_x: int, margin_y: int,
                 anchor_right: bool = True, anchor_bottom: bool = True,
                 on_quit: Callable[[], None] | None = None) -> None:
        super().__init__(title="omp pet")
        self.on_quit = on_quit
        self._menu: Gtk.PopoverMenu | None = None
        self.skin = skin
        self.model = model
        self.margin_x = margin_x
        self.margin_y = margin_y
        self.anchor_right = anchor_right
        self.anchor_bottom = anchor_bottom
        self.pos: list[float] | None = None  # authoritative top-left, screen coords
        self.set_default_size(WIN_W, WIN_H)
        self._drag_active = False
        self._drag_moved = False
        self._make_transparent()

        self.area = PetArea(model, skin)
        if skin.needs_gl:
            gl = Gtk.GLArea()
            try:
                gl.set_use_alpha(True)
            except AttributeError:
                pass
            gl.connect("realize", self.on_gl_realize)
            gl.connect("render", self.on_gl_render)
            self._gl = gl
            overlay = Gtk.Overlay()
            overlay.set_child(gl)
            self.area.set_draw_func(self.area.draw_overlay)
            overlay.add_overlay(self.area)
            self.set_child(overlay)
        else:
            self.set_child(self.area)

        click = Gtk.GestureClick()
        click.set_button(1)
        click.connect("pressed", self.on_press)
        click.connect("released", self.on_release)
        self.area.add_controller(click)

        drag = Gtk.GestureDrag()
        drag.set_button(1)
        drag.connect("drag-update", self.on_drag_update)
        self.area.add_controller(drag)

        motion = Gtk.EventControllerMotion()
        motion.connect("enter", self.on_hover_enter)
        motion.connect("leave", self.on_hover_leave)
        self.area.add_controller(motion)

        right_click = Gtk.GestureClick()
        right_click.set_button(3)
        right_click.connect("pressed", self.on_right_press)
        self.area.add_controller(right_click)

        # Plain Gtk.Window carries no action map in GTK4 — expose the quit
        # action through a widget-level group so the popover's "win.quit"
        # item resolves via the ancestor chain.
        self._actions = Gio.SimpleActionGroup()
        self.quit_action = Gio.SimpleAction.new("quit", None)
        self.quit_action.connect("activate", lambda *_a: self._request_quit())
        self._actions.add_action(self.quit_action)
        self.insert_action_group("win", self._actions)

        LayerShell.init_for_window(self)
        LayerShell.set_layer(self, LayerShell.Layer.TOP)
        LayerShell.set_keyboard_mode(self, LayerShell.KeyboardMode.NONE)
        LayerShell.set_namespace(self, "omp-pet")
        self.apply_layout()

    def on_gl_realize(self, area: Gtk.GLArea) -> None:  # noqa: ANN001
        area.make_current()
        gl_init = getattr(self.skin, "gl_init", None)
        if gl_init is not None:
            gl_init()
        on_resize = getattr(self.skin, "resize", None)
        if on_resize is not None:
            on_resize(area.get_allocated_width(), area.get_allocated_height())

    def on_gl_render(self, area: Gtk.GLArea, _ctx) -> bool:  # noqa: ANN001
        w, h = area.get_allocated_width(), area.get_allocated_height()
        on_resize = getattr(self.skin, "resize", None)
        if on_resize is not None and (w, h) != getattr(self, "_gl_size", None):
            self._gl_size = (w, h)
            on_resize(w, h)
        draw_gl = getattr(self.skin, "draw_gl", None)
        if draw_gl is not None:
            draw_gl()
        return True

    def _make_transparent(self) -> None:
        """Kill the themed window background — the pet floats on the desktop."""
        self.add_css_class("pet-window")
        provider = Gtk.CssProvider()
        provider.load_from_string(".pet-window { background-color: transparent; }")
        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default(),
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
        )

    def _monitor_size(self) -> tuple[int, int]:
        try:
            disp = Gdk.Display.get_default()
            surf = self.get_surface()
            mon = disp.get_monitor_at_surface(surf) if surf else None
            if mon is None:
                monitors = disp.get_monitors()
                mon = monitors.get_item(0) if monitors.get_n_items() else None
            geo = mon.get_geometry()
            return geo.width, geo.height
        except AttributeError:
            return 1920, 1080

    def _ensure_pos(self) -> None:
        """Derive self.pos from saved margins once, then clamp fully onscreen."""
        if self.pos is None:
            sw, sh = self._monitor_size()
            self.pos = [
                float(sw - WIN_W - self.margin_x if self.anchor_right else self.margin_x),
                float(sh - WIN_H - self.margin_y if self.anchor_bottom else self.margin_y),
            ]
        sw, sh = self._monitor_size()
        self.pos[0] = min(max(self.pos[0], 4.0), max(sw - WIN_W - 4.0, 4.0))
        self.pos[1] = min(max(self.pos[1], 4.0), max(sh - WIN_H - 4.0, 4.0))

    def _push_margins(self) -> None:
        """Express self.pos through the CURRENT anchor pair. wlr-layer-shell
        margins are measured from ANCHORED edges only — write the matching
        pair or left/top placement snaps flush to the edge."""
        sw, sh = self._monitor_size()
        ax, ay = self.pos
        self.margin_x = int(sw - WIN_W - ax) if self.anchor_right else int(ax)
        self.margin_y = int(sh - WIN_H - ay) if self.anchor_bottom else int(ay)
        LayerShell.set_margin(self, LayerShell.Edge.LEFT,
                              0 if self.anchor_right else self.margin_x)
        LayerShell.set_margin(self, LayerShell.Edge.RIGHT,
                              self.margin_x if self.anchor_right else 0)
        LayerShell.set_margin(self, LayerShell.Edge.TOP,
                              0 if self.anchor_bottom else self.margin_y)
        LayerShell.set_margin(self, LayerShell.Edge.BOTTOM,
                              self.margin_y if self.anchor_bottom else 0)

    def place(self) -> None:
        """Drag-time placement: margins ONLY, anchors untouched. Flipping
        anchors mid-gesture makes the compositor re-place the surface under
        the grabbed pointer, which corrupts all later surface-local offsets
        (that is why one long drag used to die at the screen midpoint)."""
        self._ensure_pos()
        self._push_margins()

    def apply_layout(self) -> None:
        """Full (re)placement: choose the NEAREST anchor edges for self.pos —
        margins stay small and the pet can never sit half-offscreen."""
        self._ensure_pos()
        sw, sh = self._monitor_size()
        ax, ay = self.pos
        self.anchor_right = ax > (sw - WIN_W) // 2
        self.anchor_bottom = ay > (sh - WIN_H) // 2
        LayerShell.set_anchor(self, LayerShell.Edge.LEFT, not self.anchor_right)
        LayerShell.set_anchor(self, LayerShell.Edge.RIGHT, self.anchor_right)
        LayerShell.set_anchor(self, LayerShell.Edge.TOP, not self.anchor_bottom)
        LayerShell.set_anchor(self, LayerShell.Edge.BOTTOM, self.anchor_bottom)
        self._push_margins()

    def on_drag_update(self, _gesture, dx: float, dy: float) -> None:
        """Wayland gives no global pointer position: GestureDrag offsets are
        WINDOW-RELATIVE, offset = (P-P0) - (W-W0). Adding the CUMULATIVE offset
        to the current window position each update is the closed loop — it
        re-measures against wherever the window actually is, so it tracks
        exactly and self-corrects compositor lag. (Delta-stepping half-speeds:
        every move cancels the previous one; absolute rebasing lags unboundedly
        — both were tried and rejected.)"""
        if not self._drag_active:
            return
        # HiDPI-aware deadzone: scale with device pixel ratio
        scale = max(1, int(self.area.get_scale_factor()))
        deadzone = 6 * scale
        if abs(dx) + abs(dy) < deadzone:
            return  # deadzone keeps click-vs-drag discrimination stable
        self._drag_moved = True
        self.pos[0] += dx
        self.pos[1] += dy
        self.place()


    def on_release(self, _gesture, *_a) -> None:  # noqa: ANN001
        was_drag = self._drag_moved
        self._drag_active = False
        if was_drag:
            self.apply_layout()  # re-anchor to nearest edges, then persist once
            self.save_position()
            self.area.queue_draw()  # drop full-window capture immediately
            return
        attention, _view = self.model.primary()
        if attention in ("done", "error"):
            self.model.acknowledge_all()
            return
        self.model.mood_up()
        self.model.add_poke_bubble(random.choice(REACTIONS["pet"]))
        self.area.wiggle()

    def on_right_press(self, _gesture, _n_press: int, x: float, y: float) -> None:  # noqa: ANN001
        """Right-click opens the pet context menu at the pointer."""
        if self._menu is None:
            menu_model = Gio.Menu()
            menu_model.append("退出", "win.quit")
            self._menu = Gtk.PopoverMenu.new_from_model(menu_model)
            self._menu.set_has_arrow(False)
            self._menu.set_parent(self.area)
            self._menu.connect("closed", lambda *_a: self.area.queue_draw())
        rect = Gdk.Rectangle()
        rect.x, rect.y, rect.width, rect.height = int(x), int(y), 1, 1
        self._menu.set_pointing_to(rect)
        self._menu.popup()
        self.area.queue_draw()

    def _request_quit(self) -> None:
        if self.on_quit is not None:
            self.on_quit()
        else:
            self.destroy()


# --------------------------------------------------------------------------
# IPC server (asyncio in a worker thread; UI hops via GLib.idle_add)


class IpcServer:
    def __init__(self, model: PetModel, socket_path: str, area: PetArea,
                 on_fatal) -> None:  # noqa: ANN001
        self.model = model
        self.socket_path = socket_path
        self.area = area
        self.on_fatal = on_fatal
        self.conn_counter = 0
        # Track malformed frames per connection: disconnect after threshold
        self.conn_errors: dict[int, int] = {}

    async def serve(self) -> None:
        try:
            if os.path.exists(self.socket_path):
                # A CONNECTABLE socket means a live pet owns it — exit quietly
                # instead of stealing the endpoint (single-instance guard).
                # Refusing connection = stale file from a crashed instance.
                try:
                    await asyncio.wait_for(
                        asyncio.open_unix_connection(self.socket_path), timeout=1.0)
                    print("omp-pet: already running; exiting", flush=True)
                    # Deterministic single-instance exit: the duplicate has no
                    # state worth saving and the GTK teardown race is not worth
                    # solving — vanish immediately, leave the first pet alone.
                    os._exit(0)
                except (ConnectionRefusedError, FileNotFoundError,
                        asyncio.TimeoutError, OSError):
                    os.unlink(self.socket_path)
            server = await asyncio.start_unix_server(self.handle, path=self.socket_path)
            os.chmod(self.socket_path, 0o600)
            print(f"omp-pet: listening on {self.socket_path}", flush=True)
            async with server:
                await server.serve_forever()
        except OSError as exc:
            print(f"omp-pet: cannot listen on {self.socket_path}: {exc}", file=sys.stderr)
            GLib.idle_add(self.on_fatal)
        except asyncio.CancelledError:
            pass

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self.conn_counter += 1
        conn_id = self.conn_counter
        buffer = b""
        malformed_threshold = 10
        try:
            while True:
                chunk = await reader.read(4096)
                if not chunk:
                    break
                buffer += chunk
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    if not line.strip():
                        continue
                    try:
                        frame = json.loads(line.decode("utf-8"))
                    except json.JSONDecodeError:
                        # Track malformed frames; disconnect if threshold exceeded
                        self.conn_errors[conn_id] = self.conn_errors.get(conn_id, 0) + 1
                        if self.conn_errors[conn_id] >= malformed_threshold:
                            print(f"omp-pet: conn {conn_id} exceeded malformed frame limit, disconnecting",
                                  file=sys.stderr, flush=True)
                            break
                        continue
                    if frame.get("t") == "poke":
                        await self.dispatch_poke(frame, writer)
                    else:
                        GLib.idle_add(self.model.apply_frame, conn_id, frame)
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
            self.conn_errors.pop(conn_id, None)
            GLib.idle_add(self.model.drop_conn, conn_id)
            try:
                writer.close()
            except ConnectionError:
                pass

    async def dispatch_poke(self, frame: dict, writer: asyncio.StreamWriter) -> None:
        kind = frame.get("kind", "pet")
        if kind not in REACTIONS:
            kind = "pet"
        reaction = random.choice(REACTIONS[kind])
        GLib.idle_add(self.poke_effects, reaction)
        reply = json.dumps({"t": "poked", "id": frame.get("id"), "reaction": reaction}) + "\n"
        writer.write(reply.encode("utf-8"))
        await writer.drain()

    def poke_effects(self, reaction: str) -> bool:
        self.model.add_poke_bubble(reaction)
        self.model.mood_up()
        self.area.wiggle()
        return False


async def replay_frames(model: PetModel, path: str) -> None:
    """Feed a JSONL script of [delay_s, frame] rows through the real model path."""
    conn_id = 999
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            delay, frame = json.loads(line)
            await asyncio.sleep(delay)
            GLib.idle_add(model.apply_frame, conn_id, frame)


# --------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description="omp desktop pet")
    parser.add_argument("--socket", default=default_socket_path())
    parser.add_argument("--margin-x", type=int, default=None)
    parser.add_argument("--margin-y", type=int, default=None)
    parser.add_argument("--replay", help="JSONL file of [delay_s, frame] rows (testing)")
    parser.add_argument(
        "--skin",
        default=None,
        help="cat | image:<png> | frames:<dir> | live2d:<model-dir>",
    )
    args = parser.parse_args()

    mx, my, aright, abottom = load_saved_position()
    if args.margin_x is not None:
        mx = args.margin_x
    if args.margin_y is not None:
        my = args.margin_y

    model = PetModel()
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            saved_skin = json.load(f).get("skin", "cat")
    except (OSError, json.JSONDecodeError):
        saved_skin = "cat"
    spec = args.skin or str(saved_skin) or "cat"
    skin, notice = skins.create_skin(spec)
    if notice:
        print(f"omp-pet: {notice}", file=sys.stderr, flush=True)
        spec = "cat"
    save_state({"skin": spec})

    loop = GLib.MainLoop()

    def request_quit() -> None:
        # Menu 退出 shares the SIGTERM path: break the GLib loop; the IPC thread
        # is daemonized and dies with the process. A stale socket is fine — the
        # single-instance guard unlinks it on next start.
        loop.quit()

    win = PetWindow(model, skin, mx, my, aright, abottom, on_quit=request_quit)
    model.rescan()
    GLib.timeout_add_seconds(3, model.rescan)

    def on_fatal() -> bool:
        loop.quit()
        return False

    ipc = IpcServer(model, args.socket, win.area, on_fatal)

    def run_ipc() -> None:
        runner = asyncio.new_event_loop()
        asyncio.set_event_loop(runner)
        if args.replay:
            runner.create_task(replay_frames(model, args.replay))
        else:
            runner.create_task(ipc.serve())
        runner.run_forever()

    threading.Thread(target=run_ipc, name="omp-pet-ipc", daemon=True).start()

    def shutdown(_sig, _frame):  # noqa: ANN001
        loop.quit()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    win.present()
    loop.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
