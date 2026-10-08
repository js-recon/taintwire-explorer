import "./shim";
import loader from "@monaco-editor/loader";
import cytoscape from "cytoscape";
import * as taintwire from "@js-recon/taintwire/browser";
import lbug from "@ladybugdb/wasm-core"; // CJS: FS lives on the default export
// Not in wasm-core's `exports`, so it's imported by path; Vite emits it as an asset and hands back its URL.
import workerUrl from "../node_modules/@ladybugdb/wasm-core/lbug_wasm_worker.js?url";

// ponytail: wasm-core 0.21.2's worker calls FS.writeFile, but its WASMFS build only exposes createDataFile on FS.
// Wrap the worker so FS gains writeFile when it's assigned; drop this once upstream exposes it.
const fsShim = `let fs;
Object.defineProperty(self, "FS", { configurable: true, get: () => fs, set(v) {
    if (v && !v.writeFile) v.writeFile = (path, data) => v.createDataFile(path, "", new Uint8Array(data), true, true, true);
    fs = v;
} });
importScripts(${JSON.stringify(new URL(workerUrl, location.href).href)});`;
taintwire.setWorkerPath(URL.createObjectURL(new Blob([fsShim], { type: "text/javascript" })));

const SAMPLE = `function sanitize(s) {
    return s.replace(/</g, "&lt;");
}

function render(html) {
    document.body.innerHTML = html;
}

const q = location.hash.slice(1);
const safe = sanitize(q);
render(q);
render(safe);
`;

const EXAMPLES: Record<string, string> = {
    "Node counts by type": "MATCH (n) WHERE label(n) <> 'Source'\nRETURN label(n) AS type, count(*) AS n ORDER BY n DESC",
    "Edge counts by relation": "MATCH ()-[e]->()\nRETURN label(e) AS rel, count(*) AS n ORDER BY n DESC",
    "Identifiers": "MATCH (i:Identifier)\nRETURN i.id, i.name, i.line, i.col ORDER BY i.line, i.col",
    "Calls and their callees": "MATCH (c:CallExpression)-[e:CALLS]->(f)\nRETURN c, f, e.candidates",
    "Unresolved calls": "MATCH (c:CallExpression)\nWHERE NOT EXISTS { MATCH (c)-[:CALLS]->() }\nRETURN c.id, c.line, c.col",
    "Arguments into parameters": "MATCH (a)-[e:ARGUMENT_TO]->(p:Identifier)\nRETURN a, p, e.arg_index",
    "Uses resolved to declarations": "MATCH (u:Identifier)-[:REFERS_TO]->(d:Identifier)\nRETURN u.name, u.line, d.line",
    "What reaches render()'s html parameter": `MATCH p = (a)-[:FLOWS_TO|ARGUMENT_TO|RETURNS_TO* ACYCLIC 1..10]->(h:Identifier {name: 'html'})
RETURN a, h, length(p) AS hops`,
    "Paths from location.* into html": `MATCH (src)-[:SON* 1..3]->(:Identifier {name: 'location'})
MATCH p = (src)-[:FLOWS_TO|ARGUMENT_TO|RETURNS_TO* ACYCLIC 1..10]->(:Identifier {name: 'html'})
RETURN nodes(p) AS path, length(p) AS hops`,
    "Scopes": "MATCH (o)-[:CREATES_SCOPE]->(s:Scope)\nRETURN s.kind, label(o) AS owner, o.line",
};

// One color per relation, in taintwire's layer order; SON (the AST) is muted.
const PALETTE = ["#5a5a5a", "#c586c0", "#4ec9b0", "#3d8f80", "#2f5f57", "#569cd6", "#9cdcfe", "#ce9178", "#f44747", "#dcdcaa", "#d7ba7d", "#b5cea8"];
const REL_COLOR = Object.fromEntries(taintwire.RELATIONS.map((r, i) => [r, PALETTE[i % PALETTE.length]]));
const HIDDEN_BY_DEFAULT = new Set(["IN_SCOPE"]); // one edge per identifier; drowns the rest

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (msg: string, error = false) => {
    $("status").textContent = msg;
    $("status").title = msg;
    $("status").classList.toggle("error", error);
};

