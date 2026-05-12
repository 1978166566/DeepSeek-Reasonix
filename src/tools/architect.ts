/**
 * Architect/Editor dual-model mode — inspired by Aider.
 *
 * architect_task: spawns a pro subagent with read-only tools to analyze
 * the codebase and produce a structured implementation plan.
 *
 * editor_task: takes a plan from the architect and implements it with
 * a flash subagent (cheaper model).
 *
 * Usage pattern:
 *   1. Call architect_task("add search to product list") → gets a plan
 *   2. Review the plan
 *   3. Call editor_task(plan) → implements it
 */

import type { ToolRegistry } from "../tools.js";
import type { ImmutablePrefix } from "../memory/runtime.js";
import type { SubagentResult } from "./subagent.js";

/** Return true for tool names that are safe in read-only mode. */
export function isReadOnlyToolName(name: string): boolean {
  const READ_ONLY_PREFIXES = [
    "read_",
    "search_",
    "list_",
    "get_",
    "directory_",
    "todo_",
    "ask_",
    "submit_",
    "define_",
    "create_skill",
    "add_mcp",
    "run_skill",
    "spawn_",
  ];
  return READ_ONLY_PREFIXES.some((p) => name.startsWith(p));
}

export interface ArchitectToolOptions {
  /** Spawn a subagent with given params. Returns SubagentResult. */
  spawnSubagent: (opts: {
    system: string;
    task: string;
    model: string;
    signal?: AbortSignal;
    allowedTools?: readonly string[];
  }) => Promise<SubagentResult>;
  /** Format SubagentResult to a display string. */
  formatResult: (r: SubagentResult) => string;
  /** Get the current ImmutablePrefix for hot-add. */
  getPrefix: () => ImmutablePrefix | null;
}

export function registerArchitectTools(
  registry: ToolRegistry,
  opts: ArchitectToolOptions,
): void {
  // --- architect_task — Pro model, read-only, produces plan ---
  registry.register({
    name: "architect_task",
    description:
      'Spawn a read-only architecture subagent (deepseek-v4-pro) to analyze the codebase and produce a structured implementation plan. Use this for complex tasks where you want a thorough plan before making changes. The subagent has only read tools (read_file, search_content, directory_tree, etc.) and returns a plan with files to change, implementation steps, and risks. After receiving the plan, review it and optionally feed it to editor_task for implementation.',
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "The task to analyze. Be specific about what you want to achieve.",
        },
        context: {
          type: "string",
          description:
            "Optional extra context — error messages, stack traces, user requirements. The subagent has no conversation history.",
        },
      },
      required: ["task"],
    },
    fn: async (
      args: { task?: unknown; context?: unknown },
      ctx,
    ) => {
      const task =
        typeof args.task === "string" ? args.task.trim() : "";
      if (!task) {
        return JSON.stringify({
          error: "architect_task requires a non-empty 'task'",
        });
      }
      const context =
        typeof args.context === "string" ? args.context.trim() : "";

      // Find read-only tool names from the registry
      const readOnlyNames: string[] = [];
      for (const spec of registry.specs()) {
        const name = spec.function.name;
        const def = registry.get(name);
        if (def && (def.readOnly || isReadOnlyToolName(name))) {
          readOnlyNames.push(name);
        }
      }

      const fullTask = context
        ? `Task: ${task}\n\nContext: ${context}`
        : task;

      const result = await opts.spawnSubagent({
        system: "",
        task: fullTask,
        model: "deepseek-v4-pro",
        signal: ctx?.signal,
        allowedTools: readOnlyNames,
      });

      const formatted = opts.formatResult(result);
      if (!result.success) {
        return JSON.stringify({
          success: false,
          error: result.error ?? "architect subagent failed",
          output: result.output,
        });
      }
      return JSON.stringify({
        success: true,
        output: result.output,
        note: "Review the plan above, then call editor_task with this output as the 'plan' parameter to implement it.",
      });
    },
  });

  // --- editor_task — Flash model, full tool access, follows plan ---
  registry.register({
    name: "editor_task",
    description:
      'Implement a plan produced by architect_task (or any detailed plan). Spawns a subagent (deepseek-v4-flash) with full tool access to make the changes. Pass the architect\'s plan as the "plan" parameter. The editor follows the plan exactly — no scope creep, no extra refactoring.',
    parameters: {
      type: "object",
      properties: {
        plan: {
          type: "string",
          description:
            "The plan to implement. Should include: what files to change, what to change in each, steps in order, and risks.",
        },
        model: {
          type: "string",
          enum: ["deepseek-v4-flash", "deepseek-v4-pro"],
          description:
            "Model to use for implementation. Default is 'deepseek-v4-flash' (cheap). Override to 'deepseek-v4-pro' if the architect recommended it.",
        },
      },
      required: ["plan"],
    },
    fn: async (
      args: { plan?: unknown; model?: unknown },
      ctx,
    ) => {
      const plan =
        typeof args.plan === "string" ? args.plan.trim() : "";
      if (!plan) {
        return JSON.stringify({
          error: "editor_task requires a non-empty 'plan'",
        });
      }
      const model =
        typeof args.model === "string" &&
        args.model === "deepseek-v4-pro"
          ? "deepseek-v4-pro"
          : "deepseek-v4-flash";

      // Editor gets all tools except spawn_subagent (depth limit)
      const result = await opts.spawnSubagent({
        system: "", // editor persona is set via type
        task: `Implement this plan precisely:\n\n${plan}`,
        model,
        signal: ctx?.signal,
        allowedTools: undefined, // all tools
      });

      if (!result.success) {
        return JSON.stringify({
          success: false,
          error: result.error ?? "editor subagent failed",
          partial_output: result.output,
        });
      }
      return JSON.stringify({
        success: true,
        output: result.output,
        model_used: model,
      });
    },
  });
}
