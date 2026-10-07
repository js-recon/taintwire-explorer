// @babel/traverse (pulled in by cs-mast) reads process.env when it loads. `versions.node` stays unset so cs-mast
// hashes with @noble/hashes instead of reaching for node:crypto.
(globalThis as { process?: unknown }).process ??= { env: { NODE_ENV: "production" }, versions: {}, browser: true };
