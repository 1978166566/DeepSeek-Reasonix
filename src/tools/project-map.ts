/**
 * Project Map — Aider-inspired condensed project structure summary.
 *
 * Provides a lightweight "map" of the project that gets injected into the
 * system prompt so the model knows the codebase layout without reading
 * directory trees. Stored as .reasonix/project-map.md.
 *
 * Also handles Auto Skill Creation and Lint-Driven Repair.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { ToolRegistry } from "../tools.js";
import type { SubagentResult } from "./subagent.js";

// ─── Project Map ────────────────────────────────────────────────────

const PROJECT_MAP_FILE = ".reasonix/project-map.md";
const MAX_MAP_CHARS = 4000;
const MAX_FILE_MAP_CHARS = 300;

/**
 * Read the project map if it exists.
 */
export function readProjectMap(rootDir: string): string | null {
  const path = join(rootDir, PROJECT_MAP_FILE);
  try {
    if (existsSync(path)) {
      const content = readFileSync(path, "utf8").trim();
      if (content.length > 0) return content;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Format a directory listing into a condensed project map string.
 * Uses git ls-files if available, falls back to find.
 */
export function formatProjectMap(
  rootDir: string,
  files: { path: string; symbols: string[] }[],
): string {
  // Build directory tree with annotations
  const tree = new Map<string, { files: { name: string; symbols: string }[] }>();
  for (const f of files) {
    const dir = dirname(f.path);
    if (!tree.has(dir)) tree.set(dir, { files: [] });
    const symStr = f.symbols.length > 0 ? ` [${f.symbols.slice(0, 3).join(", ")}${f.symbols.length > 3 ? "..." : ""}]` : "";
    tree.get(dir)!.files.push({ name: f.path, symbols: symStr });
  }

  const lines: string[] = [];
  lines.push(`# Project Map (${files.length} files indexed)`);
  lines.push("");

  // Sort directories by depth then name
  const sorted = [...tree.entries()].sort((a, b) => {
    const depthA = a[0].split("/").length;
    const depthB = b[0].split("/").length;
    if (depthA !== depthB) return depthA - depthB;
    return a[0].localeCompare(b[0]);
  });

  for (const [dir, { files: dirFiles }] of sorted) {
    const indent = "  ".repeat(Math.max(0, dir.split("/").length - 1));
    const dirName = dir === "." ? "." : `./${dir}`;
    lines.push(`${indent}${dirName}/`);

    for (const f of dirFiles) {
      const fileIndent = "  ".repeat(dir.split("/").length);
      const shortName = f.name.split("/").pop() ?? f.name;
      lines.push(`${fileIndent}${shortName}${f.symbols}`);
    }
  }

  return lines.join("\n").slice(0, MAX_MAP_CHARS);
}

// ─── Auto Skill Creation ────────────────────────────────────────────

/**
 * Prompt fragment injected into the code system prompt to encourage
 * automatic skill creation after complex tasks.
 */
export const AUTO_SKILL_CREATION_PROMPT = `
# Auto Skill Creation

After completing a COMPLEX multi-step task (3+ steps, or something you'd
want to repeat later), CONSIDER calling \`create_skill\` to save the
workflow as a reusable skill. Good candidates:
- Multi-step debugging playbooks
- Deployment workflows
- Data migration / ETL patterns
- Anything you'd describe as "I do this every week"

When to create: if the task involved 3+ tool calls in a specific sequence
that the user might want to repeat. Don't create for one-shot edits.
`;

// ─── Lint-Driven Repair ────────────────────────────────────────────

const DEFAULT_BUILD_COMMANDS: Record<string, string[]> = {
  java: ["mvn compile -q 2>&1", "mvn test -q 2>&1 | tail -30"],
  node: ["npm run build 2>&1", "npx tsc --noEmit 2>&1"],
  python: ["python -m py_compile setup.py 2>&1 || true"],
  go: ["go build ./... 2>&1"],
  rust: ["cargo check 2>&1"],
};

function detectProjectType(rootDir: string): string {
  try {
    if (existsSync(join(rootDir, "pom.xml"))) return "java";
    if (existsSync(join(rootDir, "package.json"))) return "node";
    if (existsSync(join(rootDir, "setup.py")) || existsSync(join(rootDir, "pyproject.toml"))) return "python";
    if (existsSync(join(rootDir, "go.mod"))) return "go";
    if (existsSync(join(rootDir, "Cargo.toml"))) return "rust";
  } catch {
    // ignore
  }
  return "unknown";
}

export interface LintRepairOptions {
  projectRoot: string;
  /** Tool to run a shell command. Returns { stdout, stderr, exitCode }. */
  runCommand: (cmd: string) => Promise<{ output: string; exitCode: number }>;
  /** Spawn a subagent to fix errors. Returns formatted result string. */
  spawnFixSubagent: (task: string, signal?: AbortSignal) => Promise<SubagentResult>;
  /** Format result. */
  formatResult: (r: SubagentResult) => string;
}

export function registerLintRepairTool(
  registry: ToolRegistry,
  opts: LintRepairOptions,
): void {
  registry.register({
    name: "verify_and_repair",
    description:
      "After editing files, call this to verify the project still builds and tests pass. Runs the project's build command, and if errors are found, spawns a fix subagent to repair them. Loops until clean (max 3 attempts). Pass the edited file paths so the fixer has context.",
    parameters: {
      type: "object",
      properties: {
        edited_files: {
          type: "array",
          items: { type: "string" },
          description:
            "List of file paths that were edited. The fix subagent reads these to understand what changed.",
        },
        build_command: {
          type: "string",
          description:
            "Optional override for the build command. Default: auto-detected from project type (mvn/npm/tsc/etc).",
        },
        test_command: {
          type: "string",
          description:
            "Optional override for the test command. Default: auto-detected from project type.",
        },
      },
    },
    fn: async (
      args: {
        edited_files?: unknown;
        build_command?: unknown;
        test_command?: unknown;
      },
      ctx,
    ) => {
      const projectType = detectProjectType(opts.projectRoot);
      const buildCmd =
        typeof args.build_command === "string" && args.build_command.trim()
          ? args.build_command.trim()
          : (DEFAULT_BUILD_COMMANDS[projectType]?.[0] ?? "");
      const testCmd =
        typeof args.test_command === "string" && args.test_command.trim()
          ? args.test_command.trim()
          : (DEFAULT_BUILD_COMMANDS[projectType]?.[1] ?? "");

      if (!buildCmd) {
        return JSON.stringify({
          error: `Unknown project type "${projectType}" and no build_command provided. Known types: ${Object.keys(DEFAULT_BUILD_COMMANDS).join(", ")}`,
        });
      }

      const editedFiles =
        Array.isArray(args.edited_files)
          ? (args.edited_files as string[]).filter((f) => typeof f === "string")
          : [];

      const results: { step: string; success: boolean; output: string }[] = [];
      const MAX_RETRIES = 3;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        // Step 1: Build
        const buildResult = await opts.runCommand(buildCmd);
        const buildPassed = buildResult.exitCode === 0;
        results.push({
          step: attempt === 0 ? "build (initial)" : `build (attempt ${attempt + 1})`,
          success: buildPassed,
          output: buildResult.output.slice(0, 2000),
        });

        if (!buildPassed) {
          if (attempt < MAX_RETRIES - 1) {
            const fixTask = editedFiles.length > 0
              ? `Fix these build errors:\n\nBuild output:\n${buildResult.output.slice(0, 3000)}\n\nEdited files:\n${editedFiles.join("\n")}\n\nFix the errors and ensure the build passes.`
              : `Fix these build errors:\n\nBuild output:\n${buildResult.output.slice(0, 3000)}\n\nFix the errors and ensure the build passes.`;
            const fixResult = await opts.spawnFixSubagent(fixTask, ctx?.signal);
            results.push({
              step: `fix attempt ${attempt + 1}`,
              success: fixResult.success,
              output: opts.formatResult(fixResult).slice(0, 1000),
            });
            if (!fixResult.success) break;
          } else {
            results.push({
              step: "max retries reached",
              success: false,
              output: "Build still failing after 3 repair attempts.",
            });
          }
        } else {
          // Build passed — run tests if available
          if (testCmd) {
            const testResult = await opts.runCommand(testCmd);
            const testPassed = testResult.exitCode === 0;
            results.push({
              step: attempt === 0 ? "tests" : `tests (attempt ${attempt + 1})`,
              success: testPassed,
              output: testResult.output.slice(0, 2000),
            });
            if (!testPassed && attempt < MAX_RETRIES - 1) {
              const fixTask = `Fix these test errors:\n\nTest output:\n${testResult.output.slice(0, 3000)}\n\nFix the issues and ensure tests pass.`;
              const fixResult = await opts.spawnFixSubagent(fixTask, ctx?.signal);
              results.push({
                step: `test fix attempt ${attempt + 1}`,
                success: fixResult.success,
                output: opts.formatResult(fixResult).slice(0, 1000),
              });
              if (!fixResult.success) break;
            } else {
              break; // All passed
            }
          } else {
            break; // Build passed, no tests to run
          }
        }
      }

      const allPassed = results.every((r) => r.success);
      const failedSteps = results.filter((r) => !r.success);
      return JSON.stringify({
        success: allPassed,
        project_type: projectType,
        steps: results,
        summary: allPassed
          ? "All checks passed."
          : `Failed steps: ${failedSteps.map((r) => r.step).join(", ")}`,
      });
    },
  });
}
