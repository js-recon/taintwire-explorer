# taintwire explorer

Paste JavaScript, build its [taintwire](https://taintwire.js-recon.io) graph in the browser (LadybugDB compiled to WASM, nothing leaves the page), see it, and query it with openCypher.

- **Generate** (Ctrl/Cmd+Enter in the JS editor) parses the code and loads the AST plus the semantic overlays (scopes, references, value flow, calls) into an in-memory graph.
- **Run query** (Ctrl/Cmd+Enter in the Cypher editor) shows the rows under the graph and highlights every node a row mentions. **Example queries** has starters.
- Click a node to select its source. Toggle relations in the legend.
- **Multi file** (navbar session dropdown) swaps the editor for a file explorer. **Open js-recon.db…** loads the JS files [js-recon](https://github.com/js-recon/js-recon) downloaded (its `raw_files` table, js-recon 2.1.0-alpha.1 or newer), and Generate builds one graph from the checked files. Clicking a node opens the file it came from. A taintwire DB holding several files also opens as a multi-file session.
- **Debug** (F5) builds the same graph one Cypher statement at a time, so you can watch it grow. Each statement creates one node (a token, a Scope) or one edge, in source order. A node comes before what it contains, and an edge runs right after the later of its two ends. Click the JS editor's left gutter (or press F9) to toggle a breakpoint on a line. With breakpoints set, Debug runs to the first one; otherwise it stops before the first statement.
  - **Step into** (F11) runs one statement. **Step over** (F10) runs the rest of the current line. **Continue** (F5) runs until the next breakpoint line or the end. **Pause** (F6) stops a long run. **Stop** (Shift+F5) ends the session and keeps the partial graph.
  - The panel over the graph shows the statement that just ran and the next one. The highlighted editor line is where the next one comes from. New elements are outlined in orange. While paused, **Run query** queries the partial graph. The editor is read-only until the session ends. Multi-file sessions walk the checked files in order, opening each one.
  - Debugging doesn't change the graph: the finished graph equals Generate's. Long Step over / Continue runs are sent as batched statements, so a minified one-line file steps over in one go.
  - Only the first 1500 nodes (in source order) are drawn while debugging. A bigger graph still builds completely, and then opens collapsed the way Generate shows it.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # dist/
npm run e2e        # headless Chromium against the built dist/ (npx playwright install chromium-headless-shell once)
```

## Deploy (Cloudflare Workers)

Build command `npm run build`, deploy command `npx wrangler deploy` (serves `dist/` as static assets per `wrangler.jsonc`). The Ladybug WASM worker (`assets/lbug_wasm_worker-*.js`, ~24 MB) is under Cloudflare's 25 MiB per-asset limit. Monaco loads from jsDelivr at runtime.
