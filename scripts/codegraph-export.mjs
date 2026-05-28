// Read .codegraph/codegraph.db and emit a self-contained codegraph.html
// with an interactive D3 force-directed graph + filters + details panel.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const db = new DatabaseSync(resolve(root, '.codegraph/codegraph.db'), { readOnly: true });

const nodes = db
  .prepare(
    `SELECT id, kind, name, qualified_name, file_path, language,
            start_line, end_line, signature, docstring,
            is_exported, is_async
       FROM nodes`,
  )
  .all()
  .map((n) => ({
    id: n.id,
    kind: n.kind,
    name: n.name,
    qname: n.qualified_name,
    file: n.file_path,
    lang: n.language,
    line: n.start_line,
    endLine: n.end_line,
    sig: n.signature,
    doc: n.docstring,
    exp: !!n.is_exported,
    async: !!n.is_async,
  }));

const edges = db
  .prepare(`SELECT source, target, kind, line FROM edges`)
  .all()
  .map((e) => ({ s: e.source, t: e.target, k: e.kind, l: e.line }));

const files = db
  .prepare(`SELECT path, language, size, node_count FROM files ORDER BY path`)
  .all()
  .map((f) => ({ path: f.path, lang: f.language, size: f.size, count: f.node_count ?? 0 }));

const projectName = root.split(/[\\/]/).pop();
const generatedAt = new Date().toISOString();

const data = { projectName, generatedAt, nodes, edges, files };

const tpl = readFileSync(resolve(here, 'codegraph-template.html'), 'utf8');
const out = tpl.replace(
  '/*__CODEGRAPH_DATA__*/null',
  JSON.stringify(data).replace(/</g, '\\u003c'),
);

const outPath = resolve(root, 'codegraph.html');
writeFileSync(outPath, out);

console.log(
  `wrote ${outPath}\n  ${nodes.length} nodes, ${edges.length} edges, ${files.length} files`,
);
