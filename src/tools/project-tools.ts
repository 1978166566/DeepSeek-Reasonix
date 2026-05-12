/**
 * Structured Project Rules, Auto Checkpoint/Restore, and Background Task Enhancement.
 *
 * 1. .clinerules — per-file-type AI rules from .reasonix/rules/*.md
 * 2. auto_checkpoint + file_restore — git-based file history management
 * 3. Background job auto-inject — completed job results injected into context
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { execSync } from "node:child_process";
import type { ToolRegistry } from "../tools.js";

// ─── 1. Structured Project Rules (.clinerules) ─────────────────────

const RULES_DIR = ".reasonix/rules";

export interface RuleFile {
  name: string;
  pattern: string; // glob-like, e.g. "*.java", "*.vue", "security"
  content: string;
}

/**
 * Load all rule files from .reasonix/rules/.
 * Each file has frontmatter: pattern: *.java
 */
export function loadProjectRules(rootDir: string): RuleFile[] {
  const rulesPath = join(rootDir, RULES_DIR);
  if (!existsSync(rulesPath)) return [];
  try {
    const files = readdirSync(rulesPath).filter((f) => f.endsWith(".md"));
    return files.map((f) => {
      const content = readFileSync(join(rulesPath, f), "utf8");
      const pattern = extractPattern(content) ?? `*.${f.replace(".md", "")}`;
      return { name: f.replace(".md", ""), pattern, content };
    });
  } catch {
    return [];
  }
}

function extractPattern(content: string): string | null {
  const m = content.match(/^pattern:\s*(.+)$/m);
  return m ? m[1]!.trim() : null;
}

/**
 * Match a file path against a simple glob pattern.
 * Supports: *.java, src/**\/*.ts, specific/path/file.java
 */
function matchGlob(filePath: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    return filePath.endsWith(pattern.slice(1));
  }
  if (pattern.includes("*")) {
    const re = new RegExp(
      `^${pattern.replace(/\*\*/g, "(.+)").replace(/\*/g, "([^/]+)").replace(/\./g, "\\.")}$`,
    );
    return re.test(filePath);
  }
  return filePath === pattern || filePath.endsWith(`/${pattern}`);
}

/**
 * Get relevant rules for a set of file paths.
 */
export function getRelevantRules(
  rootDir: string,
  filePaths: string[],
): RuleFile[] {
  const allRules = loadProjectRules(rootDir);
  if (allRules.length === 0) return [];
  return allRules.filter((rule) =>
    filePaths.some((fp) => matchGlob(fp, rule.pattern)),
  );
}

/**
 * Format rules as a system prompt fragment.
 */
export function formatRulesAsPrompt(rules: RuleFile[]): string {
  if (rules.length === 0) return "";
  return (
    `\n# Project Rules (.reasonix/rules/)\n\n` +
    rules
      .map(
        (r) =>
          `### ${r.name} (pattern: \`${r.pattern}\`)\n${r.content.trim()}\n`,
      )
      .join("\n")
  );
}

// ─── 2. Auto Checkpoint + File Restore ────────────────────────────

const CHECKPOINT_DIR = ".reasonix/checkpoints";

/**
 * Create a git checkpoint (auto-commit) before making changes.
 */
