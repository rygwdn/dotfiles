import { command, load, type LoadedStore, type StoreConfig } from "./store";

const keyPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const hostPattern = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

function validate(cfg: StoreConfig, path: string, value: string): string[] {
  if (cfg.offline) throw new Error("Cannot add secrets in offline mode");
  if (!hostPattern.test(cfg.host) || !cfg.store.startsWith("/") || /[\r\n\0]/.test(cfg.store)) {
    throw new Error("Invalid SSH host or absolute store path");
  }
  if (typeof path !== "string" || path.length === 0) throw new Error("Secret path must not be empty");
  const parts = path.split("/");
  if (parts.some(part => !keyPattern.test(part))) {
    throw new Error("Secret path segments must contain only letters, digits, underscores, and hyphens");
  }
  if (parts.length === 1 && parts[0] === "EXAMPLE_TOKEN") throw new Error("Top-level EXAMPLE_TOKEN is reserved by the secret store");
  if (typeof value !== "string" || value.length < 8 || value.includes("\0")) {
    throw new Error("Secret value must be a NUL-free string of at least 8 characters for OMP environment redaction");
  }
  return parts;
}
const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

// The request, including the value, is read only from SSH stdin. This script emits
// fixed status tokens; neither subprocess diagnostics nor decrypted data are returned.
const remoteScript = String.raw`
import fcntl, hashlib, json, os, re, stat, subprocess, sys, tempfile
committed = False

KEY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")

def result(status):
    sys.stdout.write(status + "\n")
    sys.stdout.flush()

def main():
    global committed
    request = json.load(sys.stdin)
    store = request.get("store")
    path = request.get("path")
    value = request.get("value")
    if not isinstance(store, str) or not os.path.isabs(store) or any(c in store for c in "\r\n\0"):
        return "INVALID"
    if not isinstance(path, list) or not path or any(not isinstance(k, str) or not KEY.fullmatch(k) for k in path):
        return "INVALID"
    if len(path) == 1 and path[0] == "EXAMPLE_TOKEN":
        return "INVALID"
    if not isinstance(value, str) or len(value.encode("utf-16-le", "surrogatepass")) // 2 < 8 or "\0" in value:
        return "INVALID"

    parent = os.path.dirname(store)
    lock_path = store + ".omp-lock"
    lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        os.fchmod(lock_fd, 0o600)
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        fd = os.open(store, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            original_stat = os.fstat(fd)
            if not stat.S_ISREG(original_stat.st_mode):
                return "FAILED"
            with os.fdopen(fd, "rb", closefd=False) as source:
                original = source.read()
        finally:
            os.close(fd)
        original_hash = hashlib.sha256(original).digest()

        env = os.environ.copy()
        env["SOPS_AGE_KEY_FILE"] = "/root/.config/sops/age/keys.txt"
        decrypted = subprocess.run(
            ["sops", "--decrypt", "--output-type", "json", store],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env=env, check=False
        )
        if decrypted.returncode != 0:
            return "FAILED"
        try:
            root = json.loads(decrypted.stdout)
        except Exception:
            return "FAILED"
        if not isinstance(root, dict):
            return "FAILED"

        target = root
        missing_parent = None
        for index, segment in enumerate(path[:-1]):
            if segment not in target:
                missing_parent = index
                break
            child = target[segment]
            if not isinstance(child, dict):
                return "EXISTS"
            target = child
        if missing_parent is None and path[-1] in target:
            return "EXISTS"

        candidate = "OMP_SECRET_" + "_".join(path).replace("-", "_").upper()
        normalized_names = set()
        collision = False
        def visit(node, prefix):
            nonlocal collision
            for key, child in node.items():
                if not isinstance(key, str) or not KEY.fullmatch(key):
                    raise ValueError()
                if not prefix and key == "EXAMPLE_TOKEN":
                    continue
                next_path = prefix + [key]
                if isinstance(child, dict):
                    visit(child, next_path)
                    continue
                if not isinstance(child, str) or len(child.encode("utf-16-le", "surrogatepass")) // 2 < 8 or "\0" in child:
                    raise ValueError()
                normalized = "OMP_SECRET_" + "_".join(next_path).replace("-", "_").upper()
                if normalized in normalized_names or normalized == candidate:
                    collision = True
                normalized_names.add(normalized)
        try:
            visit(root, [])
        except Exception:
            return "FAILED"
        if collision:
            return "COLLISION"

        fd, temporary = tempfile.mkstemp(prefix=".omp-secrets-", suffix=os.path.splitext(store)[1], dir=parent)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "wb") as target_file:
                target_file.write(original)
                target_file.flush()
                os.fsync(target_file.fileno())
            update_path = path
            update_value = value
            if missing_parent is not None:
                update_value = {}
                cursor = update_value
                for segment in path[missing_parent + 1:-1]:
                    cursor[segment] = {}
                    cursor = cursor[segment]
                cursor[path[-1]] = value
                update_path = path[:missing_parent + 1]
            path_expr = "".join("[" + json.dumps(segment) + "]" for segment in update_path)
            updated = subprocess.run(
                ["sops", "set", "--value-stdin", temporary, path_expr],
                input=json.dumps(update_value).encode("utf-8"), stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, env=env, check=False
            )
            if updated.returncode != 0:
                return "FAILED"
            temp_fd = os.open(temporary, os.O_RDWR | getattr(os, "O_NOFOLLOW", 0))
            try:
                temp_stat = os.fstat(temp_fd)
                if not stat.S_ISREG(temp_stat.st_mode):
                    return "FAILED"
                os.fchown(temp_fd, original_stat.st_uid, original_stat.st_gid)
                os.fchmod(temp_fd, stat.S_IMODE(original_stat.st_mode))
                os.fsync(temp_fd)
            finally:
                os.close(temp_fd)

            current_fd = os.open(store, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            try:
                current_stat = os.fstat(current_fd)
                with os.fdopen(current_fd, "rb", closefd=False) as current_file:
                    current_hash = hashlib.sha256(current_file.read()).digest()
            finally:
                os.close(current_fd)
            if current_hash != original_hash or current_stat.st_ino != original_stat.st_ino or current_stat.st_dev != original_stat.st_dev:
                return "CHANGED"

            os.replace(temporary, store)
            committed = True
            dir_fd = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
            return "ADDED"
        finally:
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except FileNotFoundError:
                    pass
    finally:
        os.close(lock_fd)

try:
    status = main()
except Exception:
    status = "COMMITTED" if committed else "FAILED"
result(status)
`;

