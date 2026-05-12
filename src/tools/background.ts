/**
 * Background Tasks — spawn commands without blocking the conversation.
 *
 * Enhanced version of the existing run_background + JobRegistry:
 * - bg(command): spawn a command, returns job_id immediately
 * - bg_result(job_id): retrieve completed job output
 * - bg_list(): show all running/completed jobs
 *
 * Model usage pattern:
 *   bg("mvn compile") → { job_id: "...", status: "running" }
 *   ...continue talking...
 *   bg_result(job_id) → { status: "completed", output: "BUILD SUCCESS" }
 */

import type { ToolRegistry } from "../tools.js";
import { JobRegistry } from "./jobs.js";

export interface BackgroundToolOptions {
  jobs: JobRegistry;
}

export function registerBackgroundTools(
  registry: ToolRegistry,
  opts: BackgroundToolOptions,
): void {
  // ── bg — spawn and forget ──────────────────────────────────────
  registry.register({
    name: "bg",
    description:
      "Run a shell command in the BACKGROUND and return immediately. The command continues running while you keep talking. Use bg_result(job_id) to check output later. Use bg_list() to see all jobs. Prefer this for long-running tasks like builds, tests, deployments.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "Shell command to run. Example: 'mvn compile -q', 'npm run build', 'python tests.py'.",
        },
        description: {
          type: "string",
          description:
            "Optional human-readable description shown in job listing.",
        },
      },
      required: ["command"],
    },
    fn: async (args: { command?: unknown; description?: unknown }) => {
      const cmd =
        typeof args.command === "string" ? args.command.trim() : "";
      if (!cmd) {
        return JSON.stringify({ error: "command is required" });
      }

      try {
        const result = await opts.jobs.start(cmd, { cwd: process.cwd() });
        return JSON.stringify({
          success: true,
          job_id: result.jobId,
          status: result.stillRunning ? "running" : "completed",
          check_with: `bg_result(job_id: ${result.jobId})`,
        });
      } catch (e: any) {
        return JSON.stringify({
          error: `Failed to spawn background job: ${e.message}`,
        });
      }
    },
  });

  // ── bg_result — check job output ────────────────────────────────
  registry.register({
    name: "bg_result",
    description:
      "Check the output of a background job started with bg(). Returns job status (running/completed/failed) and its output so far.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        job_id: {
          type: "integer",
          description: "Job ID returned by bg() or bg_list().",
        },
        tail: {
          type: "integer",
          description:
            "If set, only return the last N lines of output.",
        },
      },
      required: ["job_id"],
    },
    fn: async (args: { job_id?: unknown; tail?: unknown }) => {
      const jobId =
        typeof args.job_id === "number" ? args.job_id : -1;
      if (jobId < 0) {
        return JSON.stringify({ error: "job_id must be a positive integer" });
      }

      const tailLines =
        typeof args.tail === "number" && args.tail > 0 ? args.tail : 0;

      try {
        const result = opts.jobs.read(jobId);
        if (!result) {
          return JSON.stringify({
            error: `Job #${jobId} not found. Use bg_list() to see all jobs.`,
          });
        }

        let output = result.output;
        if (tailLines > 0) {
          const lines = output.split("\n");
          output = lines.slice(-tailLines).join("\n");
        }

        return JSON.stringify({
          success: true,
          job_id: jobId,
          status: result.running ? "running" : "completed",
          exit_code: result.exitCode,
          output: output.slice(0, 5000),
          output_truncated: output.length > 5000,
        });
      } catch (e: any) {
        return JSON.stringify({
          error: `Failed to read job: ${e.message}`,
        });
      }
    },
  });

  // ── bg_list — list all background jobs ─────────────────────────
  registry.register({
    name: "bg_list",
    description:
      "List all background jobs (running and completed). Shows job ID, command, status. Use bg_result(job_id) for full output.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {},
    },
    fn: async () => {
      const allJobs = opts.jobs.list();
      const running = allJobs.filter((j) => j.running);

      return JSON.stringify({
        success: true,
        running_count: running.length,
        total_count: allJobs.length,
        running_jobs: running.map((j) => ({
          id: j.id,
          command: (j as any).command ?? j.id,
          status: "running",
        })),
      });
    },
  });
}
