import { DeepSeekClient } from "../client.js";
import {
  loadBaseUrl,
  loadEditMode,
  loadProjectShellAllowed,
  searchEnabled,
  webSearchEndpoint,
  webSearchEngine,
} from "../config.js";
import { bootstrapSemanticSearchInCodeMode } from "../index/semantic/tool.js";
import { ToolRegistry } from "../tools.js";
import { registerChoiceTool } from "../tools/choice.js";
import { registerDefineTool } from "../tools/custom-tools.js";
import { registerArchitectTools } from "../tools/architect.js";
import { registerFilesystemTools } from "../tools/filesystem.js";
import { registerLintRepairTool } from "../tools/project-map.js";
import { registerReflectTool } from "../tools/self-improve.js";
import { SkillStore } from "../skills.js";
import { JobRegistry } from "../tools/jobs.js";
import { registerMemoryTools } from "../tools/memory.js";
import { registerPlanTool } from "../tools/plan.js";
import { registerScaffoldTools } from "../tools/scaffold.js";
import { registerShellTools } from "../tools/shell.js";
import { registerSkillTools } from "../tools/skills.js";
import { formatSubagentResult, spawnSubagent } from "../tools/subagent.js";
import { registerTodoTool } from "../tools/todo.js";
import { registerWebTools } from "../tools/web.js";

export interface CodeToolsetOpts {
  rootDir: string;
}

export interface CodeToolset {
  tools: ToolRegistry;
  jobs: JobRegistry;
  registerRooted: (root: string) => void;
  reBootstrapSemantic: (root: string) => Promise<{ enabled: boolean }>;
  semantic: { enabled: boolean };
  /** Mutable ref — set by App.tsx after creating the ImmutablePrefix. Used by define_tool to hot-add tool specs. */
  prefixRef: { current: import("../memory/runtime.js").ImmutablePrefix | null };
}

export async function buildCodeToolset(opts: CodeToolsetOpts): Promise<CodeToolset> {
  const tools = new ToolRegistry();
  const jobs = new JobRegistry();
  const prefixRef: { current: import("../memory/runtime.js").ImmutablePrefix | null } = {
    current: null,
  };

  const registerRooted = (root: string): void => {
    registerFilesystemTools(tools, { rootDir: root });
    registerShellTools(tools, {
      rootDir: root,
      extraAllowed: () => loadProjectShellAllowed(root),
      allowAll: () => loadEditMode() === "yolo",
      jobs,
    });
    registerMemoryTools(tools, { projectRoot: root });
  };

  const reBootstrapSemantic = async (root: string): Promise<{ enabled: boolean }> => {
    const result = await bootstrapSemanticSearchInCodeMode(tools, root);
    if (!result.enabled) tools.unregister("semantic_search");
    return result;
  };

  registerRooted(opts.rootDir);
  registerPlanTool(tools);
  registerChoiceTool(tools);
  registerTodoTool(tools);
  registerScaffoldTools(tools, { projectRoot: opts.rootDir });
  registerDefineTool(tools, {
    subagentRunner: async (system, task, signal) => {
      if (!subagentClient) subagentClient = new DeepSeekClient({ baseUrl: loadBaseUrl() });
      const result = await spawnSubagent({
        client: subagentClient,
        parentRegistry: tools,
        parentSignal: signal,
        system,
        task,
      });
      return formatSubagentResult(result);
    },
    getPrefix: () => prefixRef.current,
  });
  registerArchitectTools(tools, {
    spawnSubagent: async (sopts) => {
      if (!subagentClient) subagentClient = new DeepSeekClient({ baseUrl: loadBaseUrl() });
      return spawnSubagent({
        client: subagentClient,
        parentRegistry: tools,
        parentSignal: sopts.signal,
        system: sopts.system,
        task: sopts.task,
        model: sopts.model,
        allowedTools: sopts.allowedTools,
      });
    },
    formatResult: formatSubagentResult,
    getPrefix: () => prefixRef.current,
  });
  registerLintRepairTool(tools, {
    projectRoot: opts.rootDir,
    runCommand: async (cmd) => {
      const { execSync } = await import("node:child_process");
      try {
        const stdout = execSync(cmd, {
          cwd: opts.rootDir,
          timeout: 120_000,
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
        });
        return { output: stdout, exitCode: 0 };
      } catch (e: any) {
        return {
          output: e.stdout ?? "",
          exitCode: e.status ?? 1,
        };
      }
    },
    spawnFixSubagent: async (task, signal) => {
      if (!subagentClient) subagentClient = new DeepSeekClient({ baseUrl: loadBaseUrl() });
      return spawnSubagent({
        client: subagentClient,
        parentRegistry: tools,
        parentSignal: signal,
        system: "",
        task,
      });
    },
    formatResult: formatSubagentResult,
  });
  registerReflectTool(tools, {
    spawnReflectSubagent: async (task, signal) => {
      if (!subagentClient) subagentClient = new DeepSeekClient({ baseUrl: loadBaseUrl() });
      return spawnSubagent({
        client: subagentClient,
        parentRegistry: tools,
        parentSignal: signal,
        system: "",
        task,
      });
    },
    formatResult: formatSubagentResult,
    skillStore: new SkillStore({ projectRoot: opts.rootDir }),
    projectRoot: opts.rootDir,
  });
  if (searchEnabled()) {
    registerWebTools(tools, {
      webSearchEngine: webSearchEngine(),
      webSearchEndpoint: webSearchEndpoint(),
    });
  }
  // Lazy: constructing DeepSeekClient throws when DEEPSEEK_API_KEY is unset,
  // which would kill `reasonix code` before the setup wizard can prompt for
  // one. Defer to first subagent dispatch — by then the user has either keyed
  // in or we error per-call instead of at boot.
  let subagentClient: DeepSeekClient | null = null;
  registerSkillTools(tools, {
    projectRoot: opts.rootDir,
    subagentRunner: async (skill, task, signal) => {
      if (!subagentClient) subagentClient = new DeepSeekClient({ baseUrl: loadBaseUrl() });
      const result = await spawnSubagent({
        client: subagentClient,
        parentRegistry: tools,
        parentSignal: signal,
        system: skill.body,
        task,
        model: skill.model,
        allowedTools: skill.allowedTools,
      });
      return formatSubagentResult(result);
    },
  });

  const semantic = await reBootstrapSemantic(opts.rootDir);

  return { tools, jobs, registerRooted, reBootstrapSemantic, semantic, prefixRef };
}