const statuses: Record<string, string> = {
  INVALID: "Invalid secret request",
  EXISTS: "A secret or non-object path already exists at that destination",
  COLLISION: "Secret path collides with an existing OMP environment name after normalization",
  CHANGED: "Central store changed during the update; no secret was added",
  FAILED: "Central store update failed; no secret was added",
};

/** Add a secret remotely without placing its value in an argument or on disk. */
export async function addSecret(cfg: StoreConfig, path: string, value: string): Promise<LoadedStore> {
  const parts = validate(cfg, path, value);
  const request = Buffer.from(JSON.stringify({ store: cfg.store, path: parts, value }), "utf8");
  let response: Buffer;
  try {
    response = await command("ssh", [
      "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "ConnectionAttempts=1",
      cfg.host, `python3 -c ${shellQuote(remoteScript)}`,
    ], request, 60_000);
  } catch {
    request.fill(0);
    throw new Error("Central store update could not be confirmed; inspect /secrets before retrying");
  }
  request.fill(0);
  const status = response.toString("utf8");
  if (status !== "ADDED\n" && status !== "COMMITTED\n") throw new Error(statuses[status.trim()] ?? "Central store update could not be confirmed; inspect /secrets before retrying");
  try {
    return await load(cfg, true);
  } catch {
    throw new Error("Secret was added, but the encrypted cache could not be refreshed; do not retry the add. Run omp-secrets sync to refresh.");
  }
}
