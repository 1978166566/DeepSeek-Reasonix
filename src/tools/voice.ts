/**
 * Voice Coding — Speech-to-Text and Text-to-Speech for hands-free coding.
 *
 * TTS: uses macOS built-in `say` command (always available, zero setup).
 * STT: uses OpenAI Whisper API (requires OPENAI_API_KEY) or macOS dictation.
 *
 * Tools:
 *   speak(text) — Read text aloud via system TTS
 *   listen() — Record from microphone and transcribe
 */

import { spawn, execSync } from "node:child_process";
import { createWriteStream, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ToolRegistry } from "../tools.js";

const TMP_DIR = join(homedir(), ".reasonix", "audio");

function ensureTmpDir(): void {
  const { mkdirSync, existsSync } = require("node:fs");
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
}

export function registerVoiceTools(registry: ToolRegistry): void {
  // ── speak — macOS TTS ──────────────────────────────────────────
  registry.register({
    name: "speak",
    description:
      "Read text aloud using the system text-to-speech engine. Works on macOS (uses 'say' command). Use this to hear code review results, error messages, or any text while you're away from the screen.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Text to speak aloud.",
        },
        voice: {
          type: "string",
          description:
            "Optional voice name. Default: 'Samantha' (English). On macOS, list voices with 'say -v ?'.",
        },
        rate: {
          type: "integer",
          description:
            "Speech rate in words per minute. Default: 200. Lower = slower, higher = faster.",
        },
      },
      required: ["text"],
    },
    fn: async (args: { text?: unknown; voice?: unknown; rate?: unknown }) => {
      const text =
        typeof args.text === "string" ? args.text.trim() : "";
      if (!text) {
        return JSON.stringify({ error: "text is required" });
      }
      if (process.platform !== "darwin") {
        return JSON.stringify({
          error: "speak is only available on macOS (uses 'say' command)",
          platform: process.platform,
        });
      }

      const voice =
        typeof args.voice === "string" ? args.voice.trim() : "Samantha";
      const rate =
        typeof args.rate === "number"
          ? Math.max(100, Math.min(500, args.rate))
          : 200;

      try {
        const args_list = ["-v", voice, "-r", String(rate)];
        // Truncate very long text
        const maxLen = 2000;
        const sayText =
          text.length > maxLen
            ? text.slice(0, maxLen) + "... (truncated)"
            : text;
        execSync(`say ${args_list.map((a) => `'${a}'`).join(" ")} '${sayText.replace(/'/g, "'\\''")}'`, {
          timeout: 60_000,
          stdio: "pipe",
        });
        return JSON.stringify({
          success: true,
          spoken_chars: sayText.length,
          voice,
          rate,
        });
      } catch (e: any) {
        return JSON.stringify({
          error: `TTS failed: ${e.message}`,
          tip: "Try: say -v '?' to list available voices.",
        });
      }
    },
  });

  // ── listen — record + transcribe ────────────────────────────────
  registry.register({
    name: "listen",
    description:
      "Record audio from the microphone and transcribe it to text. Uses sox/rec for recording (must be installed) and macOS built-in audio capture as fallback. Requires OPENAI_API_KEY for transcription via Whisper API. Returns the transcribed text. Use this for voice input while coding hands-free.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        duration: {
          type: "integer",
          description:
            "Recording duration in seconds. Default: 5. Max: 30.",
        },
        model: {
          type: "string",
          enum: ["whisper-1"],
          description:
            "Transcription model. Default: whisper-1 (OpenAI Whisper API).",
        },
      },
    },
    fn: async (args: { duration?: unknown; model?: unknown }) => {
      const duration =
        typeof args.duration === "number"
          ? Math.min(30, Math.max(1, args.duration))
          : 5;
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return JSON.stringify({
          error:
            "OPENAI_API_KEY is required for transcription. Set it in your environment or ~/.reasonix/.env.",
        });
      }

      ensureTmpDir();
      const audioFile = join(TMP_DIR, `recording-${Date.now()}.wav`);

      try {
        // Record audio
        const { execSync } = require("node:child_process");
        // Try sox first, fallback to macOS built-in (rec)
        let recorded = false;
        try {
          execSync(`sox -d -t wav "${audioFile}" trim 0 ${duration}`, {
            timeout: (duration + 5) * 1000,
            stdio: "pipe",
          });
          recorded = true;
        } catch {
          try {
            // macOS built-in: use ffmpeg if available
            execSync(
              `ffmpeg -f avfoundation -i ":0" -t ${duration} -y "${audioFile}"`,
              { timeout: (duration + 5) * 1000, stdio: "pipe" },
            );
            recorded = true;
          } catch {
            // Last resort: try rec command from sox
            execSync(`rec -q "${audioFile}" trim 0 ${duration}`, {
              timeout: (duration + 5) * 1000,
              stdio: "pipe",
            });
            recorded = true;
          }
        }

        if (!recorded) {
          return JSON.stringify({
            error:
              "Could not record audio. Install sox (brew install sox) or ffmpeg (brew install ffmpeg).",
          });
        }

        // Transcribe with Whisper API
        const FormData = require("form-data");
        const fs = require("node:fs");
        const form = new FormData();
        form.append("file", fs.createReadStream(audioFile));
        form.append("model", "whisper-1");
        form.append("language", "en");

        const response = await fetch(
          "https://api.openai.com/v1/audio/transcriptions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              ...form.getHeaders(),
            },
            body: form,
          },
        );

        // Clean up temp file
        try {
          if (require("node:fs").existsSync(audioFile))
            require("node:fs").unlinkSync(audioFile);
        } catch {}

        if (!response.ok) {
          const errText = await response.text();
          return JSON.stringify({
            error: `Whisper API error (${response.status}): ${errText}`,
          });
        }

        const data = (await response.json()) as { text?: string };
        return JSON.stringify({
          success: true,
          transcription: data.text ?? "",
          duration_seconds: duration,
          model: "whisper-1",
        });
      } catch (e: any) {
        // Clean up on error
        try {
          if (require("node:fs").existsSync(audioFile))
            require("node:fs").unlinkSync(audioFile);
        } catch {}
        return JSON.stringify({
          error: `Recording/transcription failed: ${e.message}`,
          tip: "Install sox: 'brew install sox'. Or ffmpeg: 'brew install ffmpeg'.",
        });
      }
    },
  });
}
