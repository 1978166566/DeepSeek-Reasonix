import type { DeepSeekClient } from "../client.js";

export interface DeepSeekProbeResult {
  reachable: boolean;
}

export function formatLoopError(err: Error, probe?: DeepSeekProbeResult): string {
  const msg = err.message ?? "";
  if (msg.includes("maximum context length")) {
    const reqMatch = msg.match(/requested\s+(\d+)\s+tokens/);
    const requested = reqMatch
      ? `${Number(reqMatch[1]).toLocaleString()} tokens`
      : "too many tokens";
    return `Context overflow (DeepSeek 400): session history is ${requested}, past the model's prompt limit (V4: 1M tokens; legacy chat/reasoner: 131k). Usually a single tool result grew too big. Reasonix caps new tool results at 8k tokens and auto-heals oversized history on session load — a restart often clears it. If it still overflows, run /forget (delete the session) or /clear (drop the displayed history) to start fresh.`;
  }

  const m = /^DeepSeek (\d{3}):\s*([\s\S]*)$/.exec(msg);
  if (!m) return msg;
  const status = m[1] ?? "";
  const body = m[2] ?? "";
  const inner = extractDeepSeekErrorMessage(body);

  if (status === "401") {
    return `Authentication failed (DeepSeek 401): ${inner}. Your API key is rejected. Fix with \`reasonix setup\` or \`export DEEPSEEK_API_KEY=sk-...\`. Get one at https://platform.deepseek.com/api_keys.`;
  }
  if (status === "402") {
    return `Out of balance (DeepSeek 402): ${inner}. Top up at https://platform.deepseek.com/top_up — the panel header shows your balance once it's non-zero.`;
  }
  if (status === "422") {
    return `Invalid parameter (DeepSeek 422): ${inner}`;
  }
  if (status === "400") {
    return `Bad request (DeepSeek 400): ${inner}`;
  }
  if (is5xxStatus(status)) {
    return formatDeepSeek5xx(status, probe);
  }
  return msg;
}

export function is5xxError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = /^DeepSeek (5\d{2}):/.exec(err.message ?? "");
  return m !== null;
}

export async function probeDeepSeekReachable(
  client: DeepSeekClient,
  timeoutMs = 1500,
): Promise<DeepSeekProbeResult> {
  const balance = await client.getBalance({ signal: AbortSignal.timeout(timeoutMs) });
  return { reachable: balance !== null };
}

function is5xxStatus(status: string): boolean {
  return status === "500" || status === "502" || status === "503" || status === "504";
}

function formatDeepSeek5xx(status: string, probe?: DeepSeekProbeResult): string {
  const head = `DeepSeek service unavailable (${status}) — this is a DeepSeek-side problem, not Reasonix. Already retried 4× with backoff.`;
  const probeNote =
    probe === undefined
      ? ""
      : probe.reachable
        ? " DeepSeek's main API answered our health check, but /chat/completions is failing — partial outage on their side."
        : " DeepSeek API is unreachable from your network — could be a wider DS outage or a local network issue.";
  const action =
    probe?.reachable === false
      ? " Try: (1) check your network, (2) wait 30s and retry, (3) status page: https://status.deepseek.com."
      : " Try: (1) wait 30s and retry, (2) /preset to switch model, (3) status page: https://status.deepseek.com.";
  return `${head}${probeNote}${action}`;
}

export function reasonPrefixFor(
  reason: "budget" | "aborted" | "context-guard" | "stuck",
  iterCap: number,
): string {
  if (reason === "aborted") return "[aborted by user (Esc) — summarizing what I found so far]";
  if (reason === "context-guard") {
    return "[context budget running low — summarizing before the next call would overflow]";
  }
  if (reason === "stuck") {
    return "[stuck on a repeated tool call — explaining what was tried and what's blocking progress]";
  }
  return `[tool-call budget (${iterCap}) reached — forcing summary from what I found]`;
}

export function errorLabelFor(
  reason: "budget" | "aborted" | "context-guard" | "stuck",
  iterCap: number,
): string {
  if (reason === "aborted") return "aborted by user";
  if (reason === "context-guard") return "context-guard triggered (prompt > 80% of window)";
  if (reason === "stuck") return "stuck (repeated tool call suppressed by storm-breaker)";
  return `tool-call budget (${iterCap}) reached`;
}

function extractDeepSeekErrorMessage(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "(no message)";
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as { error?: { message?: unknown }; message?: unknown };
      if (obj.error && typeof obj.error.message === "string") return obj.error.message;
      if (typeof obj.message === "string") return obj.message;
    }
  } catch {
    /* not JSON — fall through */
  }
  return trimmed;
}
