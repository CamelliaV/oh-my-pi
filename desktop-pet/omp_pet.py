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
  - attention states are PERSISTENT until clicked or superseded:
      settle ok   → celebrate ("✓ 完成")   — replaces completion notify
      settle err  → alert    ("✗ 出错")     — replaces error notify
      waiting     → ask      ("? 等待审批") — replaces ask notify
  - idle long enough → sleep pose with floating zzz.

Interaction:
  click = acknowledge attention / pet the cat   drag = move (re-anchors)
  right-click = context menu → 退出 (quit the daemon)
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

import gi

gi.require_version("Gdk", "4.0")
gi.require_version("Gtk", "4.0")
gi.require_version("Gtk4LayerShell", "1.0")
from gi.repository import Gdk, GLib, Gio, Gtk, Pango, PangoCairo  # noqa: E402
from gi.repository import Gtk4LayerShell as LayerShell  # noqa: E402

import skins  # local: pet skin plugins (same directory)

WIN_W, WIN_H = 240, 230
FPS_MS = 80  # ~12fps — plenty for wag/blink/bubble pulse
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
        self.since = time.monotonic()        # age of current state frame
        self.turn_since: float | None = None  # start of the RUNNING TURN

    def clock(self, now: float) -> str:
        """mm:ss for the in-progress turn (falls back to state age)."""
        base = self.turn_since if self.turn_since is not None else self.since
        total = max(0, int(now - base))
        return f"{total // 60}:{total % 60:02d}"

    @property
    def attention(self) -> str | None:
        """States that persist until acknowledged — the notification replacement."""
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
        pids = set(self.system_pids)
        pids |= {v.pid for v in self.sessions.values() if v.pid}
        return max(len(pids), len(self.sessions))

    def supervision_rows(self) -> list[tuple[str, str, str]]:
        """(glyph, label, detail) per session, bridged first then /proc-only."""
        now = time.monotonic()
        rows: list[tuple[int, str, str, str]] = []
        bridged: set[int] = set()
        for view in self.sessions.values():
            if view.pid:
                bridged.add(view.pid)
            glyph = STATE_GLYPHS.get(view.state, "·")
            clock = view.clock(now)
            if view.state == "waiting" and view.tool == "ask":
                detail = f"等待回答 · {clock}"
            elif view.state in WORKING_STATES or view.state == "waiting":
                detail = f"{view.tool or STATE_LABELS.get(view.state, view.state)} · {clock}"
            elif view.state in ("done", "error"):
                detail = view.label
            else:
                detail = "空闲"
            prio = {"waiting": 0, "error": 1, "done": 2}.get(
                view.attention,
                3 if view.state in WORKING_STATES else 4,
            )
            rows.append((prio, glyph, view.label, detail))
        for pid, proc in sorted(self.system_pids.items()):
            if pid not in bridged:
                rows.append((5, "○", f"pid {pid}", f"{proc['proj']} · 未桥接"))
        rows.sort(key=lambda r: r[0])
        return [(g, l, d) for _p, g, l, d in rows]

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
        working = sorted((v for v in views if v.state in WORKING_STATES), key=lambda v: -v.since)
        if working:
            return None, working[0]
        views.sort(key=lambda v: -v.since)
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


