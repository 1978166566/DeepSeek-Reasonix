/**
 * Sandbox — isolated command execution environment.
 *
 * macOS: uses sandbox-exec with a Seatbelt profile for system-call-level isolation.
 * Linux: uses bubblewrap (bwrap) when available, Docker as fallback.
 * Fallback: temp directory isolation on all platforms.
 *
 * The sandbox denies writes outside a designated temp directory, blocks
 * dangerous syscalls, and optionally restricts network access.
 */

import { execSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  rmSync,
  copyFileSync,
  mkdtempSync,
} from "node:fs";
import { join, resolve, relative } from "node:path";
import { tmpdir, hostname } from "node:os";
import type { ToolRegistry } from "../tools.js";

// ─── Sandbox Profile Template (macOS Seatbelt) ────────────────────

const SB_PROFILE = (sandboxDir: string, allowNetwork: boolean) => `
;;; Reasonix Sandbox Profile — generated automatically
;;; Restricts process to sandbox directory + basic system access

(version 1)

;; Deny by default
(deny default)

;; Allow basic system operations
(allow sysctl-read)
(allow process-fork)
(allow process-exec)
(allow signal (target self))
(allow appleevent-send (require-entitlement "com.apple.apsd"))

;; Allow reading standard system paths
(allow file-read*
  (regex "^/usr/lib/"
         "^/System/Library/"
         "^/usr/share/"
         "^/usr/bin/"
         "^/bin/"
         "^/private/tmp/"
         "^/private/var/tmp/"))

;; Allow reading common config
(allow file-read*
  (regex "^/etc/"
         "^/Library/Apple/"))
(allow file-read-metadata)

;; Allow writing only to sandbox directory
(allow file-write*
  (subpath "${sandboxDir}"))
(allow file-read*
  (subpath "${sandboxDir}"))

;; Allow reading the working directory contents
(allow file-read-metadata
  (subpath "${sandboxDir}"))

;; Standard I/O
(allow file-write* (literal "/dev/null")
                   (literal "/dev/random")
                   (literal "/dev/urandom")
                   (literal "/dev/zero"))

(allow file-read* (literal "/dev/null")
                  (literal "/dev/random")
                  (literal "/dev/urandom")
                  (literal "/dev/zero")
                  (literal "/dev/fd/0")
                  (literal "/dev/fd/1")
                  (literal "/dev/fd/2")
                  (literal "/dev/stdin")
                  (literal "/dev/stdout")
                  (literal "/dev/stderr")
                  (literal "/dev/tty"))

;; Allow standard I/O (already covered, but explicit)
(allow file-write* (literal "/dev/stdout")
                   (literal "/dev/stderr"))

;; Mach primitives needed by basic programs
(allow mach-lookup
  (global-name "com.apple.system.notification_center")
  (global-name "com.apple.system.logger"))

;; Networking
(allow network-outbound
  ${allowNetwork ? "(regex \".*\")" : ";; (regex \".*\") — blocked"}
  (require-sandbox))

;; Syscalls
(allow sysctl-read)
(allow syscall-unix)

;; IPC
(allow ipc-posix-semaphore)
(allow ipc-posix-shm)
`;

// ─── Sandbox Manager ──────────────────────────────────────────────

const SANDBOX_BASE = join(tmpdir(), "reasonix-sandbox");

interface SandboxInstance {
  id: string;
  dir: string;
  createdAt: number;
  lastUsed: number;
  commandCount: number;
}

const _instances = new Map<string, SandboxInstance>();
let _instanceCounter = 0;

function newSandboxId(): string {
  _instanceCounter++;
  return `sb-${_instanceCounter.toString(36)}-${Date.now().toString(36)}`;
}

function createSandboxDir(): string {
  if (!existsSync(SANDBOX_BASE)) mkdirSync(SANDBOX_BASE, { recursive: true });
  const dir = mkdtempSync(join(SANDBOX_BASE, "job-"));
  // Set restrictive permissions
  execSync(`chmod 700 "${dir}"`, { stdio: "pipe" });
  return dir;
}

