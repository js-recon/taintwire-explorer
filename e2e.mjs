// Headless end-to-end check against the production build: `npm run build && npm run e2e`.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import * as taintwire from "@js-recon/taintwire";

// A DB file written by the Node build, for the Open DB check.
const tmp = mkdtempSync(join(tmpdir(), "tw-e2e-"));
const FIXTURE = join(tmp, "fixture.lbdb");
const FIXTURE_CODE = "function wrap(v) {\n    return [v];\n}\nconst x = wrap(document.cookie);\nfetch(x);\n";
await (await taintwire.import(FIXTURE_CODE, { dbPath: FIXTURE, filename: "fixture.js" })).close();

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

    // Open DB: a file written by the Node build renders and is queryable, with its source in the JS editor.
    await page.setInputFiles("#open-db", FIXTURE);
    await page.waitForFunction(() => /^fixture\.lbdb: \d+ nodes, \d+ edges|error/.test(document.querySelector("#status").textContent + document.querySelector("#status").className), null, { timeout: 60_000 });
    const opened = await page.textContent("#status");
    assert.match(opened, /^fixture\.lbdb: \d+ nodes/);
    assert.ok(Number(opened.match(/(\d+) nodes/)[1]) > 15, opened);
    assert.equal(await page.evaluate(() => window.monaco.editor.getEditors()[0].getValue()), FIXTURE_CODE);
    await setEditor(1, "MATCH (c:CallExpression)-[:CALLS]->(f:FunctionDeclaration) RETURN c, f");
    await page.click("#run");
    await page.waitForFunction(() => /rows?,/.test(document.querySelector("#status").textContent), null, { timeout: 30_000 });
    assert.match(await page.textContent("#status"), /^1 row, 2 nodes highlighted/);

    // A graph over the node budget opens collapsed; double-click expands, and a query pulls a collapsed hit into view.
    const BIG = Array.from({ length: 400 }, (_, i) => `function f${i}(a) {\n    return g${i}(a + ${i});\n}\n`).join("") + "function needle(x) {\n    return x;\n}\n";
    await setEditor(0, BIG);
    await page.click("#generate");
    await page.waitForFunction(() => /of \d+ nodes|error/.test(document.querySelector("#status").textContent + document.querySelector("#status").className), null, { timeout: 60_000 });
    const shownCount = async () => Number((await page.textContent("#status")).match(/^(\d+) nodes/)[1]);
    const collapsed = await shownCount();
    assert.ok(collapsed <= 1500, await page.textContent("#status"));
    const box = await page.locator("#graph").boundingBox();
    await page.evaluate(() => cy.zoom({ level: 2, renderedPosition: cy.nodes("[more > 0]").last().renderedPosition() }));
    const at = await page.evaluate(() => cy.nodes("[more > 0]").last().renderedPosition());
    await page.mouse.dblclick(box.x + at.x, box.y + at.y);
    await page.waitForFunction((n) => Number(document.querySelector("#status").textContent.match(/^(\d+) nodes/)?.[1]) > n, collapsed, { timeout: 30_000 });
    const expanded = await shownCount();
    await setEditor(1, "MATCH (:FunctionDeclaration)-[:SON]->(i:Identifier {name: 'needle'}) RETURN i");
    await page.click("#run");
    await page.waitForFunction(() => /rows?,|error/.test(document.querySelector("#status").textContent + document.querySelector("#status").className), null, { timeout: 30_000 });
    assert.match(await page.textContent("#status"), /^1 row, 1 node highlighted/);
    assert.ok(await page.evaluate(() => cy.nodes(".hit").length) === 1);
    assert.ok(await page.evaluate(() => cy.nodes().length) > expanded);

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
    rmSync(tmp, { recursive: true, force: true });
}
