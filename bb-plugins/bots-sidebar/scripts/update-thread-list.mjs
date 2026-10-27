#!/usr/bin/env node
/**
 * Vendor the upstream BB thread-list sources into vendor/bb, byte-exact, with a
 * hash manifest.
 *
 * Usage:
 *   node scripts/update-thread-list.mjs --source <checkout>   # local git checkout
 *   node scripts/update-thread-list.mjs --ref <revision>      # fetch temp checkout of get-bb/bb
 *   node scripts/update-thread-list.mjs --check                # verify vendored tree
 *
 * Managed source -> vendor path mapping:
 *   plugins/thread-list/**                                  -> vendor/bb/thread-list/**
 *   packages/shared-ui/src/**                               -> vendor/bb/shared-ui/**
 *   packages/plugin-registry/flavors/components/ui/icon.tsx -> vendor/bb/icon.tsx
 *   LICENSE                                                 -> vendor/bb/LICENSE
 *
 * File bytes are read from the pinned commit objects (git cat-file), so the
 * supplied checkout is never modified and does not need the managed paths
 * materialised in its work tree.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const SOURCE_URL = 'https://github.com/get-bb/bb.git'
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..')
const VENDOR_DIR = path.join(REPO_ROOT, 'vendor')
const VENDOR_BB = path.join(VENDOR_DIR, 'bb')
const MANIFEST_NAME = 'manifest.json'
const MANIFEST_PATH = path.join(VENDOR_BB, MANIFEST_NAME)

/** Managed source trees, copied recursively. */
const VENDORED_DIRS = [
  { src: 'plugins/thread-list', dest: 'thread-list' },
  { src: 'packages/shared-ui/src', dest: 'shared-ui' },
]

/** Managed single files. */
const VENDORED_FILES = [
  { src: 'packages/plugin-registry/flavors/components/ui/icon.tsx', dest: 'icon.tsx' },
  { src: 'packages/shared-ui/package.json', dest: 'shared-ui/package.json' },
  { src: 'LICENSE', dest: 'LICENSE' },
]

/** Git pathspecs used for sparse checkouts and tree listings. */
const MANAGED_PATHS = [...VENDORED_DIRS.map((d) => d.src), ...VENDORED_FILES.map((f) => f.src)]

/** Fatal error; thrown so that `finally` cleanup still runs. */
class ImportError extends Error {}

function fail(message) {
  throw new ImportError(message)
}

function parseArgs(argv) {
  const args = { source: null, ref: null, check: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--source') {
      args.source = argv[++i]
      if (!args.source) fail('--source requires a checkout path')
    } else if (arg === '--ref') {
      args.ref = argv[++i]
      if (!args.ref) fail('--ref requires a revision')
    } else if (arg === '--check') {
      args.check = true
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'Usage:',
          '  node scripts/update-thread-list.mjs --source <checkout>',
          '  node scripts/update-thread-list.mjs --ref <revision>',
          '  node scripts/update-thread-list.mjs --check',
        ].join('\n'),
      )
      process.exit(0)
    } else {
      fail(`unknown argument: ${arg}`)
    }
  }
  if (args.source && args.ref) fail('--source and --ref are mutually exclusive')
  if (!args.check && !args.source && !args.ref) fail('one of --source, --ref or --check is required')
  return args
}

function git(cwd, args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'buffer',
      maxBuffer: 1024 * 1024 * 256,
    })
  } catch (error) {
    if (allowFailure) return null
    const stderr = error.stderr ? error.stderr.toString().trim() : ''
    fail(`git ${args.join(' ')} failed in ${cwd}${stderr ? `: ${stderr}` : ''}`)
  }
}

function gitText(cwd, args, options) {
  const out = git(cwd, args, options)
  return out === null ? null : out.toString().trim()
}

/** True when the directory is inside a git work tree. */
function isGitRepo(dir) {
  return gitText(dir, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true }) === 'true'
}

/** Parse `git ls-tree` output lines into { path, mode } entries. */
function parseTreeLines(out) {
  const files = []
  for (const line of out.toString().split('\n')) {
    if (!line.trim()) continue
    const tab = line.indexOf('\t')
    const meta = line.slice(0, tab)
    const parts = meta.split(/\s+/)
    const type = parts[1]
    const filePath = line.slice(tab + 1)
    if (type !== 'blob') continue
    files.push({ path: filePath, mode: parts[0] })
  }
  return files
}

