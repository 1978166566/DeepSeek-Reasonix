/**
 * Messaging Gateway — lightweight multi-platform message relay.
 *
 * Architecture:
 *   Gateway process runs alongside the agent. It polls/receives messages
 *   from platforms (Telegram, Discord, etc.) and queues them for the agent.
 *   Agent responses are delivered back to the platform.
 *
 * First platform: Telegram (polling via Bot API, no webhooks needed).
 *
 * Usage:
 *   gateway_start(telegram_token) — start the gateway
 *   gateway_status() — check connected platforms
 *   gateway_stop() — stop the gateway
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { ToolRegistry } from "../tools.js";

let _gatewayProcess: ChildProcess | null = null;
let _gatewayPort = 0;

export interface GatewayOptions {
  projectRoot: string;
}

/**
 * Send a message to a platform via the gateway's HTTP API.
 */
export async function sendViaGateway(
  platform: string,
  chatId: string,
  message: string,
): Promise<boolean> {
  if (!_gatewayProcess) return false;
  try {
    const response = await fetch(
      `http://127.0.0.1:${_gatewayPort}/api/send`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform, chat_id: chatId, message }),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

export function registerGatewayTools(
  registry: ToolRegistry,
  opts: GatewayOptions,
): void {
  // ── gateway_start ──────────────────────────────────────────────
  registry.register({
    name: "gateway_start",
    description:
      "Start the messaging gateway. This allows the agent to send and receive messages from messaging platforms. Currently supports Telegram. Pass your Telegram Bot Token (from @BotFather) to start polling for messages.",
    parameters: {
      type: "object",
      properties: {
        telegram_token: {
          type: "string",
          description:
            "Telegram Bot Token from @BotFather (e.g. '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11').",
        },
        port: {
          type: "integer",
          description:
            "Local port for the gateway HTTP API. Default: 18789.",
        },
      },
      required: ["telegram_token"],
    },
    fn: async (args: { telegram_token?: unknown; port?: unknown }) => {
      const token =
        typeof args.telegram_token === "string"
          ? args.telegram_token.trim()
          : "";
      if (!token) {
        return JSON.stringify({
          error: "telegram_token is required. Get one from @BotFather on Telegram.",
        });
      }
      if (_gatewayProcess) {
        return JSON.stringify({
          success: true,
          already_running: true,
          port: _gatewayPort,
          status: "Use gateway_stop() to restart with a new token.",
        });
      }

      const port =
        typeof args.port === "number" && args.port > 0
          ? args.port
          : 18789;
      _gatewayPort = port;

      // Start a simple Node.js HTTP server as the gateway
      const gatewayCode = `
        const http = require('http');
        const https = require('https');
        const TELEGRAM_TOKEN = ${JSON.stringify(token)};
        const PORT = ${port};
        let lastUpdateId = 0;
        const messageQueue = [];

        // Telegram polling
        async function pollTelegram() {
          try {
            const url = new URL(\`https://api.telegram.org/bot\${TELEGRAM_TOKEN}/getUpdates\`);
            url.searchParams.set('timeout', '30');
            url.searchParams.set('offset', String(lastUpdateId + 1));
            const res = await fetch(url.toString());
            const data = await res.json();
            if (data.ok && data.result) {
              for (const update of data.result) {
                if (update.update_id > lastUpdateId) lastUpdateId = update.update_id;
                if (update.message?.text) {
                  messageQueue.push({
                    platform: 'telegram',
                    chat_id: String(update.message.chat.id),
                    from: update.message.from?.first_name ?? 'unknown',
                    text: update.message.text,
                    date: update.message.date,
                  });
                }
              }
            }
          } catch (e) {
            // Polling errors are normal (timeouts, network)
          }
        }

        // Poll every 3 seconds
        setInterval(pollTelegram, 3000);

        // HTTP server for agent to read messages and send replies
        const server = http.createServer((req, res) => {
          res.setHeader('Content-Type', 'application/json');

          if (req.method === 'GET' && req.url === '/api/poll') {
            const messages = messageQueue.splice(0);
            res.end(JSON.stringify({ ok: true, messages }));
          }
          else if (req.method === 'POST' && req.url === '/api/send') {
            let body = '';
            req.on('data', (chunk) => body += chunk);
            req.on('end', async () => {
              try {
                const msg = JSON.parse(body);
                if (msg.platform === 'telegram' && msg.chat_id && msg.message) {
                  const url = \`https://api.telegram.org/bot\${TELEGRAM_TOKEN}/sendMessage\`;
                  const r = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: msg.chat_id, text: msg.message }),
                  });
                  const result = await r.json();
                  res.end(JSON.stringify({ ok: result.ok }));
                } else {
                  res.end(JSON.stringify({ ok: false, error: 'invalid message' }));
                }
              } catch (e) {
                res.end(JSON.stringify({ ok: false, error: e.message }));
              }
            });
          }
          else if (req.method === 'GET' && req.url === '/api/status') {
            res.end(JSON.stringify({
              ok: true,
              running: true,
              platform: 'telegram',
              queued_messages: messageQueue.length,
            }));
          }
          else {
            res.end(JSON.stringify({ ok: false, error: 'unknown endpoint' }));
          }
        });

        server.listen(PORT, '127.0.0.1', () => {
          console.error(\`[gateway] Telegram gateway running on port \${PORT}\`);
          pollTelegram(); // first poll immediately
        });
      `;

      try {
        const child = spawn(process.execPath, ["-e", gatewayCode], {
          stdio: ["pipe", "pipe", "pipe"],
          detached: false,
        });
        _gatewayProcess = child;

        // Wait a moment to check it started
        await new Promise((resolve) => setTimeout(resolve, 1000));

        return JSON.stringify({
          success: true,
          port,
          platforms: ["telegram"],
          status: "polling",
          how_to_send:
            "Messages from Telegram will appear in gateway_poll(). Use send_to(platform='telegram', chat_id='...', message='...') to reply.",
        });
      } catch (e: any) {
        _gatewayProcess = null;
        return JSON.stringify({
          error: `Failed to start gateway: ${e.message}`,
        });
      }
    },
  });

  // ── gateway_poll ───────────────────────────────────────────────
  registry.register({
    name: "gateway_poll",
    description:
      "Retrieve messages that have arrived from messaging platforms (Telegram, etc.) since the last poll. Returns new messages with platform, sender, and text. Call this periodically when the gateway is running.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {},
    },
    fn: async () => {
      if (!_gatewayProcess) {
        return JSON.stringify({
          error: "Gateway is not running. Start it with gateway_start(telegram_token=...).",
        });
      }
      try {
        const response = await fetch(
          `http://127.0.0.1:${_gatewayPort}/api/poll`,
        );
        const data = (await response.json()) as {
          ok?: boolean;
          messages?: { platform: string; chat_id: string; from: string; text: string }[];
        };
        if (data.ok && data.messages && data.messages.length > 0) {
          return JSON.stringify({
            success: true,
            count: data.messages.length,
            messages: data.messages.map((m) => ({
              platform: m.platform,
              chat_id: m.chat_id,
              from: m.from,
              text: m.text,
            })),
          });
        }
        return JSON.stringify({
          success: true,
          count: 0,
          messages: [],
        });
      } catch (e: any) {
        return JSON.stringify({
          error: `Failed to poll gateway: ${e.message}`,
        });
      }
    },
  });

  // ── gateway_status ─────────────────────────────────────────────
  registry.register({
    name: "gateway_status",
    description:
      "Check the status of the messaging gateway — whether it's running, which platforms are connected, and how many queued messages there are.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {},
    },
    fn: async () => {
      if (!_gatewayProcess) {
        return JSON.stringify({
          running: false,
          message: "Gateway is not running. Start it with gateway_start().",
        });
      }
      try {
        const response = await fetch(
          `http://127.0.0.1:${_gatewayPort}/api/status`,
        );
        const data = await response.json();
        return JSON.stringify({
          running: true,
          port: _gatewayPort,
          ...(data as object),
        });
      } catch {
        return JSON.stringify({
          running: true,
          port: _gatewayPort,
          platform: "telegram",
          note: "Gateway process is running but HTTP API is not responding yet.",
        });
      }
    },
  });

  // ── gateway_stop ───────────────────────────────────────────────
  registry.register({
    name: "gateway_stop",
    description:
      "Stop the messaging gateway and disconnect from all platforms.",
    parameters: {
      type: "object",
      properties: {},
    },
    fn: async () => {
      if (!_gatewayProcess) {
        return JSON.stringify({
          success: true,
          was_running: false,
        });
      }
      try {
        _gatewayProcess.kill("SIGTERM");
        _gatewayProcess = null;
        _gatewayPort = 0;
        return JSON.stringify({
          success: true,
          was_running: true,
          stopped: true,
        });
      } catch (e: any) {
        return JSON.stringify({
          error: `Failed to stop gateway: ${e.message}`,
        });
      }
    },
  });

  // ── send_to ────────────────────────────────────────────────────
  registry.register({
    name: "send_to",
    description:
      "Send a message to a chat on a connected messaging platform. Use this to reply to messages received via gateway_poll(), or to proactively send updates. Currently supports: telegram.",
    parameters: {
      type: "object",
      properties: {
        platform: {
          type: "string",
          enum: ["telegram"],
          description: "Target platform. Currently only 'telegram' is supported.",
        },
        chat_id: {
          type: "string",
          description:
            "Chat ID to send the message to. For Telegram, this is the numeric chat ID (e.g. '-1001234567890' for groups, '123456789' for DMs). Get this from gateway_poll() results.",
        },
        message: {
          type: "string",
          description: "Message text to send.",
        },
      },
      required: ["platform", "chat_id", "message"],
    },
    fn: async (args: {
      platform?: unknown;
      chat_id?: unknown;
      message?: unknown;
    }) => {
      const platform =
        typeof args.platform === "string" ? args.platform.trim() : "";
      const chatId =
        typeof args.chat_id === "string" ? args.chat_id.trim() : "";
      const message =
        typeof args.message === "string" ? args.message : "";

      if (!platform || !chatId || !message) {
        return JSON.stringify({
          error: "platform, chat_id, and message are all required.",
        });
      }

      if (!_gatewayProcess) {
        return JSON.stringify({
          error: "Gateway is not running. Start it with gateway_start().",
        });
      }

      const ok = await sendViaGateway(platform, chatId, message);
      return JSON.stringify({
        success: ok,
        platform,
        chat_id: chatId,
        message_length: message.length,
      });
    },
  });
}