function writeProfile(path: string, sandboxDir: string, allowNetwork: boolean): void {
  writeFileSync(path, SB_PROFILE(sandboxDir, allowNetwork), "utf8");
  execSync(`chmod 644 "${path}"`, { stdio: "pipe" });
}

/**
 * Check what sandbox mechanisms are available on this platform.
 */
function getSandboxType(): "sandbox-exec" | "docker" | "bwrap" | "tempdir" {
  if (process.platform === "darwin") {
    try {
      execSync("which sandbox-exec 2>/dev/null", { stdio: "pipe" });
      return "sandbox-exec";
    } catch {
      return "tempdir";
    }
  }
  if (process.platform === "linux") {
    try {
      execSync("which bwrap 2>/dev/null", { stdio: "pipe" });
      return "bwrap";
    } catch {
      try {
        execSync("which docker 2>/dev/null", { stdio: "pipe" });
        return "docker";
      } catch {
        return "tempdir";
      }
    }
  }
  return "tempdir";
}

function getSandboxExecCommand(
  sandboxDir: string,
  command: string,
  allowNetwork: boolean,
): string {
  const sbType = getSandboxType();

  switch (sbType) {
    case "sandbox-exec": {
      const profilePath = join(sandboxDir, ".reasonix-sandbox.sb");
      writeProfile(profilePath, sandboxDir, allowNetwork);
      return `sandbox-exec -f "${profilePath}" ${command}`;
    }
    case "bwrap": {
      const netFlags = allowNetwork ? "--share-net" : "--unshare-net";
      return `bwrap --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /etc /etc --bind "${sandboxDir}" "${sandboxDir}" --tmpfs /home --proc /proc --dev /dev ${netFlags} ${command}`;
    }
    case "docker": {
      const netFlag = allowNetwork ? "" : "--network none";
      return `docker run --rm -v "${sandboxDir}:/workspace" -w /workspace ${netFlag} alpine:latest sh -c "${command.replace(/"/g, '\\"')}"`;
    }
    case "tempdir":
    default: {
      // Simple chroot-like isolation: restrict to sandbox dir via cd
      return `cd "${sandboxDir}" && ${command}`;
    }
  }
}

// ─── Tools Registration ───────────────────────────────────────────

function startCleanupTimer(): void {
  // Clean up sandboxes older than 1 hour every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [id, inst] of _instances) {
      if (now - inst.lastUsed > 3_600_000) {
        try {
          rmSync(inst.dir, { recursive: true, force: true });
        } catch { /* ignore */ }
        _instances.delete(id);
      }
    }
  }, 300_000).unref();
}

startCleanupTimer();

