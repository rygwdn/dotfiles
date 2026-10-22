import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { experimental_nativeRootsResolveOutputSchema } from "@get-bb/plugin-sdk/host";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  OMP_NATIVE_ROOTS_DECLARATION,
  resolveOmpNativeRoots,
} from "./native-roots.js";

let homeDir: string;
let repoRoot: string;
let cwd: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "bb-omp-native-roots-"));
  repoRoot = join(homeDir, "repo");
  cwd = join(repoRoot, "packages", "app");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(repoRoot, ".git"), "gitdir: /worktree/common");
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

function writeSettings(
  dir: string,
  settings: unknown,
  filename = "config.yml",
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, filename),
    typeof settings === "string" ? settings : JSON.stringify(settings),
  );
}

function installSkill(agentDir: string, name: string, version = "1.0.0") {
  const dir = join(dirname(agentDir), "skillshare", "@team", name, version);
  const integrity = `sha512-${name}-${version}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".skillshare-integrity"), `${integrity}\n`);
  writeFileSync(
    join(dir, "SKILL.md"),
    "---\ndescription: Installed registry skill\n---\nUse this skill.",
  );
  return {
    path: realpathSync(dir),
    entry: {
      version,
      integrity,
      resolved: `/@team/${name}/${version}.tgz`,
    },
  };
}

async function resolvedSkillPaths(
  env: Readonly<Record<string, string | undefined>> = {},
  requestedCwd: string | null = cwd,
  origin?: "user" | "project",
): Promise<string[]> {
  const answer = await resolveOmpNativeRoots({
    homeDir,
    cwd: requestedCwd,
    env,
  });
  const parsed = experimental_nativeRootsResolveOutputSchema.parse(answer);
  expect(parsed.commands).toEqual([]);
  for (const root of parsed.skills) {
    expect(root).toMatchObject({
      recursive: false,
      ancestors: false,
      namePrefix: "",
    });
    expect(["skills", "skill-file"]).toContain(root.shape);
  }
  return parsed.skills
    .filter((root) => origin === undefined || root.origin === origin)
    .map((root) => root.path)
    .sort();
}

it("matches OMP's default shallow roots and bounds ancestors at a worktree's git file", async () => {
  const expected = [
    join(homeDir, ".omp", "agent", "skills"),
    join(homeDir, ".omp", "agent", "managed-skills"),
    join(homeDir, ".agent", "skills"),
    join(homeDir, ".agents", "skills"),
    join(cwd, ".codex", "skills"),
    join(cwd, ".opencode", "skills"),
    join(cwd, ".github", "skills"),
  ];
  for (const ancestor of [cwd, join(repoRoot, "packages"), repoRoot]) {
    for (const dir of [".omp", ".agent", ".agents", ".claude"]) {
      expected.push(join(ancestor, dir, "skills"));
    }
  }
  await expect(resolvedSkillPaths()).resolves.toEqual(expected.sort());
  expect(OMP_NATIVE_ROOTS_DECLARATION).toEqual({
    experimental_resolvesNativeRoots: true,
  });
});

it("does not add project roots when no workspace was requested", async () => {
  await expect(resolvedSkillPaths({}, null)).resolves.toEqual(
    [
      join(homeDir, ".omp", "agent", "skills"),
      join(homeDir, ".omp", "agent", "managed-skills"),
      join(homeDir, ".agent", "skills"),
      join(homeDir, ".agents", "skills"),
    ].sort(),
  );
});

it("walks to home without a repository and never treats home as an ancestor project", async () => {
  rmSync(join(repoRoot, ".git"));
  const paths = await resolvedSkillPaths({}, cwd, "project");
  expect(paths).toContain(join(repoRoot, ".omp", "skills"));
  for (const dir of [".omp", ".agent", ".agents", ".claude"]) {
    expect(paths).not.toContain(join(homeDir, dir, "skills"));
  }
  expect(paths).not.toContain(join(repoRoot, ".codex", "skills"));
  expect(paths).not.toContain(join(repoRoot, ".opencode", "skills"));
});

it("reads real YAML skills.customDirectories relative to cwd, not the config directory", async () => {
  const defaults = await resolvedSkillPaths();
  writeSettings(
    join(homeDir, ".omp", "agent"),
    [
      "skills:",
      "  customDirectories:",
      "    - /opt/team-skills",
      "    - ~/shared/skills",
      "    - local-skills/",
      "    - /opt/team-skills",
      "    - ''",
    ].join("\n"),
  );
  await expect(resolvedSkillPaths()).resolves.toEqual(
    [
      ...defaults,
      resolve("/opt/team-skills"),
      join(cwd, "local-skills"),
      join(homeDir, "shared", "skills"),
    ].sort(),
  );
});

it("prefers config.yml, then config.yaml, then legacy JSONC settings", async () => {
  const agentDir = join(homeDir, ".omp", "agent");
  writeSettings(
    agentDir,
    '{\n// legacy migration input\n"skills":{"customDirectories":["legacy"],},\n}',
    "settings.json",
  );
  writeSettings(
    agentDir,
    { skills: { customDirectories: ["fallback"] } },
    "config.yaml",
  );
  writeSettings(agentDir, { skills: { customDirectories: ["canonical"] } });
  let paths = await resolvedSkillPaths();
  expect(paths).toContain(join(cwd, "canonical"));
  expect(paths).not.toContain(join(cwd, "fallback"));
  expect(paths).not.toContain(join(cwd, "legacy"));

  rmSync(join(agentDir, "config.yml"));
  paths = await resolvedSkillPaths();
  expect(paths).toContain(join(cwd, "fallback"));
  expect(paths).not.toContain(join(cwd, "legacy"));

  rmSync(join(agentDir, "config.yaml"));
  paths = await resolvedSkillPaths();
  expect(paths).toContain(join(cwd, "legacy"));
});

it("does not interpret Pi's skills array as OMP directory settings", async () => {
  const defaults = await resolvedSkillPaths();
  writeSettings(join(homeDir, ".omp", "agent"), {
    skills: ["~/pi-only", "npm:@acme/skills", "one-skill/SKILL.md"],
  });
  await expect(resolvedSkillPaths()).resolves.toEqual(defaults);
});

it("tolerates unreadable or malformed settings without inventing roots", async () => {
  const defaults = await resolvedSkillPaths();
  writeSettings(join(homeDir, ".omp", "agent"), "skills: [not valid");
  await expect(resolvedSkillPaths()).resolves.toEqual(defaults);
});

it("uses the retained PI_CODING_AGENT_DIR override and does not expand its tilde", async () => {
  const agentDir = join(cwd, "custom-agent");
  writeSettings(agentDir, { skills: { customDirectories: ["extra"] } });
  const paths = await resolvedSkillPaths({
    PI_CODING_AGENT_DIR: "custom-agent",
  });
  expect(paths).toContain(join(agentDir, "skills"));
  expect(paths).toContain(join(agentDir, "managed-skills"));
  expect(paths).toContain(join(cwd, "extra"));
  expect(paths).not.toContain(join(homeDir, ".omp", "agent", "skills"));
  expect(
    await resolvedSkillPaths({ PI_CODING_AGENT_DIR: "~/custom-agent" }),
  ).toContain(join(cwd, "~", "custom-agent", "skills"));
  expect(
    await resolvedSkillPaths({ OMP_CODING_AGENT_DIR: agentDir }),
  ).not.toContain(join(agentDir, "skills"));
});

it("honors PI_CONFIG_DIR and named profiles before the agent-dir override", async () => {
  const profileDir = join(homeDir, ".omp-alt", "profiles", "work", "agent");
  writeSettings(profileDir, { skills: { customDirectories: ["profile-extra"] } });
  const paths = await resolvedSkillPaths({
    PI_CONFIG_DIR: ".omp-alt",
    OMP_PROFILE: " work ",
    PI_PROFILE: "other",
    PI_CODING_AGENT_DIR: join(homeDir, "ignored"),
  });
  expect(paths).toContain(join(profileDir, "skills"));
  expect(paths).toContain(join(profileDir, "managed-skills"));
  expect(paths).toContain(join(cwd, "profile-extra"));
  expect(paths).not.toContain(join(homeDir, ".omp", "agent", "skills"));
  expect(paths).not.toContain(join(homeDir, "ignored", "skills"));
  expect(await resolvedSkillPaths({ PI_PROFILE: "work" })).toContain(
    join(homeDir, ".omp", "profiles", "work", "agent", "skills"),
  );
});

it("lets an explicit default profile discard an inherited profile-derived agent directory", async () => {
  const paths = await resolvedSkillPaths({
    OMP_PROFILE: "",
    PI_PROFILE: "work",
    PI_CODING_AGENT_DIR: join(homeDir, ".omp", "profiles", "work", "agent"),
  });
  expect(paths).toContain(join(homeDir, ".omp", "agent", "skills"));
  expect(paths).not.toContain(
    join(homeDir, ".omp", "profiles", "work", "agent", "skills"),
  );
  expect(
    await resolvedSkillPaths({
      OMP_PROFILE: "default",
      PI_PROFILE: "work",
      PI_CODING_AGENT_DIR: "custom",
    }),
  ).toContain(join(cwd, "custom", "skills"));
});

it("rejects invalid profile names like OMP does", async () => {
  await expect(
    resolvedSkillPaths({ OMP_PROFILE: "../outside" }),
  ).rejects.toThrow("Invalid OMP profile");
});

it("merges only cwd project settings over user settings, replacing directory arrays", async () => {
  writeSettings(join(homeDir, ".omp", "agent"), {
    skills: { customDirectories: ["from-user"] },
  });
  writeSettings(join(repoRoot, ".omp"), {
    skills: { customDirectories: ["from-ancestor"] },
  });
  writeSettings(
    join(cwd, ".omp"),
    {
      skills: {
        enablePiUser: false,
        customDirectories: ["from-project-json"],
      },
    },
    "settings.json",
  );
  writeSettings(join(cwd, ".omp"), {
    skills: { customDirectories: ["from-project-yaml"] },
  });
  const paths = await resolvedSkillPaths();
  expect(paths).toContain(join(cwd, "from-project-yaml"));
  expect(paths).not.toContain(join(cwd, "from-project-json"));
  expect(paths).not.toContain(join(cwd, "from-ancestor"));
  expect(paths).not.toContain(join(cwd, "from-user"));
  expect(paths).not.toContain(join(homeDir, ".omp", "agent", "skills"));
  expect(paths).toContain(join(homeDir, ".omp", "agent", "managed-skills"));
});

it("applies PI_CONFIG_FILES overlays in order and resolves their directories from cwd", async () => {
  writeSettings(join(cwd, ".omp"), {
    skills: { enableAgentsUser: false, customDirectories: ["from-project"] },
  });
  writeSettings(
    join(homeDir, "overlays"),
    { skills: { customDirectories: ["from-first"] } },
    "first.yml",
  );
  writeSettings(
    join(homeDir, "overlays"),
    { skills: { enableAgentsUser: true, customDirectories: ["from-last"] } },
    "last.yml",
  );
  const paths = await resolvedSkillPaths({
    PI_CONFIG_FILES: [
      "~/overlays/first.yml",
      join(homeDir, "overlays", "last.yml"),
    ].join(delimiter),
  });
  expect(paths).toContain(join(cwd, "from-last"));
  expect(paths).toContain(join(homeDir, ".agent", "skills"));
  expect(paths).not.toContain(join(cwd, "from-first"));
  expect(paths).not.toContain(join(cwd, "from-project"));
  expect(paths).not.toContain(join(homeDir, "overlays", "from-last"));
});

it("honors source toggles while managed skills remain independent of native authored skills", async () => {
  writeSettings(join(homeDir, ".omp", "agent"), {
    skills: {
      enablePiUser: false,
      enablePiProject: false,
      enableAgentsUser: false,
      enableAgentsProject: false,
      enableClaudeProject: false,
      customDirectories: ["custom"],
    },
    enabledProviders: ["all"],
    disabledProviders: ["codex", "github"],
  });
  await expect(resolvedSkillPaths()).resolves.toEqual(
    [
      join(homeDir, ".omp", "agent", "managed-skills"),
      join(homeDir, ".claude", "skills"),
      join(homeDir, ".config", "opencode", "skills"),
      join(cwd, ".opencode", "skills"),
      join(cwd, "custom"),
    ].sort(),
  );
});

it("opts foreign user roots in through skill settings or CLAUDE_CONFIG_DIR", async () => {
  writeSettings(join(homeDir, ".omp", "agent"), {
    skills: { enableClaudeUser: true, enableCodexUser: true },
  });
  const paths = await resolvedSkillPaths({ CLAUDE_CONFIG_DIR: "claude-config" });
  expect(paths).toContain(join(cwd, "claude-config", "skills"));
  expect(paths).toContain(join(homeDir, ".codex", "skills"));
  expect(paths).not.toContain(join(homeDir, ".claude", "skills"));
  expect(paths).not.toContain(join(homeDir, ".config", "opencode", "skills"));
});

it("honors the master disable without static roots leaking into bb", async () => {
  writeSettings(join(homeDir, ".omp", "agent"), {
    skills: { enabled: false, customDirectories: ["also-disabled"] },
  });
  await expect(resolvedSkillPaths()).resolves.toEqual([]);
  expect(
    OMP_NATIVE_ROOTS_DECLARATION.experimental_nativeSkillRoots,
  ).toBeUndefined();
});

it("uses OMP discovery provider ids to disable complete sources", async () => {
  writeSettings(join(homeDir, ".omp", "agent"), {
    disabledProviders: [
      "native",
      "agents",
      "claude",
      "codex",
      "opencode",
      "github",
      "omp-managed",
      "skillshare",
    ],
    skills: { customDirectories: ["custom"] },
  });
  await expect(resolvedSkillPaths()).resolves.toEqual([join(cwd, "custom")]);
});

it("resolves locked OMP registry installs and prefers ancestor locks over the user lock", async () => {
  const agentDir = join(homeDir, ".omp", "agent");
  const alpha = installSkill(agentDir, "alpha");
  const beta = installSkill(agentDir, "beta", "2.0.0");
  writeSettings(
    agentDir,
    {
      version: 1,
      skills: { "@team/alpha": alpha.entry, "@team/beta": beta.entry },
    },
    "skills.lock.json",
  );
  writeSettings(
    join(repoRoot, ".omp"),
    { version: 1, skills: { "@team/alpha": alpha.entry } },
    "skills.lock.json",
  );
  const answer = experimental_nativeRootsResolveOutputSchema.parse(
    await resolveOmpNativeRoots({ homeDir, cwd, env: {} }),
  );
  expect(
    answer.skills.filter((root) => root.shape === "skill-file"),
  ).toEqual([
    {
      path: join(alpha.path, "SKILL.md"),
      origin: "project",
      shape: "skill-file",
      recursive: false,
      ancestors: false,
      namePrefix: "",
      fallbackName: "alpha",
    },
    {
      path: join(beta.path, "SKILL.md"),
      origin: "user",
      shape: "skill-file",
      recursive: false,
      ancestors: false,
      namePrefix: "",
      fallbackName: "beta",
    },
  ]);
  expect(await resolvedSkillPaths({}, null)).toEqual(
    expect.arrayContaining([
      join(alpha.path, "SKILL.md"),
      join(beta.path, "SKILL.md"),
    ]),
  );
});

it("does not advertise incomplete registry installs or mismatched locked bytes", async () => {
  const defaults = await resolvedSkillPaths();
  const agentDir = join(homeDir, ".omp", "agent");
  const mismatch = installSkill(agentDir, "mismatch");
  const incomplete = installSkill(agentDir, "incomplete");
  const missing = installSkill(agentDir, "missing");
  rmSync(join(incomplete.path, ".skillshare-integrity"));
  rmSync(join(missing.path, "SKILL.md"));
  writeSettings(
    agentDir,
    {
      version: 1,
      skills: {
        "@team/mismatch": { ...mismatch.entry, integrity: "sha512-other" },
        "@team/incomplete": incomplete.entry,
        "@team/missing": missing.entry,
      },
    },
    "skills.lock.json",
  );
  await expect(resolvedSkillPaths()).resolves.toEqual(defaults);
});

it.each([
  { id: "@team/alpha", version: "../outside" },
  { id: "@team/alpha", version: "1.0.0-a..b" },
  { id: "@../escape", version: "1.0.0" },
])(
  "rejects a registry lock with unsafe coordinates $id@$version",
  async ({ id, version }) => {
    const defaults = await resolvedSkillPaths();
    const agentDir = join(homeDir, ".omp", "agent");
    const installed = installSkill(agentDir, "installed");
    writeSettings(
      agentDir,
      {
        version: 1,
        skills: {
          "@team/installed": installed.entry,
          [id]: { ...installed.entry, version },
        },
      },
      "skills.lock.json",
    );
    await expect(resolvedSkillPaths()).resolves.toEqual(defaults);
  },
);

it("keeps registry discovery independent of authored native-skill toggles", async () => {
  const agentDir = join(homeDir, ".omp", "profiles", "work", "agent");
  const installed = installSkill(agentDir, "installed");
  writeSettings(agentDir, {
    skills: { enablePiUser: false, enablePiProject: false },
  });
  writeSettings(
    agentDir,
    { version: 1, skills: { "@team/installed": installed.entry } },
    "skills.lock.json",
  );
  const env = { OMP_PROFILE: "work" };
  expect(await resolvedSkillPaths(env)).toContain(
    join(installed.path, "SKILL.md"),
  );
  writeSettings(agentDir, { disabledProviders: ["skillshare"] });
  expect(await resolvedSkillPaths(env)).not.toContain(
    join(installed.path, "SKILL.md"),
  );
});

it("discovers the home project registry lock without misclassifying home skill directories", async () => {
  rmSync(join(repoRoot, ".git"));
  const agentDir = join(homeDir, ".omp", "agent");
  const installed = installSkill(agentDir, "installed");
  writeSettings(
    join(homeDir, ".omp"),
    { version: 1, skills: { "@team/installed": installed.entry } },
    "skills.lock.json",
  );
  const paths = await resolvedSkillPaths({}, cwd, "project");
  expect(paths).toContain(join(installed.path, "SKILL.md"));
  expect(paths).not.toContain(join(homeDir, ".omp", "skills"));
});

it("normalizes and deduplicates custom paths before returning the host contract", async () => {
  const defaults = await resolvedSkillPaths();
  writeSettings(join(homeDir, ".omp", "agent"), {
    skills: {
      customDirectories: [
        "/opt/../etc/skills",
        "/opt//skills",
        "relative/../escape",
        "/srv/skills/",
        "~/team-skills//",
        "~/team-skills",
      ],
    },
  });
  await expect(resolvedSkillPaths()).resolves.toEqual(
    [
      ...defaults,
      resolve("/etc/skills"),
      resolve("/opt/skills"),
      join(cwd, "escape"),
      resolve("/srv/skills"),
      join(homeDir, "team-skills"),
    ].sort(),
  );
});
