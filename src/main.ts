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
import { batches, plan, showCypher, type EdgeRow, type NodeRow, type Step } from "./plan";

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
        // Debugger: laid out from the start, shown once their CREATE has run; the last command's elements stand out.
        { selector: ".pending", style: { visibility: "hidden", events: "no" } },
        { selector: "node.fresh", style: { "border-width": 3, "border-color": "#ff8c00", width: 16, height: 16 } },
        { selector: "edge.fresh", style: { width: 4 } },
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
const jsEditor = monaco.editor.create($("editor"), { ...editorOpts, model: singleModel, glyphMargin: true });
const cypherEditor = monaco.editor.create($("cypher"), {
    ...editorOpts,
    value: EXAMPLES["Paths from location.* into html"],
    language: "plaintext",
    lineNumbers: "off",
});

let graph: taintwire.TaintGraph | undefined;
let cursorSeq = 0; // bumped per cursor lookup and per reset; a lookup whose number is stale drops its result
let busy = false;
let editorFile: string | undefined; // the file whose source is in the JS editor; undefined = the editor's own code
let uploads = 0;
const built = new Map<Model, number>(); // each model's version the graph was built from; offsets are stale once it changes
const files = new Map<string, Model>(); // multi-file session: path -> its editor model
const multi = () => $<HTMLSelectElement>("session").value === "multi";
const SINGLE_FILE = "input.js"; // the single-file session's filename in the graph
/** A debugger session: the plan, the next step to run, and whether a command is running (and was asked to pause). */
let dbg: { steps: Step[]; at: number; running: boolean; pause: boolean; stop?: boolean; last?: Step } | undefined;
const breakpoints = new WeakMap<Model, string[]>(); // each model's breakpoint decoration ids; they move with edits

/** Enable each control for the current state: idle, busy (guarded), debugging paused, or debugging running. */
function syncButtons() {
    const set = (ids: string[], disabled: boolean) => ids.forEach((b) => ($<HTMLButtonElement>(b).disabled = disabled));
    set(["session", "generate", "debug", "parser", "open-db", "open-jsr"], busy || !!dbg);
    set(["run", "fit"], busy || !graph || !!dbg?.running);
    set(["dbg-continue", "dbg-over", "dbg-into"], busy || !dbg || dbg.running);
    set(["dbg-pause"], !dbg?.running);
    set(["dbg-stop"], busy || !dbg);
    $("debug-bar").hidden = !dbg;
}

/** Run `fn` with the buttons locked; errors go to the status line. */
async function guarded(label: string, fn: () => Promise<string>) {
    if (busy) return;
    busy = true;
    syncButtons();
    status(label);
    const t = performance.now();
    try {
        status(`${await fn()} (${Math.round(performance.now() - t)} ms)`);
    } catch (e) {
        status(String((e as Error).message ?? e), true);
        console.error(e);
    } finally {
        busy = false;
        syncButtons();
    }
}

const nodeLabel = (r: Record<string, unknown>) => {
    const extra = r.name ?? r.value ?? r.op ?? r.kind;
    return extra == null ? String(r.type) : `${r.type} ${String(extra).slice(0, 24)}`;
};

async function reset() {
    if (dbg) endDebug();
    cursorSeq++; // a cursor lookup in flight is for the graph being closed
    await graph?.close();
    graph = undefined;
    built.clear();
    cy.elements().remove();
    $("results").hidden = true;
}

const markBuilt = (model: Model) => built.set(model, model.getAlternativeVersionId());

/** Parse the editor's code (single file) or the checked files (multi file) into a fresh graph; returns the files, in build order. */
async function build(): Promise<string[]> {
    await reset();
    const parser = $<HTMLSelectElement>("parser").value as taintwire.Parser;
    if (!multi()) {
        graph = await taintwire.import(jsEditor.getValue(), { parser, filename: SINGLE_FILE });
        editorFile = undefined;
        markBuilt(singleModel);
        return [SINGLE_FILE];
    }
    const paths = [...$("files").querySelectorAll<HTMLElement>(".file:has(> input:checked)")].map((f) => f.dataset.path!);
    if (!paths.length) throw new Error("No files checked; open a js-recon.db and check the files to analyze");
    graph = await taintwire.TaintGraph.open(undefined, { parser });
    for (const [i, path] of paths.entries()) {
        status(`Parsing ${i + 1}/${paths.length}: ${path}`);
        await graph.add(files.get(path)!.getValue(), path);
        markBuilt(files.get(path)!);
    }
    return paths;
}

