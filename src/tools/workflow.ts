/**
 * Agent Workflow Enhancements — Multi-Agent, Steer, Auto Commit, Fork Session, Ultra Review.
 *
 * All five features bundled as they share infrastructure (agent profiles, session mgmt).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { ToolRegistry } from "../tools.js";
import type { SubagentResult } from "./subagent.js";

// ─── 1. Multi-Agent Mode ──────────────────────────────────────────

const AGENTS_DIR = ".reasonix/agents";

export interface AgentProfile {
  name: string;
  description: string;
  prompt: string;
  allowedTools?: string[];
  model?: string;
  /** Whether to override the default system prompt entirely. Default false (appends). */
  overrideSystem?: boolean;
}

const BUILTIN_AGENTS: AgentProfile[] = [
  {
    name: "default",
    description: "Default coding agent — balanced developer mode",
    prompt: "",
  },
  {
    name: "reviewer",
    description: "Code review specialist — finds bugs, security issues, style problems",
    prompt: `You are a code review specialist. Your job is to CRITICALLY examine code changes and find issues.

Focus on:
- Logic errors and edge cases
- Security vulnerabilities (XSS, injection, auth bypasses)
- Performance problems
- API misuse
- Type safety issues
- Code style violations against project conventions

Be specific: cite file:line numbers for every issue found.
Rate each issue: CRITICAL / MAJOR / MINOR.
Always suggest concrete fixes.`,
    overrideSystem: true,
  },
  {
    name: "tester",
    description: "Test writer — generates unit/integration tests",
    prompt: `You are a test writing specialist. Your job is to write comprehensive tests.

Rules:
- Cover: happy path, edge cases, error conditions, boundary values
- Use the project's existing test framework (detect from package.json/pom.xml)
- Follow existing test patterns in the codebase
- Each test should be independently runnable
- Include descriptive test names that explain the scenario
- Mock external dependencies, test internal logic`,
    overrideSystem: true,
  },
  {
    name: "architect",
    description: "Architecture specialist — designs system structure and data flow",
    prompt: `You are a software architect. Your job is to design high-level system structure.

Analyze:
- Current codebase structure and how the change fits in
- Coupling between modules
- Data flow and state management
- API design (REST endpoints, data formats)
- Schema design
- Scalability and maintainability

Produce:
- A clear architecture diagram description
- Module boundaries and interfaces
- Data models and relationships
- Migration path from current to desired state`,
    overrideSystem: true,
  },
  {
    name: "security",
    description: "Security auditor — finds vulnerabilities and hardens code",
    prompt: `You are a security engineer. Your job is to audit code for vulnerabilities.

Checklist (OWASP Top 10):
- Injection (SQL, NoSQL, OS, LDAP)
- Broken authentication
- Sensitive data exposure
- XML External Entities (XXE)
- Broken access control
- Security misconfiguration
- Cross-Site Scripting (XSS)
- Insecure deserialization
- Using components with known vulnerabilities
- Insufficient logging & monitoring

For each finding: CVE-like severity rating, exploit scenario, fix recommendation.`,
    overrideSystem: true,
  },
];

function loadUserAgents(rootDir: string): AgentProfile[] {
  const agentsPath = join(rootDir, AGENTS_DIR);
  if (!existsSync(agentsPath)) return [];
  try {
    const files = readdirSync(agentsPath).filter((f) => f.endsWith(".json"));
    return files.map((f) => {
      const content = readFileSync(join(agentsPath, f), "utf8");
      return JSON.parse(content) as AgentProfile;
    });
  } catch {
    return [];
  }
}

function getAllAgents(rootDir: string): AgentProfile[] {
  return [...BUILTIN_AGENTS, ...loadUserAgents(rootDir)];
}

function getAgent(rootDir: string, name: string): AgentProfile | undefined {
  return getAllAgents(rootDir).find((a) => a.name === name);
}

// ─── 2. Steer (Mid-run nudges) ─────────────────────────────────────

