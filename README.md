# taintwire explorer

Paste JavaScript, build its [taintwire](https://taintwire.js-recon.io) graph in the browser (LadybugDB compiled to WASM, nothing leaves the page), see it, and query it with openCypher.

- **Generate** (Ctrl/Cmd+Enter in the JS editor) parses the code and loads the AST plus the semantic overlays (scopes, references, value flow, calls) into an in-memory graph.
- **Run query** (Ctrl/Cmd+Enter in the Cypher editor) shows the rows under the graph and highlights every node a row mentions. **Example queries** has starters.
- Click a node to select its source. Toggle relations in the legend.
- **Multi file** (navbar session dropdown) swaps the editor for a file explorer. **Open js-recon.db…** loads the JS files [js-recon](https://github.com/js-recon/js-recon) downloaded (its `raw_files` table, js-recon 2.1.0-alpha.1 or newer), and Generate builds one graph from the checked files. Clicking a node opens the file it came from. A taintwire DB holding several files also opens as a multi-file session.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # dist/
npm run e2e        # headless Chromium against the built dist/ (npx playwright install chromium-headless-shell once)
```

## Deploy (Cloudflare Workers)

Build command `npm run build`, deploy command `npx wrangler deploy` (serves `dist/` as static assets per `wrangler.jsonc`). The Ladybug WASM worker (`assets/lbug_wasm_worker-*.js`, ~24 MB) is under Cloudflare's 25 MiB per-asset limit. Monaco loads from jsDelivr at runtime.
