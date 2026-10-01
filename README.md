dotfiles
========

my dot files

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/rygwdn/dotfiles/master/init.py | python3
```

This clones the repo to `~/dotfiles` (or pulls if it already exists) and symlinks everything.

To preview what would be linked without making changes:

```sh
python3 ~/dotfiles/init.py --dry
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
