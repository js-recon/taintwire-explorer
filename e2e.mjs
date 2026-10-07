// Headless end-to-end check against the production build: `npm run build && npm run e2e`.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const PORT = 4179;
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--port", String(PORT), "--strictPort"], { stdio: "pipe" });
await new Promise((ok, fail) => {
    server.stdout.on("data", (d) => String(d).includes(String(PORT)) && ok());
    server.on("exit", fail);
});

const browser = await chromium.launch();
const errors = [];
try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForSelector("#generate:not([disabled])", { timeout: 60_000 });

    // Every example query runs cleanly on the built-in sample.
    await page.click("#generate");
    await page.waitForFunction(() => /nodes, \d+ edges/.test(document.querySelector("#status").textContent), null, { timeout: 60_000 });
    const examples = await page.$$eval("#examples option", (os) => os.map((o) => o.value).filter(Boolean));
    assert.ok(examples.length >= 5);
    for (const name of examples) {
        await page.selectOption("#examples", name);
        await page.click("#run");
        await page.waitForFunction(() => /rows?,|error/i.test(document.querySelector("#status").textContent + document.querySelector("#status").className), null, { timeout: 30_000 });
        assert.match(await page.textContent("#status"), /rows?,/, `example "${name}"`);
        if (name.startsWith("Paths from location")) assert.match(await page.textContent("#status"), /^2 rows,/);
    }

    // The Monaco loader puts `monaco` on window; editors are [JS, Cypher] in creation order.
    const setEditor = (i, value) => page.evaluate(([i, v]) => window.monaco.editor.getEditors()[i].setValue(v), [i, value]);
    await setEditor(0, "function id(x) {\n    return x;\n}\nconst a = source();\nsink(id(a));\n");
    await page.click("#generate");
    await page.waitForFunction(() => /nodes, \d+ edges/.test(document.querySelector("#status").textContent), null, { timeout: 60_000 });
    const status = await page.textContent("#status");
    const nodes = Number(status.match(/(\d+) nodes/)[1]);
    assert.ok(nodes > 15, `expected a graph, got: ${status}`);
    assert.equal(await page.locator("#graph canvas").count() > 0, true);

    // Query: the one call that resolves is id(a).
    await setEditor(1, "MATCH (c:CallExpression)-[:CALLS]->(f:FunctionDeclaration) RETURN c.id AS call, f.id AS fn");
    await page.click("#cypher .view-lines");
    await page.keyboard.press("ControlOrMeta+Enter"); // the shortcut, not the button
    await page.waitForFunction(() => /rows?,/.test(document.querySelector("#status").textContent), null, { timeout: 30_000 });
    assert.match(await page.textContent("#status"), /^1 row, 2 nodes highlighted/);
    assert.equal(await page.locator("#results tbody tr").count(), 1);
    assert.match(await page.textContent("#results tbody td"), /^CallExpression_/);

    // A bad query reports its error instead of throwing.
    await setEditor(1, "MATCH (n:Nope) RETURN n");
    await page.click("#run");
    await page.waitForSelector("#status.error");

    await page.screenshot({ path: "e2e-screenshot.png" });
    const unexpected = errors.filter((e) => !/Nope/.test(e)); // the bad query is logged on purpose
    assert.deepEqual(unexpected, [], "console errors");
    console.log(`e2e ok: ${status}`);
} catch (e) {
    console.error("status:", await browser.contexts()[0]?.pages()[0]?.textContent("#status").catch(() => "?"), "\nerrors:", errors);
    process.exitCode = 1;
    throw e;
} finally {
    await browser.close();
    server.kill();
}
