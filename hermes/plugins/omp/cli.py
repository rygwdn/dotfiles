"""External observation and control, including an exclusive native-TUI handoff.

Read-only native transcript prototype:
    bun install                     # once, in this plugin directory; OMP UI pinned to 18.12.1
    python3 cli.py watch WORKER --tui

The Bun viewer replays this worker's supervisor journal, then follows live
message/thinking deltas and tool results. It never opens/resumes the saved
conversation or sends prompts/answers. Quit detaches without stopping the worker.
Arrow keys/PageUp/PageDown scroll; End/f follows; o expands tools; q exits.
The journal is chronological, not a projection of the current session branch.
History predating supervisor observation, extension-specific UI, inline images,
and subagent drill-down are not provided by this prototype. Text/JSON watch
remains available without Bun. --tui excludes --json, --once, and --after.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

from client import SupervisorError, private_directory, request


def duration(text: str) -> float:
    units = {"s": 1, "m": 60, "h": 3600, "d": 86400}
    try:
        value = float(text[:-1]) * units[text[-1]] if text[-1:] in units else float(text)
        if not 0 < value < float("inf"):
            raise ValueError()
        return value
    except (ValueError, IndexError):
        raise argparse.ArgumentTypeError("Use a positive duration, e.g. 30s, 30m, 2h")


def object_json(text: str) -> dict:
    try:
        value = json.loads(text)
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except ValueError:
        raise argparse.ArgumentTypeError("Expected a JSON object")


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Observe and control persistent OMP RPC workers independently of Hermes")
    p.add_argument("--state-dir", help="Override HERMES_OMP_STATE_DIR")
    p.add_argument("--json", action="store_true", help="Print machine-readable results")
    subs = p.add_subparsers(dest="op", required=True)
    subs.add_parser("list", help="List saved workers and occupied slots")
    subs.add_parser("daemon-stop", help="Gracefully stop the supervisor and all its RPC workers")
    start = subs.add_parser("start", help="Start an OMP rpc-ui worker")
    start.add_argument("--cwd", default=os.getcwd())
    start.add_argument("--name")
    start.add_argument("--profile")
    start.add_argument("--message")
    start.add_argument("--worker-timeout", type=duration)
    start.add_argument("--idle-timeout", type=duration)
    resume = subs.add_parser("resume", help="Resume a stopped worker's exact conversation")
    resume.add_argument("worker")
    resume.add_argument("--worker-timeout", type=duration)
    resume.add_argument("--idle-timeout", type=duration)
    for op in ("status", "pending", "abort", "stop", "takeover", "transcript"):
        s = subs.add_parser(op)
        s.add_argument("worker")
    send = subs.add_parser("send")
    send.add_argument("worker")
    send.add_argument("message")
    send.add_argument("--behavior", choices=["steer", "followUp"])
    btw = subs.add_parser("btw")
    btw.add_argument("worker")
    btw.add_argument("question")
    btw.add_argument("--record-id")
    wait = subs.add_parser("wait")
    wait.add_argument("worker")
    wait.add_argument("--until", choices=["settled", "input", "exit", "prompt"], default="settled")
    wait.add_argument("--timeout", type=duration, default=60)
    wait.add_argument("--prompt-id")
    watch = subs.add_parser("watch")
    watch.add_argument("worker")
    watch.add_argument("--after", type=int, default=0)
    watch.add_argument("--once", action="store_true")
    watch.add_argument("--tui", action="store_true", help="Read-only live OMP transcript UI (requires Bun and bun install)")
    answer = subs.add_parser("answer", help="Resolve a pending dialog; explicit human CLI action")
    answer.add_argument("worker")
    answer.add_argument("request_id")
    group = answer.add_mutually_exclusive_group(required=True)
    group.add_argument("--value")
    group.add_argument("--confirm", choices=["yes", "no"])
    group.add_argument("--cancel", action="store_true")
    group.add_argument("--response", type=object_json, help="Full response fields, e.g. an ask answers array")
    raw = subs.add_parser("rpc")
    raw.add_argument("worker")
    raw.add_argument("command", type=object_json)
    extend = subs.add_parser("extend")
    extend.add_argument("worker")
    extend.add_argument("duration", type=duration)
    config = subs.add_parser("config", help="Show or change supervisor limits")
    config.add_argument("--max-running-sessions", type=int)
    for key in ("worker-timeout", "idle-timeout", "shutdown-grace", "termination-grace"):
        config.add_argument("--" + key, type=duration)
    return p


def output(result: dict, machine: bool) -> None:
    if machine:
        print(json.dumps(result, ensure_ascii=False))
        return
    if "workers" in result:
        print(f"Slots: {result.get('live_count', '?')}/{result.get('limit', '?')}")
        for worker in result["workers"]:
            print(f"{worker.get('id', worker.get('worker', '?')):<22} {worker.get('state', '?'):<16} {worker.get('name') or worker.get('cwd', '')}")
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2))


def render_event(event: dict, machine: bool) -> None:
    if machine:
        print(json.dumps(event, ensure_ascii=False), flush=True)
        return
    frame = event["frame"]
    kind = frame.get("type", "unknown")
    if kind in ("message_update", "btw_delta"):
        update = frame.get("assistantMessageEvent", {})
        delta = frame.get("delta") if kind == "btw_delta" else update.get("delta") if update.get("type") == "text_delta" else None
        if isinstance(delta, str):
            print(delta, end="", flush=True)
    elif kind == "message_end":
        print(flush=True)
    elif kind in ("tool_execution_start", "tool_execution_end"):
        print(f"\n[{kind}: {frame.get('toolName', '')}]", flush=True)
    elif kind in ("extension_ui_request", "prompt_result", "session_settled", "notice", "worker_exit", "worker_stopping", "btw_record"):
        print(f"\n[{event['seq']}] {json.dumps(frame, ensure_ascii=False)}", flush=True)


def watch(args) -> None:
    cursor = args.after
    while True:
        page = request("events", worker=args.worker, after=cursor, limit=100)
        for event in page["events"]:
            render_event(event, args.json)
        cursor = page["cursor"]
        if args.once:
            break
        if len(page["events"]) == 100:
            continue
        status = request("status", worker=args.worker)
        if not status.get("pid") and status.get("state") not in ("starting", "stopping", "takeover_reserved"):
            break
        if not page["events"]:
            time.sleep(0.5)


def watch_tui(args) -> int:
    if args.json or args.once or args.after:
        raise SupervisorError("incompatible_options", "--tui cannot be combined with --json, --once, or --after")
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        raise SupervisorError("terminal_required", "Run watch --tui in an interactive terminal")
    bun = shutil.which("bun")
    root = Path(__file__).resolve().parent
    if not bun or not (root / "node_modules/@oh-my-pi/pi-tui/package.json").is_file():
        raise SupervisorError("viewer_not_installed", f"Install Bun, then run bun install in {root}")
    # Validate the target before handing the terminal to the renderer.
    request("status", worker=args.worker)
    os.execv(bun, [bun, str(root / "watch-tui.ts"), sys.executable, str(root / "cli.py"), args.worker])


def takeover(args) -> None:
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        raise SupervisorError("terminal_required", "Run takeover in an interactive terminal (including a herdr pane)")
    prepared = request("takeover_prepare", worker=args.worker)
    token = prepared["token"]
    child = None
    previous = signal.getsignal(signal.SIGINT)
    try:
        try:
            child = subprocess.Popen(prepared["argv"], cwd=prepared["cwd"])
        except Exception:
            request("takeover_release", worker=args.worker, token=token)
            raise
        try:
            request("takeover_claim", worker=args.worker, token=token, pid=child.pid)
        except Exception:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
            request("takeover_release", worker=args.worker, token=token)
            raise
        # The TUI inherits the terminal process group and receives Ctrl+C itself.
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        child.wait()
        output(request("takeover_release", worker=args.worker, token=token), args.json)
    finally:
        signal.signal(signal.SIGINT, previous)
        # A surviving TUI keeps its reservation if this client dies or is interrupted.


def configure(args) -> dict:
    root = private_directory()
    path = root / "config.json"
    defaults = {"max_running_sessions": 3, "worker_timeout": 7200, "idle_timeout": 1800, "shutdown_grace": 30, "termination_grace": 5}
    if path.exists():
        defaults.update(json.loads(path.read_text()))
    values = {key: getattr(args, key) for key in defaults if getattr(args, key) is not None}
    if values.get("max_running_sessions", 1) < 1:
        raise SupervisorError("invalid_limit", "max_running_sessions must be at least 1")
    defaults.update(values)
    if values:
        tmp = root / f"config.{os.getpid()}.tmp"
        fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(defaults, stream, indent=2)
            stream.write("\n")
        os.replace(tmp, path)
    return {"config": defaults, "path": str(path), "note": "New operations load configuration; existing workers retain their recorded deadlines."}


def main() -> int:
    args = parser().parse_args()
    if args.state_dir:
        os.environ["HERMES_OMP_STATE_DIR"] = args.state_dir
    try:
        if args.op == "watch":
            if args.tui:
                return watch_tui(args)
            watch(args)
            return 0
        if args.op == "takeover":
            takeover(args)
            return 0
        if args.op == "config":
            result = configure(args)
        elif args.op == "daemon-stop":
            result = request("shutdown", stop_workers=True)
        elif args.op in ("start", "resume"):
            params = {key: value for key, value in vars(args).items() if key not in ("op", "state_dir", "json") and value is not None}
            result = request(args.op, **params)
        elif args.op == "btw":
            command = {"type": "btw", "question": args.question}
            if args.record_id:
                command["recordId"] = args.record_id
            result = request("rpc", worker=args.worker, command=command)
        elif args.op == "answer":
            response = args.response or ({"value": args.value} if args.value is not None else {"confirmed": args.confirm == "yes"} if args.confirm else {"cancelled": True})
            result = request("answer", worker=args.worker, request_id=args.request_id, response=response, human=True)
        elif args.op == "transcript":
            status = request("status", worker=args.worker)
            if status.get("pid") and status.get("state") not in ("takeover", "takeover_reserved"):
                result = request("rpc", worker=args.worker, command={"type": "get_messages"})
            else:
                cursor, messages = 0, []
                while True:
                    page = request("events", worker=args.worker, after=cursor, limit=100)
                    messages.extend(event["frame"]["message"] for event in page["events"] if event["frame"].get("type") == "message_end")
                    cursor = page["cursor"]
                    if len(page["events"]) < 100:
                        break
                result = {"messages": messages, "source": "supervisor journal; saved conversation path is in status"}
        elif args.op == "extend":
            result = request("extend", worker=args.worker, seconds=args.duration)
        elif args.op == "wait":
            result = request("wait", worker=args.worker, until=args.until, timeout=args.timeout, prompt_id=args.prompt_id)
        else:
            params = {key: value for key, value in vars(args).items() if key not in ("op", "state_dir", "json") and value is not None}
            result = request(args.op, **params)
        output(result, args.json)
        return 0
    except SupervisorError as exc:
        print(json.dumps({"error": exc.as_dict()}, ensure_ascii=False), file=sys.stderr)
        return 1
    except (OSError, ValueError) as exc:
        print(f"hermes-omp: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