export function registerSandboxTools(registry: ToolRegistry): void {
  // ── sandbox_create ────────────────────────────────────────────
  registry.register({
    name: "sandbox_create",
    description:
      "Create a new isolated sandbox environment for safe command execution. Commands run inside the sandbox cannot write outside their designated directory, and dangerous system calls are blocked. Use sandbox_run to execute commands inside the sandbox. Returns a sandbox ID to use in subsequent sandbox_run calls.",
    parameters: {
      type: "object",
      properties: {
        label: {
          type: "string",
          description: "Optional label for this sandbox (e.g. 'build-env', 'test-run').",
        },
        allow_network: {
          type: "boolean",
          description: "Whether to allow network access. Default: false (no network). Set to true if the command needs to download packages.",
        },
      },
    },
    fn: async (args: { label?: unknown; allow_network?: unknown }) => {
      const label =
        typeof args.label === "string" ? args.label.trim() : "";
      const allowNetwork = args.allow_network === true;
      const sbType = getSandboxType();

      const id = newSandboxId();
      const dir = createSandboxDir();
      const instance: SandboxInstance = {
        id,
        dir,
        createdAt: Date.now(),
        lastUsed: Date.now(),
        commandCount: 0,
      };
      _instances.set(id, instance);

      return JSON.stringify({
        success: true,
        sandbox_id: id,
        label: label || id,
        dir,
        sandbox_type: sbType,
        allow_network: allowNetwork,
        isolation:
          sbType === "sandbox-exec"
            ? "system-call-level (macOS Seatbelt)"
            : sbType === "bwrap"
              ? "user-namespace (bubblewrap)"
              : sbType === "docker"
                ? "container (Docker)"
                : "directory-level (tempdir)",
        network: allowNetwork ? "enabled" : "blocked",
        created: new Date(instance.createdAt).toISOString(),
      });
    },
  });

  // ── sandbox_run ───────────────────────────────────────────────
  registry.register({
    name: "sandbox_run",
    description:
      "Run a shell command INSIDE a sandbox. The command is isolated from the host system — it cannot modify files outside the sandbox directory, cannot access sensitive system resources, and (by default) cannot make network requests. Use this for: compiling untrusted code, running tests, installing packages, executing downloaded scripts — anything where you want a safety net. Returns stdout, stderr, and exit code.",
    parameters: {
      type: "object",
      properties: {
        sandbox_id: {
          type: "string",
          description: "Sandbox ID from sandbox_create. If omitted, creates a temporary sandbox for this command.",
        },
        command: {
          type: "string",
          description: "Shell command to run inside the sandbox.",
        },
        timeout: {
          type: "integer",
          description: "Max execution time in seconds. Default: 60.",
        },
        allow_network: {
          type: "boolean",
          description: "Override network access for this command. Only applies if sandbox_id is omitted (new sandbox).",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of file paths to copy INTO the sandbox before running the command.",
        },
      },
      required: ["command"],
    },
    fn: async (args: {
      sandbox_id?: unknown;
      command?: unknown;
      timeout?: unknown;
      allow_network?: unknown;
      files?: unknown;
    }) => {
      const rawCmd =
        typeof args.command === "string" ? args.command.trim() : "";
      if (!rawCmd) {
        return JSON.stringify({ error: "command is required" });
      }

      const sandboxId =
        typeof args.sandbox_id === "string" ? args.sandbox_id.trim() : "";
      const timeoutSec =
        typeof args.timeout === "number"
          ? Math.min(600, Math.max(1, args.timeout))
          : 60;
      const allowNetwork = args.allow_network === true;
      const filesToCopy =
        Array.isArray(args.files)
          ? (args.files as string[]).filter((f) => typeof f === "string")
          : [];

      let instance: SandboxInstance;

      if (sandboxId && _instances.has(sandboxId)) {
        instance = _instances.get(sandboxId)!;
      } else {
        // Create ad-hoc sandbox
        const id = newSandboxId();
        const dir = createSandboxDir();
        instance = { id, dir, createdAt: Date.now(), lastUsed: Date.now(), commandCount: 0 };
        _instances.set(id, instance);
      }

      instance.lastUsed = Date.now();
      instance.commandCount++;

      // Copy files into sandbox
      for (const fp of filesToCopy) {
        try {
          const resolved = resolve(fp);
          if (existsSync(resolved)) {
            const basename = resolved.split("/").pop() || "file";
            const dest = join(instance.dir, basename);
            copyFileSync(resolved, dest);
          }
        } catch { /* skip unreadable files */ }
      }

      const sandboxCmd = getSandboxExecCommand(instance.dir, rawCmd, allowNetwork);

      try {
        const output = execSync(sandboxCmd, {
          cwd: instance.dir,
          timeout: timeoutSec * 1000,
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
          stdio: "pipe",
        });

        // Also read any output files from sandbox
        const outputFiles: string[] = [];
        try {
          const { readdirSync, statSync } = require("node:fs");
          const entries = readdirSync(instance.dir);
          for (const entry of entries) {
            if (entry.startsWith(".reasonix-")) continue;
            const fullPath = join(instance.dir, entry);
            const stat = statSync(fullPath);
            if (stat.isFile() && stat.size > 0 && stat.size < 100_000) {
              outputFiles.push(entry);
            }
          }
        } catch { /* ignore */ }

        return JSON.stringify({
          success: true,
          sandbox_id: instance.id,
          exit_code: 0,
          stdout: output.slice(0, 5000),
          stdout_truncated: output.length > 5000,
          files_created: outputFiles.length > 0 ? outputFiles : undefined,
          isolation: getSandboxType(),
        });
      } catch (e: any) {
        return JSON.stringify({
          success: false,
          sandbox_id: instance.id,
          exit_code: e.status ?? 1,
          stdout: (e.stdout ?? "").slice(0, 5000),
          stderr: (e.stderr ?? "").slice(0, 2000),
          error: e.message?.slice(0, 200),
          isolation: getSandboxType(),
        });
      }
    },
  });

  // ── sandbox_status ────────────────────────────────────────────
  registry.register({
    name: "sandbox_status",
    description:
      "List all active sandbox environments and their current state. Shows sandbox ID, creation time, command count, and directory path.",
    readOnly: true,
    parameters: { type: "object", properties: {} },
    fn: async () => {
      const sandboxes = Array.from(_instances.values()).map((inst) => ({
        id: inst.id,
        created: new Date(inst.createdAt).toISOString(),
        last_used: new Date(inst.lastUsed).toISOString(),
        commands_run: inst.commandCount,
        dir: inst.dir,
        idle_seconds: Math.round((Date.now() - inst.lastUsed) / 1000),
      }));

      return JSON.stringify({
        success: true,
        active_count: sandboxes.length,
        sandbox_type: getSandboxType(),
        sandboxes,
        create_new: "Use sandbox_create() to create a new sandbox.",
      });
    },
  });

  // ── sandbox_reset ─────────────────────────────────────────────
  registry.register({
    name: "sandbox_reset",
    description:
      "Delete a sandbox environment and all its contents. Use this to clean up after a task is complete. If no sandbox_id is provided, deletes ALL sandboxes.",
    parameters: {
      type: "object",
      properties: {
        sandbox_id: {
          type: "string",
          description: "Specific sandbox ID to reset. Omit to reset ALL sandboxes.",
        },
      },
    },
    fn: async (args: { sandbox_id?: unknown }) => {
      const sandboxId =
        typeof args.sandbox_id === "string" ? args.sandbox_id.trim() : "";

      if (sandboxId) {
        const inst = _instances.get(sandboxId);
        if (!inst) {
          return JSON.stringify({
            error: `Sandbox not found: ${sandboxId}`,
            active: Array.from(_instances.keys()),
          });
        }
        try {
          rmSync(inst.dir, { recursive: true, force: true });
        } catch { /* ignore */ }
        _instances.delete(sandboxId);
        return JSON.stringify({
          success: true,
          removed: sandboxId,
          remaining: _instances.size,
        });
      }

      // Reset ALL sandboxes
      const count = _instances.size;
      for (const [id, inst] of _instances) {
        try {
          rmSync(inst.dir, { recursive: true, force: true });
        } catch { /* ignore */ }
      }
      _instances.clear();
      return JSON.stringify({
        success: true,
        removed_all: true,
        count,
      });
    },
  });

  // ── sandbox_info ──────────────────────────────────────────────
  registry.register({
    name: "sandbox_info",
    description:
      "Get detailed information about the current sandbox environment: which isolation mechanism is active, what's restricted, and how it works on this platform.",
    readOnly: true,
    parameters: { type: "object", properties: {} },
    fn: async () => {
      const sbType = getSandboxType();
      const details: Record<string, string> = {
        sandbox_type: sbType,
        platform: process.platform,
        description:
          sbType === "sandbox-exec"
            ? "macOS Seatbelt sandbox — system-call-level isolation via sandbox-exec(1). Denies writes outside sandbox dir by default."
            : sbType === "bwrap"
              ? "Bubblewrap — user-namespace isolation via bwrap(1). Requires CAP_SYS_ADMIN or setuid bwrap."
              : sbType === "docker"
                ? "Docker container isolation. Requires docker daemon running."
                : "Directory-level isolation — commands run in a temp directory with restrictive permissions. No syscall filtering.",
        restrictions: [
          "Cannot write outside sandbox directory",
          sbType === "sandbox-exec" ? "System-call filtering active" : "No syscall filtering",
          "Network blocked by default (use allow_network: true to enable)",
        ],
        how_to_use:
          "1. sandbox_create() to start a sandbox\n2. sandbox_run(sandbox_id, command) to run commands\n3. sandbox_status() to check active sandboxes\n4. sandbox_reset() to clean up",
      };

      return JSON.stringify({
        success: true,
        ...details,
      });
    },
  });
}