const cy = cytoscape({
    container: $("graph"),
    wheelSensitivity: 0.3,
    style: [
        {
            selector: "node",
            style: {
                label: "data(label)",
                "font-size": 9,
                color: "#d4d4d4",
                "text-valign": "bottom",
                "text-margin-y": 2,
                "background-color": "#0e639c",
                width: 12,
                height: 12,
            },
        },
        { selector: "node[kind = 'Scope']", style: { shape: "round-rectangle", "background-color": "#4ec9b0" } },
        { selector: "node[kind = 'Identifier']", style: { "background-color": "#9cdcfe" } },
        { selector: "node[kind = 'CallExpression']", style: { "background-color": "#dcdcaa" } },
        {
            selector: "edge",
            style: {
                width: 1.5,
                "line-color": "data(color)",
                "target-arrow-color": "data(color)",
                "target-arrow-shape": "triangle",
                "arrow-scale": 0.6,
                "curve-style": "bezier",
            },
        },
        { selector: "edge[rel != 'SON']", style: { width: 2.5 } },
        { selector: ".hit", style: { "background-color": "#f44747", width: 18, height: 18, "z-index": 10 } },
        { selector: ".dim", style: { opacity: 0.25 } },
        { selector: "node:selected", style: { "border-width": 3, "border-color": "#ffcc00" } },
    ],
});

// Legend doubles as the relation filter.
for (const rel of taintwire.RELATIONS) {
    const row = document.createElement("label");
    row.innerHTML = `<input type="checkbox" ${HIDDEN_BY_DEFAULT.has(rel) ? "" : "checked"}><i style="background:${REL_COLOR[rel]}"></i>${rel}`;
    row.querySelector("input")!.addEventListener("change", (e) =>
        cy.edges(`[rel = "${rel}"]`).style("display", (e.target as HTMLInputElement).checked ? "element" : "none")
    );
    $("legend").append(row);
}

const monaco = await loader.init();
const editorOpts = { theme: "vs-dark", automaticLayout: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false };
const jsEditor = monaco.editor.create($("code"), { ...editorOpts, value: SAMPLE, language: "javascript" });
const cypherEditor = monaco.editor.create($("cypher"), {
    ...editorOpts,
    value: EXAMPLES["Paths from location.* into html"],
    language: "plaintext",
    lineNumbers: "off",
});

let graph: taintwire.TaintGraph | undefined;
let busy = false;
let editorFile: string | undefined; // the file whose source is in the JS editor; undefined = the editor's own code
let uploads = 0;

/** Run `fn` with the buttons locked; errors go to the status line. */
async function guarded(label: string, fn: () => Promise<string>) {
    if (busy) return;
    busy = true;
    for (const b of ["generate", "open-db", "run", "fit"]) $<HTMLButtonElement>(b).disabled = true;
    status(label);
    const t = performance.now();
    try {
        status(`${await fn()} (${Math.round(performance.now() - t)} ms)`);
    } catch (e) {
        status(String((e as Error).message ?? e), true);
        console.error(e);
    } finally {
        busy = false;
        $<HTMLButtonElement>("generate").disabled = $<HTMLInputElement>("open-db").disabled = false;
        $<HTMLButtonElement>("run").disabled = $<HTMLButtonElement>("fit").disabled = !graph;
    }
}

const nodeLabel = (r: Record<string, unknown>) => {
    const extra = r.name ?? r.value ?? r.op ?? r.kind;
    return extra == null ? String(r.type) : `${r.type} ${String(extra).slice(0, 24)}`;
};

async function reset() {
    await graph?.close();
    graph = undefined;
    cy.elements().remove();
    $("results").hidden = true;
}

async function generate() {
    await reset();
    const parser = $<HTMLSelectElement>("parser").value as taintwire.Parser;
    graph = await taintwire.import(jsEditor.getValue(), { parser });
    editorFile = undefined;
    return render();
}

/** Load a LadybugDB file written by taintwire (save() or import with dbPath) and show it. */
async function openDb(file: File) {
    await reset();
    // A fresh path per load, so a previous upload's DB/WAL never collides with this one.
    const path = `/upload-${++uploads}.lbdb`;
    await lbug.FS.writeFile(path, await file.arrayBuffer());
    graph = await taintwire.TaintGraph.open(path);
    const sources = await graph.query("MATCH (s:Source) RETURN s.file AS file, s.code AS code ORDER BY file");
    editorFile = sources[0]?.file as string | undefined;
    if (sources.length) jsEditor.setValue(sources[0].code as string);
    const shown = sources.length > 1 ? `, ${sources.length} files, showing ${editorFile}` : "";
    return `${file.name}: ${await render()}${shown}`;
}

