/**
 * Observability — Langfuse integration for tool call tracing and cost tracking.
 *
 * Wraps the Langfuse SDK to capture:
 * - Each tool call (name, args, duration, success/fail)
 * - Each assistant turn (model, tokens, cost)
 * - Session-level aggregation
 *
 * Usage: set LANGFUSE_SECRET_KEY and LANGFUSE_PUBLIC_KEY in env.
 */

import { execSync } from "node:child_process";

let _langfuse: any = null;
let _traceId: string | null = null;
let _sessionId: string | null = null;
let _initialized = false;

export interface ObservationEvent {
  type: "tool_call" | "assistant_turn" | "session_start" | "session_end";
  toolName?: string;
  toolArgs?: string;
  toolResult?: string;
  durationMs?: number;
  success?: boolean;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
  sessionId?: string;
  error?: string;
}

function getLangfuse(): any {
  if (_initialized) return _langfuse;
  _initialized = true;
  try {
    const secretKey = process.env.LANGFUSE_SECRET_KEY;
    const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
    const host = process.env.LANGFUSE_HOST ?? "https://cloud.langfuse.com";
    if (!secretKey || !publicKey) {
      console.warn("[observability] Langfuse not configured: set LANGFUSE_SECRET_KEY and LANGFUSE_PUBLIC_KEY");
      return null;
    }
    const Langfuse = require("langfuse").Langfuse;
    _langfuse = new Langfuse({
      secretKey,
      publicKey,
      host,
    });
    return _langfuse;
  } catch (e: any) {
    console.warn(`[observability] Failed to init Langfuse: ${e.message}`);
    return null;
  }
}

export function initSession(sessionId: string): void {
  _sessionId = sessionId;
  const lf = getLangfuse();
  if (!lf) return;
  const trace = lf.trace({
    name: "reasonix-session",
    sessionId,
    metadata: { startTime: new Date().toISOString() },
  });
  _traceId = trace.id;
}

export function observe(ev: ObservationEvent): void {
  const lf = getLangfuse();
  if (!lf || !_traceId) return;

  try {
    if (ev.type === "tool_call") {
      lf.span({
        traceId: _traceId,
        name: ev.toolName ?? "unknown-tool",
        input: ev.toolArgs ?? "",
        output: ev.toolResult ?? "",
        startTime: new Date(Date.now() - (ev.durationMs ?? 0)),
        endTime: new Date(),
        metadata: {
          success: ev.success,
          durationMs: ev.durationMs,
          error: ev.error,
        },
      });
    } else if (ev.type === "assistant_turn") {
      lf.generation({
        traceId: _traceId,
        name: "assistant-turn",
        model: ev.model ?? "unknown",
        usage: {
          promptTokens: ev.promptTokens ?? 0,
          completionTokens: ev.completionTokens ?? 0,
          totalTokens: (ev.promptTokens ?? 0) + (ev.completionTokens ?? 0),
        },
        metadata: {
          costUsd: ev.costUsd,
        },
      });
    } else if (ev.type === "session_end") {
      lf.trace({
        id: _traceId,
        metadata: { endTime: new Date().toISOString(), ...(ev.costUsd ? { totalCostUsd: ev.costUsd } : {}) },
      });
    }
  } catch {
    // silently fail — observability should never crash the agent
  }
}

export async function flushObservability(): Promise<void> {
  const lf = getLangfuse();
  if (lf) await lf.flushAsync().catch(() => {});
}
