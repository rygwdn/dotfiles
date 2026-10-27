#!/usr/bin/env python3
"""Persistent, single-writer supervisor for OMP RPC sessions."""
from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import os
import secrets
import signal
import sqlite3
import stat
import sys
import time
import uuid
from pathlib import Path
from typing import Any
import math

MAX_IN = 1024 * 1024
MAX_LOGICAL = 64 * 1024 * 1024
DEFAULTS = {"max_running_sessions": 3, "worker_timeout": 7200,
            "idle_timeout": 1800, "shutdown_grace": 30, "termination_grace": 5}
LIVE = {"starting", "running", "idle", "blocked", "stopping", "takeover"}


def state_dir() -> Path:
    p = Path(os.environ.get("HERMES_OMP_STATE_DIR", "~/.local/state/hermes-omp")).expanduser()
    p.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = p.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise RuntimeError("supervisor state directory must be an owned, non-symlink directory")
    os.chmod(p, 0o700)
    return p


def config() -> dict[str, float | int]:
    cfg = DEFAULTS.copy()
    p = state_dir() / "config.json"
    if p.exists():
        try:
            values = json.loads(p.read_text())
        except (OSError, ValueError) as e:
            raise ValueError(f"invalid supervisor config: {e}") from e
        if not isinstance(values, dict):
            raise ValueError("config.json must contain an object")
        unknown = set(values) - set(cfg)
        if unknown:
            raise ValueError("unknown config keys: " + ", ".join(sorted(unknown)))
        cfg.update(values)
    for key, value in cfg.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
            raise ValueError(f"{key} must be a positive finite number")
    if int(cfg["max_running_sessions"]) != cfg["max_running_sessions"]:
        raise ValueError("max_running_sessions must be an integer")
    return cfg


def _now() -> float:
    return time.time()


def _json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


class SupervisorError(Exception):
    def __init__(self, code: str, message: str, details: Any = None):
        super().__init__(message)
        self.code, self.details = code, details


def positive_duration(value: Any, default: float, field: str) -> float:
    if value is None:
        value = default
    if isinstance(value, bool):
        raise SupervisorError("invalid_timeout", f"{field} must be a positive finite number")
    try:
        result = float(value)
    except (TypeError, ValueError) as e:
        raise SupervisorError("invalid_timeout", f"{field} must be a positive finite number") from e
    if not math.isfinite(result) or result <= 0:
        raise SupervisorError("invalid_timeout", f"{field} must be a positive finite number")
    return result


