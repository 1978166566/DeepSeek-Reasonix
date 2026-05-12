/**
 * define_tool — 让 AI 在会话中实时注册新的 function calling 工具。
 *
 * 工作原理：
 * 1. AI 调用 define_tool(name, description, parameters, handler)
 * 2. 在 ToolRegistry 注册一个新工具，fn 是启动 subagent 执行 handler
 * 3. 在 ImmutablePrefix 也注册该工具（下一轮 DeepSeek API 请求就能看到）
 * 4. 下一轮 AI 可以像调用任何内置工具一样调用刚定义的工具
 *
 * 每个新工具都会引起一次 prefix cache miss，但后续调用走缓存。
 */

import type { ImmutablePrefix } from "../memory/runtime.js";
import type { ToolRegistry } from "../tools.js";
import type { ToolSpec } from "../types.js";

export interface DefineToolOptions {
  /** 用于执行 tool handler 的 subagent runner */
  subagentRunner: (system: string, task: string, signal?: AbortSignal) => Promise<string>;
  /** 返回当前的 ImmutablePrefix，用于动态注册工具 spec */
  getPrefix: () => ImmutablePrefix | null;
}

const VALID_TOOL_NAME = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

export function registerDefineTool(registry: ToolRegistry, opts: DefineToolOptions): void {
  registry.register({
    name: "define_tool",
    description:
      "Register a new callable tool on-the-fly. The tool becomes available as a function-calling tool on the NEXT turn (one cache-miss turn to shift the prefix). When called, it spawns a subagent with the handler prompt + the arguments it received. Use this when a task needs a reusable structured operation — the model can define it once and call it multiple times with different args. Each defined tool costs a small amount of extra prefix tokens but is otherwise free (no MCP server process).",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Tool name — letters/digits/underscores, must start with letter or underscore. Becomes the function name the model calls.",
        },
        description: {
          type: "string",
          description:
            "One-line description of what this tool does. Shown to the model when deciding whether to call it.",
        },
        parameters: {
          type: "object",
          description:
            "JSON Schema object describing the tool's arguments. Must have `type: \"object\"` and `properties`. Example: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] }",
        },
        handler: {
          type: "string",
          description:
            "System prompt for the subagent that executes when this tool is called. The subagent receives the arguments as its task description. Write clear instructions — the subagent has no context beyond this prompt + the call arguments.",
        },
      },
      required: ["name", "description", "parameters", "handler"],
    },
    fn: async (args: {
      name?: unknown;
      description?: unknown;
      parameters?: unknown;
      handler?: unknown;
    }) => {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!VALID_TOOL_NAME.test(name)) {
        return JSON.stringify({
          error: `invalid tool name: ${JSON.stringify(name)} — must match [a-zA-Z_][a-zA-Z0-9_-]*`,
        });
      }

      const description = typeof args.description === "string" ? args.description.trim() : "";
      if (!description) {
        return JSON.stringify({
          error: "define_tool requires a non-empty 'description'",
        });
      }

      const parameters = args.parameters;
      if (!parameters || typeof parameters !== "object") {
        return JSON.stringify({
          error: "define_tool requires 'parameters' as a JSON Schema object",
        });
      }
      const params = parameters as Record<string, unknown>;
      if (params.type !== "object") {
        return JSON.stringify({
          error: "define_tool 'parameters' must have type: 'object' (JSON Schema format)",
        });
      }

      const handler = typeof args.handler === "string" ? args.handler.trim() : "";
      if (!handler) {
        return JSON.stringify({
          error: "define_tool requires a non-empty 'handler'",
        });
      }

      // Check for duplicate name
      if (registry.has(name)) {
        return JSON.stringify({
          error: `tool ${JSON.stringify(name)} is already registered`,
        });
      }

      // Register the new tool in the ToolRegistry
      // When called, it spawns a subagent with handler + args
      registry.register({
        name,
        readOnly: false,
        description,
        parameters: params as any,
        fn: async (toolArgs: unknown, toolCtx) => {
          const task = JSON.stringify(
            { args: toolArgs, handler_description: description },
            null,
            2,
          );
          return opts.subagentRunner(handler, task, toolCtx?.signal);
        },
      });

      // Also register in the ImmutablePrefix so the model sees it
      const prefix = opts.getPrefix();
      const toolSpec: ToolSpec = {
        type: "function",
        function: { name, description, parameters: params as ToolSpec["function"]["parameters"] },
      };
      const added = prefix?.addTool(toolSpec) ?? false;

      return JSON.stringify({
        success: true,
        name,
        prefix_registered: added,
        note: added
          ? "Tool will be available from the next turn. One cache-miss turn for prefix shift."
          : "Tool registered in registry but prefix update pending (new turn will pick it up).",
      });
    },
  });
}
