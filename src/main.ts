import "./shim";
import loader from "@monaco-editor/loader";
import cytoscape from "cytoscape";
// @ts-expect-error no bundled types
import fcose from "cytoscape-fcose";
import * as taintwire from "@js-recon/taintwire/browser";
import lbug from "@ladybugdb/wasm-core"; // CJS: FS lives on the default export
// Not in wasm-core's `exports`, so it's imported by path; Vite emits it as an asset and hands back its URL.
import workerUrl from "../node_modules/@ladybugdb/wasm-core/lbug_wasm_worker.js?url";
import sqlWasmUrl from "sql.js/dist/sql-wasm-browser.wasm?url";

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
// Bigger graphs open as the top of the AST; the rest is fetched on double-click or when a query hits it.
const BUDGET = 1500;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (msg: string, error = false) => {
    $("status").textContent = msg;
    $("status").title = msg;
    $("status").classList.toggle("error", error);
};

cytoscape.use(fcose);
const cy = cytoscape({
    container: $("graph"),
    wheelSensitivity: 0.3,
    webgl: true,
    hideEdgesOnViewport: true,
    textureOnViewport: true,
    style: [
        {
            selector: "node",
            style: {
                label: "data(label)",
                "font-size": 9,
                color: "#d4d4d4",
                "text-valign": "bottom",
                "text-margin-y": 2,
                "min-zoomed-font-size": 8,
                "background-color": "#0e639c",
                width: 12,
                height: 12,
            },
        },
        { selector: "node[kind = 'Scope']", style: { shape: "round-rectangle", "background-color": "#4ec9b0" } },
        { selector: "node[kind = 'Identifier']", style: { "background-color": "#9cdcfe" } },
        { selector: "node[kind = 'CallExpression']", style: { "background-color": "#dcdcaa" } },
        { selector: "node[more > 0]", style: { "border-width": 2, "border-style": "dashed", "border-color": "#d4d4d4" } },
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
        { selector: ".cursor", style: { "border-width": 4, "border-color": "#ffcc00", width: 18, height: 18, "z-index": 11, opacity: 1 } },
    ],
});

Object.assign(window, { cy }); // for e2e and console poking

// Cytoscape only watches the window, so tell it when the pane itself changes size (divider drag, media query).
new ResizeObserver(() => cy.resize()).observe($("graph"));

