# taintwire explorer

Paste JavaScript, build its [taintwire](https://taintwire.js-recon.io) graph in the browser (LadybugDB compiled to WASM, nothing leaves the page), see it, and query it with openCypher.

- **Generate** (Ctrl/Cmd+Enter in the JS editor) parses the code and loads the AST plus the semantic overlays (scopes, references, value flow, calls) into an in-memory graph.
- **Run query** (Ctrl/Cmd+Enter in the Cypher editor) shows the rows under the graph and highlights every node a row mentions. **Example queries** has starters.
- Click a node to select its source. Toggle relations in the legend.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # dist/
npm run e2e        # headless Chromium against the built dist/ (npx playwright install chromium-headless-shell once)
```

## Deploy (Cloudflare Pages)

Build command `npm run build`, output directory `dist`. The Ladybug WASM worker (`assets/lbug_wasm_worker-*.js`, ~24 MB) is under Pages' 25 MiB per-file limit. Monaco loads from jsDelivr at runtime.