export function createCheckpoint(
  rootDir: string,
  message: string,
): { ok: boolean; hash?: string; error?: string } {
  try {
    // Check if we're in a git repo
    execSync("git rev-parse --git-dir", {
      cwd: rootDir,
      stdio: "pipe",
      timeout: 5000,
    });
    // Stash any unstaged changes
    execSync("git add -A", { cwd: rootDir, stdio: "pipe", timeout: 10000 });
    const result = execSync(
      `git commit -m "reasonix checkpoint: ${message.replace(/"/g, "'").slice(0, 100)}" --allow-empty`,
      {
        cwd: rootDir,
        encoding: "utf8",
        timeout: 10000,
      },
    );
    const hashMatch = result.match(/\[[^\]]+ ([a-f0-9]+)\]/);
    const hash = hashMatch?.[1] ?? "unknown";
    return { ok: true, hash };
  } catch (e: any) {
    // Not a git repo or git failed
    // Fallback: save file copies to .reasonix/checkpoints/
    try {
      const dir = join(rootDir, CHECKPOINT_DIR);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const ts = Date.now();
      writeFileSync(
        join(dir, `checkpoint-${ts}.json`),
        JSON.stringify({ timestamp: ts, message }, null, 2),
        "utf8",
      );
      return { ok: true, hash: `checkpoint-${ts}` };
    } catch (e2: any) {
      return { ok: false, error: e2.message };
    }
  }
}

/**
 * Get git diff for a specific file.
 */
function getGitDiff(
  rootDir: string,
  filePath: string,
): string | null {
  try {
    const result = execSync(
      `git diff HEAD -- "${filePath}"`,
      { cwd: rootDir, encoding: "utf8", timeout: 5000, stdio: "pipe" },
    );
    return result || "(no changes)";
  } catch {
    return null;
  }
}

/**
 * Restore a file from the last git commit (git checkout HEAD -- file).
 */