// Drag the divider to split editors vs graph; pointer capture keeps the drag alive over the Monaco/canvas panes.
const divider = $("divider");
divider.addEventListener("pointerdown", (e) => divider.setPointerCapture(e.pointerId));
divider.addEventListener("pointermove", (e) => {
    if (!divider.hasPointerCapture(e.pointerId)) return;
    const box = divider.parentElement!.getBoundingClientRect();
    const left = Math.min(Math.max(e.clientX - box.left, 150), box.width - 150);
    divider.parentElement!.style.setProperty("--left", `${left}px`);
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
// Created by hand: a model Monaco makes from `value` is disposed as soon as setModel swaps it out for a multi-file one.
const singleModel = monaco.editor.createModel(SAMPLE, "javascript");
type Model = typeof singleModel;
const jsEditor = monaco.editor.create($("editor"), { ...editorOpts, model: singleModel });
const cypherEditor = monaco.editor.create($("cypher"), {
    ...editorOpts,
    value: EXAMPLES["Paths from location.* into html"],
    language: "plaintext",
    lineNumbers: "off",
});

// A graph in this page (WASM), or the one a connected backend holds.
let graph: Pick<taintwire.TaintGraph, "query" | "close"> | undefined;
let busy = false;
let editorFile: string | undefined; // the file whose source is in the JS editor; undefined = the editor's own code
let uploads = 0;
const built = new Map<Model, number>(); // each model's version the graph was built from; offsets are stale once it changes
const files = new Map<string, Model>(); // multi-file session: path -> its editor model
const multi = () => $<HTMLSelectElement>("session").value === "multi";

/** Run `fn` with the buttons locked; errors go to the status line. */
async function guarded(label: string, fn: () => Promise<string>) {
    if (busy) return;
    busy = true;
    for (const b of ["session", "generate", "open-db", "open-jsr", "connect", "run", "fit"]) $<HTMLButtonElement>(b).disabled = true;
    status(label);
    const t = performance.now();
    try {
        status(`${await fn()} (${Math.round(performance.now() - t)} ms)`);
    } catch (e) {
        status(String((e as Error).message ?? e), true);
        console.error(e);
    } finally {
        busy = false;
        for (const b of ["session", "generate", "open-db", "open-jsr", "connect"]) $<HTMLButtonElement>(b).disabled = false;
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
    built.clear();
    cy.elements().remove();
    $("results").hidden = true;
}

const markBuilt = (model: Model) => built.set(model, model.getAlternativeVersionId());

async function generate() {
    await reset();
    const parser = $<HTMLSelectElement>("parser").value as taintwire.Parser;
    if (!multi()) {
        graph = await taintwire.import(jsEditor.getValue(), { parser });
        editorFile = undefined;
        markBuilt(singleModel);
        return render();
    }
    const paths = [...$("files").querySelectorAll<HTMLElement>(".file:has(> input:checked)")].map((f) => f.dataset.path!);
    if (!paths.length) throw new Error("No files checked; open a js-recon.db and check the files to analyze");
    const g = (graph = await taintwire.TaintGraph.open(undefined, { parser }));
    for (const [i, path] of paths.entries()) {
        status(`Parsing ${i + 1}/${paths.length}: ${path}`);
        await g.add(files.get(path)!.getValue(), path);
        markBuilt(files.get(path)!);
    }
    return `${await render()}, ${paths.length} file${paths.length === 1 ? "" : "s"}`;
}

/** Show one file of the multi-file session in the JS editor. */
function openFile(path: string) {
    jsEditor.setModel(files.get(path)!);
    editorFile = path;
    cy.$(".cursor").removeClass("cursor"); // it marked a spot in the file being closed
    for (const f of $("files").querySelectorAll<HTMLElement>(".file")) f.classList.toggle("open", f.dataset.path === path);
}

/** Replace the multi-file session's files with these (sorted by path) and build the explorer tree from their paths. */
function setFiles(rows: { path: string; code: string; url?: string }[]) {
    jsEditor.setModel(singleModel); // before the old models are disposed under it
    for (const m of files.values()) m.dispose();
    files.clear();
    const root = $("files");
    root.replaceChildren();
    const dirs = new Map<string, HTMLElement>();
    // Paths and URLs come from the uploaded file, so they only ever go in as text.
    for (const { path, code, url } of rows) {
        files.set(path, monaco.editor.createModel(code, "javascript"));
        const parts = path.split("/");
        let parent = root;
        for (let i = 1; i < parts.length; i++) {
            const dir = parts.slice(0, i).join("/");
            if (!dirs.has(dir)) {
                const d = document.createElement("details");
                d.open = true;
                d.innerHTML = `<summary><input type="checkbox" checked></summary>`;
                d.firstElementChild!.append(parts[i - 1]);
                parent.append(d);
                dirs.set(dir, d);
            }
            parent = dirs.get(dir)!;
        }
        const leaf = document.createElement("div");
        leaf.className = "file";
        leaf.dataset.path = path;
        leaf.title = url ?? path;
        leaf.innerHTML = `<input type="checkbox" checked>`;
        leaf.append(parts.at(-1)!);
        parent.append(leaf);
    }
    if (rows.length) openFile(rows[0].path);
}

/** Switch the editor pane between the single-file editor and the multi-file explorer. */
function setSession(mode: string) {
    $<HTMLSelectElement>("session").value = mode;
    $("files").hidden = $("open-jsr-label").hidden = mode !== "multi";
    editorFile = undefined;
    if (mode !== "multi") jsEditor.setModel(singleModel);
    else if (files.size) openFile(files.keys().next().value!);
}

/** Load the JS files js-recon downloaded (its js-recon.db `raw_files` table) into the multi-file session. */
async function openJsReconDb(file: File) {
    await reset();
    const { default: initSqlJs } = await import("sql.js");
    const SQL = await initSqlJs({ locateFile: () => sqlWasmUrl });
    const db = new SQL.Database(new Uint8Array(await file.arrayBuffer()));
    let rows: { path: string; code: string; url: string }[];
    try {
        const cols = db.exec("SELECT name FROM pragma_table_info('raw_files')")[0]?.values.flat() ?? [];
        if (!cols.length) throw new Error(`${file.name} has no raw_files table; regenerate it with js-recon 2.1.0-alpha.1 or newer`);
        // A batch run's global DB holds every target's files, keyed by (domain, path).
        const path = cols.includes("domain") ? "domain || '/' || path" : "path";
        const [res] = db.exec(`SELECT ${path} AS path, content, url FROM raw_files ORDER BY 1`);
        rows = (res?.values ?? []).map(([path, code, url]) => ({ path: String(path), code: String(code), url: String(url) }));
    } finally {
        db.close();
    }
    if (!rows.length) throw new Error(`${file.name} has no files in raw_files`);
    setFiles(rows);
    return `${file.name}: ${rows.length} files; uncheck what to skip and hit Generate`;
}

/** Load a LadybugDB file written by taintwire (save() or import with dbPath) and show it. */
async function openDb(file: File) {
    await reset();
    // A fresh path per load, so a previous upload's DB/WAL never collides with this one.
    const path = `/upload-${++uploads}.lbdb`;
    await lbug.FS.writeFile(path, await file.arrayBuffer());
    graph = await taintwire.TaintGraph.open(path);
    const sources = await graph.query("MATCH (s:Source) RETURN s.file AS file, s.code AS code ORDER BY file");
    // Several files open as a multi-file session, so every node can jump to its own file.
    if (sources.length > 1) {
        setFiles(sources.map((s) => ({ path: s.file as string, code: s.code as string })));
        setSession("multi");
        files.forEach(markBuilt);
        return `${file.name}: ${await render()}, ${sources.length} files`;
    }
    setSession("single");
    editorFile = sources[0]?.file as string | undefined;
    if (sources.length) {
        jsEditor.setValue(sources[0].code as string);
        markBuilt(singleModel);
    }
    return `${file.name}: ${await render()}`;
}

const NODE_COLS = `n.id AS id, label(n) AS type, n.name AS name, n.value AS value, n.operator AS op, n.kind AS kind,
                   n.file AS file, n.startOffset AS s, n.endOffset AS e`;
let total = 0;
let edgeSeq = 0;

const ids = (rows: Record<string, unknown>[]) => rows.map((r) => r.id as string);
const sonChildren = async (of: string[]) =>
    ids(await graph!.query("MATCH (p)-[:SON]->(n) WHERE p.id IN $of RETURN n.id AS id", { of }));

/** Add these nodes (ids that aren't nodes are ignored), every edge between them and what's on screen, and re-lay out. */
async function show(want: string[], fit = true) {
    const fresh = [...new Set(want)].filter((id) => cy.getElementById(id).empty());
    if (fresh.length) {
        // Untyped MATCH spans every node table; columns a table lacks (Scope has no name/offsets) come back null.
        const nodes = await graph!.query(`MATCH (n) WHERE n.id IN $fresh RETURN ${NODE_COLS}`, { fresh });
        const kids = await graph!.query("MATCH (n)-[:SON]->() WHERE n.id IN $fresh RETURN n.id AS id, count(*) AS k", { fresh });
        const kidCount = new Map(kids.map((r) => [r.id as string, Number(r.k)]));
        cy.add(nodes.map((n) => ({ data: { ...n, id: n.id as string, kind: n.type, base: nodeLabel(n), kids: kidCount.get(n.id as string) ?? 0 } })));
        // Edges touching a new node whose other end is on screen; the rest wait until both ends are shown.
        const edges = [
            ...(await graph!.query("MATCH (a)-[r]->(b) WHERE a.id IN $fresh RETURN a.id AS s, b.id AS t, label(r) AS rel", { fresh })),
            ...(await graph!.query("MATCH (a)-[r]->(b) WHERE b.id IN $fresh AND NOT a.id IN $fresh RETURN a.id AS s, b.id AS t, label(r) AS rel", { fresh })),
        ].filter((e) => cy.getElementById(e.s as string).nonempty() && cy.getElementById(e.t as string).nonempty());
        cy.add(edges.map((e) => ({ data: { id: `e${edgeSeq++}`, source: e.s as string, target: e.t as string, rel: e.rel, color: REL_COLOR[e.rel as string] } })));
        for (const input of $("legend").querySelectorAll("input")) input.dispatchEvent(new Event("change"));
    }
    // Hidden AST children show as a "+N" on their parent.
    cy.nodes().forEach((n) => {
        const more = n.data("kids") - n.outgoers('edge[rel = "SON"]').length;
        n.data({ more, label: more > 0 ? `${n.data("base")} +${more}` : n.data("base") });
    });
    if (fit) {
        // Force layout over every edge (AST and overlays): connected nodes pull together, all nodes push apart.
        spread(true);
        cy.fit(undefined, 20);
    } else if (fresh.length) {
        // Expand/reveal: drop new nodes next to their AST parent and spread only them; everything else stays pinned.
        const added = cy.collection();
        for (const id of fresh) added.merge(cy.getElementById(id));
        placeOrder(added).nodes().forEach((n) => {
            const parent = n.incomers('edge[rel = "SON"]').sources();
            const at = parent.nonempty() ? parent.first().position() : { x: 0, y: 0 };
            n.position({ x: at.x + (Math.random() - 0.5) * 40, y: at.y + 30 + Math.random() * 20 });
        });
        spread(false, cy.nodes().not(added));
    }
}

/** Parents before children, so a new node's AST parent already has a position when it's placed. */
function placeOrder(added: cytoscape.NodeCollection) {
    const out = cy.collection();
    let level = added.filter((n) => n.incomers('edge[rel = "SON"]').sources().intersection(added).empty());
    while (level.nonempty()) {
        out.merge(level);
        level = level.outgoers('edge[rel = "SON"]').targets().intersection(added);
    }
    return out;
}

/** fcose over everything on screen, then clear leftover overlaps; `pinned` nodes don't move. */
function spread(randomize: boolean, pinned = cy.collection()) {
    pinned.lock();
    cy.layout({
        name: "fcose",
        randomize,
        animate: false,
        fit: false,
        nodeDimensionsIncludeLabels: true,
        nodeRepulsion: 20000,
        idealEdgeLength: 80,
        fixedNodeConstraint: pinned.nodes().map((n) => ({ nodeId: n.id(), position: { ...n.position() } })),
    } as cytoscape.LayoutOptions).run();
    separate();
    pinned.unlock();
}

/** Forces can still leave a few node bodies overlapping; push each such pair apart along its shallower axis. */
function separate(gap = 4) {
    // ponytail: x-sorted sweep, under 0.1 s total at the 1500-node budget; bodies only (labels still may overlap), use a grid index if the budget grows.
    for (let round = 0; round < 50; round++) {
        const boxes = cy.nodes().map((n) => ({ n, b: n.boundingBox({ includeLabels: false }) }));
        boxes.sort((p, q) => p.b.x1 - q.b.x1);
        let moved = false;
        for (let i = 0; i < boxes.length; i++) {
            const a = boxes[i];
            for (let j = i + 1; j < boxes.length && boxes[j].b.x1 < a.b.x2 + gap; j++) {
                const b = boxes[j];
                const ox = Math.min(a.b.x2, b.b.x2) - Math.max(a.b.x1, b.b.x1) + gap;
                const oy = Math.min(a.b.y2, b.b.y2) - Math.max(a.b.y1, b.b.y1) + gap;
                if (ox <= 0 || oy <= 0) continue;
                const free = [a, b].filter((x) => !x.n.locked());
                if (!free.length) continue;
                // Away from each other on the shallower axis, split between whichever ends may move.
                const [dx, dy] = ox < oy ? [ox * Math.sign(b.b.x1 + b.b.x2 - a.b.x1 - a.b.x2 || 1), 0] : [0, oy * Math.sign(b.b.y1 + b.b.y2 - a.b.y1 - a.b.y2 || 1)];
                for (const x of free) {
                    const s = (x === a ? -1 : 1) / free.length;
                    x.n.shift({ x: dx * s, y: dy * s });
                    x.b = { ...x.b, x1: x.b.x1 + dx * s, x2: x.b.x2 + dx * s, y1: x.b.y1 + dy * s, y2: x.b.y2 + dy * s };
                }
                moved = true;
            }
        }
        if (!moved) return;
    }
}

const shown = () =>
    `${cy.nodes().length} nodes, ${cy.edges().length} edges` +
    (cy.nodes().length < total ? ` (of ${total} nodes; double-click a +N node to expand)` : "");

async function render() {
    if (!graph) throw new Error("No graph");
    const [{ n }] = await graph.query("MATCH (n) WHERE label(n) <> 'Source' RETURN count(*) AS n");
    total = Number(n);
    let want: string[];
    if (total <= BUDGET) want = ids(await graph.query("MATCH (n) WHERE label(n) <> 'Source' RETURN n.id AS id"));
    else {
        // Breadth-first down the AST until the next level would blow the budget.
        want = [];
        let level = ids(await graph.query("MATCH (n:File) RETURN n.id AS id"));
        while (level.length && want.length + level.length <= BUDGET) {
            want.push(...level);
            level = await sonChildren(level);
        }
    }
    await show(want);
    return shown();
}

/** Pull query hits that aren't on screen into view, with their AST ancestors so they hang off the tree. */
async function reveal(hitIds: string[]) {
    // ponytail: capped so a query returning every node can't undo the budget; page through hits if that bites.
    let missing = hitIds.filter((id) => cy.getElementById(id).empty()).slice(0, BUDGET);
    if (!missing.length) return;
    const want = [...missing];
    // One SON hop up per query until we reach what's already shown (AST depth, not graph size, bounds this).
    while (missing.length) {
        const parents = ids(await graph!.query("MATCH (n)-[:SON]->(c) WHERE c.id IN $missing RETURN DISTINCT n.id AS id", { missing }));
        missing = parents.filter((id) => cy.getElementById(id).empty() && !want.includes(id));
        want.push(...missing);
    }
    await show(want, false);
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

    const hitIds = [...new Set(rows.flatMap(strings))];
    if (cy.nodes().length < total) await reveal(hitIds);
    cy.elements().removeClass("hit dim");
    const hits = cy.collection();
    for (const id of hitIds) hits.merge(cy.getElementById(id));
    if (hits.nonempty()) {
        cy.elements().addClass("dim");
        hits.removeClass("dim").addClass("hit");
        hits.connectedEdges().filter((e) => hits.contains(e.source()) && hits.contains(e.target())).removeClass("dim");
        cy.animate({ fit: { eles: hits, padding: 60 }, duration: 300 });
    }
    return `${rows.length} row${rows.length === 1 ? "" : "s"}${rows.length > 1000 ? " (showing 1000)" : ""}, ${hits.length} node${hits.length === 1 ? "" : "s"} highlighted`;
}

// Clicking a node selects its source in the JS editor (or the backend's IDE); clicking the background clears highlights.
cy.on("tap", "node", (e) => {
    const { s, e: end, file } = e.target.data();
    if (s == null) return;
    if (backend) return void api("/api/reveal", { file, s, e: end }).catch((err) => status(err.message, true));
    if (editorFile !== undefined && file !== editorFile) {
        if (!multi() || !files.has(file)) return;
        openFile(file);
    }
    const model = jsEditor.getModel()!;
    const a = model.getPositionAt(s);
    const b = model.getPositionAt(end);
    const range = new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column);
    jsEditor.setSelection(range);
    jsEditor.revealRangeInCenter(range);
});
let backend: { base: string; token: string } | undefined;
const remoteGraph = { query: (cypher: string, params?: Record<string, unknown>) => api("/api/query", { cypher, params }), close: async () => {} };

async function api(path: string, body?: unknown) {
    const { base, token } = backend!;
    let res: Response;
    try {
        res = await fetch(base + path, {
            method: body ? "POST" : "GET",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: body ? JSON.stringify(body) : undefined,
        });
    } catch {
        const mixed = location.protocol === "https:" && base.startsWith("http:");
        throw new Error(`Can't reach ${base}${mixed ? " (an https page can't call an http backend: serve the backend over https, or run the explorer locally)" : ""}`);
    }
    const out = await res.json();
    if (!res.ok) throw new Error(out.error);
    return out;
}

/** Switch to the backend this URL (as the backend printed it, with its ?token=) points at: its IDE replaces the JS editor. */
async function connect(input: string) {
    const url = new URL(input);
    const token = url.searchParams.get("token");
    if (!token) throw new Error("That URL has no ?token=; copy the whole Connect URL the backend printed");
    backend = { base: url.origin + url.pathname.replace(/\/$/, ""), token };
    let info;
    try {
        info = await api("/api/info");
    } catch (e) {
        backend = undefined;
        throw e;
    }
    await reset();
    setSession("single");
    for (const id of ["session", "generate", "open-jsr-label", "editor", "files"]) $(id).hidden = true;
    for (const el of [$("parser").parentElement!, $("open-db").parentElement!]) el.hidden = true;
    $("code").dataset.title = "";
    document.querySelector("main")!.style.setProperty("--left", "1.6fr");
    $<HTMLIFrameElement>("ide").src = backend.base + info.ide;
    $("ide").hidden = false;
    $("connect").textContent = "Disconnect";
    listen();
    if (!info.graph) return "Connected — build a graph from the IDE (taintwire button in its status bar, or right-click a folder)";
    graph = remoteGraph;
    return `${describe(info.graph)}: ${await render()}`;
}

const describe = (g: { dir: string; taintwire: string; files: number }) => `${g.dir} (${g.files} files, taintwire ${g.taintwire})`;

/** Follow the backend's events (server-sent, read off a fetch so the token can go in a header); reconnects on drop. */
async function listen() {
    for (;;) {
        try {
            const { base, token } = backend!;
            const res = await fetch(`${base}/api/events`, { headers: { authorization: `Bearer ${token}` } });
            const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
            let buf = "";
            for (let r; !(r = await reader.read()).done; ) {
                buf += r.value;
                for (let i; (i = buf.indexOf("\n\n")) >= 0; buf = buf.slice(i + 2)) if (buf.startsWith("data: ")) onEvent(JSON.parse(buf.slice(6, i)));
            }
        } catch (e) {
            console.error(e);
        }
        await new Promise((ok) => setTimeout(ok, 3000));
    }
}

function onEvent(ev: { type: string; [k: string]: unknown }) {
    if (ev.type === "built")
        guarded("Loading graph…", async () => {
            await reset();
            graph = remoteGraph;
            return `${describe(ev as never)}: ${await render()}`;
        });
    else if (ev.type === "query") {
        cypherEditor.setValue(ev.cypher as string);
        doRun();
    } else if (ev.type === "building") status("Building the graph in the backend…");
    else if (ev.type === "log" && !busy) status(String(ev.msg).split("\n").at(-1)!);
    else if (ev.type === "failed") status(`Build failed: ${ev.error}`, true);
}

// Moving the cursor in the JS editor marks the deepest node whose source range contains the selection.
let cursorSeq = 0;
jsEditor.onDidChangeCursorSelection(async ({ selection }: { selection: InstanceType<typeof monaco.Selection> }) => {
    const model = jsEditor.getModel()!;
    if (!graph || busy || model.getAlternativeVersionId() !== built.get(model)) return;
    const seq = ++cursorSeq;
    const s = model.getOffsetAt(selection.getStartPosition());
    const e = model.getOffsetAt(selection.getEndPosition());
    // Smallest span wins; on a tie (File/Program, a statement and its expression) skip nodes with a same-range AST child.
    const [hit] = await graph.query(
        `MATCH (n) WHERE n.startOffset <= $s AND n.endOffset >= $e ${editorFile === undefined ? "" : "AND n.file = $file"}
         AND NOT EXISTS { MATCH (n)-[:SON]->(c) WHERE c.startOffset = n.startOffset AND c.endOffset = n.endOffset }
         RETURN n.id AS id ORDER BY n.endOffset - n.startOffset LIMIT 1`,
        { s, e, ...(editorFile === undefined ? {} : { file: editorFile }) }
    );
    if (seq !== cursorSeq) return; // a newer cursor move already ran
    cy.$(".cursor").removeClass("cursor");
    if (!hit) return;
    if (cy.nodes().length < total) await reveal([hit.id as string]);
    if (seq !== cursorSeq) return;
    const node = cy.getElementById(hit.id as string).addClass("cursor");
    const { x1, x2, y1, y2 } = cy.extent();
    const { x, y } = node.position();
    if (x < x1 || x > x2 || y < y1 || y > y2) cy.animate({ center: { eles: node }, duration: 300 });
});
cy.on("tap", (e) => e.target === cy && cy.elements().removeClass("hit dim"));
cy.on("dbltap", "node[more > 0]", (e) =>
    guarded("Expanding…", async () => {
        await show(await sonChildren([e.target.id()]), false);
        cy.animate({ center: { eles: e.target }, duration: 300 });
        return shown();
    })
);

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
$<HTMLInputElement>("open-jsr").addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) guarded("Opening…", () => openJsReconDb(file));
});
$<HTMLSelectElement>("session").addEventListener("change", (e) => {
    const mode = (e.target as HTMLSelectElement).value;
    guarded("Switching…", async () => {
        await reset();
        setSession(mode);
        if (mode !== "multi") return "Ready — edit the code and hit Generate";
        return files.size ? `${files.size} files; uncheck what to skip and hit Generate` : "Open a js-recon.db to load its JS files";
    });
});
// A folder's checkbox sets every checkbox under it; clicking a file's name opens it.
$("files").addEventListener("change", (e) => {
    const box = e.target as HTMLInputElement;
    if (box.parentElement!.tagName === "SUMMARY") for (const b of box.closest("details")!.querySelectorAll("input")) b.checked = box.checked;
});
$("files").addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    if (el.classList.contains("file")) openFile(el.dataset.path!);
});
$("fit").addEventListener("click", () => cy.fit(undefined, 20));
$("connect").addEventListener("click", () => {
    if (backend) return location.reload();
    const url = prompt("Backend URL, as the backend printed it (http://host:8080/?token=…)");
    if (url) guarded("Connecting…", () => connect(url.trim()));
});
jsEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, doGenerate);
cypherEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, doRun);

status("Ready — edit the code and hit Generate");
$<HTMLButtonElement>("generate").disabled = false;