/** List managed files (repo-relative) present in the given commit. */
function listManagedFiles(cwd, commit) {
  const files = []
  for (const dir of VENDORED_DIRS) {
    const out = git(cwd, ['ls-tree', '-r', '--full-tree', commit, '--', dir.src], {
      allowFailure: true,
    })
    if (out === null) fail(`unable to list ${dir.src} at ${commit}`)
    files.push(...parseTreeLines(out))
  }
  for (const file of VENDORED_FILES) {
    const out = git(cwd, ['ls-tree', '--full-tree', commit, '--', file.src], {
      allowFailure: true,
    })
    if (out === null) fail(`unable to list ${file.src} at ${commit}`)
    files.push(...parseTreeLines(out))
  }
  return files
}

/** Map a managed source path to its vendored path (relative to vendor/bb). */
function vendorPathFor(relPath) {
  for (const dir of VENDORED_DIRS) {
    if (relPath === dir.src) return dir.dest
    if (relPath.startsWith(`${dir.src}/`)) {
      return path.posix.join(dir.dest, relPath.slice(dir.src.length + 1))
    }
  }
  for (const file of VENDORED_FILES) {
    if (relPath === file.src) return file.dest
  }
  return null
}

function readBlob(cwd, commit, relPath) {
  const blob = git(cwd, ['cat-file', 'blob', `${commit}:${relPath}`], { allowFailure: true })
  if (blob === null) fail(`unable to read ${relPath} at ${commit}`)
  return blob
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** Recursively list files under dir (relative paths, POSIX separators). */
function listFilesRecursive(dir, prefix = '') {
  const results = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(abs, rel))
    } else if (entry.isFile()) {
      results.push(rel)
    }
  }
  return results
}

function resolveSourceUrl(cwd) {
  const url = gitText(cwd, ['remote', 'get-url', 'origin'], { allowFailure: true })
  if (url) return url
  return SOURCE_URL
}

/** Prepare a local checkout as the source of truth. */
function prepareLocalSource(sourcePath) {
  const cwd = path.resolve(sourcePath)
  if (!fs.existsSync(cwd)) fail(`source checkout not found: ${cwd}`)
  if (!isGitRepo(cwd)) fail(`source is not a git checkout: ${cwd}`)
  const commit = gitText(cwd, ['rev-parse', 'HEAD'])
  if (!commit) fail(`unable to resolve HEAD in ${cwd}`)
  const branch = gitText(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true })
  const revision = branch && branch !== 'HEAD' ? branch : commit.slice(0, 12)
  return { cwd, commit, revision, url: resolveSourceUrl(cwd), cleanup: null }
}

/** Fetch a temporary checkout of get-bb/bb at the requested revision. */
function prepareFetchedSource(ref) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-thread-list-'))
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true })
  try {
    git(tmp, ['init', '--quiet'])
    git(tmp, ['remote', 'add', 'origin', SOURCE_URL])
    const fetched = git(tmp, ['fetch', '--depth', '1', 'origin', ref], { allowFailure: true })
    if (fetched === null) fail(`unable to fetch ${ref} from ${SOURCE_URL}`)
    git(tmp, ['sparse-checkout', 'init', '--no-cone'])
    git(tmp, ['sparse-checkout', 'set', '--no-cone', ...MANAGED_PATHS], { allowFailure: true })
    git(tmp, ['checkout', '--quiet', '--detach', 'FETCH_HEAD'])
    const commit = gitText(tmp, ['rev-parse', 'HEAD'])
    if (!commit) fail(`unable to resolve FETCH_HEAD in ${tmp}`)
    return { cwd: tmp, commit, revision: ref, url: SOURCE_URL, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}

/** Collect the managed file set with exact bytes and hashes. */
function collectSourceFiles(source) {
  const files = listManagedFiles(source.cwd, source.commit)
  const collected = []
  const seen = new Set()
  for (const entry of files) {
    const dest = vendorPathFor(entry.path)
    if (!dest) continue
    if (seen.has(dest)) fail(`two managed sources map to the same vendor path: ${dest}`)
    seen.add(dest)
    const bytes = readBlob(source.cwd, source.commit, entry.path)
    collected.push({ dest, bytes, mode: entry.mode })
  }
  // Managed paths that do not exist in the commit are a hard error.
  for (const file of VENDORED_FILES) {
    if (!seen.has(file.dest)) fail(`missing required source file: ${file.src}`)
  }
  for (const dir of VENDORED_DIRS) {
    const any = files.some((entry) => entry.path.startsWith(`${dir.src}/`))
    if (!any) fail(`missing required source directory: ${dir.src}`)
  }
  collected.sort((a, b) => (a.dest < b.dest ? -1 : a.dest > b.dest ? 1 : 0))
  return collected
}

function buildManifest(source, files) {
  const hashes = {}
  for (const file of files) {
    hashes[file.dest] = sha256(file.bytes)
  }
  return {
    generatedBy: 'scripts/update-thread-list.mjs',
    source: {
      url: source.url,
      commit: source.commit,
      revision: source.revision,
    },
    files: hashes,
  }
}

function writeVendor(files, manifest) {
  fs.rmSync(VENDOR_BB, { recursive: true, force: true })
  fs.mkdirSync(VENDOR_BB, { recursive: true })
  for (const file of files) {
    const target = path.join(VENDOR_BB, file.dest)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, file.bytes)
    const mode = file.mode === '100755' ? 0o755 : 0o644
    fs.chmodSync(target, mode)
  }
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
}

