/**
 * Chrome Integration — native browser control via Chrome extension.
 *
 * Unlike Puppeteer (headless), this connects to the user's REAL Chrome
 * browser through a Chrome extension. The agent can see what the user
 * sees, interact with the current page, switch tabs, etc.
 *
 * Usage:
 *   1. Load .reasonix/chrome-extension/ as an unpacked extension in Chrome
 *   2. chrome_connect() — start the bridge server
 *   3. chrome_navigate / chrome_click / chrome_type / chrome_extract / ...
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolRegistry } from "../tools.js";

const WS_PORT = 18889;
let _wss: any = null;
let _clientConn: any = null;
let _pendingResolvers = new Map<string, (result: any) => void>();
let _cmdCounter = 0;
let _server: any = null;

// Minimal WebSocket server (no external deps — uses http upgrade)
function startWSServer(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const http = require("node:http");
      const crypto = require("node:crypto");

      _server = http.createServer();
      
      _server.on("upgrade", (req: any, socket: any, head: any) => {
        const key = req.headers["sec-websocket-key"];
        if (!key) { socket.destroy(); return; }
        
        const accept = crypto
          .createHash("sha1")
          .update(key + "258EAFA5-E914-47DA-95CA-5AB3C6F0B2BD")
          .digest("base64");

        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
        );

        _clientConn = socket;

        // Receive messages
        let buf = Buffer.alloc(0);
        socket.on("data", (data: Buffer) => {
          buf = Buffer.concat([buf, data]);
          while (buf.length >= 2) {
            const firstByte = buf[0];
            const secondByte = buf[1];
            const opcode = firstByte & 0x0f;
            const masked = (secondByte & 0x80) !== 0;
            let payloadLen = secondByte & 0x7f;
            let offset = 2;

            if (payloadLen === 126) {
              if (buf.length < 4) return;
              payloadLen = buf.readUInt16BE(2);
              offset = 4;
            } else if (payloadLen === 127) {
              if (buf.length < 10) return;
              payloadLen = Number(buf.readBigUInt64BE(2));
              offset = 10;
            }

            const totalLen = offset + (masked ? 4 : 0) + payloadLen;
            if (buf.length < totalLen) return;

            let mask: Buffer | null = null;
            if (masked) {
              mask = buf.subarray(offset, offset + 4);
              offset += 4;
            }

            let payload = buf.subarray(offset, offset + payloadLen);
            if (mask) {
              for (let i = 0; i < payload.length; i++) {
                payload[i] ^= mask[i % 4];
              }
            }

            const text = payload.toString("utf8");
            buf = buf.subarray(totalLen);

            // Handle close frame
            if (opcode === 0x08) {
              _clientConn = null;
              continue;
            }

            try {
              const msg = JSON.parse(text);
              if (msg.type === "result" && msg.id) {
                const resolver = _pendingResolvers.get(String(msg.id));
                if (resolver) {
                  resolver(msg.result);
                  _pendingResolvers.delete(String(msg.id));
                }
              } else if (msg.type === "hello") {
                console.error(`[chrome] Extension connected: ${msg.browser?.slice(0, 50) || "unknown"}`);
              }
            } catch {
              // ignore parse errors
            }
          }
        });

        socket.on("close", () => {
          _clientConn = null;
          // Reject all pending commands
          for (const [id, resolver] of _pendingResolvers) {
            resolver({ error: "Chrome extension disconnected" });
          }
          _pendingResolvers.clear();
          console.error("[chrome] Extension disconnected");
        });

        socket.on("error", () => {
          _clientConn = null;
        });

        console.error(`[chrome] Extension connected on port ${port}`);
        resolve();
      });

      _server.listen(port, "127.0.0.1");
    } catch (e: any) {
      reject(e);
    }
  });
}

function sendFrame(data: any): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!_clientConn) {
      resolve({ error: "Chrome extension not connected. Start it with chrome_connect(), then load the extension in Chrome." });
      return;
    }

    const id = String(++_cmdCounter);
    data.id = id;
    _pendingResolvers.set(id, resolve);

    // Timeout after 15s
    setTimeout(() => {
      if (_pendingResolvers.has(id)) {
        _pendingResolvers.delete(id);
        resolve({ error: "Command timed out" });
      }
    }, 15000);

    try {
      const json = JSON.stringify(data);
      const msg = Buffer.from(json, "utf8");
      const frame = Buffer.alloc(2 + msg.length);
      frame[0] = 0x81; // FIN + text opcode
      frame[1] = msg.length;
      msg.copy(frame, 2);
      _clientConn.write(frame);
    } catch (e: any) {
      resolve({ error: `Send failed: ${e.message}` });
    }
  });
}

function ensureWSServer(port: number): Promise<void> {
  if (_server) return Promise.resolve();
  return startWSServer(port);
}

export function registerChromeTools(registry: ToolRegistry): void {
  // ── chrome_connect ────────────────────────────────────────────
  registry.register({
    name: "chrome_connect",
    description:
      'Start the Chrome bridge server. After calling this, load the Chrome extension from .reasonix/chrome-extension/ in your browser (chrome://extensions → Load unpacked). The extension connects automatically. Once connected, you can use chrome_navigate, chrome_click, chrome_type, etc. to control your real browser.',
    parameters: {
      type: "object",
      properties: {
        port: {
          type: "integer",
          description: "Port for the WebSocket server. Default: 18889.",
        },
      },
    },
    fn: async (args: { port?: unknown }) => {
      const port =
        typeof args.port === "number" && args.port > 0 ? args.port : WS_PORT;

      try {
        await ensureWSServer(port);
        return JSON.stringify({
          success: true,
          port,
          ws_url: `ws://127.0.0.1:${port}`,
          extension_path: ".reasonix/chrome-extension/",
          instructions: [
            "1. Open chrome://extensions in your browser",
            "2. Enable 'Developer mode' (top right)",
            "3. Click 'Load unpacked' and select the '.reasonix/chrome-extension/' folder",
            "4. The extension should connect automatically",
            "5. Verify with chrome_status()",
          ],
        });
      } catch (e: any) {
        return JSON.stringify({
          error: `Failed to start bridge: ${e.message}`,
        });
      }
    },
  });

  // ── chrome_status ─────────────────────────────────────────────
  registry.register({
    name: "chrome_status",
    description:
      "Check the status of the Chrome bridge connection. Returns whether the extension is connected, the active tab info, and the list of open tabs.",
    readOnly: true,
    parameters: { type: "object", properties: {} },
    fn: async () => {
      if (!_clientConn) {
        return JSON.stringify({
          connected: false,
          message: "No extension connected. Call chrome_connect() first, then load the extension.",
          instructions: "Open chrome://extensions → Developer mode → Load unpacked → select .reasonix/chrome-extension/",
        });
      }
      const result = await sendFrame({ command: "ping" });
      const tabs = await sendFrame({ command: "get_tabs" });
      const active = await sendFrame({ command: "get_active_tab" });
      return JSON.stringify({
        connected: true,
        extension_connected: !result?.error,
        active_tab: active?.error ? null : active,
        tabs: tabs?.error ? [] : (tabs as any[])?.slice(0, 10) ?? [],
        total_tabs: Array.isArray(tabs) ? tabs.length : 0,
      });
    },
  });

  // ── chrome_navigate ───────────────────────────────────────────
  registry.register({
    name: "chrome_navigate",
    description:
      "Navigate the active Chrome tab to a URL. The user will see the page load in their browser.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to navigate to (e.g. 'https://example.com')." },
      },
      required: ["url"],
    },
    fn: async (args: { url?: unknown }) => {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!url) return JSON.stringify({ error: "url required" });
      const result = await sendFrame({ command: "navigate", url });
      return JSON.stringify({ success: !result.error, ...result });
    },
  });

  // ── chrome_click ──────────────────────────────────────────────
  registry.register({
    name: "chrome_click",
    description:
      "Click an element in the active Chrome tab by CSS selector. The user sees the click happen in real-time.",
    parameters: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector for the element to click (e.g. 'button.submit', '#login-btn')." },
      },
      required: ["selector"],
    },
    fn: async (args: { selector?: unknown }) => {
      const selector = typeof args.selector === "string" ? args.selector.trim() : "";
      if (!selector) return JSON.stringify({ error: "selector required" });
      const result = await sendFrame({ command: "click", selector });
      return JSON.stringify({ success: !result.error, ...result });
    },
  });

  // ── chrome_type ───────────────────────────────────────────────
  registry.register({
    name: "chrome_type",
    description:
      "Type text into an input field in the active Chrome tab. The user sees the text being entered.",
    parameters: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector for the input element." },
        text: { type: "string", description: "Text to type into the field." },
      },
      required: ["selector", "text"],
    },
    fn: async (args: { selector?: unknown; text?: unknown }) => {
      const selector = typeof args.selector === "string" ? args.selector.trim() : "";
      const text = typeof args.text === "string" ? args.text : "";
      if (!selector) return JSON.stringify({ error: "selector required" });
      const result = await sendFrame({ command: "type", selector, text });
      return JSON.stringify({ success: !result.error, ...result });
    },
  });

  // ── chrome_extract ────────────────────────────────────────────
  registry.register({
    name: "chrome_extract",
    description:
      "Extract text or attributes from elements in the active Chrome tab. Without a selector, returns all interactive elements (links, buttons, inputs) on the page — useful for understanding the page structure.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        selector: { type: "string", description: "Optional CSS selector. Omit to get all interactive elements." },
        attribute: { type: "string", description: "Attribute to extract: 'innerText' (default), 'href', 'src', 'textContent'." },
      },
    },
    fn: async (args: { selector?: unknown; attribute?: unknown }) => {
      const selector = typeof args.selector === "string" ? args.selector.trim() : undefined;
      const attr = typeof args.attribute === "string" ? args.attribute.trim() : "innerText";
      const result = await sendFrame({ command: "extract", selector, attribute: attr });
      return JSON.stringify({ success: !result.error, ...result });
    },
  });

  // ── chrome_evaluate ───────────────────────────────────────────
  registry.register({
    name: "chrome_evaluate",
    description:
      "Run JavaScript code in the active Chrome tab's page context and get the result. Use this for complex interactions, data extraction, or checking page state.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "JavaScript expression to evaluate, e.g. 'document.title', 'window.localStorage.getItem(\"token\")'." },
      },
      required: ["code"],
    },
    fn: async (args: { code?: unknown }) => {
      const code = typeof args.code === "string" ? args.code.trim() : "";
      if (!code) return JSON.stringify({ error: "code required" });
      const result = await sendFrame({ command: "evaluate", code });
      return JSON.stringify({ success: !result.error, ...result });
    },
  });

  // ── chrome_screenshot ─────────────────────────────────────────
  registry.register({
    name: "chrome_screenshot",
    description:
      "Take a screenshot of the active Chrome tab. Returns the image as a data URL. Use this to see exactly what the user is seeing — useful for debugging UI issues, verifying page state, or understanding layout.",
    readOnly: true,
    parameters: { type: "object", properties: {} },
    fn: async () => {
      const result = await sendFrame({ command: "screenshot_full" });
      if (result.error) return JSON.stringify({ error: result.error });
      const dataUrl = result.screenshot as string;
      return JSON.stringify({
        success: true,
        image_data_url: dataUrl?.slice(0, 100) + `... (${Math.round((dataUrl?.length ?? 0) / 1024)} KB)`,
        size_bytes: dataUrl?.length ?? 0,
      });
    },
  });

  // ── chrome_tabs ───────────────────────────────────────────────
  registry.register({
    name: "chrome_tabs",
    description:
      "List all open Chrome tabs and switch to a specific tab. Use this to find the right tab before interacting with a page.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        switch_to: {
          type: "integer",
          description:
            "Optional tab ID to switch to. If provided, also returns the new active tab info after switching.",
        },
      },
    },
    fn: async (args: { switch_to?: unknown }) => {
      const switchTo =
        typeof args.switch_to === "number" ? args.switch_to : undefined;

      if (switchTo !== undefined) {
        const result = await sendFrame({ command: "switch_tab", targetTabId: switchTo });
        if (result.error) return JSON.stringify({ error: result.error });
      }

      const tabs = await sendFrame({ command: "get_tabs" });
      const active = await sendFrame({ command: "get_active_tab" });
      return JSON.stringify({
        success: true,
        switched: switchTo !== undefined,
        active_tab: active?.error ? null : active,
        tabs: tabs?.error ? [] : (tabs as any[]) ?? [],
      });
    },
  });

  // ── chrome_scroll ─────────────────────────────────────────────
  registry.register({
    name: "chrome_scroll",
    description:
      "Scroll the active Chrome tab. Use this to reveal content below the fold before extracting or clicking.",
    parameters: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["down", "up", "to_top", "to_bottom"], description: "Scroll direction. Default: down." },
        amount: { type: "integer", description: "Scroll amount in pixels. Default: 80% of viewport height." },
      },
    },
    fn: async (args: { direction?: unknown; amount?: unknown }) => {
      const direction = typeof args.direction === "string" ? args.direction : "down";
      const amount = typeof args.amount === "number" ? args.amount : undefined;
      const result = await sendFrame({ command: "scroll", direction, amount });
      return JSON.stringify({ success: !result.error, ...result });
    },
  });
}