class Worker:
    def __init__(self, owner: "Supervisor", row: sqlite3.Row):
        self.owner = owner
        self.id = row["id"]
        self.proc: asyncio.subprocess.Process | None = None
        self.writer: asyncio.StreamWriter | None = None
        self.stdout_task: asyncio.Task | None = None
        self.stderr_task: asyncio.Task | None = None
        self.deadline_task: asyncio.Task | None = None
        self.requests: dict[str, asyncio.Future] = {}
        self.active_commands: dict[str, str] = {}
        self.pending_ui: dict[str, dict] = {}
        self.prompt_events: dict[str, asyncio.Event] = {}
        self.prompt_results: dict[str, dict] = {}
        self.activity = asyncio.Event()
        self.started = asyncio.Event()
        self.start_error: Exception | None = None
        self.frame_cursor = 0
        self.chunks: dict | None = None
        self._row = dict(row)
        self.process_identity: str | None = None
        self.last_assistant_text = ""

    def row(self) -> dict:
        return self.owner.db.execute("SELECT * FROM workers WHERE id=?", (self.id,)).fetchone()

    async def spawn(self, resume: bool = False) -> None:
        r = self.row()
        cmd = os.environ.get("HERMES_OMP_COMMAND")
        if cmd:
            try:
                argv = json.loads(cmd)
            except ValueError as e:
                raise SupervisorError("configuration", "HERMES_OMP_COMMAND must be JSON argv") from e
            if not isinstance(argv, list) or not argv or not all(isinstance(x, str) for x in argv):
                raise SupervisorError("configuration", "HERMES_OMP_COMMAND must be a non-empty string array")
        else:
            argv = ["omp"]
        argv += ["--mode", "rpc-ui", "--cwd", r["cwd"]]
        if r["profile"]:
            argv += ["--profile", r["profile"]]
        if resume:
            if not r["session_file"] or not Path(r["session_file"]).is_file():
                raise SupervisorError("session_missing", "saved OMP session file is unavailable", {"sessionFile": r["session_file"]})
            argv += ["--resume", r["session_file"]]
        env = os.environ.copy()
        env["PI_NO_PTY"] = "1"
        try:
            self.proc = await asyncio.create_subprocess_exec(*argv, cwd=r["cwd"], stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True, env=env, limit=MAX_IN)
        except (OSError, ValueError) as e:
            raise SupervisorError("spawn_failed", str(e)) from e
        self.writer = self.proc.stdin
        self.process_identity = self.owner.process_start(self.proc.pid)
        if not self.process_identity:
            self.proc.kill()
            await self.proc.wait()
            raise SupervisorError("process_identity_missing", "cannot safely identify OMP process for supervision")
        self.owner.db.execute("UPDATE workers SET pid=?,process_start=?,state='starting',updated=? WHERE id=?",
                              (self.proc.pid, self.process_identity, _now(), self.id))
        self.owner.db.commit()
        self.stdout_task = asyncio.create_task(self._stdout())
        self.stderr_task = asyncio.create_task(self._stderr())
        self.deadline_task = asyncio.create_task(self._watch())
        await asyncio.wait_for(self.started.wait(), 60)
        if self.start_error:
            raise SupervisorError("rpc_start_failed", str(self.start_error))
        if resume and r["session_file"]:
            state = await self.rpc({"type": "get_state"}, timeout=60)
            if not state.get("success"):
                raise SupervisorError("resume_failed", state.get("error", "could not inspect resumed session"))
            got = (state.get("data") or {}).get("sessionFile")
            if got and os.path.realpath(got) != os.path.realpath(r["session_file"]):
                await self.terminate("resume_mismatch")
                raise SupervisorError("resume_mismatch", "OMP resumed a different session", {"expected": r["session_file"], "actual": got})
        # Ask aggregation is optional across installed OMP builds; enable before initial input.
        with contextlib.suppress(SupervisorError):
            await self.rpc({"type": "set_ask_dialog", "enabled": True}, timeout=10)
        if r["message"] and not resume:
            result = await self.rpc({"type": "prompt", "id": "initial-" + self.id, "message": r["message"]}, timeout=120)
            if not result.get("success"):
                raise SupervisorError("initial_prompt_failed", result.get("error", "initial prompt rejected"))
        await self.refresh_state()

    async def _stdout(self) -> None:
        assert self.proc and self.proc.stdout
        try:
            while line := await self.proc.stdout.readline():
                if len(line) > MAX_IN:
                    raise ValueError("OMP physical RPC frame exceeds 1 MiB")
                frame = json.loads(line)
                if not isinstance(frame, dict):
                    raise ValueError("OMP emitted a non-object frame")
                await self._frame(frame)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            self.owner.event(self.id, {"type": "transport_error", "error": str(e)})
            for fut in self.requests.values():
                if not fut.done():
                    fut.set_exception(SupervisorError("transport_error", str(e)))
            if not self.started.is_set():
                self.start_error = e
                self.started.set()
            if self.proc and self.proc.returncode is None:
                asyncio.create_task(self.terminate("transport_error"))
        finally:
            if not self.started.is_set():
                self.start_error = ValueError("OMP exited before RPC ready")
                self.started.set()
            if self.proc and self.proc.returncode is not None:
                self.activity.set()

    async def _stderr(self) -> None:
        assert self.proc and self.proc.stderr
        # Consume continuously; never persist provider output or credentials.
        while await self.proc.stderr.read(65536):
            pass

    async def _frame(self, frame: dict) -> None:
        typ = frame.get("type")
        if typ == "ready":
            if frame.get("protocolVersion") != 1:
                self.start_error = ValueError("unsupported OMP RPC protocol")
                self.started.set()
                return
            self.started.set()
            if 2 in frame.get("supportedProtocolVersions", []):
                asyncio.create_task(self._negotiate())
            return
        if typ == "rpc_chunk":
            await self._chunk(frame)
            return
        if self.chunks:
            raise ValueError("interrupted OMP RPC chunk sequence")
        fid = frame.get("id")
        if typ == "response" and isinstance(fid, str):
            self.active_commands.pop(fid, None)
        if typ == "extension_ui_request":
            method = frame.get("method")
            if method == "cancel":
                target = str(frame.get("targetId") or "")
                self.pending_ui.pop(target, None)
                self.owner.db.execute("DELETE FROM pending WHERE worker=? AND request_id=?", (self.id, target))
                self.owner.db.commit()
                for notification in self.owner.db.execute("SELECT id,text FROM notifications WHERE worker=? AND kind='input'", (self.id,)).fetchall():
                    try:
                        if json.loads(notification["text"]).get("id") == target:
                            self.owner.db.execute("DELETE FROM notifications WHERE id=?", (notification["id"],))
                    except (TypeError, ValueError):
                        pass
                self.owner.event(self.id, frame)
                return
            if method in ("select", "confirm", "input", "editor", "ask"):
                rid = str(frame.get("id") or uuid.uuid4())
                self.pending_ui[rid] = frame
                self.owner.db.execute("INSERT OR REPLACE INTO pending(worker,request_id,frame,created) VALUES(?,?,?,?)",
                                      (self.id, rid, _json(frame), _now()))
                self.owner.db.commit()
                self.owner.event(self.id, frame, notify=True)
            else:
                self.owner.event(self.id, frame)
            return
        if typ == "response" and isinstance(fid, str):
            fut = self.requests.get(fid)
            if fut and not fut.done():
                fut.set_result(frame)
            if frame.get("command") == "handoff" and frame.get("success"):
                self.owner.event(self.id, frame, notify=True)
            return
        if typ == "prompt_result" and isinstance(fid, str):
            self.prompt_results[fid] = frame
            self.prompt_events.setdefault(fid, asyncio.Event()).set()
            self.owner.event(self.id, frame, notify=True)
        elif typ == "session_settled":
            self.owner.event(self.id, frame, notify=True)
        elif typ == "message_end":
            message = frame.get("message") or {}
            if message.get("role") == "assistant":
                self.last_assistant_text = "\n".join(
                    block.get("text", "") for block in message.get("content", [])
                    if isinstance(block, dict) and block.get("type") == "text"
                )[:2000]
            self.owner.event(self.id, frame)
        elif typ == "agent_end":
            self.owner.event(self.id, frame)
        elif typ == "btw_delta":
            self.owner.db.execute("INSERT INTO worker_activity(worker,btw_pending) VALUES(?,1) ON CONFLICT(worker) DO UPDATE SET btw_pending=1", (self.id,))
            self.owner.db.commit()
            self.owner.event(self.id, frame)
        elif typ == "btw_record":
            record = frame.get("record") or {}
            active = ((record.get("followUps") or [record])[-1]).get("status") == "running"
            self.owner.db.execute("INSERT INTO worker_activity(worker,btw_pending) VALUES(?,?) ON CONFLICT(worker) DO UPDATE SET btw_pending=excluded.btw_pending",
                                  (self.id, int(active)))
            self.owner.db.commit()
            self.owner.event(self.id, frame, notify=not active)
        else:
            important = typ in {"extension_error", "rpc_frame_error", "transport_error"} or (
                typ == "notice" and frame.get("level") == "error")
            self.owner.event(self.id, frame, notify=important)
        if typ in ("agent_start", "agent_end", "session_settled", "prompt_result", "btw_record"):
            self.activity.set()

    async def _negotiate(self):
        with contextlib.suppress(Exception):
            await self.rpc({"type": "negotiate_protocol", "protocolVersion": 2}, timeout=15, internal=True)
            await self.rpc({"type": "set_event_filter", "events": None, "messageUpdates": "delta"}, timeout=15)
            self.owner.db.execute("UPDATE workers SET protocol=2 WHERE id=?", (self.id,))
            self.owner.db.commit()

    async def _chunk(self, frame: dict) -> None:
        required = ("chunkId", "index", "count", "byteLength", "data")
        if any(k not in frame for k in required):
            raise ValueError("malformed rpc_chunk")
        if self.chunks is None:
            if frame["index"] != 0 or not (0 < frame["count"] < 100000) or frame["byteLength"] > MAX_LOGICAL:
                raise ValueError("invalid rpc_chunk sequence start")
            self.chunks = {"id": frame["chunkId"], "count": frame["count"], "length": frame["byteLength"], "next": 0, "parts": []}
        c = self.chunks
        if (frame["chunkId"] != c["id"] or frame["index"] != c["next"] or frame["count"] != c["count"] or frame["byteLength"] != c["length"]):
            raise ValueError("interrupted or invalid rpc_chunk sequence")
        part = base64.b64decode(frame["data"], validate=True)
        c["parts"].append(part); c["next"] += 1
        if c["next"] == c["count"]:
            raw = b"".join(c["parts"])
            if len(raw) != c["length"] or len(raw) > MAX_LOGICAL:
                raise ValueError("rpc_chunk byte length mismatch")
            obj = json.loads(raw.decode("utf-8", errors="strict"))
            if not isinstance(obj, dict):
                raise ValueError("rpc_chunk payload is not an object")
            self.chunks = None
            await self._frame(obj)

    async def rpc(self, command: dict, timeout: float = 180, internal: bool = False) -> dict:
        if self.proc is None or self.proc.returncode is not None or self.writer is None:
            raise SupervisorError("worker_exited", "OMP worker is not running")
        if not isinstance(command, dict) or not isinstance(command.get("type"), str):
            raise SupervisorError("invalid_command", "RPC command must have a string type")
        owned = {"negotiate_protocol", "host_tool_result", "host_uri_result", "extension_ui_response"}
        if command["type"] in owned and not internal:
            raise SupervisorError("owned_protocol", "this RPC command is owned by the supervisor")
        if command["type"] in {"login", "logout", "get_logout_accounts"}:
            raise SupervisorError("credential_operation_blocked", "credential management is not exposed through Hermes OMP RPC")
        rid = command.get("id")
        if rid is None:
            rid = "hermes-" + uuid.uuid4().hex
            command = {**command, "id": rid}
        elif not isinstance(rid, str) or not rid:
            raise SupervisorError("invalid_request_id", "RPC id must be a non-empty string")
        if len(_json(command).encode()) + 1 > MAX_IN:
            raise SupervisorError("frame_too_large", "RPC command exceeds 1 MiB")
        if rid in self.requests:
            raise SupervisorError("duplicate_request", "RPC request id is already pending")
        fut = asyncio.get_running_loop().create_future()
        self.requests[rid] = fut
        busy = command["type"] in {"bash", "compact", "handoff", "prompt", "abort_and_prompt",
                                    "btw", "new_session", "switch_session", "branch", "fork", "open_session"}
        if busy:
            self.active_commands[rid] = command["type"]
            await self.owner.set_state(self.id, "running")
        sent = False
        try:
            self.writer.write(_json(command).encode() + b"\n")
            await self.writer.drain()
            sent = True
            response = await asyncio.wait_for(fut, timeout)
            if response.get("success") is False:
                raise SupervisorError(response.get("code") or "rpc_error", response.get("error", "OMP RPC failed"), response)
            if command["type"] in {"prompt", "steer", "follow_up", "abort_and_prompt", "btw"}:
                await self.owner.set_state(self.id, "running")
                self.owner.db.commit()
            self.activity.set()
            return response
        except asyncio.TimeoutError as e:
            raise SupervisorError("rpc_timeout", f"OMP {command['type']} request timed out", {"id": rid}) from e
        finally:
            if not sent:
                self.active_commands.pop(rid, None)
            self.requests.pop(rid, None)

    async def send(self, message: str, behavior: str | None = None) -> dict:
        if not isinstance(message, str) or not message:
            raise SupervisorError("invalid_message", "message must be a non-empty string")
        cmd = {"type": "prompt", "message": message}
        if behavior:
            if behavior not in ("steer", "followUp"):
                raise SupervisorError("invalid_behavior", "behavior must be steer or followUp")
            cmd["streamingBehavior"] = behavior
        resp = await self.rpc(cmd)
        data = resp.get("data") or {}
        return {"response": resp, "promptId": resp.get("id"), "agentInvoked": data.get("agentInvoked")}

    async def refresh_state(self) -> None:
        if self.proc is None or self.proc.returncode is not None:
            return
        try:
            response = await self.rpc({"type": "get_state"}, timeout=15)
            d = response.get("data") or {}
            session_file = d.get("sessionFile")
            is_persisted = bool(session_file and Path(session_file).is_file())
            self.owner.db.execute("UPDATE workers SET session_file=COALESCE(?,session_file),session_id=COALESCE(?,session_id),persisted=?,updated=? WHERE id=?",
                (session_file, d.get("sessionId"), int(is_persisted), _now(), self.id))
        except Exception:
            pass

    async def _watch(self) -> None:
        r = self.row()
        now = _now()
        lifetime = max(0, r["deadline"] - now)
        while self.proc and self.proc.returncode is None:
            try:
                await asyncio.wait_for(self.proc.wait(), timeout=min(1, max(.05, lifetime)))
                break
            except asyncio.TimeoutError:
                pass
            r = self.row()
            if r["state"] in ("takeover", "stopping"):
                continue
            with contextlib.suppress(Exception):
                self.owner.cfg = config()
            if _now() >= r["deadline"]:
                await self.owner.stop_worker(self.id, "worker_timeout")
                return
            try:
                state = await self.rpc({"type": "get_state"}, timeout=min(5.0, max(.1, r["deadline"] - _now())))
                d = state.get("data") or {}
                pending_ui = self.owner.db.execute("SELECT 1 FROM pending WHERE worker=? LIMIT 1", (self.id,)).fetchone()
                btw = self.owner.db.execute("SELECT btw_pending FROM worker_activity WHERE worker=?", (self.id,)).fetchone()
                settled = (d.get("isSettled") is True and not d.get("hasPendingAsyncWork")
                           and not d.get("queuedMessageCount") and not pending_ui
                           and not (btw and btw["btw_pending"]) and not self.active_commands)
                await self.owner.set_state(self.id, "idle" if settled else ("running" if d.get("isStreaming") else "blocked"),
                                           idle_since=(_now() if settled else None), session=d)
                self.owner.db.commit()
                if settled:
                    r = self.row()
                    if r["idle_since"] and _now() - r["idle_since"] >= r["idle_timeout"]:
                        await self.owner.stop_worker(self.id, "idle_timeout")
                        return
            except Exception:
                pass
        await self.owner.child_exited(self.id, self.proc.returncode if self.proc else None)

    async def terminate(self, reason: str) -> None:
        if not self.proc:
            await self.owner.record_exit(self.id, None, reason)
            return
        pid = self.proc.pid
        if self.proc.returncode is None and self.writer:
            self.writer.close()
            with contextlib.suppress(Exception):
                await self.writer.wait_closed()
        forced = False
        if self.proc.returncode is None:
            try:
                await asyncio.wait_for(self.proc.wait(), float(self.owner.cfg["shutdown_grace"]))
            except asyncio.TimeoutError:
                forced = True
                await self.owner.signal_process_group(pid, self.process_identity)
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(self.proc.wait(), float(self.owner.cfg["termination_grace"]))
                if self.proc.returncode is None:
                    with contextlib.suppress(ProcessLookupError): os.killpg(pid, signal.SIGKILL)
                    with contextlib.suppress(Exception): await self.proc.wait()
        clean = await self.owner.cleanup_process_group(pid, self.process_identity)
        if not clean:
            raise SupervisorError("process_group_alive", "OMP child processes could not be confirmed stopped; worker reservation retained")
        if forced:
            reason = reason + "_forced"
        await self.owner.record_exit(self.id, self.proc.returncode, reason)


