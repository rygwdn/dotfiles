"""Lifecycle regressions against the real OMP executable; no model calls required.

Run: python3 -m unittest discover -s hermes/plugins/omp -p 'test_*.py' -v
"""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from client import SupervisorError, request


@unittest.skipUnless(shutil.which("omp"), "requires an installed OMP executable")
class SupervisorLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hermes-omp-test-")
        self.root = Path(self.temp.name)
        self.previous = {key: os.environ.get(key) for key in ("HERMES_OMP_STATE_DIR", "HERMES_OMP_COMMAND")}
        os.environ["HERMES_OMP_STATE_DIR"] = str(self.root / "state")
        os.environ["HERMES_OMP_COMMAND"] = json.dumps([
            shutil.which("omp"), "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-tools",
            "--session-dir", str(self.root / "sessions"),
        ])
        state = self.root / "state"
        state.mkdir(mode=0o700)
        (state / "config.json").write_text(json.dumps({
            "max_running_sessions": 2, "worker_timeout": 120,
            "idle_timeout": 120, "shutdown_grace": 3, "termination_grace": 1,
        }))
        self.service = subprocess.Popen([sys.executable, str(Path(__file__).with_name("supervisor.py"))],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        deadline = time.monotonic() + 10
        while not (state / "supervisor.sock").exists() and time.monotonic() < deadline:
            if self.service.poll() is not None:
                self.fail("Supervisor startup failed: " + self.service.stderr.read())
            time.sleep(0.05)
        self.assertTrue((state / "supervisor.sock").exists())

    def tearDown(self):
        self.service.terminate()
        try:
            self.service.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.service.kill()
            self.service.wait()
        self.service.stderr.close()
        for key, value in self.previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.temp.cleanup()

    def start(self, **params):
        return request("start", cwd=str(self.root), **params)

    def worker_id(self, worker):
        return worker["id"]

    def test_invalid_lifetimes_cannot_disable_the_hard_deadline(self):
        for value in (0, -1, float("inf"), float("nan")):
            with self.subTest(value=value):
                with self.assertRaises(SupervisorError) as caught:
                    self.start(worker_timeout=value)
                self.assertEqual(caught.exception.code, "invalid_timeout")
                self.assertEqual(request("list")["live_count"], 0)

    def test_parallel_admission_never_exceeds_limit_and_idle_workers_count(self):
        def attempt(index):
            try:
                return self.start(name=f"worker-{index}")
            except SupervisorError as exc:
                return exc.code
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(attempt, range(4)))
        successful = [result for result in results if isinstance(result, dict)]
        self.assertEqual(len(successful), 2)
        self.assertEqual([result for result in results if isinstance(result, str)], ["session_limit_reached"] * 2)
        listing = request("list")
        self.assertEqual(listing["live_count"], 2)
        request("stop", worker=self.worker_id(successful[0]))
        replacement = self.start()
        self.assertTrue(replacement["pid"])
        self.assertEqual(request("list")["live_count"], 2)

    def test_idle_expiry_ignores_observer_polling_and_releases_slot(self):
        worker = self.start(idle_timeout=2)
        wid = self.worker_id(worker)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            state = request("status", worker=wid)
            request("events", worker=wid)
            if state["state"] == "exited":
                break
            time.sleep(0.2)
        self.assertEqual(state["stop_reason"], "idle_timeout")
        self.assertIsNone(state["pid"])
        self.assertEqual(request("list")["live_count"], 0)
        # OMP deliberately does not persist a conversation before its first assistant turn.
        self.assertFalse(state["persisted"])
        with self.assertRaises(SupervisorError) as caught:
            request("resume", worker=wid)
        self.assertEqual(caught.exception.code, "session_missing")

    def test_hard_deadline_does_not_reset_on_status_or_busy_bash(self):
        worker = self.start(worker_timeout=5, idle_timeout=1)
        wid = self.worker_id(worker)
        initial = request("status", worker=wid)["deadline"]
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(request, "rpc", worker=wid, command={"type": "bash", "command": "sleep 30"})
            time.sleep(0.5)
            self.assertEqual(request("status", worker=wid)["deadline"], initial)
            request("wait", worker=wid, until="exit", timeout=15)
            try:
                pending.result(timeout=5)
            except SupervisorError:
                pass
        stopped = request("status", worker=wid)
        self.assertEqual(stopped["stop_reason"], "worker_timeout")
        self.assertEqual(request("list")["live_count"], 0)

    def test_restart_stops_unattached_worker_before_accepting_new_work(self):
        import client
        worker = self.start()
        wid = worker["id"]
        with ThreadPoolExecutor(max_workers=1) as pool:
            busy = pool.submit(request, "rpc", worker=wid, command={"type": "bash", "command": "sleep 30"})
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and request("status", worker=wid)["state"] not in ("running", "blocked"):
                time.sleep(0.05)
            self.service.kill()
            self.service.wait(timeout=5)
            self.service.stderr.close()
            self.service = subprocess.Popen(
                [sys.executable, str(Path(__file__).with_name("supervisor.py"))],
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
            deadline = time.monotonic() + 12
            listing = None
            while time.monotonic() < deadline:
                try:
                    listing = client._exchange("list", {}, 2)
                    break
                except (FileNotFoundError, ConnectionRefusedError):
                    time.sleep(0.05)
            self.assertIsNotNone(listing, "Recovery did not become ready")
            recovered = next(w for w in listing["workers"] if w["id"] == wid)
            self.assertEqual(recovered["state"], "exited")
            self.assertIsNone(recovered["pid"])
            self.assertEqual(listing["live_count"], 0)
            try:
                busy.result(timeout=5)
            except SupervisorError:
                pass
        replacement = self.start()
        self.assertNotEqual(replacement["pid"], worker["pid"])
        self.assertEqual(request("list")["live_count"], 1)

    def test_notifications_are_origin_scoped_and_acknowledged(self):
        worker = self.start(origin="hermes:test-origin")
        wid = self.worker_id(worker)
        request("stop", worker=wid)
        notifications = request("notifications", origin="hermes:test-origin")["notifications"]
        self.assertTrue(any(n["worker"] == wid for n in notifications))
        self.assertEqual(request("notifications", origin="hermes:other-origin")["notifications"], [])
        for notification in notifications:
            request("ack", notification_id=notification["id"])
        self.assertEqual(request("notifications", origin="hermes:test-origin")["notifications"], [])


if __name__ == "__main__":
    unittest.main()
