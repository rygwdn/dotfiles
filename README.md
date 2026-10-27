dotfiles
========

my dot files

## BB plugins

`bb-plugins/` holds ordinary source directories for the local BB plugins,
alongside `provider-omp`. The active checkout on this machine is
`/Users/traceywooden/dotfiles`, branch `master`.
Build and install from the chosen dotfiles checkout; plugin data stays in BB's
private storage under `~/.bb/plugins/<id>`.

| Directory | Imported source |
| --- | --- |
| `bots-sidebar` | [rygwdn/bb-bots-sidebar](https://github.com/rygwdn/bb-bots-sidebar), installed `bi12-bb-memory` revision `825fe7e48a5105e2a538504a1a429c8d3323618e` |
| `ballast` | [rygwdn/bb-plugin-ballast](https://github.com/rygwdn/bb-plugin-ballast), `a4643d066a3b93dc8087d42689e6d49ce657944f` plus the installed checkout's authored disk-reporting changes; upstream [braedonsaunders/bb-plugin-ballast](https://github.com/braedonsaunders/bb-plugin-ballast) |
| `continuity` | Local checkout `38d1cc7ebef68992397525f7ff2412f07df68276` |
| `memory-fork` | [rygwdn/bb-plugin-memory-fork](https://github.com/rygwdn/bb-plugin-memory-fork), `df8b46b60f9f380d7c794e788383f0c8b21798fe`; upstream attribution in its `UPSTREAM.md` and `LICENSE` |

For a plugin already installed from a local path, run its documented checks,
then move the existing installation
with `bb plugin install /absolute/path/to/dotfiles/bb-plugins/<directory> --yes`.
This preserves its ID, settings and private data. Later source edits use
`bb plugin reload <id>` after rebuilding. Do not uninstall to relocate a plugin.
BB 0.47.1 refuses this move for the Git-managed `bots-sidebar` installation.
Its source is ready here, but the live source remains the exact managed revision.
Registration is a normalized row in `~/.bb/bb.db` (`plugins`), including the active
artifact pointer; changing only `source` or `root_dir` is insufficient. A live
external edit cannot acquire BB's in-memory lifecycle/registration locks or
exclude its periodic update checks. The remaining move therefore requires a
supported configuration-preserving Git-to-path operation, or an explicitly
authorized maintenance window with BB stopped for a backed-up targeted change.
Do not uninstall or edit the live registry to bypass this guard.
Dependencies and runtime state are excluded from Git; Memory Fork retains its
previously tracked distribution files. The original checkouts and managed Bots
Sidebar cache are retained. The three relocated plugins and `provider-omp` use these dotfiles
directories at runtime; the Bots Sidebar cache remains active while its move
is blocked.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/rygwdn/dotfiles/master/init.py | python3
```

This clones the repo to `~/dotfiles` (or pulls if it already exists) and symlinks everything.

To preview what would be linked without making changes:

```sh
python3 ~/dotfiles/init.py --dry
```

## Hermes OMP supervisor

`hermes/plugins/omp` is a native Hermes plugin with an independent local
supervisor. OMP workers run with `--mode rpc-ui`; Hermes and the external
`hermes-omp` CLI share their structured control channel. No herdr dependency:
run the native-TUI takeover command in a herdr pane if desired.

### Install and enable

Requires Unix, Python 3.11+, Hermes native plugins, and OMP. Tested with OMP
18.8.7 and Hermes 0.21.6+131.

```sh
python3 ~/dotfiles/init.py
hermes plugins enable omp
hermes tools enable omp --platform cli
hermes config set plugins.entries.omp.allow_gateway_injection true
# Enable on each messaging surface you use, too:
hermes tools enable omp --platform telegram
hermes plugins doctor omp --ci
```

The installer links the plugin into the default and `codr` profiles, and the CLI
to `~/.local/bin/hermes-omp`. Enable it in `codr` with the commands above using
`hermes -p codr` instead of `hermes`. Other named profiles need their own plugin
link, toolset enablement, and injection permission. Existing conversations may need
a new session to discover the tools. The injection permission is required for
modern TUI/desktop and gateway delivery; classic CLI uses its attached REPL.

Hermes exposes `omp_start`, `omp_sessions`, `omp_resume`, `omp_send`,
`omp_status`, `omp_watch`, `omp_wait`, `omp_btw`, `omp_pending`, `omp_answer`,
`omp_abort`, `omp_stop`, `omp_rpc`, and `omp_extend`. Tool timeout values are
seconds. Normal questions can be answered through Hermes; confirm dialogs
require an explicit human response through the external CLI.

### Limits and lifetime

Defaults: **3 live workers**, **2-hour maximum lifetime**, **30-minute idle
timeout**, **30-second shutdown grace**, and **5-second termination grace**.
Starting, working, idle, blocked, stopping, and controller-managed takeover
processes all consume slots. At capacity, new starts/resumes fail rather than
queueing work or evicting another session. Reconnecting to a live worker does
not consume another slot.

```sh
hermes-omp config
hermes-omp config --max-running-sessions 3 --worker-timeout 2h --idle-timeout 30m
hermes-omp start --cwd ~/bookorbit --name importer --message "Investigate the importer"
hermes-omp start --cwd ~/bookorbit --worker-timeout 45m --idle-timeout 10m
hermes-omp extend <worker-id> 30m
```

Configuration is stored as JSON in `~/.local/state/hermes-omp/config.json`.
New operations load changes; existing workers retain their recorded lifetime
and idle durations. Lowering capacity blocks admissions without killing workers.
Lifetime does not reset on output, retries, or automatic continuation. Idle
means settled with no pending question, side question, command, or background
work. Observing status/output does not keep a worker alive.

Expiry aborts work, closes RPC input while draining output, then escalates to
termination if necessary. Status records the stop reason; a `_forced` suffix
means forced termination and possible loss of the latest unsaved state.
Resume starts a fresh lifetime; expired workers never restart automatically.
An empty conversation may not yet have a durable OMP file and cannot be resumed.
The worker count is not a hard RAM cap: tools and subagents can use more memory.

### Observe, stop, and take over without Hermes

```sh
hermes-omp list
hermes-omp status <worker-id>
hermes-omp watch <worker-id>
hermes-omp transcript <worker-id>
hermes-omp pending <worker-id>
hermes-omp answer <worker-id> <request-id> --value "Exact option label"
hermes-omp answer <worker-id> <request-id> --confirm yes
hermes-omp btw <worker-id> "What is blocking progress?"
hermes-omp abort <worker-id>
hermes-omp stop <worker-id>
hermes-omp resume <worker-id>
hermes-omp takeover <worker-id>
```

`takeover` requires a terminal. It reserves the slot, interrupts active work,
verifies clean RPC exit and the saved conversation, then launches normal
`omp --resume <exact-session-path>`. Queued input or work that cannot settle
prevents handoff; forced/persistence-failed shutdown never silently launches a
competing TUI. The tracked TUI keeps its slot but has no unattended timers.
Exit the TUI before resuming RPC control. Arbitrary manually launched OMP
processes are outside the supervisor's ownership guarantee and capacity limit.

`--json` produces machine-readable CLI output. `watch` includes live deltas;
`btw` returns its running record immediately and `watch` shows its final answer.
The Hermes `omp_btw` tool instead waits for the answer up to its requested timeout.
`wait --until settled|input|exit|prompt --timeout 60s` provides bounded waits;
prompt waits also require `--prompt-id` from a send result.
`rpc` accepts supported command JSON; transport framing/UI answers are owned by
the supervisor, and credential-management commands are deliberately not exposed.

### Push delivery and durability

Input requests, completion, failures, BTW answers, exit, and handoff updates
enter a durable outbox. The plugin injects them into the exact originating
Hermes conversation without model-side polling. Session reset or a reused
gateway chat does not redirect old notifications to a new conversation.
Offline updates remain pending until the matching session reconnects.
Delivery acknowledgment means Hermes accepted the injection, not that its
model processed it. In-process retries deduplicate accepted notifications;
crashes between acceptance and acknowledgment can still cause redelivery.

Workers survive Hermes exit/reload. The supervisor is a detached, on-demand
daemon, not a login service; the next client starts it if absent. Its private
Unix socket, SQLite registry, event journal, and outbox live under
`~/.local/state/hermes-omp` (override with `HERMES_OMP_STATE_DIR` or CLI
`--state-dir`). They contain conversation data; protect them as private files.
After supervisor failure, unrecoverable RPC pipes are not reattached: surviving
owned RPC process groups are stopped and their conversations remain available
for explicit resume. Live tracked TUIs retain their reservation.

`hermes-omp daemon-stop` stops the supervisor's RPC workers and the daemon.
There is no automatic eviction, restart, or permission approval.
For isolated development, `HERMES_OMP_COMMAND` accepts a JSON executable/argument
prefix; workers append their RPC/cwd/resume flags.

Regression checks use real OMP processes without model calls:

```sh
python3 -m unittest discover -s hermes/plugins/omp -p 'test_*.py' -v
```

## OMP central secrets

`omp/secrets/extension.ts` adds a metadata-only agent tool and a `/secrets` TUI
manager. The dotfiles installer links it into `~/.omp/agent/extensions`, so
ordinary `omp` awaits secret loading before building its built-in obfuscator:

```sh
# Workstation dependencies; Proxmox already has sops and age.
brew install age
omp-secrets init
omp-secrets sync
omp

# Offline startup; normal startup also falls back when SSH/export fails.
OMP_SECRETS_OFFLINE=1 omp
```

The auto-discovery link is installed on this workstation. On another Unix
workstation, run `python3 ~/dotfiles/init.py` to install the link, then
`omp-secrets init`. Requires Bun, OpenSSH, age, and OMP 18.4.4 or newer.
Named profiles and `PI_CODING_AGENT_DIR` have separate extension directories;
link `~/dotfiles/omp/secrets/extension.ts` into their `agent/extensions/` directory
as `omp-secrets.ts` too. `--no-extensions` intentionally disables this feature.

`bin/omp-secrets` remains available through the existing `~/.bin` link for
`init`, `sync`, and metadata-only `status`. Its optional `run` command still
preloads the environment, but is no longer required for CLI sessions.

### Hermes command adapter

`omp-secrets hermes` exports the same normalized `OMP_SECRET_*` names through
Hermes' bulk command-secret source. Add this to the desired Hermes profile's
`config.yaml` (not `.env`); replace the absolute checkout path if necessary:

```yaml
secrets:
  command:
    enabled: true
    command: 'OMP_SECRETS_CACHE_TTL_SECONDS=300 /Users/traceywooden/dotfiles/bin/omp-secrets hermes'
    helper_timeout_seconds: 60
    override_existing: false
```

Bun and age must be on Hermes' PATH, and the offline identity must already
exist (`omp-secrets init`). The example refreshes from Proxmox only when the
encrypted cache is missing or expired; a fresh cache avoids SSH. The 60-second
helper timeout allows bounded SSH/decryption operations (Hermes defaults to
only 3 seconds). For strictly offline startup, prepend `OMP_SECRETS_OFFLINE=1`
to the command; an existing cache is then required regardless of its age.
The usual `OMP_SECRETS_IDENTITY` and `OMP_SECRETS_CACHE` overrides also apply.

#### Encrypted-cache TTL

`OMP_SECRETS_CACHE_TTL_SECONDS` applies to the shared loader, including ordinary
OMP startup, `status`, `run`, and `hermes`. Default: **300 seconds**.
Use nonnegative decimal seconds (fractional seconds allowed); `0` restores
fetch-every-invocation behavior. Empty, negative, nonfinite, exponent/hex,
whitespace-padded, or millisecond-overflowing settings fail before cache/SSH
access, including in offline mode.

- Fresh means `0 <= now - cache mtime < TTL`. Cache hits decrypt and validate
  the ciphertext without SSH or rewriting/touching its mtime. Future timestamps
  count as expired. Missing/expired caches attempt a remote refresh.
- A successful refresh validates the received ciphertext/schema before atomic
  encrypted-cache replacement; its new mtime starts the TTL.
- Transport/export-command failures fall back to the existing cache even when
  stale, without advancing its mtime. Each subsequent invocation retries while
  expired. A missing or corrupt fallback cache fails.
- Received corruption/schema errors fail closed: no stale fallback and no cache
  replacement. A corrupt fresh cache also fails; it is not treated as a miss.
  An expired cache can be replaced by a successfully validated remote snapshot.
- `OMP_SECRETS_OFFLINE=1` always suppresses SSH and uses the cache irrespective
  of TTL. `omp-secrets sync` ignores freshness and forces remote fetch, with no
  transport fallback; combined with offline mode it fails without contacting SSH.

TTL is checked **on invocation**, not by a background daemon. Installed Hermes'
`CommandSource.fetch()` runs the helper on every source fetch and uses no
command-specific in-memory/disk cache. Its environment loader guards startup
fetches once per profile/home (including failed attempts); its internal
`reset_secret_source_cache()` allows the next load to fetch again. Therefore TTL
expiry alone does not update an already-running Hermes environment: a new
startup or Hermes source reload/refresh must invoke the helper. Existing
`override_existing` precedence still applies; this adapter adds no scheduler.

For example, `homelab/bookorbit/api_key` becomes
`OMP_SECRET_HOMELAB_BOOKORBIT_API_KEY`, not `BOOKORBIT_API_KEY`. No aliases or
automatic renaming are added. Hermes' existing shell/`.env` values win with
`override_existing: false`. OMP's redactor is not installed into Hermes by this
adapter; use Hermes' own security boundaries.

Protocol: no stdin, no JSON requests, no get/set/delete operations. Hermes runs
the helper once via `/bin/sh -c` with an empty `HERMES_SECRET_KEY`, parses stdout
as a bulk `KEY=VALUE` map, and discards stderr. Success emits only quoted dotenv
lines; quotes, spaces, equals signs, backslashes, and Unicode remain literal.
By default, Hermes does not decode escapes or multiline dotenv values:
CR/LF-containing or whitespace-only secrets reject the entire export, as does
output over 1 MiB. Failures exit nonzero with empty stdout and a fixed,
value-free stderr message. Only the optional flag below is accepted; nonempty
`HERMES_SECRET_KEY` is rejected. Never run this mode in a terminal, redirect it
to plaintext files, or log its stdout.

#### Explicit newline markers

Opt in only when **every consumer is prepared to decode** the output:

```yaml
secrets:
  command:
    enabled: true
    command: 'OMP_SECRETS_CACHE_TTL_SECONDS=300 /Users/traceywooden/dotfiles/bin/omp-secrets hermes --escape-newlines'
    helper_timeout_seconds: 60
    override_existing: false
```

`--escape-newlines` encodes **all** values, including single-line credentials:
literal backslash becomes `\\`, CR becomes `\r`, and LF becomes `\n`.
CRLF becomes `\r\n`, not one normalized newline. All other characters remain
literal. Thus a literal backslash followed by `n` encodes as `\\n`, distinct
from an actual LF's `\n`. Whitespace-only original values still fail.
The 1 MiB cap is checked after encoding.

Hermes parses the quotes but **does not decode these markers**. Passing the
encoded credential directly to an API will change it. Consumers must decode
left-to-right exactly once, recognizing only `\\`, `\r`, and `\n`; reject a
trailing backslash or any other escape. Do not use chained replacements,
`unicode_escape`, shell `eval`, or a general dotenv decoder.

Example consumer decoder (operates in memory; do not print the result):

```python
def decode_omp_markers(value: str) -> str:
    result = []
    i = 0
    markers = {"\\": "\\", "r": "\r", "n": "\n"}
    while i < len(value):
        if value[i] != "\\":
            result.append(value[i])
            i += 1
            continue
        i += 1
        if i == len(value) or value[i] not in markers:
            raise ValueError("Invalid OMP newline marker")
        result.append(markers[value[i]])
        i += 1
    return "".join(result)
```

There is no automatic detection: choose one mode per helper configuration and
decode only escaped-mode values. Default mode preserves exact single-line
values, including literal backslashes, and fails rather than mutating multiline
credentials.

Contract references:
[official command-source documentation](https://hermes-agent.nousresearch.com/docs/user-guide/secrets/command)
and installed Hermes `agent/secret_sources/command.py` (`CommandSource.fetch`,
`_parse_dotenv_map`). The installed source, not a guessed RPC schema, defines
the quote handling and bulk-only operation.

Synthetic regression tests (local Bun and age required):

```sh
bun test omp/secrets/store.test.ts omp/secrets/hermes.test.ts

# Also exercise the actual installed Hermes CommandSource against a temporary
# synthetic encrypted store; adjust these paths for another installation.
HERMES_TEST_SOURCE="$HOME/.hermes/hermes-agent" \
HERMES_TEST_PYTHON="$HOME/.hermes/tools/python-3.14.7+20260901-darwin-arm64/bin/python3" \
  bun test omp/secrets/store.test.ts omp/secrets/hermes.test.ts
```

The installed-contract test uses an explicit isolated child environment; it
does not load Hermes configuration or inspect/modify real credential stores.

### TUI management

Enter `/secrets` in interactive OMP:

- **Browse:** Up/Down selects a logical path; Enter opens its value inspector.
- **Inspect:** values start masked. Space/Enter toggles a local reveal;
  Up/Down and PgUp/PgDn scroll long values. Escape closes the panel. Terminal
  controls are escaped before display; values never enter agent messages.
- **Add secret:** select the final menu item, enter a path, then enter/paste a
  masked value. Enter adds a line; Ctrl+S or Ctrl+Enter submits. Multiline paste
  preserves tabs, CRLF, Unicode, and trailing newlines. Escape cancels.
- Confirm the exact SSH host, store file, and destination path before saving.
  Existing paths and environment-name collisions are rejected, not overwritten.
  Offline inspection works; offline writes are refused.

Writes send the value through SSH stdin, never command arguments. SOPS updates
a temporary **encrypted** file before replacement, preserving recipients,
ownership, and permissions. Our writers share a lock and check for intervening
file changes; avoid concurrent edits from external SOPS editors.
Successful writes refresh the encrypted cache. **Restart OMP before an agent
uses a newly added entry:** the live environment and obfuscator remain fixed.
If a write committed but cache refresh failed, the TUI says not to retry the add.

The TUI is user-only; agent tools and RPC clients cannot request a value reveal
or an edit. Revealing a value makes it visible to the terminal, screenshots,
and recordings; closing the panel is not a secure erasure guarantee.

### Store and cache

The source remains the existing SOPS/age file
`proxmox:/root/.secrets/omp-tokens.yaml`. Over authenticated SSH, the client
sends its **public** age recipient. Proxmox decrypts the source into a pipe
and immediately age-encrypts the JSON snapshot to that recipient. Only
ciphertext crosses SSH stdout and is cached locally; the server's private key
and SOPS recipients remain unchanged.

The workstation has a separate `0600` age identity at
`~/.config/omp-secrets/identity.txt` and an encrypted snapshot at
`~/.cache/omp-secrets/store.age`, inside `0700` directories. Decryption happens
in memory. A fetched snapshot is decrypted and validated before atomic cache
replacement. Invalid received ciphertext or secret data is rejected without
installing new values; plain OMP reports an extension-load error and continues
without this extension. The optional launcher exits before starting OMP on
failure. SSH/export failure permits cache fallback. `sync` requires a successful
remote fetch. `status` reports names, source, and timestamp only; it refreshes online.

`omp/secrets/proxmox-loader.sh` is deployed as `/usr/local/bin/omp-secrets` on
Proxmox. It exports only top-level string entries to its existing bash, fish,
and systemd consumers; nested objects are ignored. This replaces SOPS's dotenv
conversion, which fails on nested data. Existing flat credentials and the
`*_CONTENT` materialization commands are preserved.

Configuration is through environment variables:

| Variable | Default |
| --- | --- |
| `OMP_SECRETS_HOST` | `proxmox` (OpenSSH alias, not an OMP SSH-host id) |
| `OMP_SECRETS_STORE` | `/root/.secrets/omp-tokens.yaml` |
| `OMP_SECRETS_IDENTITY` | `~/.config/omp-secrets/identity.txt` |
| `OMP_SECRETS_CACHE` | `~/.cache/omp-secrets/store.age` |
| `OMP_SECRETS_CACHE_TTL_SECONDS` | `300`; nonnegative decimal seconds; `0` always attempts remote fetch unless offline |
| `OMP_SECRETS_OFFLINE` | unset; `1` skips SSH |
| `OMP_SECRETS_OMP` | `omp` executable |

Overridden identity/cache paths must be absolute; `~` in a variable is not
expanded. Remote decryption currently uses the existing server identity
`/root/.config/sops/age/keys.txt`.

### Agent usage and redaction

The `secrets` tool lists logical paths and corresponding environment names,
with an optional `prefix` filter. A nested path `homelab/bookorbit/api_key`
becomes `OMP_SECRET_HOMELAB_BOOKORBIT_API_KEY`. Existing flat keys keep their
names after the prefix; for example `GITHUB_TOKEN` becomes
`OMP_SECRET_GITHUB_TOKEN`. Original environment names are **not** overwritten.
Use per-command bindings for programs that expect a conventional name:

```sh
GH_TOKEN="$OMP_SECRET_GITHUB_TOKEN" gh api user

# Example for a nested BookOrbit entry, once added to the central store:
curl https://example.invalid/api \
  -H "Authorization: Bearer $OMP_SECRET_HOMELAB_BOOKORBIT_API_KEY"
```

Keys may contain letters, digits, underscores, and hyphens. Objects provide
nested namespaces; leaves must be NUL-free strings of at least eight
characters, matching OMP's environment-redaction minimum. Unsupported leaves
and normalized-name collisions fail closed. `EXAMPLE_TOKEN` is excluded;
`*_CONTENT` blobs are available as environment values, not materialized files.

The CLI awaits the extension's async factory before constructing the session.
The factory enables `secrets.enabled`, decrypts the snapshot, and injects
`OMP_SECRET_*` variables before that scan. It provides guidance without placing
values in prompts or tool definitions. Subagent and reload factories reuse the
process snapshot; they do not rotate a live session's credentials.

`secrets://...` is a logical reference, **not** a registered URI or shell file.
OMP URI routing would not make `cat secrets://...` work inside a real shell.
Session-hook injection is too late. Direct SDK sessions can build their
obfuscator before loading factories, so SDK callers must prepare the environment
and enable redaction **before** creating a session; extension-only loading is
supported for the CLI, not standalone SDK initialization.

### Security boundaries

- Restart OMP after secret rotation; a running session uses a fixed snapshot.
  Offline credentials may be stale or revoked; the cache timestamp is shown.
- Every injected credential is available to the OMP process and its children.
  This is not per-tool access control or isolation from untrusted commands.
- Built-in redaction protects provider-visible **text**, not local terminal
  output, session/log files, arbitrary network requests, or binary payloads.
  Do not print secrets or put their expanded values in prompts.
- Encryption protects the cached file, not a compromised workstation. The
  local identity can decrypt it; use disk encryption and protect backups.
  `init` preserves an existing identity. Keep that identity to retain offline
  access; never commit it or cached credential data.

Verification: `bun test omp/secrets/store.test.ts` requires local age tooling.