/**
 * Compare the vendored tree against the recorded manifest.
 * Returns a list of problems: missing files, hash mismatches and unexpected
 * (unmanaged) files.
 */
function collectVendorProblems(manifest) {
  const problems = []
  if (!manifest.files || typeof manifest.files !== 'object') {
    return ['manifest has no "files" map']
  }
  for (const [rel, expected] of Object.entries(manifest.files)) {
    const target = path.join(VENDOR_BB, rel)
    if (!fs.existsSync(target)) {
      problems.push(`missing: ${rel}`)
      continue
    }
    const actual = sha256(fs.readFileSync(target))
    if (actual !== expected) problems.push(`hash mismatch: ${rel}`)
  }
  const present = fs.existsSync(VENDOR_BB) ? listFilesRecursive(VENDOR_BB) : []
  for (const rel of present) {
    if (rel === MANIFEST_NAME) continue
    if (!Object.prototype.hasOwnProperty.call(manifest.files, rel)) {
      problems.push(`unexpected: ${rel}`)
    }
  }
  return problems
}

function readManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) return null
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
  } catch (error) {
    fail(`unable to parse ${path.relative(REPO_ROOT, MANIFEST_PATH)}: ${error.message}`)
  }
}

function checkVendor() {
  const manifest = readManifest()
  if (!manifest) fail(`missing ${path.relative(REPO_ROOT, MANIFEST_PATH)}`)
  const problems = collectVendorProblems(manifest)
  if (problems.length > 0) {
    fail(`vendor check failed (${problems.length} problem(s)):\n  ${problems.join('\n  ')}`)
  }
  console.log(
    `vendor check ok: ${Object.keys(manifest.files).length} file(s) match ${path.relative(
      REPO_ROOT,
      MANIFEST_PATH,
    )} (commit ${manifest.source?.commit ?? 'unknown'})`,
  )
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.check) {
    checkVendor()
    return
  }

  const source = args.source ? prepareLocalSource(args.source) : prepareFetchedSource(args.ref)
  try {
    const files = collectSourceFiles(source)
    const manifest = buildManifest(source, files)
    // Refuse to replace a vendored tree that has drifted from its manifest.
    const existing = readManifest()
    if (existing) {
      const problems = collectVendorProblems(existing)
      if (problems.length > 0) {
        fail(
          `refusing to update: the vendored tree differs from ` +
            `${path.relative(REPO_ROOT, MANIFEST_PATH)} (${problems.length} problem(s)):\n  ` +
            `${problems.join('\n  ')}\nRestore or delete them before re-vendoring.`,
        )
      }
    }
    writeVendor(files, manifest)
    console.log(
      `vendored ${files.length} file(s) from ${source.url}@${source.commit} into ${path.relative(
        REPO_ROOT,
        VENDOR_BB,
      )}`,
    )
  } finally {
    if (source.cleanup) source.cleanup()
  }
}

try {
  main()
} catch (error) {
  if (error instanceof ImportError) {
    console.error(`error: ${error.message}`)
    process.exit(1)
  }
  throw error
}