class Supervisor:
    def __init__(self):
        self.dir = state_dir()
        self.cfg = config()
        self.db = sqlite3.connect(self.dir / "registry.sqlite3", isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS workers(id TEXT PRIMARY KEY,name TEXT,cwd TEXT NOT NULL,profile TEXT,message TEXT,origin TEXT,
          state TEXT NOT NULL,created REAL NOT NULL,updated REAL NOT NULL,deadline REAL NOT NULL,idle_since REAL,idle_timeout REAL NOT NULL,
          worker_timeout REAL NOT NULL,session_file TEXT,session_id TEXT,persisted INTEGER NOT NULL DEFAULT 0,pid INTEGER,process_start TEXT,
          exit_code INTEGER,reason TEXT,pending_count INTEGER NOT NULL DEFAULT 0,protocol INTEGER NOT NULL DEFAULT 1,
          takeover_token TEXT,tui_pid INTEGER,tui_start TEXT);
        CREATE TABLE IF NOT EXISTS events(worker TEXT NOT NULL,seq INTEGER NOT NULL,frame TEXT NOT NULL,created REAL NOT NULL,PRIMARY KEY(worker,seq));
        CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,origin TEXT NOT NULL,worker TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,created REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS pending(worker TEXT NOT NULL,request_id TEXT NOT NULL,frame TEXT NOT NULL,created REAL NOT NULL,PRIMARY KEY(worker,request_id));
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS worker_activity(worker TEXT PRIMARY KEY,btw_pending INTEGER NOT NULL DEFAULT 0);
        """)
        os.chmod(self.dir / "registry.sqlite3", 0o600)
        self.workers: dict[str, Worker] = {}
        self.server: asyncio.AbstractServer | None = None
        self.closing = False
        self.lock_fd: int | None = None

    @staticmethod
    def process_start(pid: int | None) -> str | None:
        if not pid:
            return None
        try:
            # macOS ps start time disambiguates PID reuse sufficiently for recovery.
            import subprocess
            return subprocess.check_output(["ps", "-o", "lstart=", "-p", str(pid)], text=True, timeout=2).strip() or None
        except Exception:
            return None

    def alive(self, pid: int | None, identity: str | None) -> bool:
        if not pid or not identity:
            return False
        try: os.kill(pid, 0)
        except ProcessLookupError: return False
        except PermissionError: pass
        return self.process_start(pid) == identity
    def process_group_alive(self, pid: int, identity: str | None) -> bool:
        if not identity:
            return False
        current = self.process_start(pid)
        if current is not None and current != identity:
            return False
        try:
            os.killpg(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            # A denied probe does not prove a group exists; inspect membership.
            import subprocess
            rows = subprocess.check_output(["ps", "-axo", "pgid="], text=True, timeout=2)
            return any(line.strip() == str(pid) for line in rows.splitlines())

    async def signal_process_group(self, pid: int, identity: str | None) -> None:
        if not self.process_group_alive(pid, identity):
            return
        with contextlib.suppress(ProcessLookupError):
            os.killpg(pid, signal.SIGTERM)
        until = time.monotonic() + float(self.cfg["termination_grace"])
        while time.monotonic() < until and self.process_group_alive(pid, identity):
            await asyncio.sleep(.1)
        if self.process_group_alive(pid, identity):
            with contextlib.suppress(ProcessLookupError):
                os.killpg(pid, signal.SIGKILL)

    async def cleanup_process_group(self, pid: int, identity: str | None) -> bool:
        if not self.process_group_alive(pid, identity):
            return True
        await self.signal_process_group(pid, identity)
        until = time.monotonic() + 1
        while time.monotonic() < until and self.process_group_alive(pid, identity):
            await asyncio.sleep(.1)
        return not self.process_group_alive(pid, identity)

    async def record_exit(self, wid: str, code: int | None, reason: str) -> None:
        row = self.db.execute("SELECT * FROM workers WHERE id=?", (wid,)).fetchone()
        if not row or row["state"] in ("exited", "takeover"):
            return
        w = self.workers.get(wid)
        if w:
            for fut in w.requests.values():
                if not fut.done():
                    fut.set_exception(SupervisorError("worker_exited", "OMP worker exited"))
            w.pending_ui.clear()
        self.db.execute("DELETE FROM pending WHERE worker=?", (wid,))
        self.db.execute("DELETE FROM worker_activity WHERE worker=?", (wid,))
        self.db.execute("DELETE FROM notifications WHERE worker=? AND kind='input'", (wid,))
        persisted = bool(row["session_file"] and Path(row["session_file"]).is_file())
        self.db.execute("UPDATE workers SET state='exited',exit_code=?,reason=?,pid=NULL,process_start=NULL,persisted=?,pending_count=0,updated=? WHERE id=?",
                        (code, reason, int(persisted), _now(), wid))
        self.db.commit()
        self.event(wid, {"type": "worker_exit", "exitCode": code, "reason": reason, "persisted": persisted}, notify=True)
        self.db.commit()

    def event(self, wid: str, frame: dict, notify: bool = False) -> None:
        row = self.db.execute("SELECT COALESCE(MAX(seq),0)+1 FROM events WHERE worker=?", (wid,)).fetchone()[0]
        self.db.execute("INSERT INTO events VALUES(?,?,?,?)", (wid, row, _json(frame), _now()))
        if notify:
            w = self.db.execute("SELECT origin FROM workers WHERE id=?", (wid,)).fetchone()
            if w and w["origin"]:
                kind, text = self.notification_text(frame)
                worker = self.workers.get(wid)
                if kind == "completion" and worker and worker.last_assistant_text:
                    text += "\n" + worker.last_assistant_text
                if kind:
                    self.db.execute("INSERT INTO notifications VALUES(?,?,?,?,?,?)", (uuid.uuid4().hex, w["origin"], wid, kind, text, _now()))

    @staticmethod
    def notification_text(frame: dict) -> tuple[str | None, str]:
        typ = frame.get("type")
        if typ == "extension_ui_request":
            return "input", _json({k: frame.get(k) for k in ("id", "method", "title", "message", "options", "optionDetails", "questions", "placeholder", "initialValue") if k in frame})
        if typ in {"extension_error", "rpc_frame_error", "transport_error"} or (
                typ == "notice" and frame.get("level") == "error"):
            return "error", _json(frame)[:2000]
        if typ == "prompt_result":
            return ("error" if frame.get("status") == "error" else None), _json({k: frame.get(k) for k in ("status", "error") if k in frame})
        if typ == "session_settled":
            return "completion", "OMP session settled."
        if typ == "worker_exit":
            return "exit", _json({k: frame.get(k) for k in ("reason", "exitCode", "persisted") if k in frame})
        if typ == "response" and frame.get("command") == "handoff" and frame.get("success"):
            return "handoff", "OMP session handed off."
        if typ == "handoff":
            return "handoff", "OMP session handed off."
        if typ == "btw_record":
            record = frame.get("record") or {}
            latest = (record.get("followUps") or [record])[-1]
            if latest.get("status") in ("running", None):
                return None, ""
            summary = {k: latest.get(k) for k in ("question", "answer", "status") if k in latest}
            summary["id"] = record.get("id")
            if isinstance(summary.get("question"), str): summary["question"] = summary["question"][:500]
            if isinstance(summary.get("answer"), str): summary["answer"] = summary["answer"][:1500]
            return "btw", _json(summary)
        return None, ""

    async def set_state(self, wid: str, state: str, reason: str | None = None, idle_since: float | None = None, session: dict | None = None) -> None:
        fields = ["state=?", "updated=?"]
        args: list[Any] = [state, _now()]
        if reason is not None: fields.append("reason=?"); args.append(reason)
        if idle_since is not None: fields.append("idle_since=COALESCE(idle_since,?)"); args.append(idle_since)
        elif state != "idle": fields.append("idle_since=NULL")
        if session:
            sf, sid = session.get("sessionFile"), session.get("sessionId")
            if sf:
                persisted = bool(Path(sf).is_file())
                fields.extend(["session_file=?", "persisted=?"]); args.extend([sf, int(persisted)])
            if sid:
                fields.append("session_id=?"); args.append(sid)
            pending_ui = self.db.execute("SELECT COUNT(*) FROM pending WHERE worker=?", (wid,)).fetchone()[0]
            btw_pending = self.db.execute("SELECT btw_pending FROM worker_activity WHERE worker=?", (wid,)).fetchone()
            count = int(session.get("queuedMessageCount") or 0) + pending_ui + int(bool(btw_pending and btw_pending["btw_pending"]))
            fields.append("pending_count=?"); args.append(count)
        args.append(wid)
        self.db.execute(f"UPDATE workers SET {','.join(fields)} WHERE id=?", args)

    def worker_info(self, row: sqlite3.Row) -> dict:
        d = dict(row)
        d.pop("message", None); d.pop("profile", None); d.pop("process_start", None); d.pop("takeover_token", None); d.pop("tui_start", None)
        d["sessionId"], d["sessionFile"] = d.pop("session_id"), d.pop("session_file")
        d["idleSince"], d["pending"] = d["idle_since"], d.pop("pending_count")
        d["idle_since"] = d["idleSince"]
        d["stop_reason"] = d["reason"]
        d["workerTimeout"], d["idleTimeout"] = d.pop("worker_timeout"), d.pop("idle_timeout")
        d["persisted"] = bool(d["persisted"])
        d["live"] = d["state"] in LIVE
        d["pending_ui"] = [json.loads(r["frame"]) for r in self.db.execute("SELECT frame FROM pending WHERE worker=? ORDER BY created", (d["id"],)).fetchall()]
        return d

    def _slot(self) -> None:
        count = self.db.execute("SELECT COUNT(*) FROM workers WHERE state IN ('starting','running','idle','blocked','stopping','takeover')").fetchone()[0]
        if count >= int(self.cfg["max_running_sessions"]):
            raise SupervisorError("session_limit_reached", "maximum live worker count reached", {"limit": int(self.cfg["max_running_sessions"]), "live_count": count})

    async def start(self, **p) -> dict:
        cwd = str(Path(p.get("cwd") or os.getcwd()).expanduser().resolve())
        if not Path(cwd).is_dir(): raise SupervisorError("invalid_cwd", "cwd must be an existing directory")
        self.cfg = config()
        wt = positive_duration(p.get("worker_timeout"), self.cfg["worker_timeout"], "worker_timeout")
        it = positive_duration(p.get("idle_timeout"), self.cfg["idle_timeout"], "idle_timeout")
        wid, now = uuid.uuid4().hex, _now()
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self._slot()
            self.db.execute("INSERT INTO workers(id,name,cwd,profile,message,origin,state,created,updated,deadline,idle_timeout,worker_timeout) VALUES(?,?,?,?,?,?,'starting',?,?,?,?,?)",
                (wid, p.get("name"), cwd, p.get("profile"), p.get("message"), p.get("origin"), now, now, now+wt, it, wt))
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK"); raise
        w = Worker(self, self.db.execute("SELECT * FROM workers WHERE id=?", (wid,)).fetchone()); self.workers[wid] = w
        try: await w.spawn()
        except Exception as e:
            await w.terminate("start_failed")
            raise e
        return self.worker_info(self.db.execute("SELECT * FROM workers WHERE id=?", (wid,)).fetchone())

    async def resume(self, wid: str, **p) -> dict:
        row = self.db.execute("SELECT * FROM workers WHERE id=?", (wid,)).fetchone()
        if not row: raise SupervisorError("not_found", "worker not found")
        async with self._worker_lock(wid):
            row = self.db.execute("SELECT * FROM workers WHERE id=?", (wid,)).fetchone()
            if row["state"] == "takeover":
                if self.alive(row["tui_pid"], row["tui_start"]):
                    raise SupervisorError("tui_alive", "TUI still owns this session; release it before RPC resume")
                self.db.execute("UPDATE workers SET state='exited',reason='takeover_process_lost',pid=NULL,process_start=NULL,tui_pid=NULL,tui_start=NULL,takeover_token=NULL,updated=? WHERE id=?",
                                (_now(), wid))
                row = self.db.execute("SELECT * FROM workers WHERE id=?", (wid,)).fetchone()
            elif row["state"] in LIVE:
                if self.alive(row["pid"], row["process_start"]):
                    if wid in self.workers:
                        if p.get("origin") is not None:
                            self.db.execute("UPDATE workers SET origin=?,updated=? WHERE id=?", (p["origin"], _now(), wid)); self.db.commit()
                        return self.worker_info(self.db.execute("SELECT * FROM workers WHERE id=?", (wid,)).fetchone())
                    raise SupervisorError("orphan_still_alive", "unattached live OMP process retained; resume will not create a competing writer")
                await self._reap_orphan(row)
                row = self.db.execute("SELECT * FROM workers WHERE id=?", (wid,)).fetchone()
            if not row["session_file"] or not Path(row["session_file"]).is_file(): raise SupervisorError("session_missing", "worker has no saved session to resume")
            wt = positive_duration(p.get("worker_timeout"), row["worker_timeout"], "worker_timeout")
            it = positive_duration(p.get("idle_timeout"), row["idle_timeout"], "idle_timeout")
            now = _now()
            self.db.execute("BEGIN IMMEDIATE")
            try:
                self._slot()
                self.db.execute("UPDATE workers SET state='starting',deadline=?,worker_timeout=?,idle_timeout=?,updated=?,reason=NULL,origin=COALESCE(?,origin) WHERE id=?",
                                (now+wt, wt, it, now, p.get("origin"), wid))
                self.db.execute("COMMIT")
            except Exception:
                self.db.execute("ROLLBACK")
                raise
            w = Worker(self, self.db.execute("SELECT * FROM workers WHERE id=?", (wid,)).fetchone()); self.workers[wid] = w
            try:
                await w.spawn(resume=True)
            except Exception:
                await w.terminate("resume_failed")
                raise
            return self.worker_info(self.db.execute("SELECT * FROM workers WHERE id=?", (wid,)).fetchone())

    @contextlib.asynccontextmanager
    async def _worker_lock(self, wid):
        # Event-loop-local keyed lock prevents overlapping resume/takeover/stop operations.
        locks = getattr(self, "_locks", None)
        if locks is None: self._locks = locks = {}
        lock = locks.setdefault(wid, asyncio.Lock())
        async with lock: yield

    async def _reap_orphan(self, row):
        if row["state"] == "takeover":
            raise SupervisorError("takeover_active", "TUI reservation cannot be reaped as an RPC worker")
        if row["pid"] and not row["process_start"]:
            raise SupervisorError("process_identity_missing", "orphan PID lacks identity; retaining slot rather than risking an unrelated process")
        if self.alive(row["pid"], row["process_start"]):
            await self.signal_process_group(row["pid"], row["process_start"])
        if self.alive(row["pid"], row["process_start"]) or self.process_group_alive(row["pid"], row["process_start"]):
            raise SupervisorError("orphan_still_alive", "old OMP process group is still alive; slot remains reserved")
        await self.record_exit(row["id"], row["exit_code"], "supervisor_restart")

    async def child_exited(self, wid: str, code: int | None):
        row = self.db.execute("SELECT * FROM workers WHERE id=?", (wid,)).fetchone()
        if not row or row["state"] in ("exited", "takeover", "stopping"):
            return
        worker = self.workers.get(wid)
        if worker and not await self.cleanup_process_group(worker.proc.pid, worker.process_identity):
            self.db.execute("UPDATE workers SET state='stopping',reason='child_group_cleanup_failed',updated=? WHERE id=?", (_now(), wid))
            self.db.commit()
            return
        await self.record_exit(wid, code, row["reason"] or "process_exit")

    async def stop_worker(self, wid: str, reason="user_stop") -> dict:
        row = self.db.execute("SELECT * FROM workers WHERE id=?", (wid,)).fetchone()
        if not row: raise SupervisorError("not_found", "worker not found")
        async with self._worker_lock(wid):
            row = self.db.execute("SELECT * FROM workers WHERE id=?", (wid,)).fetchone()
            if row["state"] == "exited": return self.worker_info(row)
            self.db.execute("UPDATE workers SET state='stopping',reason=?,updated=? WHERE id=?", (reason, _now(), wid))
            self.db.commit()
            worker = self.workers.get(wid) if row["state"] != "takeover" else None
            if worker:
                await self._cancel_pending_ui(worker)
                if worker.proc and worker.proc.returncode is None:
                    for command_type in ("abort", "abort_bash", "btw_cancel"):
                        with contextlib.suppress(Exception):
                            await worker.rpc({"type": command_type}, timeout=5, internal=True)
                await worker.terminate(reason)
            elif row["state"] == "takeover":
                pid = row["tui_pid"]
                if self.alive(pid, row["tui_start"]):
                    with contextlib.suppress(ProcessLookupError): os.kill(pid, signal.SIGTERM)
                    await asyncio.sleep(float(self.cfg["termination_grace"]))
                    if self.alive(pid, row["tui_start"]):
                        with contextlib.suppress(ProcessLookupError): os.kill(pid, signal.SIGKILL)
                    if self.alive(pid, row["tui_start"]):
                        raise SupervisorError("tui_still_alive", "TUI process could not be stopped; reservation retained")
                await self.record_exit(wid, row["exit_code"], reason)
            else:
                if row["pid"] and not row["process_start"]:
                    raise SupervisorError("process_identity_missing", "worker PID lacks identity; retaining slot rather than risking an unrelated process")
                if self.alive(row["pid"], row["process_start"]):
                    await self.signal_process_group(row["pid"], row["process_start"])
                if self.alive(row["pid"], row["process_start"]) or self.process_group_alive(row["pid"], row["process_start"]):
                    raise SupervisorError("process_group_alive", "OMP process group still alive; reservation retained")
                await self.record_exit(wid, row["exit_code"], reason)
            return self.worker_info(self.db.execute("SELECT * FROM workers WHERE id=?", (wid,)).fetchone())

    async def _cancel_pending_ui(self, worker: Worker) -> None:
        if not worker.writer:
            return
        for rid, frame in list(worker.pending_ui.items()):
            if frame.get("method") == "ask":
                response = {"type": "extension_ui_response", "id": frame.get("id"),
                            "answers": [{"id": q.get("id"), "selectedOptions": []} for q in frame.get("questions", [])]}
            else:
                response = {"type": "extension_ui_response", "id": frame.get("id"), "cancelled": True}
            with contextlib.suppress(Exception):
                worker.writer.write(_json(response).encode() + b"\n")
                await worker.writer.drain()
            worker.pending_ui.pop(rid, None)
            self.db.execute("DELETE FROM pending WHERE worker=? AND request_id=?", (worker.id, rid))
            for notification in self.db.execute("SELECT id,text FROM notifications WHERE worker=? AND kind='input'", (worker.id,)).fetchall():
                try:
                    if json.loads(notification["text"]).get("id") == rid:
                        self.db.execute("DELETE FROM notifications WHERE id=?", (notification["id"],))
                except (TypeError, ValueError):
                    pass
        self.db.commit()

    async def shutdown(self):
        self.closing = True
        for wid in list(self.workers):
            with contextlib.suppress(Exception): await self.stop_worker(wid, "supervisor_shutdown")
        current = asyncio.current_task()
        tasks = [task for worker in self.workers.values()
                 for task in (worker.stdout_task, worker.stderr_task, worker.deadline_task)
                 if task and task is not current and not task.done()]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        if self.server: self.server.close(); await self.server.wait_closed()
        sock = self.dir / "supervisor.sock"
        with contextlib.suppress(FileNotFoundError): sock.unlink()
        if self.lock_fd is not None: os.close(self.lock_fd)
        self.db.close()

    def reconcile_takeovers(self) -> None:
        for row in self.db.execute("SELECT * FROM workers WHERE state='takeover' AND tui_pid IS NOT NULL").fetchall():
            if self.alive(row["tui_pid"], row["tui_start"]):
                continue
            self.db.execute("UPDATE workers SET state='exited',reason='tui_exited',pid=NULL,process_start=NULL,"
                            "tui_pid=NULL,tui_start=NULL,updated=? WHERE id=?", (_now(), row["id"]))
            self.event(row["id"], {"type": "worker_exit", "reason": "tui_exited",
                                  "persisted": bool(row["session_file"] and Path(row["session_file"]).is_file())},
                       notify=True)

    async def dispatch(self, op: str, p: dict) -> Any:
        self.cfg = config()
        self.reconcile_takeovers()
        if op == "list":
            rows = self.db.execute("SELECT * FROM workers ORDER BY created DESC").fetchall()
            return {"workers": [self.worker_info(r) for r in rows], "limit": int(self.cfg["max_running_sessions"]), "live_count": sum(r["state"] in LIVE for r in rows)}
        if op == "config":
            return {"config": dict(self.cfg)}
        if op == "shutdown":
            stop_workers = bool(p.get("stop_workers", True))
            async def close_later():
                await asyncio.sleep(.05)
                if stop_workers:
                    await self.shutdown()
                else:
                    self.closing = True
                    if self.server:
                        self.server.close()
                        await self.server.wait_closed()
                    with contextlib.suppress(FileNotFoundError):
                        (self.dir / "supervisor.sock").unlink()
                    if self.lock_fd is not None:
                        os.close(self.lock_fd)
            asyncio.create_task(close_later())
            return {"shutting_down": True, "stopping_workers": stop_workers}
        if op == "start": return await self.start(**p)
        if op == "resume": return await self.resume(p.pop("worker"), **p)
        if op == "status":
            row = self.db.execute("SELECT * FROM workers WHERE id=?", (p["worker"],)).fetchone()
            if not row: raise SupervisorError("not_found", "worker not found")
            w = self.workers.get(row["id"])
            if w: await w.refresh_state()
            return self.worker_info(self.db.execute("SELECT * FROM workers WHERE id=?", (p["worker"],)).fetchone())
        if op == "rpc":
            w = self._worker(p["worker"]); return await w.rpc(p["command"], float(p.get("timeout", 180)))
        if op == "send":
            w = self._worker(p["worker"]); return await w.send(p["message"], p.get("behavior"))
        if op == "events":
            rows = self.db.execute("SELECT seq,frame FROM events WHERE worker=? AND seq>? ORDER BY seq LIMIT ?", (p["worker"], int(p.get("after", 0)), min(1000, max(1, int(p.get("limit", 100)))))).fetchall()
            return {"events": [{"seq": r["seq"], "frame": json.loads(r["frame"])} for r in rows], "cursor": rows[-1]["seq"] if rows else int(p.get("after", 0))}
        if op == "wait": return await self.wait(p)
        if op == "pending":
            rows = self.db.execute("SELECT request_id,frame,created FROM pending WHERE worker=? ORDER BY created", (p["worker"],)).fetchall()
            return {"requests": [{"id": r["request_id"], **json.loads(r["frame"])} for r in rows]}
        if op == "answer": return await self.answer(p)
        if op == "abort": return await self._worker(p["worker"]).rpc({"type": "abort"})
        if op == "stop": return await self.stop_worker(p["worker"], p.get("reason", "user_stop"))
        if op == "extend":
            sec = positive_duration(p["seconds"], 0, "seconds")
            self.db.execute("UPDATE workers SET deadline=deadline+?,updated=? WHERE id=? AND state IN ('starting','running','idle','blocked')", (sec, _now(), p["worker"])); self.db.commit()
            return self.worker_info(self.db.execute("SELECT * FROM workers WHERE id=?", (p["worker"],)).fetchone())
        if op == "notifications":
            rows = self.db.execute("SELECT * FROM notifications WHERE origin=? ORDER BY created", (p["origin"],)).fetchall()
            return {"notifications": [dict(r) for r in rows]}
        if op == "ack":
            cur = self.db.execute("DELETE FROM notifications WHERE id=?", (p["notification_id"],)); self.db.commit()
            return {"acknowledged": bool(cur.rowcount)}
        if op == "takeover_prepare": return await self.takeover_prepare(p["worker"])
        if op == "takeover_claim": return await self.takeover_claim(p["worker"], p["token"], int(p["pid"]))
        if op == "takeover_release": return await self.takeover_release(p["worker"], p["token"])
        raise SupervisorError("unknown_operation", f"unknown supervisor operation: {op}")

    def _worker(self, wid: str) -> Worker:
        if wid not in self.workers: raise SupervisorError("worker_unavailable", "worker is not attached to the running supervisor")
        row = self.db.execute("SELECT state FROM workers WHERE id=?", (wid,)).fetchone()
        if row and row["state"] in ("stopping", "takeover"):
            raise SupervisorError("worker_transition", f"worker is {row['state']} and rejects new mutations")
        return self.workers[wid]

    async def wait(self, p: dict) -> dict:
        wid, until = p["worker"], p.get("until", "settled")
        if until not in ("settled", "input", "exit", "prompt"): raise SupervisorError("invalid_wait", "until must be settled, input, exit, or prompt")
        w = self._worker(wid); deadline = _now()+positive_duration(p.get("timeout"), 60, "timeout")
        while _now() < deadline:
            row = self.db.execute("SELECT * FROM workers WHERE id=?", (wid,)).fetchone()
            if until == "exit" and row["state"] == "exited": return self.worker_info(row)
            if until == "input" and self.db.execute("SELECT 1 FROM pending WHERE worker=? LIMIT 1", (wid,)).fetchone(): return self.worker_info(row)
            if until == "prompt" and p.get("prompt_id") in w.prompt_results: return w.prompt_results[p["prompt_id"]]
            if until == "settled":
                try:
                    state = await w.rpc({"type": "get_state"}, timeout=10)
                    d = state.get("data") or {}
                    pending_ui = self.db.execute("SELECT 1 FROM pending WHERE worker=? LIMIT 1", (wid,)).fetchone()
                    btw = self.db.execute("SELECT btw_pending FROM worker_activity WHERE worker=?", (wid,)).fetchone()
                    if (d.get("isSettled") is True and not d.get("hasPendingAsyncWork")
                            and not d.get("queuedMessageCount") and not pending_ui
                            and not (btw and btw["btw_pending"]) and not w.active_commands):
                        await self.set_state(wid, "idle", idle_since=_now(), session=d); self.db.commit()
                        return self.worker_info(self.db.execute("SELECT * FROM workers WHERE id=?", (wid,)).fetchone())
                except Exception: pass
            w.activity.clear()
            try: await asyncio.wait_for(w.activity.wait(), min(.5, deadline-_now()))
            except asyncio.TimeoutError: pass
        return {"timed_out": True, "worker": self.worker_info(self.db.execute("SELECT * FROM workers WHERE id=?", (wid,)).fetchone())}

    async def answer(self, p: dict) -> dict:
        async with self._worker_lock(p["worker"]):
            return await self._answer_locked(p)

    async def _answer_locked(self, p: dict) -> dict:
        wid, rid = p["worker"], str(p["request_id"])
        row = self.db.execute("SELECT frame FROM pending WHERE worker=? AND request_id=?", (wid, rid)).fetchone()
        if not row: raise SupervisorError("request_resolved", "UI request is no longer pending")
        w = self._worker(wid); frame = json.loads(row["frame"]); resp = p["response"]
        if not isinstance(resp, dict): raise SupervisorError("invalid_response", "UI response must be an object")
        method = frame.get("method")
        # Only UI response frames are accepted; never permit host-tool/URI protocol injection.
        # Confirm dialogs can represent permission gates and require an explicit terminal action.
        if method == "ask":
            answers = resp.get("answers")
            if set(resp) != {"answers"} or not isinstance(answers, list):
                raise SupervisorError("invalid_response", "ask response requires answers array only")
            questions = {q.get("id"): q for q in frame.get("questions", []) if isinstance(q, dict)}
            if len(answers) != len(questions):
                raise SupervisorError("invalid_response", "ask response must answer every question")
            seen = set()
            for answer in answers:
                if (not isinstance(answer, dict) or set(answer) - {"id", "selectedOptions", "customInput"}
                        or answer.get("id") not in questions or answer["id"] in seen
                        or not isinstance(answer.get("selectedOptions"), list)
                        or not all(isinstance(x, str) for x in answer["selectedOptions"])):
                    raise SupervisorError("invalid_response", "ask answers must correlate with unique question IDs and selectedOptions")
                seen.add(answer["id"])
                if "customInput" in answer and not isinstance(answer["customInput"], str):
                    raise SupervisorError("invalid_response", "ask customInput must be a string")
                question = questions[answer["id"]]
                labels = {option.get("label") for option in question.get("options", []) if isinstance(option, dict)}
                if any(label not in labels for label in answer["selectedOptions"]):
                    raise SupervisorError("invalid_response", "ask answer selected an unknown option")
                if not question.get("multi") and len(answer["selectedOptions"]) > 1:
                    raise SupervisorError("invalid_response", "single-choice ask answers may select only one option")
            outbound = {"type": "extension_ui_response", "id": frame.get("id"), "answers": answers}
        elif method in ("select", "input", "editor"):
            if set(resp) - {"value", "cancelled", "timedOut"}:
                raise SupervisorError("invalid_response", "unsupported response field")
            if "timedOut" in resp and not isinstance(resp["timedOut"], bool):
                raise SupervisorError("invalid_response", "timedOut must be boolean")
            if resp.get("cancelled") is True:
                outbound = {"type": "extension_ui_response", "id": frame.get("id"), "cancelled": True, **({"timedOut": True} if resp.get("timedOut") is True else {})}
            elif isinstance(resp.get("value"), str):
                if method == "select" and resp["value"] not in frame.get("options", []):
                    raise SupervisorError("invalid_response", "select value must match one of the offered options")
                if "timedOut" in resp:
                    raise SupervisorError("invalid_response", "timedOut requires cancelled=true")
                outbound = {"type": "extension_ui_response", "id": frame.get("id"), "value": resp["value"]}
            else:
                raise SupervisorError("invalid_response", "response requires string value or cancelled=true")
        elif method == "confirm":
            if p.get("human") is not True:
                raise SupervisorError("human_confirmation_required", "confirm requests require interactive approval; use `hermes-omp answer --confirm yes|no`")
            if set(resp) - {"confirmed", "cancelled", "timedOut"}:
                raise SupervisorError("invalid_response", "unsupported response field")
            if resp.get("cancelled") is True:
                outbound = {"type": "extension_ui_response", "id": frame.get("id"), "cancelled": True, **({"timedOut": True} if resp.get("timedOut") is True else {})}
            elif isinstance(resp.get("confirmed"), bool):
                outbound = {"type": "extension_ui_response", "id": frame.get("id"), "confirmed": resp["confirmed"]}
            else:
                raise SupervisorError("invalid_response", "response requires confirmed boolean or cancelled=true")
        elif method == "cancel":
            if resp.get("cancelled") is not True:
                raise SupervisorError("invalid_response", "cancel response requires cancelled=true")
            outbound = {"type": "extension_ui_response", "id": frame.get("id"), "cancelled": True}
        else: raise SupervisorError("unsupported_ui", f"unsupported extension UI method: {method}")
        key = str(frame.get("id") or rid)
        if key not in w.pending_ui: raise SupervisorError("request_resolved", "UI request already resolved")
        # Remove only after write succeeds; OMP's first-response-wins arbitration decides races.
        try:
            raw = _json(outbound).encode()
            if len(raw)+1 > MAX_IN: raise SupervisorError("frame_too_large", "UI answer exceeds 1 MiB")
            w.writer.write(raw+b"\n"); await w.writer.drain()
        except Exception: raise
        if key not in w.pending_ui:
            raise SupervisorError("request_resolved", "UI request was cancelled while the answer was being written")
        w.pending_ui.pop(key, None)
        self.db.execute("DELETE FROM pending WHERE worker=? AND request_id=?", (wid, rid)); self.db.commit()
        for notification in self.db.execute("SELECT id,text FROM notifications WHERE worker=? AND kind='input'", (wid,)).fetchall():
            try:
                if json.loads(notification["text"]).get("id") == key:
                    self.db.execute("DELETE FROM notifications WHERE id=?", (notification["id"],))
            except (TypeError, ValueError):
                pass
        await self.set_state(wid, "running")
        self.db.commit()
        w.activity.set()
        return {"acknowledged": True}

    async def takeover_prepare(self, wid: str) -> dict:
        async with self._worker_lock(wid):
            row = self.db.execute("SELECT * FROM workers WHERE id=?", (wid,)).fetchone()
            if not row: raise SupervisorError("not_found", "worker not found")
            if row["state"] == "takeover": raise SupervisorError("takeover_active", "takeover is already in progress")
            if row["state"] not in LIVE or wid not in self.workers: raise SupervisorError("worker_unavailable", "worker is not attached and live")
            worker = self.workers[wid]
            previous_state = row["state"]
            token = secrets.token_urlsafe(32)
            self.db.execute("UPDATE workers SET state='takeover',takeover_token=?,updated=? WHERE id=?", (token, _now(), wid))
            self.db.commit()
            closed = False
            try:
                await self._cancel_pending_ui(worker)
                state = await worker.rpc({"type": "get_state"}, timeout=10)
                data = state.get("data") or {}
                btw = self.db.execute("SELECT btw_pending FROM worker_activity WHERE worker=?", (wid,)).fetchone()
                if data.get("queuedMessageCount"):
                    raise SupervisorError("takeover_busy", "queued input must be handled before TUI takeover")
                if (not data.get("isSettled") or data.get("hasPendingAsyncWork")
                        or (btw and btw["btw_pending"]) or worker.active_commands):
                    for command_type in ("abort", "abort_bash", "btw_cancel"):
                        with contextlib.suppress(Exception):
                            await worker.rpc({"type": command_type}, timeout=5, internal=True)
                    until = time.monotonic() + float(self.cfg["shutdown_grace"])
                    while time.monotonic() < until:
                        state = await worker.rpc({"type": "get_state"}, timeout=min(5, max(.1, until-time.monotonic())))
                        data = state.get("data") or {}
                        pending = self.db.execute("SELECT 1 FROM pending WHERE worker=? LIMIT 1", (wid,)).fetchone()
                        btw = self.db.execute("SELECT btw_pending FROM worker_activity WHERE worker=?", (wid,)).fetchone()
                        if (data.get("isSettled") and not data.get("hasPendingAsyncWork")
                                and not data.get("queuedMessageCount") and not pending
                                and not (btw and btw["btw_pending"]) and not worker.active_commands):
                            break
                    else:
                        raise SupervisorError("takeover_busy", "active work did not settle; worker remains under RPC control")
                btw = self.db.execute("SELECT btw_pending FROM worker_activity WHERE worker=?", (wid,)).fetchone()
                if (not data.get("isSettled") or data.get("hasPendingAsyncWork")
                        or data.get("queuedMessageCount") or (btw and btw["btw_pending"]) or worker.active_commands):
                    raise SupervisorError("takeover_busy", "queued input or background work prevents a safe TUI handoff")
                session_file = data.get("sessionFile")
                if not session_file or not Path(session_file).is_file():
                    raise SupervisorError("session_not_persisted", "OMP has no saved session file to hand off")
                self.db.execute("UPDATE workers SET session_file=?,session_id=?,persisted=1,updated=? WHERE id=?",
                                (session_file, data.get("sessionId"), _now(), wid)); self.db.commit()
                worker.writer.close()
                await worker.writer.wait_closed()
                worker.writer = None
                try:
                    await asyncio.wait_for(worker.proc.wait(), float(self.cfg["shutdown_grace"]))
                except asyncio.TimeoutError:
                    await self.signal_process_group(worker.proc.pid, worker.process_identity)
                    with contextlib.suppress(asyncio.TimeoutError):
                        await asyncio.wait_for(worker.proc.wait(), float(self.cfg["termination_grace"]))
                    if worker.proc.returncode is None:
                        with contextlib.suppress(ProcessLookupError): os.killpg(worker.proc.pid, signal.SIGKILL)
                        with contextlib.suppress(Exception): await worker.proc.wait()
                    raise SupervisorError("takeover_forced_shutdown", "OMP required forced shutdown; TUI takeover refused")
                closed = True
                if worker.stdout_task: await worker.stdout_task
                if worker.stderr_task: await worker.stderr_task
                if not await self.cleanup_process_group(worker.proc.pid, worker.process_identity):
                    raise SupervisorError("takeover_process_group_alive", "OMP child processes remain after clean EOF")
                if worker.proc.returncode != 0 or not Path(session_file).is_file():
                    raise SupervisorError("takeover_persistence_failed", "OMP did not exit cleanly with its exact saved session intact")
                current = self.db.execute("SELECT * FROM workers WHERE id=?", (wid,)).fetchone()
                self.db.execute("UPDATE workers SET pid=NULL,process_start=NULL,exit_code=0,updated=? WHERE id=?", (_now(), wid)); self.db.commit()
                self.event(wid, {"type": "handoff", "sessionFile": session_file}, notify=True); self.db.commit()
                return {"worker": wid, "token": token, "argv": self._takeover_argv(current), "cwd": current["cwd"]}
            except Exception as e:
                if not closed and worker.proc.returncode is None:
                    self.db.execute("UPDATE workers SET state=?,takeover_token=NULL,updated=? WHERE id=?", (previous_state, _now(), wid))
                    self.db.commit()
                else:
                    self.db.execute("UPDATE workers SET state='stopping',takeover_token=NULL,reason='takeover_failed',updated=? WHERE id=?", (_now(), wid))
                    self.db.commit()
                    await self.record_exit(wid, worker.proc.returncode, "takeover_failed")
                if isinstance(e, SupervisorError):
                    raise
                raise SupervisorError("takeover_failed", str(e), {"worker": wid}) from e

    def _takeover_argv(self, row):
        cmd = json.loads(os.environ["HERMES_OMP_COMMAND"]) if os.environ.get("HERMES_OMP_COMMAND") else ["omp"]
        args, skip_mode_value = [], False
        for arg in cmd:
            if skip_mode_value:
                skip_mode_value = False
            elif arg == "--mode":
                skip_mode_value = True
            elif not arg.startswith("--mode="):
                args.append(arg)
        args += ["--cwd", row["cwd"]]
        if row["profile"]: args += ["--profile", row["profile"]]
        return args + ["--resume", row["session_file"]]

    async def takeover_claim(self, wid: str, token: str, pid: int) -> dict:
        row = self.db.execute("SELECT * FROM workers WHERE id=?", (wid,)).fetchone()
        if not row or row["state"] != "takeover" or not secrets.compare_digest(row["takeover_token"] or "", token):
            raise SupervisorError("invalid_takeover", "takeover token is invalid or expired")
        if row["pid"] is not None or row["tui_pid"] is not None:
            raise SupervisorError("takeover_claimed", "takeover reservation already has an owner")
        identity = self.process_start(pid)
        if not identity or not self.alive(pid, identity): raise SupervisorError("invalid_pid", "takeover process is not alive")
        self.db.execute("UPDATE workers SET pid=?,process_start=?,tui_pid=?,tui_start=?,updated=? WHERE id=?",
                        (pid, identity, pid, identity, _now(), wid)); self.db.commit()
        return self.worker_info(self.db.execute("SELECT * FROM workers WHERE id=?", (wid,)).fetchone())

    async def takeover_release(self, wid: str, token: str) -> dict:
        row = self.db.execute("SELECT * FROM workers WHERE id=?", (wid,)).fetchone()
        if row and row["state"] == "exited":
            return self.worker_info(row)
        if not row or row["state"] != "takeover" or not secrets.compare_digest(row["takeover_token"] or "", token):
            raise SupervisorError("invalid_takeover", "takeover token is invalid or expired")
        if row["tui_pid"] and self.alive(row["tui_pid"], row["tui_start"]):
            raise SupervisorError("tui_alive", "cannot release while the TUI process is alive")
        self.db.execute("UPDATE workers SET state='exited',reason='takeover_released',takeover_token=NULL,pid=NULL,process_start=NULL,tui_pid=NULL,tui_start=NULL,updated=? WHERE id=?", (_now(), wid)); self.db.commit()
        self.event(wid, {"type": "worker_exit", "exitCode": row["exit_code"], "reason": "takeover_released"}, notify=True)
        self.db.commit()
        return self.worker_info(self.db.execute("SELECT * FROM workers WHERE id=?", (wid,)).fetchone())

    async def handle(self, reader, writer):
        try:
            line = await asyncio.wait_for(reader.readline(), 30)
            if not line or len(line) > MAX_IN: raise SupervisorError("invalid_request", "request line missing or exceeds 1 MiB")
            req = json.loads(line)
            if not isinstance(req, dict) or not isinstance(req.get("op"), str) or not isinstance(req.get("params", {}), dict):
                raise SupervisorError("invalid_request", "expected {op, params} object")
            result = await self.dispatch(req["op"], req.get("params", {}))
            response = {"ok": True, "result": result}
        except SupervisorError as e:
            response = {"ok": False, "error": {"code": e.code, "message": str(e), "details": e.details}}
        except Exception as e:
            response = {"ok": False, "error": {"code": "internal_error", "message": str(e)}}
        try:
            writer.write(_json(response).encode()+b"\n"); await writer.drain()
        except Exception: pass
        writer.close()
        with contextlib.suppress(Exception): await writer.wait_closed()

    async def serve(self):
        lock = self.dir / "supervisor.lock"
        self.lock_fd = os.open(lock, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            import fcntl
            fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (ImportError, BlockingIOError) as e:
            raise RuntimeError("another Hermes OMP supervisor owns this state directory") from e
        sock = self.dir / "supervisor.sock"
        if sock.exists():
            # Do not unlink another live server's socket; lock ownership proves stale socket.
            sock.unlink()
        for sig in (signal.SIGINT, signal.SIGTERM):
            with contextlib.suppress(NotImplementedError): asyncio.get_running_loop().add_signal_handler(sig, lambda: asyncio.create_task(self.shutdown()))
        await self._recover()
        self.server = await asyncio.start_unix_server(self.handle, path=sock, limit=MAX_IN+1)
        os.chmod(sock, 0o600)
        async with self.server: await self.server.serve_forever()

    async def _recover(self):
        for row in self.db.execute("SELECT * FROM workers WHERE state IN ('starting','running','idle','blocked','stopping','takeover')").fetchall():
            if row["state"] == "takeover":
                if row["pid"] is None and row["tui_pid"] is None:
                    continue
                if row["tui_pid"] and self.alive(row["tui_pid"], row["tui_start"]):
                    continue
                self.db.execute("UPDATE workers SET state='exited',reason='takeover_process_lost',pid=NULL,process_start=NULL,tui_pid=NULL,tui_start=NULL,takeover_token=NULL,updated=? WHERE id=?", (_now(), row["id"]))
                self.db.commit()
                self.event(row["id"], {"type": "worker_exit", "exitCode": row["exit_code"], "reason": "takeover_process_lost"}, notify=True)
            else:
                # Previous supervisor's children cannot continue unsupervised as a second writer.
                await self._reap_orphan(row)
        self.db.commit()


async def main():
    os.umask(0o077)
    sup = Supervisor()
    try: await sup.serve()
    except asyncio.CancelledError: pass
    finally:
        if not sup.closing: await sup.shutdown()

if __name__ == "__main__":
    try: asyncio.run(main())
    except Exception as e:
        print(f"hermes-omp supervisor: {e}", file=sys.stderr)
        raise SystemExit(1)
