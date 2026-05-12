/**
 * Self-Improvement Loop — inspired by Hermes Agent's background review fork.
 *
 * After complex tasks, the model can call `reflect` to analyze what was done,
 * extract patterns, and create/update skills for future reuse.
 *
 * This is the programmatic half. The other half is the system prompt hint
 * already added in src/code/prompt.ts (Auto Skill Creation section).
 */

import { SkillStore } from "../skills.js";
import type { ToolRegistry } from "../tools.js";
import type { SubagentResult } from "./subagent.js";

export interface ReflectOptions {
  /** Spawn a subagent to analyze work and produce skill content. */
  spawnReflectSubagent: (
    task: string,
    signal?: AbortSignal,
  ) => Promise<SubagentResult>;
  /** Format a subagent result to string. */
  formatResult: (r: SubagentResult) => string;
  /** Skills store (to check for duplicates). */
  skillStore: SkillStore;
  /** Project root for scoping skills. */
  projectRoot?: string;
}

const SELF_IMPROVE_SYSTEM = `You are a self-improvement analyst. Your job is to analyze recent work and decide if anything should be saved as a reusable skill.

You have access to:
- create_skill — to create new skills
- Memory tools — to save important facts
- Only READ tools — you cannot modify files or run commands

Rules:
1. ONLY create a skill if the work involved 3+ steps in a specific sequence that could be repeated.
2. A good skill has: a clear trigger condition, numbered steps, and expected outcomes.
3. Don't create skills for one-off tasks, simple queries, or things the model already handles well.
4. Prefer updating an EXISTING skill over creating a new one.
5. If nothing is worth saving, say so — don't force creation.

When you DO create a skill:
- Name it something descriptive like "deploy-frontend" or "debug-http-500"
- Description should lead with the trigger verb: "Deploy the frontend to production server..."
- Body: numbered steps with exact commands, expected outputs, and common pitfalls
- Use run_as: inline (default) so the steps appear in the conversation log

When you create a skill, also save a memory entry explaining when to use it.

Final answer format:
## Decision
CREATE / UPDATE / SKIP

## Rationale (one paragraph)

## Skill (if created)
Name, description, body preview

## Memory (if saved)
What was saved`;

/**
 * Count tool calls in the current conversation excerpt.
 */
function countToolCalls(task: string): number {
  const matches = task.match(/tool_call|Tool Result|called:/gi);
  return matches?.length ?? 0;
}

export function registerReflectTool(
  registry: ToolRegistry,
  opts: ReflectOptions,
): void {
  registry.register({
    name: "reflect",
    description:
      'Analyze recent work and decide if anything should be saved as a reusable skill. Call this after completing a complex multi-step task (3+ steps, non-trivial workflow). The reflect subagent has access to create_skill to save patterns for future reuse, and memory to record important facts. It is READ-ONLY — it cannot modify files. Skips creating skills for simple or one-off tasks automatically. Returns a decision summary with any new skills or memory entries created.',
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        task_summary: {
          type: "string",
          description:
            "Optional summary of what was just accomplished. If omitted, the subagent will work from context. Good to include: what you did, what steps were involved, any tricky parts.",
        },
        tool_call_count: {
          type: "integer",
          description:
            "Number of tool calls made during this task. Used to decide if reflection is worthwhile. Usually: < 3 = skip, 3-8 = consider, 8+ = strongly consider.",
        },
        force: {
          type: "boolean",
          description:
            "If true, always run the reflection even for simple tasks. Default false.",
        },
      },
    },
    fn: async (
      args: {
        task_summary?: unknown;
        tool_call_count?: unknown;
        force?: unknown;
      },
      ctx,
    ) => {
      const taskSummary =
        typeof args.task_summary === "string"
          ? args.task_summary.trim()
          : "";
      const toolCount =
        typeof args.tool_call_count === "number"
          ? args.tool_call_count
          : 0;
      const force = args.force === true;

      // Skip reflection for very simple tasks unless forced
      if (!force && toolCount < 3 && !taskSummary) {
        return JSON.stringify({
          decision: "SKIP",
          rationale:
            "Task was too simple (fewer than 3 tool calls) to warrant a skill. Self-improvement skipped.",
          tool_call_count: toolCount,
        });
      }

      // Check recent skills to avoid duplicates
      const existingSkills = opts.skillStore
        .list()
        .map((s) => s.name)
        .join(", ");

      const task = taskSummary
        ? `Task just completed: ${taskSummary}\n\nTool calls made: ${toolCount}\n\nExisting skills: ${existingSkills || "(none)"}\n\nAnalyze what was done and decide: should any part of this be saved as a skill for future reuse?`
        : `A task was just completed with ${toolCount} tool calls.\n\nExisting skills: ${existingSkills || "(none)"}\n\nAnalyze the work patterns from context and decide what to save.`;

      const result = await opts.spawnReflectSubagent(task, ctx?.signal);

      if (!result.success) {
        return JSON.stringify({
          decision: "ERROR",
          error: result.error ?? "Reflection subagent failed",
        });
      }

      return JSON.stringify({
        decision: "COMPLETED",
        output: result.output,
        tool_call_count: toolCount,
        note: "Review the reflection output above. If a skill was created, it will be available next session via /skill list or run_skill.",
      });
    },
  });
}