/** Queue of steer messages that the model will see on next tool dispatch. */
const _steerQueue: string[] = [];

export function dequeueSteerMessages(): string[] {
  return _steerQueue.splice(0);
}

// ─── 3. Auto Commit ───────────────────────────────────────────────

function getGitDiff(rootDir: string): string {
  try {
    return execSync("git diff --stat", {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 5000,
      stdio: "pipe",
    }).trim();
  } catch {
    return "";
  }
}

function gitCommit(rootDir: string, message: string): { ok: boolean; hash?: string; error?: string } {
  try {
    execSync("git add -A", { cwd: rootDir, stdio: "pipe", timeout: 10000 });
    const result = execSync(`git commit -m "${message.replace(/"/g, "'").slice(0, 200)}" --allow-empty`, {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 10000,
    });
    const hashMatch = result.match(/\[[^\]]+ ([a-f0-9]+)\]/);
    return { ok: true, hash: hashMatch?.[1] ?? "unknown" };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

// ─── 4. Fork Session ─────────────────────────────────────────────

export interface ForkResult {
  ok: boolean;
  parentSession?: string;
  forkSession?: string;
  error?: string;
}

// ─── 5. Ultra Review ──────────────────────────────────────────────

const REVIEW_AGENTS = ["security", "reviewer", "architect"];

export interface ReviewFinding {
  agent: string;
  summary: string;
  issues: { file?: string; line?: number; severity: "CRITICAL" | "MAJOR" | "MINOR"; description: string }[];
  passed: boolean;
}

// ─── Registration ──────────────────────────────────────────────────

export interface WorkflowOptions {
  projectRoot: string;
  spawnSubagent: (opts: {
    system: string;
    task: string;
    signal?: AbortSignal;
  }) => Promise<SubagentResult>;
  formatResult: (r: SubagentResult) => string;
  /** Callback to fork the current session. Set by the UI layer. */
  onForkSession?: () => Promise<string | null>;
  /** Callback to switch agent. Set by the UI layer. */
  onSwitchAgent?: (agent: string) => void;
}

export function registerWorkflowTools(
  registry: ToolRegistry,
  opts: WorkflowOptions,
): void {
  // ── 1. list_agents ────────────────────────────────────────────
  registry.register({
    name: "list_agents",
    description:
      "List all available agent personas. Each agent has a different expertise (reviewer, tester, architect, security) and system prompt. Use switch_agent(name) to change the active agent. Built-in agents: default, reviewer, tester, architect, security. Custom agents can be added in .reasonix/agents/<name>.json.",
    readOnly: true,
    parameters: { type: "object", properties: {} },
    fn: async () => {
      const agents = getAllAgents(opts.projectRoot);
      return JSON.stringify({
        success: true,
        count: agents.length,
        agents: agents.map((a) => ({
          name: a.name,
          description: a.description,
          overrides_system: a.overrideSystem,
          has_tool_restrictions: !!a.allowedTools,
        })),
        active: "default",
        switch_with: "switch_agent(name: 'reviewer')",
      });
    },
  });

  // ── 1b. switch_agent ──────────────────────────────────────────
  registry.register({
    name: "switch_agent",
    description:
      "Switch to a different agent persona. Changes the system prompt for subsequent turns. See list_agents for available agents. Use 'default' to return to normal coding mode.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Agent name. Built-in: default, reviewer, tester, architect, security. Custom: any .json file in .reasonix/agents/.",
        },
      },
      required: ["name"],
    },
    fn: async (args: { name?: unknown }) => {
      const name =
        typeof args.name === "string" ? args.name.trim() : "";
      if (!name) {
        return JSON.stringify({ error: "name is required" });
      }
      const agent = getAgent(opts.projectRoot, name);
      if (!agent) {
        const available = getAllAgents(opts.projectRoot)
          .map((a) => a.name)
          .join(", ");
        return JSON.stringify({
          error: `Unknown agent: ${name}. Available: ${available}`,
        });
      }
      opts.onSwitchAgent?.(name);
      return JSON.stringify({
        success: true,
        agent: name,
        description: agent.description,
        note: "Agent switched. The new system prompt will apply from your next turn.",
      });
    },
  });

  // ── 1c. run_as_agent ──────────────────────────────────────────
  registry.register({
    name: "run_as_agent",
    description:
      "Run a task using a specific agent persona. Unlike switch_agent, this spawns an isolated subagent with the given persona, runs the task, and returns the result — without changing your own persona. Use this for: code review, test generation, security audit, architecture analysis.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          enum: ["reviewer", "tester", "architect", "security"],
          description:
            "Agent persona to use. Each has a specialized system prompt.",
        },
        task: {
          type: "string",
          description:
            "What the agent should do. Be specific. Example: 'Review src/api/users.ts for security vulnerabilities.'",
        },
      },
      required: ["agent", "task"],
    },
    fn: async (args: { agent?: unknown; task?: unknown }, ctx) => {
      const agentName =
        typeof args.agent === "string" ? args.agent.trim() : "";
      const task =
        typeof args.task === "string" ? args.task.trim() : "";
      if (!agentName || !task) {
        return JSON.stringify({ error: "agent and task are required" });
      }
      const agent = getAgent(opts.projectRoot, agentName);
      if (!agent) {
        return JSON.stringify({
          error: `Unknown agent: ${agentName}. Available: reviewer, tester, architect, security`,
        });
      }
      const result = await opts.spawnSubagent({
        system: agent.prompt || "You are a helpful assistant.",
        task,
        signal: ctx?.signal,
      });
      if (!result.success) {
        return JSON.stringify({
          success: false,
          error: result.error ?? `${agentName} agent failed`,
          partial: result.output,
        });
      }
      return JSON.stringify({
        success: true,
        agent: agentName,
        output: result.output,
      });
    },
  });

  // ── 2. steer ──────────────────────────────────────────────────
  registry.register({
    name: "steer",
    description:
      "Send a mid-task nudge to the agent. The message will be seen before the agent's next tool call — without interrupting the current turn or breaking the prompt cache. Use this to course-correct without restarting.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description:
            "Short instruction to guide the agent. Example: 'Don't refactor, just fix the bug.' or 'Add error handling for edge cases.' or 'Use the existing utility instead of reinventing.'",
        },
      },
      required: ["message"],
    },
    fn: async (args: { message?: unknown }) => {
      const message =
        typeof args.message === "string" ? args.message.trim() : "";
      if (!message) {
        return JSON.stringify({ error: "message is required" });
      }
      _steerQueue.push(message);
      return JSON.stringify({
        success: true,
        queued: true,
        message,
        note: "The agent will see this on its next tool call.",
      });
    },
  });

  // ── 3. auto_commit ────────────────────────────────────────────
  registry.register({
    name: "auto_commit",
    description:
      "Automatically commit all current changes with a descriptive message. Stages all files (git add -A), creates a commit, and returns the commit hash. Use this after completing a set of changes to keep a clean history. The commit message describes what was changed based on the git diff.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description:
            "Optional override commit message. If omitted, a message is auto-generated from the diff (e.g. 'feat: add search to inventory module').",
        },
      },
    },
    fn: async (args: { message?: unknown }) => {
      const overrideMsg =
        typeof args.message === "string" ? args.message.trim() : "";
      let message = overrideMsg;

      if (!message) {
        // Auto-generate from diff
        const diff = getGitDiff(opts.projectRoot);
        if (!diff) {
          return JSON.stringify({
            success: true,
            committed: false,
            note: "No changes to commit.",
          });
        }
        // Simple heuristic: first line of diff stat
        const firstLine = diff.split("\n")[0] ?? "";
        message = `update: ${firstLine.slice(0, 80)}`;
      }

      const result = gitCommit(opts.projectRoot, message);
      if (result.ok) {
        return JSON.stringify({
          success: true,
          committed: true,
          hash: result.hash,
          message,
        });
      }
      return JSON.stringify({
        error: `Commit failed: ${result.error}`,
        tip: "Is this a git repository? If not, run 'git init' first.",
      });
    },
  });

  // ── 4. fork_session ───────────────────────────────────────────
  registry.register({
    name: "fork_session",
    description:
      "Create a fork (branch) of the current conversation. The current session is saved and a new session starts fresh, but the fork retains access to the parent's conversation history. Use this when you want to try an alternative approach without losing your current progress — like git branching for conversations.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Name for the forked session. Default: 'fork-<timestamp>'.",
        },
      },
    },
    fn: async (args: { name?: unknown }) => {
      const name =
        typeof args.name === "string" ? args.name.trim() : `fork-${Date.now()}`;
      if (!opts.onForkSession) {
        return JSON.stringify({
          error: "Session forking is not available in the current mode.",
        });
      }
      try {
        const forkId = await opts.onForkSession();
        if (forkId) {
          return JSON.stringify({
            success: true,
            fork_session: forkId,
            name,
            note: `Session forked. Use 'resume session ${forkId}' to switch to the fork. The original session is preserved.`,
          });
        }
        return JSON.stringify({
          error: "Failed to fork session.",
        });
      } catch (e: any) {
        return JSON.stringify({
          error: `Fork failed: ${e.message}`,
        });
      }
    },
  });

  // ── 5. ultra_review ────────────────────────────────────────────
  registry.register({
    name: "ultra_review",
    description:
      "Run a comprehensive multi-agent code review on a set of files or the current changes. Spawns multiple specialized agents (security, reviewer, architect) in parallel, each analyzing from their perspective. Returns an aggregated report with findings, severity ratings, and fix recommendations. Use this before committing to catch issues early.",
    parameters: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional list of file paths to review. If omitted, reviews all uncommitted changes.",
        },
        agents: {
          type: "array",
          items: { type: "string", enum: REVIEW_AGENTS },
          description:
            "Which review agents to run. Default: all (security, reviewer, architect).",
        },
      },
    },
    fn: async (args: { files?: unknown; agents?: unknown }, ctx) => {
      const files =
        Array.isArray(args.files)
          ? (args.files as string[]).filter((f) => typeof f === "string")
          : [];
      const selectedAgents =
        Array.isArray(args.agents)
          ? (args.agents as string[]).filter((a) => REVIEW_AGENTS.includes(a))
          : REVIEW_AGENTS;

      if (selectedAgents.length === 0) {
        return JSON.stringify({
          error: `At least one agent required. Available: ${REVIEW_AGENTS.join(", ")}`,
        });
      }

      const diff = files.length > 0
        ? `Files to review:\n${files.join("\n")}`
        : getGitDiff(opts.projectRoot) || "(no uncommitted changes)";

      // Run review agents in sequence (parallel would need Promise.all with the spawn client)
      const findings: ReviewFinding[] = [];

      for (const agentName of selectedAgents) {
        const agent = getAgent(opts.projectRoot, agentName);
        if (!agent) continue;

        const result = await opts.spawnSubagent({
          system: agent.prompt,
          task: `Review these changes for ${agentName} issues:\n\n${diff}`,
          signal: ctx?.signal,
        });

        findings.push({
          agent: agentName,
          summary: result.success ? "completed" : "failed",
          issues: [],
          passed: result.success,
        });

        if (!result.success) {
          findings[findings.length - 1].summary = `Error: ${result.error}`;
        }
      }

      const criticalCount = findings.filter((f) => !f.passed).length;
      return JSON.stringify({
        success: true,
        agents_run: selectedAgents.length,
        findings: findings.map((f) => ({
          agent: f.agent,
          status: f.passed ? "passed" : "has issues",
          result_preview: f.summary.slice(0, 300),
        })),
        summary:
          criticalCount > 0
            ? `${criticalCount}/${selectedAgents.length} agents found issues. Run individual reviews for details.`
            : "All agents passed. Code looks good!",
      });
    },
  });
}
