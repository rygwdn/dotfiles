"""Thread-safe, dependency-free client for the independently running OMP supervisor."""
from __future__ import annotations

import fcntl
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys
import time

MAX_RESPONSE = 70 * 1024 * 1024


class SupervisorError(RuntimeError):
    def __init__(self, code: str, message: str, details: dict | None = None):
        super().__init__(message)
        self.code = code
        self.details = details or {}

    def as_dict(self) -> dict:
        return {"code": self.code, "message": str(self), "details": self.details}


def state_dir() -> Path:
    return Path(os.environ.get("HERMES_OMP_STATE_DIR", "~/.local/state/hermes-omp")).expanduser().absolute()


def private_directory() -> Path:
    root = state_dir()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise SupervisorError("unsafe_state_directory", "Supervisor state must be an owned, non-symlink directory")
    os.chmod(root, 0o700)
    return root


def _exchange(op: str, params: dict, timeout: float) -> dict:
    path = state_dir() / "supervisor.sock"
    info = path.lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise SupervisorError("unsafe_socket", "Supervisor socket must be private and owned by this user")
    payload = json.dumps({"op": op, "params": params}, ensure_ascii=False).encode() + b"\n"
    if len(payload) > 1024 * 1024:
        raise SupervisorError("request_too_large", "Requests must be smaller than 1 MiB")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        sock.connect(str(path))
        sock.sendall(payload)
        with sock.makefile("rb") as stream:
            data = stream.readline(MAX_RESPONSE + 1)
    if not data or len(data) > MAX_RESPONSE or not data.endswith(b"\n"):
        raise SupervisorError("invalid_response", "Supervisor closed the connection or exceeded the response limit")
    reply = json.loads(data)
    if not reply.get("ok"):
        error = reply.get("error", {})
        raise SupervisorError(error.get("code", "supervisor_error"), error.get("message", "Supervisor operation failed"), error.get("details"))
    return reply["result"]


def ensure_server() -> None:
    root = private_directory()
    try:
        _exchange("list", {}, 2)
        return
    except (FileNotFoundError, ConnectionRefusedError):
        pass
    lock_path = root / "startup.lock"
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            _exchange("list", {}, 2)
            return
        except (FileNotFoundError, ConnectionRefusedError):
            pass
        log_fd = os.open(root / "supervisor.log", os.O_CREAT | os.O_APPEND | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        with os.fdopen(log_fd, "ab") as log:
            child = subprocess.Popen(
                [sys.executable, str(Path(__file__).resolve().with_name("supervisor.py"))],
                stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                start_new_session=True, close_fds=True, cwd=str(root),
            )
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            try:
                _exchange("list", {}, 2)
                return
            except (FileNotFoundError, ConnectionRefusedError):
                if child.poll() is not None:
                    raise SupervisorError("startup_failed", "Supervisor failed to start; inspect " + str(root / "supervisor.log"))
                time.sleep(0.1)
        raise SupervisorError("startup_timeout", "Supervisor did not become ready within 20 seconds")


def request(op: str, **params) -> dict:
    timeout = float(params.pop("_client_timeout", max(180, float(params.get("timeout", 60)) + 10)))
    ensure_server()
    try:
        return _exchange(op, params, timeout)
    except socket.timeout as exc:
        raise SupervisorError("client_timeout", "Response timed out; inspect status before retrying a mutation") from exc
    except (ConnectionError, FileNotFoundError) as exc:
        raise SupervisorError("connection_lost", "Supervisor connection lost; inspect status before retrying a mutation") from exc
