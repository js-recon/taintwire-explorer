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
    // Force layout: no two nodes sit on top of each other.
    const stacked = () =>
        page.evaluate(() => {
            const bs = cy.nodes().map((n) => n.boundingBox({ includeLabels: false }));
            let k = 0;
            for (let i = 0; i < bs.length; i++)
                for (let j = i + 1; j < bs.length; j++) if (bs[i].x1 < bs[j].x2 && bs[j].x1 < bs[i].x2 && bs[i].y1 < bs[j].y2 && bs[j].y1 < bs[i].y2) k++;
            return k;
        });
    assert.equal(await stacked(), 0, "stacked nodes");
    // Selecting code in the JS editor marks the deepest node spanning it.
    const cursorOn = async (text, base, len = text.length) => {
        await page.evaluate(([t, len]) => {
            const ed = window.monaco.editor.getEditors()[0], m = ed.getModel(), i = m.getValue().indexOf(t);
            const a = m.getPositionAt(i), b = m.getPositionAt(i + len);
            ed.setSelection(new window.monaco.Selection(a.lineNumber, a.column, b.lineNumber, b.column));
        }, [text, len]);
        await page.waitForFunction((b) => cy.nodes(".cursor").length === 1 && cy.nodes(".cursor").data("base") === b, base, { timeout: 30_000 });
    };
    // Dragging the divider resizes both sides, and cytoscape follows its container; it clamps at the edges.
    const drag = async (x) => {
        const d = await page.locator("#divider").boundingBox();
        await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2);
        await page.mouse.down();
        await page.mouse.move(x, d.y + d.height / 2, { steps: 5 });
        await page.mouse.up();
        await page.waitForFunction(() => Math.abs(cy.width() - document.querySelector("#graph").clientWidth) < 1);
        return [(await page.locator("#code").boundingBox()).width, (await page.locator("#graph").boundingBox()).width];
    };
    const [code1, graph1] = await drag(400);
    assert.ok(Math.abs(code1 - 400) < 3 && graph1 > 900, `drag left: ${code1}/${graph1}`);
    const [code2] = await drag(5);
    assert.ok(Math.abs(code2 - 150) < 3, `clamp: ${code2}`);
    await drag(700); // back to roughly even for the rest of the run
    await cursorOn("id(a)", "CallExpression");
    await cursorOn("sourc", "Identifier source");

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
    await cursorOn("document.cookie", "MemberExpression");

    // A graph over the node budget opens collapsed; double-click expands, and a query pulls a collapsed hit into view.
    const BIG = Array.from({ length: 400 }, (_, i) => `function f${i}(a) {\n    return g${i}(a + ${i});\n}\n`).join("") + "function needle(x) {\n    return x;\n}\n";
    await setEditor(0, BIG);
    await page.click("#generate");
    await page.waitForFunction(() => /of \d+ nodes|error/.test(document.querySelector("#status").textContent + document.querySelector("#status").className), null, { timeout: 60_000 });
    const shownCount = async () => Number((await page.textContent("#status")).match(/^(\d+) nodes/)[1]);
    const collapsed = await shownCount();
    assert.ok(collapsed <= 1500, await page.textContent("#status"));
    const box = await page.locator("#graph").boundingBox();
    await page.evaluate(() => { cy.zoom(2); cy.center(cy.nodes("[more > 0]").last()); }); // clear of the overlaid panels
    assert.equal(await stacked(), 0, "stacked nodes (collapsed)");
    const before = await page.evaluate(() => Object.fromEntries(cy.nodes().map((n) => [n.id(), n.position()])));
    const at = await page.evaluate(() => cy.nodes("[more > 0]").last().renderedPosition());
    await page.mouse.dblclick(box.x + at.x, box.y + at.y);
    await page.waitForFunction((n) => Number(document.querySelector("#status").textContent.match(/^(\d+) nodes/)?.[1]) > n, collapsed, { timeout: 30_000 });
    const expanded = await shownCount();
    // Expanding moves only the new subtree.
    const moved = await page.evaluate((b) => Object.entries(b).filter(([id, p]) => { const q = cy.getElementById(id).position(); return q.x !== p.x || q.y !== p.y; }).length, before);
    assert.equal(moved, 0, "pinned nodes moved on expand");
    await setEditor(1, "MATCH (:FunctionDeclaration)-[:SON]->(i:Identifier {name: 'needle'}) RETURN i");
    await page.click("#run");
    await page.waitForFunction(() => /rows?,|error/.test(document.querySelector("#status").textContent + document.querySelector("#status").className), null, { timeout: 30_000 });
    assert.match(await page.textContent("#status"), /^1 row, 1 node highlighted/);
    assert.ok(await page.evaluate(() => cy.nodes(".hit").length) === 1);
    assert.ok(await page.evaluate(() => cy.nodes().length) > expanded);
    // The cursor reveals a collapsed node too.
    const hidden = await page.evaluate(() => cy.nodes().length);
    await cursorOn("x;\n}\n", "Identifier x", 1);
    assert.ok(await page.evaluate(() => cy.nodes().length) > hidden);

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