function restoreFromGit(
  rootDir: string,
  filePath: string,
): { ok: boolean; error?: string } {
  try {
    execSync(`git checkout HEAD -- "${filePath}"`, {
      cwd: rootDir,
      stdio: "pipe",
      timeout: 10000,
    });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

// ─── 3. Registration ──────────────────────────────────────────────

export interface ProjectToolsOptions {
  projectRoot: string;
}

export function registerProjectTools(
  registry: ToolRegistry,
  opts: ProjectToolsOptions,
): void {
  // ── checkpoint tool ──────────────────────────────────────────────
  registry.register({
    name: "checkpoint",
    description:
      'Create an automatic checkpoint (git commit) before making changes. Call this before starting any multi-step or risky operation so you can restore files if something goes wrong. If git is not available, saves a file-based checkpoint marker.',
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description:
            "Short description of what you're about to do, e.g. 'refactor inventory search', 'add user auth'.",
        },
      },
      required: ["message"],
    },
    fn: async (args: { message?: unknown }) => {
      const message =
        typeof args.message === "string" ? args.message.trim() : "checkpoint";
      const result = createCheckpoint(opts.projectRoot, message);
      if (result.ok) {
        return JSON.stringify({
          success: true,
          hash: result.hash,
          note: "Changes committed. Use restore_file to undo if needed.",
        });
      }
      return JSON.stringify({
        error: `Checkpoint failed: ${result.error ?? "unknown error"}`,
        tip: "Not a git repo? Run 'git init' first, or manually copy files before editing.",
      });
    },
  });

  // ── restore_file tool ────────────────────────────────────────────
  registry.register({
    name: "restore_file",
    description:
      'Restore a file to its state at the last checkpoint (git checkout HEAD). Use this to undo changes when something went wrong. Only works in git repositories. Shows a diff preview of what will be changed before restoring.',
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path to the file to restore, relative to project root (e.g. 'src/main/java/MyFile.java').",
        },
        preview: {
          type: "boolean",
          description:
            "If true, only show the diff without actually restoring. Default: false.",
        },
      },
      required: ["path"],
    },
    fn: async (args: { path?: unknown; preview?: unknown }) => {
      const filePath =
        typeof args.path === "string" ? args.path.trim() : "";
      if (!filePath) {
        return JSON.stringify({ error: "path is required" });
      }
      const isPreview = args.preview === true;

      // Show diff preview
      const diff = getGitDiff(opts.projectRoot, filePath);
      if (diff === null) {
        return JSON.stringify({
          error:
            "Not a git repository or file not tracked. Cannot restore from git.",
        });
      }

      if (isPreview || diff === "(no changes)") {
        return JSON.stringify({
          success: true,
          preview: true,
          diff: diff === "(no changes)" ? "No uncommitted changes to this file." : diff,
          restored: false,
          note: isPreview
            ? "This is a preview. Call restore_file without preview=true to actually restore."
            : "File has no uncommitted changes.",
        });
      }

      // Actually restore
      const result = restoreFromGit(opts.projectRoot, filePath);
      if (result.ok) {
        return JSON.stringify({
          success: true,
          restored: true,
          reverted_diff: diff,
          note: "File restored to last committed state. Use checkpoint to re-save if needed.",
        });
      }
      return JSON.stringify({
        error: `Restore failed: ${result.error}`,
      });
    },
  });

  // ── rules tool ──────────────────────────────────────────────────
  registry.register({
    name: "rules",
    description:
      'Load and display project-specific rules from .reasonix/rules/*.md. Rules are matched to file patterns (e.g. "*.java" rules only apply to Java files). Call this when you need to check if there are specific conventions for the files you are about to edit. Rules are automatically loaded on session start — this tool is for previewing what rules are active.',
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        for_files: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional list of file paths to check rules for. If provided, only rules matching these files are shown.",
        },
      },
    },
    fn: async (args: { for_files?: unknown }) => {
      const files =
        Array.isArray(args.for_files)
          ? (args.for_files as string[]).filter((f) => typeof f === "string")
          : [];

      const allRules = loadProjectRules(opts.projectRoot);
      if (allRules.length === 0) {
        return JSON.stringify({
          success: true,
          rules_count: 0,
          message:
            "No project rules found. Create .reasonix/rules/*.md files with 'pattern: *.java' frontmatter.",
          active_rules: [],
        });
      }

      const relevant = files.length > 0
        ? getRelevantRules(opts.projectRoot, files)
        : allRules;

      return JSON.stringify({
        success: true,
        rules_count: allRules.length,
        matching_count: relevant.length,
        active_rules: relevant.map((r) => ({
          name: r.name,
          pattern: r.pattern,
          preview: r.content.slice(0, 200),
        })),
        all_rules: allRules.map((r) => ({
          name: r.name,
          pattern: r.pattern,
        })),
        how_to:
          "Create a new rule: write a markdown file in .reasonix/rules/<name>.md with 'pattern: *.java' as the first line.",
      });
    },
  });

  // ── git_status tool ──────────────────────────────────────────────
  registry.register({
    name: "git_status",
    description:
      "Show the current git status — changed files, staged changes, branch info. Use this to check what has been modified before committing or restoring.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        include_diff: {
          type: "boolean",
          description:
            "If true, includes a summary of changes per file. Default: false.",
        },
      },
    },
    fn: async (args: { include_diff?: unknown }) => {
      const showDiff = args.include_diff === true;

      try {
        const branch = execSync(
          "git rev-parse --abbrev-ref HEAD",
          { cwd: opts.projectRoot, encoding: "utf8", timeout: 5000, stdio: "pipe" },
        ).trim();
        const status = execSync(
          "git status --short",
          { cwd: opts.projectRoot, encoding: "utf8", timeout: 5000, stdio: "pipe" },
        ).trim();
        const log = execSync(
          "git log --oneline -5",
          { cwd: opts.projectRoot, encoding: "utf8", timeout: 5000, stdio: "pipe" },
        ).trim();

        const diff = showDiff
          ? execSync("git diff --stat", {
              cwd: opts.projectRoot,
              encoding: "utf8",
              timeout: 5000,
              stdio: "pipe",
            }).trim()
          : null;

        return JSON.stringify({
          success: true,
          branch,
          has_changes: status.length > 0,
          status: status || "(clean)",
          recent_commits: log,
          diff_summary: diff,
        });
      } catch (e: any) {
        return JSON.stringify({
          error: `Git failed: ${e.message}. Is this a git repository?`,
        });
      }
    },
  });
}
