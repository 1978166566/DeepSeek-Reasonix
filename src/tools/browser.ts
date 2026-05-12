/**
 * Browser Automation — CDP-based web interaction via Puppeteer.
 *
 * Manages a headless Chromium instance. Tools auto-launch on first use
 * and keep the browser alive across calls within a session.
 *
 * Tools:
 *   browser_navigate  — Go to a URL
 *   browser_click     — Click an element by CSS selector
 *   browser_type      — Type text into an input
 *   browser_snapshot  — Get page text/accessibility content
 *   browser_screenshot — Take a screenshot (saves to .reasonix/screenshots/)
 *   browser_evaluate  — Run JavaScript in page context
 *   browser_close     — Close the browser
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolRegistry } from "../tools.js";

let _browser: import("puppeteer").Browser | null = null;
let _page: import("puppeteer").Page | null = null;
let _launching: Promise<void> | null = null;

const SCREENSHOTS_DIR = ".reasonix/screenshots";
const VIEWPORT = { width: 1280, height: 800 };

async function ensureBrowser(): Promise<import("puppeteer").Page> {
  if (_page) return _page;
  if (_launching) {
    await _launching;
    return _page!;
  }
  _launching = (async () => {
    const puppeteer = await import("puppeteer");
    _browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });
    _page = await _browser.newPage();
    await _page.setViewport(VIEWPORT);
  })();
  await _launching;
  _launching = null;
  return _page!;
}

async function ensureScreenshotsDir(rootDir: string): Promise<string> {
  const dir = join(rootDir, SCREENSHOTS_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export interface BrowserToolOptions {
  projectRoot: string;
}

export function registerBrowserTools(
  registry: ToolRegistry,
  opts: BrowserToolOptions,
): void {
  // ── browser_navigate ────────────────────────────────────────────
  registry.register({
    name: "browser_navigate",
    description:
      "Navigate to a URL in the headless browser. Launches the browser on first call. Use this to load web pages for testing, scraping, or visual inspection.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "URL to navigate to. Must include protocol (http:// or https://).",
        },
        wait_until: {
          type: "string",
          enum: ["load", "domcontentloaded", "networkidle0", "networkidle2"],
          description:
            "When to consider navigation complete. Default: networkidle0 (no network activity for 500ms).",
        },
      },
      required: ["url"],
    },
    fn: async (args: { url?: unknown; wait_until?: unknown }) => {
      const url =
        typeof args.url === "string" ? args.url.trim() : "";
      if (!url) {
        return JSON.stringify({ error: "url is required" });
      }
      if (!/^https?:\/\//i.test(url)) {
        return JSON.stringify({
          error: "url must start with http:// or https://",
        });
      }
      const waitUntil =
        (typeof args.wait_until === "string"
          ? args.wait_until
          : "networkidle0") as
          | "load"
          | "domcontentloaded"
          | "networkidle0"
          | "networkidle2";

      try {
        const page = await ensureBrowser();
        await page.goto(url, { waitUntil, timeout: 30_000 });
        return JSON.stringify({
          success: true,
          url: page.url(),
          title: await page.title(),
          status: "loaded",
        });
      } catch (e: any) {
        return JSON.stringify({
          error: `Navigation failed: ${e.message}`,
        });
      }
    },
  });

  // ── browser_click ───────────────────────────────────────────────
  registry.register({
    name: "browser_click",
    description:
      "Click an element on the current page identified by a CSS selector. Waits for the element to appear (up to 5s). Returns the new page URL if navigation occurred.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description:
            "CSS selector for the element to click (e.g. 'button.submit', '#login-link', 'a[href=\"/about\"]').",
        },
        timeout: {
          type: "integer",
          description:
            "Max milliseconds to wait for the element. Default: 5000.",
        },
      },
      required: ["selector"],
    },
    fn: async (args: { selector?: unknown; timeout?: unknown }) => {
      const selector =
        typeof args.selector === "string" ? args.selector.trim() : "";
      if (!selector) {
        return JSON.stringify({ error: "selector is required" });
      }
      const timeout =
        typeof args.timeout === "number" && args.timeout > 0
          ? args.timeout
          : 5000;

      try {
        const page = await ensureBrowser();
        await page.waitForSelector(selector, { timeout });
        // Wait a tiny bit for any JS-rendered elements to settle
        await page.evaluate((sel: string) => {
          const el = document.querySelector(sel) as HTMLElement;
          if (el) el.click();
        }, selector);
        await new Promise((r) => setTimeout(r, 300));
        return JSON.stringify({
          success: true,
          url: page.url(),
          title: await page.title(),
        });
      } catch (e: any) {
        return JSON.stringify({
          error: `Click failed: ${e.message}`,
        });
      }
    },
  });

  // ── browser_type ────────────────────────────────────────────────
  registry.register({
    name: "browser_type",
    description:
      "Type text into an input field identified by a CSS selector. Clears the field first, then types the text.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description:
            "CSS selector for the input element (e.g. '#search-box', 'input[name=\"q\"]').",
        },
        text: {
          type: "string",
          description: "Text to type into the field.",
        },
        clear: {
          type: "boolean",
          description:
            "Whether to clear the field before typing. Default: true.",
        },
      },
      required: ["selector", "text"],
    },
    fn: async (args: {
      selector?: unknown;
      text?: unknown;
      clear?: unknown;
    }) => {
      const selector =
        typeof args.selector === "string" ? args.selector.trim() : "";
      const text =
        typeof args.text === "string" ? args.text : "";
      const shouldClear = args.clear !== false;

      if (!selector) {
        return JSON.stringify({ error: "selector is required" });
      }

      try {
        const page = await ensureBrowser();
        await page.waitForSelector(selector, { timeout: 5000 });
        if (shouldClear) {
          await page.$eval(
            selector,
            (el: any) => {
              el.value = "";
              el.dispatchEvent(new Event("input", { bubbles: true }));
            },
          );
        }
        await page.type(selector, text, { delay: 10 });
        return JSON.stringify({
          success: true,
          typed: text.length,
        });
      } catch (e: any) {
        return JSON.stringify({
          error: `Type failed: ${e.message}`,
        });
      }
    },
  });

  // ── browser_snapshot ────────────────────────────────────────────
  registry.register({
    name: "browser_snapshot",
    description:
      "Get a text snapshot of the current page. Returns the page text content (visible text, links, headings) and the page title. Useful for understanding page structure without a screenshot.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        max_chars: {
          type: "integer",
          description:
            "Max characters of text to return. Default: 8000.",
        },
      },
    },
    fn: async (args: { max_chars?: unknown }) => {
      const maxChars =
        typeof args.max_chars === "number" && args.max_chars > 0
          ? args.max_chars
          : 8000;

      try {
        const page = await ensureBrowser();
        const title = await page.title();
        const url = page.url();
        const text = await page.evaluate(() => {
          // Get a clean text representation: headings, links, buttons, main content
          const parts: string[] = [];
          const selectors = [
            "h1", "h2", "h3", "h4",
            "a[href]",
            "button",
            "input[type='submit']",
            "input[type='button']",
            'p',
            "li",
            "td",
            "th",
            'label',
            '[role="button"]',
            '[role="link"]',
            '[role="heading"]',
          ];
          for (const sel of selectors) {
            document.querySelectorAll(sel).forEach((el) => {
              const text2 = (el as HTMLElement).innerText?.trim();
              if (text2 && text2.length > 1) {
                const href = (el as HTMLAnchorElement).href;
                parts.push(
                  href && href.startsWith("http")
                    ? `[${text2}](${href})`
                    : text2,
                );
              }
            });
          }
          return [...new Set(parts)].join("\n");
        });

        const truncated =
          text.length > maxChars
            ? text.slice(0, maxChars) +
              `\n… (${text.length - maxChars} more chars)`
            : text;

        return JSON.stringify({
          success: true,
          title,
          url,
          text_length: text.length,
          content: truncated,
        });
      } catch (e: any) {
        return JSON.stringify({
          error: `Snapshot failed: ${e.message}`,
        });
      }
    },
  });

  // ── browser_screenshot ──────────────────────────────────────────
  registry.register({
    name: "browser_screenshot",
    description:
      "Take a screenshot of the current page. Saves to .reasonix/screenshots/ and returns the file path. Use this for visual inspection of pages.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        full_page: {
          type: "boolean",
          description:
            "If true, captures the full scrollable page. Default: false (only viewport).",
        },
      },
    },
    fn: async (args: { full_page?: unknown }) => {
      const fullPage = args.full_page === true;

      try {
        const page = await ensureBrowser();
        const dir = await ensureScreenshotsDir(opts.projectRoot);
        const timestamp = Date.now();
        const filename = `screenshot-${timestamp}.png`;
        const filePath = join(dir, filename);

        await page.screenshot({
          path: filePath,
          fullPage,
          type: "png",
        });

        return JSON.stringify({
          success: true,
          path: filePath,
          full_page: fullPage,
          dimensions: {
            width: VIEWPORT.width,
            height: VIEWPORT.height,
          },
        });
      } catch (e: any) {
        return JSON.stringify({
          error: `Screenshot failed: ${e.message}`,
        });
      }
    },
  });

  // ── browser_evaluate ────────────────────────────────────────────
  registry.register({
    name: "browser_evaluate",
    description:
      "Run JavaScript code in the browser page context and return the result. Use this for complex interactions, data extraction, or checking page state. The code runs as an anonymous function.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "JavaScript expression or function body to evaluate in the page. Examples: 'document.title', 'document.querySelectorAll(\"a\").length', 'JSON.stringify(window.__INITIAL_STATE__)'.",
        },
      },
      required: ["code"],
    },
    fn: async (args: { code?: unknown }) => {
      const code =
        typeof args.code === "string" ? args.code.trim() : "";
      if (!code) {
        return JSON.stringify({ error: "code is required" });
      }

      try {
        const page = await ensureBrowser();
        const result = await page.evaluate(code);
        return JSON.stringify({
          success: true,
          result:
            typeof result === "string"
              ? result.slice(0, 5000)
              : JSON.stringify(result).slice(0, 5000),
        });
      } catch (e: any) {
        return JSON.stringify({
          error: `Evaluate failed: ${e.message}`,
        });
      }
    },
  });

  // ── browser_close ──────────────────────────────────────────────
  registry.register({
    name: "browser_close",
    description:
      "Close the headless browser and free resources. Call this when done with browser tasks. The browser auto-launches again on the next browser_navigate call if needed.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {},
    },
    fn: async () => {
      if (!_browser) {
        return JSON.stringify({ success: true, was_open: false });
      }
      try {
        await _browser.close();
      } catch {
        // ignore
      }
      _browser = null;
      _page = null;
      return JSON.stringify({ success: true, was_open: true });
    },
  });

  // ── browser_dialog_accept / dismiss ──────────────────────────────
  registry.register({
    name: "browser_dialog_accept",
    description:
      "Accept the next JavaScript dialog (alert, confirm, prompt). Call this before triggering a dialog if you expect one, or call browser_listen to auto-handle.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            "Optional text to provide for prompt() dialogs.",
        },
      },
    },
    fn: async (args: { text?: unknown }) => {
      try {
        const page = await ensureBrowser();
        const promptText =
          typeof args.text === "string" ? args.text : undefined;
        page.once("dialog", async (dialog) => {
          await dialog.accept(promptText);
        });
        return JSON.stringify({
          success: true,
          message: "Dialog handler registered (accept)",
        });
      } catch (e: any) {
        return JSON.stringify({
          error: `Failed to set dialog handler: ${e.message}`,
        });
      }
    },
  });

  registry.register({
    name: "browser_dialog_dismiss",
    description:
      "Dismiss the next JavaScript dialog (alert, confirm, prompt). Call this before triggering a dialog to reject/cancel it.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {},
    },
    fn: async () => {
      try {
        const page = await ensureBrowser();
        page.once("dialog", async (dialog) => {
          await dialog.dismiss();
        });
        return JSON.stringify({
          success: true,
          message: "Dialog handler registered (dismiss)",
        });
      } catch (e: any) {
        return JSON.stringify({
          error: `Failed to set dialog handler: ${e.message}`,
        });
      }
    },
  });
}
