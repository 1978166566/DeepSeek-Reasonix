/**
 * HBuilderX-free uni-app H5 publishing tool.
 *
 * Replaces the GUI "发行 → 网站-PC Web或手机H5 → 自定义发行" flow
 * with a single CLI command. Uses the existing vite + @dcloudio/uni-cli
 * build pipeline that's already in package.json.
 *
 * Usage:
 *   publish_h5()               — build only (local)
 *   publish_h5(deploy: true)   — build + deploy to server
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import type { ToolRegistry } from "../tools.js";

 // Hardcoded paths from the user's project
 const RUOYI_APP = "/Users/dengyanming/Documents/Tc_Ruoyi/RuoYi-App";
 const DEPLOY_DIR = "unpackage/dist/build/web";
 const SERVER_IP = "81.70.209.107";
 const SSH_KEY = "~/.ssh/localhost.pem";
 const NGINX_HTML = "/usr/share/nginx/html";
 const APP_DIR = "app";
 const PROD_API = "81.70.209.107/prod-api";

 export interface PublishOptions {
   projectRoot?: string;
 }

 export function registerPublishTools(registry: ToolRegistry): void {
   // ── publish_h5 ────────────────────────────────────────────────
   registry.register({
     name: "publish_h5",
     description:
       "Build and optionally deploy the uni-app H5 app. Replaces HBuilderX's '发行 → 网站-PC Web或手机H5' GUI flow with a single CLI command.\n\n" +
       "Steps:\n" +
       "1. npm install (auto-skip if already installed)\n" +
       "2. npm run build (vite build via @dcloudio/vite-plugin-uni)\n" +
       "3. sed replace baseUrl to production server\n" +
       "4. (optional) tar + scp + nginx reload\n\n" +
       "Output goes to RuoYi-App/unpackage/dist/build/web/ — same as HBuilderX.",
     parameters: {
       type: "object",
       properties: {
         deploy: {
           type: "boolean",
           description:
             "If true, also deploys to the production server after build. Default: false (build only).",
         },
         server: {
           type: "string",
           description:
             "Server IP/hostname for deployment. Default: 81.70.209.107",
         },
         base_url: {
           type: "string",
           description:
             "Base URL to replace in the built JS. Default: localhost:8080 → " +
             PROD_API,
         },
         clean_install: {
           type: "boolean",
           description:
             "If true, force reinstall dependencies (rm -rf node_modules + npm install). Default: false.",
         },
       },
     },
     fn: async (args: {
       deploy?: unknown;
       server?: unknown;
       base_url?: unknown;
       clean_install?: unknown;
     }) => {
       const shouldDeploy = args.deploy === true;
       const server = (typeof args.server === "string" && args.server.trim()) || SERVER_IP;
       const baseUrl = (typeof args.base_url === "string" && args.base_url.trim()) || PROD_API;
       const cleanInstall = args.clean_install === true;

       const results: { step: string; ok: boolean; output?: string; error?: string }[] = [];
       const appDir = RUOYI_APP;

       if (!existsSync(appDir)) {
         return JSON.stringify({
           success: false,
           error: `RuoYi-App directory not found at ${appDir}`,
         });
       }

       // Step 1: npm install
       try {
         const hasModules = existsSync(join(appDir, "node_modules"));
         if (cleanInstall && hasModules) {
           execSync("rm -rf node_modules", { cwd: appDir, stdio: "pipe", timeout: 30_000 });
         }

         if (cleanInstall || !hasModules) {
           const installOutput = execSync("npm install 2>&1", {
             cwd: appDir,
             stdio: "pipe",
             timeout: 120_000,
             encoding: "utf8",
           });
           results.push({
             step: "npm install",
             ok: true,
             output: installOutput.slice(0, 500),
           });
         } else {
           results.push({ step: "npm install", ok: true, output: "(skipped — already installed)" });
         }
       } catch (e: any) {
         results.push({
           step: "npm install",
           ok: false,
           error: e.message?.slice(0, 200) ?? "install failed",
         });
         return JSON.stringify({ success: false, steps: results });
       }

       // Step 2: npm run build
       let buildOutput = "";
       try {
         buildOutput = execSync("npm run build 2>&1", {
           cwd: appDir,
           stdio: "pipe",
           timeout: 120_000,
           encoding: "utf8",
         });
         results.push({
           step: "npm run build",
           ok: true,
           output: buildOutput.slice(0, 500),
         });
       } catch (e: any) {
         results.push({
           step: "npm run build",
           ok: false,
           error: (e.stdout ?? e.message ?? "").slice(0, 500),
         });
         return JSON.stringify({ success: false, steps: results });
       }

       // Step 3: sed replace baseUrl
       const webDir = join(appDir, DEPLOY_DIR);
       if (!existsSync(webDir)) {
         results.push({
           step: "baseUrl replacement",
           ok: false,
           error: `Build output not found at ${DEPLOY_DIR}. Build may have failed.`,
         });
         return JSON.stringify({ success: false, steps: results });
       }

       try {
         // Find the index JS file and replace baseUrl
         const jsDir = join(webDir, "static", "js");
         if (existsSync(jsDir)) {
           const { readdirSync } = require("node:fs");
           const jsFiles = readdirSync(jsDir).filter(
             (f: string) => f.startsWith("index.") && f.endsWith(".js"),
           );
           for (const jsFile of jsFiles) {
             const filePath = join(jsDir, jsFile);
             let content = readFileSync(filePath, "utf8");
             const original = content;
             content = content.replace(/localhost:8080/g, baseUrl);
             if (content !== original) {
               writeFileSync(filePath, content, "utf8");
             }
           }
         }
         results.push({ step: "baseUrl replacement", ok: true });
       } catch (e: any) {
         results.push({
           step: "baseUrl replacement",
           ok: false,
           error: e.message?.slice(0, 200),
         });
       }

       // Step 4: Deploy (optional)
       if (shouldDeploy) {
         // 4a. tar the build output
         const tarFile = "/tmp/ruoyi-app-dist.tar.gz";
         try {
           execSync(
             `cd "${webDir}/.." && tar czf ${tarFile} web/ 2>&1`,
             { stdio: "pipe", timeout: 30_000 },
           );
           results.push({ step: "tar build output", ok: true });
         } catch (e: any) {
           results.push({
             step: "tar build output",
             ok: false,
             error: e.message?.slice(0, 200),
           });
           return JSON.stringify({ success: false, steps: results });
         }

         // 4b. Ensure app directory exists on server
         try {
           execSync(
             `ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no root@${server} "mkdir -p ${NGINX_HTML}/${APP_DIR}" 2>&1`,
             { stdio: "pipe", timeout: 15_000 },
           );
           results.push({ step: "ensure server dir", ok: true });
         } catch (e: any) {
           results.push({
             step: "ensure server dir",
             ok: false,
             error: e.message?.slice(0, 200),
           });
           return JSON.stringify({ success: false, steps: results });
         }

         // 4c. scp tar to server
         try {
           execSync(
             `scp -i ${SSH_KEY} -o StrictHostKeyChecking=no ${tarFile} root@${server}:/tmp/ 2>&1`,
             { stdio: "pipe", timeout: 60_000 },
           );
           results.push({ step: "scp to server", ok: true });
         } catch (e: any) {
           results.push({
             step: "scp to server",
             ok: false,
             error: e.message?.slice(0, 200),
           });
           return JSON.stringify({ success: false, steps: results });
         }

         // 4d. extract + reload nginx
         try {
           execSync(
             `ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no root@${server} "cd ${NGINX_HTML} && tar xzf /tmp/ruoyi-app-dist.tar.gz && cp -r web/* ${APP_DIR}/ && systemctl reload nginx" 2>&1`,
             { stdio: "pipe", timeout: 30_000 },
           );
           results.push({ step: "extract + nginx reload", ok: true });
         } catch (e: any) {
           // Try without systemctl (some servers use nginx -s reload)
           try {
             execSync(
               `ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no root@${server} "cd ${NGINX_HTML} && tar xzf /tmp/ruoyi-app-dist.tar.gz && cp -r web/* ${APP_DIR}/ && nginx -s reload" 2>&1`,
               { stdio: "pipe", timeout: 30_000 },
             );
             results.push({ step: "extract + nginx reload", ok: true });
           } catch (e2: any) {
             results.push({
               step: "extract + nginx reload",
               ok: false,
               error: e2.message?.slice(0, 200),
             });
             return JSON.stringify({ success: false, steps: results });
           }
         }

         // Cleanup local tar
         try {
           execSync(`rm -f ${tarFile}`, { stdio: "pipe" });
         } catch { /* ignore */ }
       }

       const allOk = results.every((r) => r.ok);
       const failedSteps = results.filter((r) => !r.ok).map((r) => r.step);

       if (shouldDeploy) {
         return JSON.stringify({
           success: allOk,
           steps: results,
           summary: allOk
             ? `✅ Build + deploy complete! App is live at http://${server}/${APP_DIR}`
             : `❌ Failed at: ${failedSteps.join(", ")}`,
           output_dir: webDir,
           deploy_url: shouldDeploy ? `http://${server}/${APP_DIR}` : undefined,
         });
       }

       return JSON.stringify({
         success: allOk,
         steps: results,
         summary: allOk
           ? `✅ Build complete! Output at ${DEPLOY_DIR}`
           : `❌ Failed at: ${failedSteps.join(", ")}`,
         output_dir: webDir,
         next_step: shouldDeploy
           ? undefined
           : "To also deploy: publish_h5(deploy: true)",
       });
     },
   });
 }
