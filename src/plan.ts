// The debugger's plan: a built graph's rows replayed as one Cypher statement per step, in source order.
type Value = unknown;
export type NodeRow = { table: string; row: Record<string, Value> };
export type EdgeRow = { rel: string; s: string; sl: string; t: string; tl: string; props: Record<string, Value> };
export type Step = {
    cypher: string;
    params: Record<string, Value>;
    file: string;
    line: number;
    /** What it creates: a node id, or `d<index>` for an edge (edges can repeat, so they're keyed by step). */
    creates: string;
    node?: NodeRow;
    edge?: EdgeRow;
};

const props = (o: Record<string, Value>) => {
    const keys = Object.keys(o).filter((k) => o[k] != null); // a null param has no type to bind; the column stays null anyway
    return { text: keys.map((k) => `${k}: $${k}`).join(", "), params: Object.fromEntries(keys.map((k) => [k, o[k]])) };
};

/**
 * Order rows the way a reader meets them: files in build order, then by line, a node before what it contains (start
 * offset, wider span first). A Scope follows the node that creates it, and an edge follows the later of its two ends,
 * so every statement only refers to nodes that exist. Edges are created after their later end; File/Program are line 1.
 */
export function plan(nodes: NodeRow[], edges: EdgeRow[], fileOrder: string[]): Step[] {
    const num = (v: Value) => Number(v ?? 0);
    const fileIdx = (f: Value) => {
        const i = fileOrder.indexOf(String(f));
        return i < 0 ? fileOrder.length : i;
    };
    const owner = new Map<string, string>(); // scope id -> the node that creates it
    for (const e of edges) if (e.rel === "CREATES_SCOPE") owner.set(e.t, e.s);
    const ast = nodes.filter((n) => n.table !== "Scope");
    ast.sort(
        (a, b) =>
            fileIdx(a.row.file) - fileIdx(b.row.file) ||
            num(a.row.line) - num(b.row.line) ||
            num(a.row.startOffset) - num(b.row.startOffset) ||
            num(b.row.endOffset) - num(a.row.endOffset)
    );
    const scopesOf = new Map<string, NodeRow[]>();
    const orphans: NodeRow[] = []; // a Scope nothing creates; never seen, but kept so the replay stays complete
    for (const n of nodes.filter((n) => n.table === "Scope")) {
        const o = owner.get(n.row.id as string);
        if (o) scopesOf.set(o, [...(scopesOf.get(o) ?? []), n]);
        else orphans.push(n);
    }
    const ordered: NodeRow[] = [];
    for (const n of ast) ordered.push(n, ...(scopesOf.get(n.row.id as string) ?? []));
    ordered.push(...orphans);

    const pos = new Map(ordered.map((n, i) => [n.row.id as string, i]));
    const where = new Map<string, { file: string; line: number }>();
    for (const n of ordered) {
        const o = n.table === "Scope" ? owner.get(n.row.id as string) : undefined;
        where.set(n.row.id as string, o && where.has(o) ? where.get(o)! : { file: String(n.row.file), line: num(n.row.line) || 1 });
    }
    const edgesAfter = new Map<number, number[]>();
    edges.forEach((e, i) => {
        const at = Math.max(pos.get(e.s) ?? -1, pos.get(e.t) ?? -1);
        if (at >= 0) edgesAfter.set(at, [...(edgesAfter.get(at) ?? []), i]);
    });

    const steps: Step[] = [];
    ordered.forEach((n, i) => {
        const p = props(n.row);
        const id = n.row.id as string;
        steps.push({ cypher: `CREATE (:\`${n.table}\` {${p.text}})`, params: p.params, ...where.get(id)!, creates: id, node: n });
        for (const j of edgesAfter.get(i) ?? []) {
            const e = edges[j];
            const ep = props(e.props);
            steps.push({
                cypher: `MATCH (a:\`${e.sl}\` {id: $s}), (b:\`${e.tl}\` {id: $t}) CREATE (a)-[:${e.rel}${ep.text ? ` {${ep.text}}` : ""}]->(b)`,
                params: { s: e.s, t: e.t, ...ep.params },
                ...where.get(id)!,
                creates: `d${j}`,
                edge: e,
            });
        }
    });
    return steps;
}

/** The statement with its parameters written in, for display only (it runs with the parameters bound). */
export function showCypher(step: Step, max = 40): string {
    return step.cypher.replace(/\$(\w+)/g, (_, k: string) => {
        const v = step.params[k];
        if (typeof v !== "string") return String(v);
        const s = v.length > max ? `${v.slice(0, max)}…` : v;
        return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'`;
    });
}

/**
 * The same writes as running `steps` one by one, as few UNWIND statements: every node first, then every edge (each edge
 * only needs its two ends, which this run or an earlier one creates), grouped by statement text, `size` rows at most.
 */
export function batches(steps: Step[], size = 5000): { cypher: string; rows: Record<string, unknown>[] }[] {
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const s of [...steps.filter((s) => s.node), ...steps.filter((s) => !s.node)]) groups.set(s.cypher, [...(groups.get(s.cypher) ?? []), s.params]);
    const out: { cypher: string; rows: Record<string, unknown>[] }[] = [];
    for (const [cypher, rows] of groups)
        for (let i = 0; i < rows.length; i += size) out.push({ cypher: `UNWIND $rows AS r ${cypher.replace(/\$(\w+)/g, "r.$1")}`, rows: rows.slice(i, i + size) });
    return out;
}