async function render() {
    if (!graph) throw new Error("No graph");
    // Untyped MATCH spans every node table; columns a table lacks (Scope has no name/offsets) come back null.
    const nodes = await graph.query(
        `MATCH (n) WHERE label(n) <> 'Source'
         RETURN n.id AS id, label(n) AS type, n.name AS name, n.value AS value, n.operator AS op, n.kind AS kind,
                n.file AS file, n.startOffset AS s, n.endOffset AS e`
    );
    const edges = await graph.query("MATCH (a)-[r]->(b) RETURN a.id AS s, b.id AS t, label(r) AS rel");
    cy.add([
        ...nodes.map((n) => ({ data: { ...n, id: n.id as string, kind: n.type, label: nodeLabel(n) } })),
        ...edges.map((e, i) => ({
            data: { id: `e${i}`, source: e.s as string, target: e.t as string, rel: e.rel, color: REL_COLOR[e.rel as string] },
        })),
    ]);
    for (const input of $("legend").querySelectorAll("input")) input.dispatchEvent(new Event("change"));
    // Lay out the AST (SON) as a tree; overlay edges ride along on top of it.
    cy.elements('node, edge[rel = "SON"]')
        .layout({ name: "breadthfirst", directed: true, roots: cy.nodes('[kind = "File"]') as unknown as string[], spacingFactor: 1.1 })
        .run();
    cy.fit(undefined, 20);
    return `${nodes.length} nodes, ${edges.length} edges`;
}

/** Every string anywhere in a result value; node values carry their `id`, so this finds the nodes a row mentions. */
const strings = (v: unknown): string[] =>
    typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];

const cell = (v: unknown): string => {
    if (Array.isArray(v)) return v.map(cell).join(" → ");
    if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        // A node: show its id and label instead of every column.
        if (typeof o.id === "string") return `${o.id}${o.name ? ` (${o.name})` : ""}`;
        return JSON.stringify(v, (_, x) => (typeof x === "bigint" ? Number(x) : x));
    }
    return String(v);
};

async function runQuery() {
    if (!graph) throw new Error("Generate a graph first");
    const rows = await graph.query(cypherEditor.getValue());
    const cols = rows.length ? Object.keys(rows[0]) : [];
    const table = document.createElement("table");
    table.innerHTML = `<thead><tr>${cols.map((c) => `<th>${c}</th>`).join("")}</tr></thead>`;
    const body = table.createTBody();
    for (const r of rows.slice(0, 1000)) {
        const tr = body.insertRow();
        for (const c of cols) tr.insertCell().textContent = cell(r[c]);
    }
    $("results").replaceChildren(table);
    $("results").hidden = false;

    cy.elements().removeClass("hit dim");
    const hits = cy.collection();
    for (const id of new Set(rows.flatMap(strings))) hits.merge(cy.getElementById(id));
    if (hits.nonempty()) {
        cy.elements().addClass("dim");
        hits.removeClass("dim").addClass("hit");
        hits.connectedEdges().filter((e) => hits.contains(e.source()) && hits.contains(e.target())).removeClass("dim");
        cy.animate({ fit: { eles: hits, padding: 60 }, duration: 300 });
    }
    return `${rows.length} row${rows.length === 1 ? "" : "s"}${rows.length > 1000 ? " (showing 1000)" : ""}, ${hits.length} node${hits.length === 1 ? "" : "s"} highlighted`;
}

// Clicking a node selects its source in the JS editor; clicking the background clears highlights.
cy.on("tap", "node", (e) => {
    const { s, e: end, file } = e.target.data();
    if (s == null || (editorFile !== undefined && file !== editorFile)) return;
    const model = jsEditor.getModel()!;
    const a = model.getPositionAt(s);
    const b = model.getPositionAt(end);
    const range = new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column);
    jsEditor.setSelection(range);
    jsEditor.revealRangeInCenter(range);
});
cy.on("tap", (e) => e.target === cy && cy.elements().removeClass("hit dim"));

for (const name of Object.keys(EXAMPLES)) $("examples").append(new Option(name, name));
$<HTMLSelectElement>("examples").addEventListener("change", (e) => {
    const sel = e.target as HTMLSelectElement;
    if (sel.value) cypherEditor.setValue(EXAMPLES[sel.value]);
    sel.value = "";
});

const doGenerate = () => guarded("Generating…", generate);
const doRun = () => guarded("Running…", runQuery);
$("generate").addEventListener("click", doGenerate);
$("run").addEventListener("click", doRun);
$<HTMLInputElement>("open-db").addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ""; // re-selecting the same file still fires change
    if (file) guarded("Opening…", () => openDb(file));
});
$("fit").addEventListener("click", () => cy.fit(undefined, 20));
jsEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, doGenerate);
cypherEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, doRun);

status("Ready — edit the code and hit Generate");
$<HTMLButtonElement>("generate").disabled = false;
