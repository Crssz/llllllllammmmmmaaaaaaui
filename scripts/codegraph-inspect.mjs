import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

const db = new DatabaseSync(resolve('.codegraph/codegraph.db'), { readOnly: true });

console.log('=== edge kinds ===');
console.log(db.prepare('SELECT kind, COUNT(*) c FROM edges GROUP BY kind ORDER BY c DESC').all());

console.log('\n=== node kinds ===');
console.log(db.prepare('SELECT kind, COUNT(*) c FROM nodes GROUP BY kind ORDER BY c DESC').all());

console.log('\n=== sample call/reference edges ===');
console.log(
  db
    .prepare(
      "SELECT e.source, e.target, e.kind, e.line, ns.name AS sname, nt.name AS tname FROM edges e LEFT JOIN nodes ns ON ns.id=e.source LEFT JOIN nodes nt ON nt.id=e.target WHERE e.kind != 'contains' LIMIT 10"
    )
    .all()
);