class PetArea(Gtk.DrawingArea):
    def __init__(self, model: PetModel, skin) -> None:
        super().__init__()
        self.model = model
        self.skin = skin
        self.last_state: str | None = None
        self.wiggle_until = 0.0
        self.set_draw_func(self.on_draw)
        GLib.timeout_add(FPS_MS, self.tick)

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

    def _bubble(self, ctx, text, ax, ay, color, t, pulse=False):  # noqa: ANN001
        scale = 1.0 + (0.05 * math.sin(t * 6) if pulse else 0.0)
        layout = PangoCairo.create_layout(ctx)
        desc = Pango.FontDescription()
        desc.set_size(int(12.5 * Pango.SCALE))
        desc.set_weight(Pango.Weight.BOLD)
        layout.set_font_description(desc)
        layout.set_text(text, -1)
        lw, lh = layout.get_pixel_size()
        pad_x, pad_y = 9.0, 5.0
        w, h = (lw + pad_x * 2) * scale, (lh + pad_y * 2) * scale
        bx = min(max(ax - w, 4), max(WIN_W - w - 4, 4))
        by = max(ay - h, 2)
        rounded(ctx, bx, by, w, h, 8)
        ctx.set_source_rgba(*COL_BUBBLE_BG)
        ctx.fill_preserve()
        ctx.set_source_rgba(*color)
        ctx.set_line_width(1.8)
        ctx.stroke()
        ctx.set_source_rgba(*COL_BUBBLE_FG)
        ctx.move_to(bx + pad_x, by + pad_y)
        PangoCairo.show_layout(ctx, layout)

    def _draw_panel(self, ctx, w: int, h: int) -> None:  # noqa: ANN001
        rows = self.model.supervision_rows()[:8]
        pad = 6.0
        ph = 30.0 + 16.0 * len(rows) + pad
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
        for glyph, label, detail in rows:
            color = COL_OK if glyph == "✓" else COL_ERR if glyph == "✗" else (
                COL_ASK if glyph == "?" else COL_DIM
            )
            self._text(ctx, glyph, 14, y, 10.5, color)
            self._text(ctx, label, 32, y, 10.5, COL_BUBBLE_FG, max_w=w * 0.40)
            self._text(ctx, detail, w - 14, y, 9.5, COL_DIM,
                       align_right=True, max_w=w * 0.44)
            y += 16.0

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
        self.skin.draw_body(ctx, w, h, t, state, pose)

        self.draw_chrome(ctx, w, h, t, state, view, sleeping, panel_open)

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
        # clock is the TURN clock — monotonic across tool flips within a turn.
        if not panel_open and view and state in WORKING_STATES | {"waiting"}:
            if state == "waiting" and view.tool == "ask":
                line = "等待回答"
            else:
                line = view.tool or STATE_LABELS.get(view.state, view.state)
            self._text(ctx, f"{line} · {view.clock(t)}",
                       w / 2, h - 34, 10.5, COL_DIM, align_center=True, max_w=w - 16)
            if view.detail and state == "tool":
                self._text(ctx, view.detail, w / 2, h - 20, 9.0, COL_DIM,
                           align_center=True, max_w=w - 16)
        elif sleeping and not panel_open:
            self._text(ctx, "zzz… 有任务会叫醒我", w / 2, h - 24, 9.5, COL_DIM,
                       align_center=True, max_w=w - 16)

        # persistent attention bubbles — THE notification surface
        if state == "done":
            self._bubble(ctx, f"✓ 完成 · {view.label if view else ''}".strip(),
                         w * 0.78, 34, COL_OK, t, pulse=True)
        elif state == "error":
            self._bubble(ctx, f"✗ 出错 · {view.label if view else ''}".strip(),
                         w * 0.78, 34, COL_ERR, t, pulse=True)
        elif state == "waiting":
            asking = view is not None and view.tool == "ask"
            self._bubble(ctx, "? 等待回答" if asking else "? 等待审批",
                         w * 0.78, 34, COL_ASK, t, pulse=True)

        for text, _exp in self.model.poke_bubbles:
            self._bubble(ctx, text, w * 0.70, 66, COL_OK, t)

        if self.model.total_live() > 1:
            self._bubble(ctx, f"×{self.model.total_live()}", w - 6, 20, COL_DIM, t)

        if panel_open:
            self._draw_panel(ctx, w, h)


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

    def save_position(self) -> None:
        save_state({
            "margin_x": self.margin_x,
            "margin_y": self.margin_y,
            "anchor_right": self.anchor_right,
            "anchor_bottom": self.anchor_bottom,
        })

    def on_hover_enter(self, *_a) -> None:  # noqa: ANN001
        self.model.panel_visible = True
        self.area.queue_draw()

    def on_hover_leave(self, *_a) -> None:  # noqa: ANN001
        self.model.panel_visible = False
        self.area.queue_draw()

    def on_press(self, _gesture, _n, x, y) -> None:  # noqa: ANN001
        self._drag_active = True
        self._drag_moved = False
        self._ensure_pos()

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
        if abs(dx) + abs(dy) < 6:
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
        rect = Gdk.Rectangle()
        rect.x, rect.y, rect.width, rect.height = int(x), int(y), 1, 1
        self._menu.set_pointing_to(rect)
        self._menu.popup()

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
                        continue
                    if frame.get("t") == "poke":
                        await self.dispatch_poke(frame, writer)
                    else:
                        GLib.idle_add(self.model.apply_frame, conn_id, frame)
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
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
