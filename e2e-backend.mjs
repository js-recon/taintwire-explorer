// End-to-end check against a running taintwire-explorer-backend, on the machine whose WORKSPACE it serves:
//   BACKEND_URL=http://127.0.0.1:8080/?token=… WORKSPACE=/workspace npm run e2e:backend
// Use 127.0.0.1 (not localhost) so the backend is cross-site to the explorer on localhost, like a hosted explorer.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const url = new URL(process.env.BACKEND_URL);
const BACKEND = url.origin;
const TOKEN = url.searchParams.get("token");
const APP = join(process.env.WORKSPACE, "e2e-app/dist");
mkdirSync(APP, { recursive: true });
writeFileSync(join(APP, "main.js"), "const q = location.hash.slice(1);\nshow(q);\n");
writeFileSync(join(APP, "sink.js"), "function show(v) {\n    eval(v);\n}\n");
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--port", "4179", "--strictPort"], { stdio: "pipe" });
await new Promise((ok) => server.stdout.on("data", (d) => String(d).includes("4179") && ok()));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const statusText = () => page.locator("#status").textContent();
const waitStatus = (re, timeout = 60000) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector("#status").textContent), re.source, { timeout });
try {
    await page.goto("http://localhost:4179/");
    await waitStatus(/Ready/);
    page.once("dialog", (d) => d.accept(`${BACKEND}/?token=${TOKEN}`));
    await page.click("#connect");
    await waitStatus(/nodes|Connected/);
    console.log("connect:", await statusText());
    const ide = page.frameLocator("#ide");
    await ide.locator(".statusbar-item:has-text('taintwire')").waitFor({ timeout: 90000 });
    console.log("IDE loaded with taintwire status bar button");
    // Build from the IDE: the taintwire status bar button, then pick a version.
    await ide.locator(".statusbar-item:has-text('taintwire')").click();
    await ide.locator(".quick-input-widget input").fill("0.1.1");
    await ide.locator(".quick-input-list .monaco-list-row:has-text('0.1.1')").waitFor();
    await page.keyboard.press("Enter");
    await waitStatus(/^\. \(2 files, taintwire 0.1.1\): \d+ nodes/, 120000);
    console.log("built:", await statusText());
    // Run a .cypher from the IDE: quick-open it, Ctrl+Enter (the extension's keybinding).
    await ide.locator(".monaco-list-row:has-text('queries')").click();
    await ide.locator(".monaco-list-row:has-text('node-counts.cypher')").click();
    await ide.locator(".tab:has-text('node-counts.cypher')").waitFor();
    await ide.locator(".editor-instance .view-lines").click();
    await page.keyboard.press("Control+Enter");
    await waitStatus(/rows?, \d+ nodes? highlighted/);
    console.log("query from IDE:", await statusText());
    assert.match((await page.locator("#cypher").textContent()).replace(/\s/g, " "), /label\(n\) AS type/);
    // Click a graph node: the IDE opens its file.
    await page.evaluate(() => {
        const n = window.cy.nodes().filter((n) => n.data("name") === "eval").first();
        n.emit("tap");
    });
    await ide.locator(".tab:has-text('sink.js')").waitFor({ timeout: 15000 });
    await ide.locator(".statusbar-item:has-text('Ln 2, Col 9 (4 selected)')").waitFor({ timeout: 15000 });
    console.log("node click selected its source in the IDE");
    await page.screenshot({ path: "e2e-backend-screenshot.png" });
    console.log("PASS");
} catch (e) {
    await page.screenshot({ path: "e2e-backend-screenshot.png" });
    console.log("FAIL", e.message, "| status:", await statusText());
    process.exitCode = 1;
} finally {
    await browser.close();
    server.kill();
}