async function generate() {
    const paths = await build();
    return multi() ? `${await render()}, ${paths.length} file${paths.length === 1 ? "" : "s"}` : render();
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
    for (const m of files.values()) breakpoints.delete(m);
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

// Clicking a node selects its source in the JS editor; clicking the background clears highlights.
cy.on("tap", "node", (e) => {
    const { s, e: end, file } = e.target.data();
    if (s == null) return;
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
// Moving the cursor in the JS editor marks the deepest node whose source range contains the selection.
jsEditor.onDidChangeCursorSelection(async ({ selection }: { selection: InstanceType<typeof monaco.Selection> }) => {
    const model = jsEditor.getModel()!;
    if (!graph || busy || dbg?.running || model.getAlternativeVersionId() !== built.get(model)) return;
    const seq = ++cursorSeq;
    const s = model.getOffsetAt(selection.getStartPosition());
    const e = model.getOffsetAt(selection.getEndPosition());
    // Smallest span wins; on a tie (File/Program, a statement and its expression) skip nodes with a same-range AST child.
    const [hit] = await graph.query(
        `MATCH (n) WHERE n.startOffset <= $s AND n.endOffset >= $e ${editorFile === undefined ? "" : "AND n.file = $file"}
         AND NOT EXISTS { MATCH (n)-[:SON]->(c) WHERE c.startOffset = n.startOffset AND c.endOffset = n.endOffset }
         RETURN n.id AS id ORDER BY n.endOffset - n.startOffset LIMIT 1`,
        { s, e, ...(editorFile === undefined ? {} : { file: editorFile }) }
    ).catch((err) => (seq === cursorSeq ? Promise.reject(err) : [])); // the graph was closed under it (reset bumps cursorSeq)
    if (seq !== cursorSeq) return; // a newer cursor move already ran, or the graph was replaced
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

// --- Debugger: build the graph, read its rows back, empty it, and replay the rows one statement per step.

/** Every non-Source node and every edge of the graph, with all columns, read through the schema taintwire made. */
async function readBack() {
    const cols = async (t: string) => (await graph!.query(`CALL table_info('${t}') RETURN name`)).map((c) => c.name as string);
    const nodes: NodeRow[] = [];
    for (const t of await graph!.query("CALL show_tables() RETURN name, type")) {
        const table = t.name as string;
        if (t.type !== "NODE" || table === "Source") continue;
        const c = await cols(table);
        for (const row of await graph!.query(`MATCH (n:\`${table}\`) RETURN ${c.map((x) => `n.${x} AS ${x}`).join(", ")}`)) nodes.push({ table, row });
    }
    const edges: EdgeRow[] = [];
    for (const rel of taintwire.RELATIONS) {
        const c = await cols(rel);
        const q = `MATCH (a)-[e:${rel}]->(b) RETURN a.id AS s, label(a) AS sl, b.id AS t, label(b) AS tl${c.map((x) => `, e.${x} AS ${x}`).join("")}`;
        for (const { s, sl, t, tl, ...props } of await graph!.query(q)) edges.push({ rel, s: s as string, sl: sl as string, t: t as string, tl: tl as string, props });
    }
    return { nodes, edges };
}

/** Lay out the finished graph once, every element hidden until its step runs, so the picture grows in place. */
function layoutPlan(steps: Step[]) {
    // shortcut: only the first BUDGET nodes (in source order) are drawn; later steps still run, raise BUDGET or page if that bites.
    const nodeSteps = steps.filter((s) => s.node).slice(0, BUDGET);
    cy.add(
        nodeSteps.map(({ node }) => {
            const { table, row: r } = node!;
            const base = nodeLabel({ type: table, name: r.name, value: r.value, op: r.operator, kind: r.kind });
            const data = { id: r.id as string, type: table, kind: table, name: r.name, value: r.value, op: r.operator, file: r.file, s: r.startOffset, e: r.endOffset };
            return { data: { ...data, base, label: base, kids: 0, more: 0 }, classes: "pending" };
        })
    );
    const drawn = steps.filter((s) => s.edge && cy.getElementById(s.edge.s).nonempty() && cy.getElementById(s.edge.t).nonempty());
    cy.add(drawn.map(({ creates, edge: e }) => ({ data: { id: creates, source: e!.s, target: e!.t, rel: e!.rel, color: REL_COLOR[e!.rel] }, classes: "pending" })));
    for (const input of $("legend").querySelectorAll("input")) input.dispatchEvent(new Event("change"));
    spread(true);
    cy.fit(undefined, 20);
    total = cy.nodes().length; // nothing to reveal or expand while debugging
}

const modelFor = (file: string) => (multi() ? files.get(file) : file === SINGLE_FILE ? singleModel : undefined);
const lineKey = (s: Step) => `${s.file}\0${s.line}`;
const breakpointLines = (model: Model) =>
    (breakpoints.get(model) ?? []).map((id) => model.getDecorationRange(id)?.startLineNumber).filter((l): l is number => l != null);

function toggleBreakpoint(model: Model, line: number) {
    const ids = breakpoints.get(model) ?? [];
    const hit = ids.find((id) => model.getDecorationRange(id)?.startLineNumber === line);
    const added = model.deltaDecorations(hit ? [hit] : [], hit ? [] : [
        { range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: "breakpoint", glyphMarginHoverMessage: { value: "Breakpoint" }, stickiness: 1 } },
    ]);
    breakpoints.set(model, [...ids.filter((id) => id !== hit), ...added]);
}

let exec: { model: Model; ids: string[] } | undefined; // the execution-point decoration
function clearExec() {
    if (exec && !exec.model.isDisposed()) exec.model.deltaDecorations(exec.ids, []);
    exec = undefined;
}

/** Show where the debugger stands: the next statement's line in the editor, and the last/next statement in the panel. */
function showPaused() {
    const { steps, at, last } = dbg!;
    const next = steps[at];
    clearExec();
    const model = modelFor(next.file);
    if (model) {
        if (multi() && editorFile !== next.file) openFile(next.file);
        const range = new monaco.Range(next.line, 1, next.line, 1);
        exec = { model, ids: model.deltaDecorations([], [{ range, options: { isWholeLine: true, className: "exec-line", glyphMarginClassName: "exec-glyph" } }]) };
        jsEditor.revealLineInCenterIfOutsideViewport(next.line);
    }
    const panel = $("debug-panel");
    panel.replaceChildren();
    const row = (label: string, text: string) => {
        const div = document.createElement("div");
        div.innerHTML = "<b></b><code></code>";
        div.querySelector("b")!.textContent = label;
        div.querySelector("code")!.textContent = text;
        panel.append(div);
    };
    // Follow the build: bring what the last command created into view when none of it is on screen.
    const fresh = cy.nodes(".fresh");
    if (fresh.nonempty()) {
        const { x1, x2, y1, y2 } = cy.extent();
        const b = fresh.boundingBox({});
        if (b.x2 < x1 || b.x1 > x2 || b.y2 < y1 || b.y1 > y2) cy.animate({ center: { eles: fresh }, duration: 200 });
    }
    if (last) row("ran", showCypher(last));
    row("next", showCypher(next));
    panel.hidden = false;
    const where = multi() ? `${next.file}:${next.line}` : `line ${next.line}`;
    status(`Paused before step ${at + 1}/${steps.length}, ${where} — ${cy.nodes().not(".pending").length} nodes, ${cy.edges().not(".pending").length} edges so far`);
}

/** Leave debug mode: no execution point, editor writable again, buttons back. Drops the drawn-but-never-created elements. */
function endDebug() {
    clearExec();
    cy.$(".pending").remove();
    cy.$(".fresh").removeClass("fresh");
    $("debug-panel").hidden = true;
    jsEditor.updateOptions({ readOnly: false });
    dbg = undefined;
    syncButtons();
}

async function startDebug() {
    const fileOrder = await build();
    const { nodes, edges } = await readBack();
    // The schema taintwire created stays; only the rows go, to come back one statement at a time.
    await graph!.query("MATCH (n) WHERE label(n) <> 'Source' DETACH DELETE n");
    const steps = plan(nodes, edges, fileOrder);
    if (!steps.length) throw new Error("Nothing to debug: the graph is empty");
    layoutPlan(steps);
    dbg = { steps, at: 0, running: false, pause: false };
    jsEditor.updateOptions({ readOnly: true }); // offsets in the plan are only valid for this exact text
    showPaused();
    return $("status").textContent!;
}

/** Where a run that starts at `at` stops: one statement (`into`), the end of the line (`over`), or before a breakpoint line (`continue`). */
function runEnd(mode: "into" | "over" | "continue", at: number, steps: Step[]) {
    if (mode === "into") return at + 1;
    const stops = new Set<string>();
    if (mode === "continue")
        for (const [file, model] of multi() ? files : [[SINGLE_FILE, singleModel] as const]) for (const l of breakpointLines(model)) stops.add(`${file}\0${l}`);
    const start = lineKey(steps[at]);
    let i = at + 1;
    for (; i < steps.length; i++) {
        const k = lineKey(steps[i]);
        if (mode === "over" ? k !== start : k !== lineKey(steps[i - 1]) && stops.has(k)) break;
    }
    return i;
}

const CHUNK = 2000; // statements per pausable chunk of a long run

/** Run debugger steps: `into` one statement, `over` the rest of the current line, `continue` until a breakpoint line or the end. */
async function debugRun(mode: "into" | "over" | "continue") {
    if (!dbg || dbg.running || busy) return;
    const d = dbg;
    d.running = true;
    d.pause = false;
    syncButtons();
    cy.$(".fresh").removeClass("fresh");
    const end = runEnd(mode, d.at, d.steps);
    try {
        while (d.at < end && !d.pause) {
            const chunk = d.steps.slice(d.at, Math.min(end, d.at + CHUNK));
            // One statement runs as itself; longer runs go in batches (same writes, far fewer round trips into the WASM worker).
            if (chunk.length === 1) await graph!.query(chunk[0].cypher, chunk[0].params);
            else for (const b of batches(chunk)) await graph!.query(b.cypher, { rows: b.rows });
            d.at += chunk.length;
            d.last = chunk.at(-1);
            cy.batch(() => chunk.forEach((s) => cy.getElementById(s.creates).removeClass("pending").addClass("fresh")));
            if (d.at < end) status(`Running… ${d.at}/${d.steps.length} statements (Pause to stop here)`);
        }
    } catch (e) {
        status(`Statements ${d.at + 1}… failed: ${(e as Error).message ?? e}`, true);
        console.error(e);
        d.running = false;
        endDebug();
        return;
    }
    d.running = false;
    if (d.stop) return stopDebug(); // asked while a statement was in flight
    if (d.at < d.steps.length) {
        syncButtons();
        return showPaused();
    }
    endDebug();
    const drawnAll = cy.nodes().length === d.steps.filter((s) => s.node).length;
    if (!drawnAll) {
        // Bigger than the debug drawing: show it the way Generate does (top of the AST, expandable).
        cy.elements().remove();
        await render();
    }
    status(`Debug finished after ${d.steps.length} statements: ${shown()}`);
}

function stopDebug() {
    if (!dbg) return;
    const { at, steps, running } = dbg;
    if (running) return void (dbg.stop = dbg.pause = true); // debugRun calls back once the running statement is done
    endDebug();
    total = cy.nodes().length;
    status(`Stopped after ${at}/${steps.length} statements; the graph holds only what ran (${shown()})`);
}

async function debugStart() {
    await guarded("Preparing debugger…", startDebug);
    if (!dbg) return;
    syncButtons();
    // With breakpoints set, run to the first one (unless it's the first line); otherwise stay paused before the first statement.
    const first = dbg.steps[0];
    const onFirst = breakpointLines(modelFor(first.file) ?? singleModel).includes(first.line) && !!modelFor(first.file);
    if (!onFirst && (multi() ? [...files.values()] : [singleModel]).some((m) => breakpointLines(m).length)) await debugRun("continue");
}

$("debug").addEventListener("click", debugStart);
$("dbg-continue").addEventListener("click", () => debugRun("continue"));
$("dbg-over").addEventListener("click", () => debugRun("over"));
$("dbg-into").addEventListener("click", () => debugRun("into"));
$("dbg-pause").addEventListener("click", () => dbg && (dbg.pause = true));
$("dbg-stop").addEventListener("click", stopDebug);
jsEditor.onMouseDown((e: { target: { type: number; position: { lineNumber: number } | null } }) => {
    if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && e.target.position) toggleBreakpoint(jsEditor.getModel()!, e.target.position.lineNumber);
});
// Debugger keys, as in VS Code; capture phase so they work with focus in an editor too.
window.addEventListener(
    "keydown",
    (e) => {
        // Outside a session only F5 (start) and F9 (breakpoint) are taken, so F11 fullscreen etc. still work.
        const act: Record<string, () => unknown> = {
            F5: () => (e.shiftKey ? !busy && stopDebug() : dbg ? debugRun("continue") : !busy && debugStart()),
            F9: () => jsEditor.getPosition() && toggleBreakpoint(jsEditor.getModel()!, jsEditor.getPosition()!.lineNumber),
            ...(dbg && { F6: () => dbg && (dbg.pause = true), F10: () => debugRun("over"), F11: () => debugRun("into") }),
        };
        if (!act[e.key] || e.ctrlKey || e.metaKey || e.altKey || (e.key === "F5" && e.shiftKey && !dbg)) return;
        e.preventDefault();
        e.stopPropagation();
        act[e.key]();
    },
    true
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
jsEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, doGenerate);
cypherEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, doRun);

status("Ready — edit the code and hit Generate");
syncButtons();
