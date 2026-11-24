'use strict';
/**
 * Konversi sintaks ESM (import/export) -> CommonJS supaya script bot berformat ESM
 * ("type":"module") tetap bisa dijalankan. Mendukung bentuk umum:
 *   import x from 'a' | import {a, b as c} from 'a' | import * as n from 'a' | import x, {a} from 'a' | import 'a'
 *   export default ... | export const/let/var/function/class | export {a, b as c} | export * from 'a'
 *   import(...) dinamis, import.meta.url/dirname/filename
 * Tidak didukung: top-level await.
 */
let seq = 0;
function names(list) {
  return list.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = s.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
    return m ? [m[1], m[2]] : [s, s];
  });
}
function toCjs(code) {
  if (!/(^|\n)[ \t]*(import|export)\b/.test(code) && !/import\.meta|(^|[^\w$.])import\s*\(/.test(code)) return code;
  let out = code;
  const exportsList = [];
  out = out.replace(/import\.meta\.url/g, '("file://" + __filename)')
    .replace(/import\.meta\.dirname/g, '__dirname').replace(/import\.meta\.filename/g, '__filename')
    .replace(/(^|[^\w$.])import\s*\(/g, '$1__dynImport(');

  out = out.replace(/^[ \t]*import\s+([\s\S]*?)\s+from\s+(['"])([^'"\n]+)\2[ \t]*;?/gm, (m, clause, q, src) => {
    if (/^type\s/.test(clause)) return '';
    const id = '__m' + (++seq);
    let res = `const ${id} = require(${JSON.stringify(src)});`;
    const def = (v) => ` const ${v} = (${id} && ${id}.__esModule && 'default' in ${id}) ? ${id}.default : ${id};`;
    clause = clause.trim();
    const star = clause.match(/^(?:([\w$]+)\s*,\s*)?\*\s+as\s+([\w$]+)$/);
    const braces = clause.match(/^(?:([\w$]+)\s*,\s*)?\{([\s\S]*)\}$/);
    if (star) { if (star[1]) res += def(star[1]); res += ` const ${star[2]} = ${id};`; }
    else if (braces) {
      if (braces[1]) res += def(braces[1]);
      const ns = names(braces[2]);
      if (ns.length) res += ` const { ${ns.map(([a, b]) => (a === b ? a : `${a}: ${b}`)).join(', ')} } = ${id};`;
    } else if (/^[\w$]+$/.test(clause)) res += def(clause);
    else return m;
    return res;
  });
  out = out.replace(/^[ \t]*import\s+(['"])([^'"\n]+)\1[ \t]*;?/gm, (m, q, src) => `require(${JSON.stringify(src)});`);

  out = out.replace(/^[ \t]*export\s+default\s+/gm, 'module.exports.default = ');
  out = out.replace(/^[ \t]*export\s+((?:async\s+)?function\*?\s+([\w$]+))/gm, (m, d, n) => { exportsList.push(n); return d; });
  out = out.replace(/^[ \t]*export\s+(class\s+([\w$]+))/gm, (m, d, n) => { exportsList.push(n); return d; });
  out = out.replace(/^[ \t]*export\s+((?:const|let|var)\s+([\w$]+))/gm, (m, d, n) => { exportsList.push(n); return d; });
  out = out.replace(/^[ \t]*export\s+\*\s+from\s+(['"])([^'"\n]+)\1[ \t]*;?/gm, (m, q, src) => `Object.assign(exports, require(${JSON.stringify(src)}));`);
  out = out.replace(/^[ \t]*export\s+\{([\s\S]*?)\}\s*from\s+(['"])([^'"\n]+)\2[ \t]*;?/gm, (m, list, q, src) => {
    const id = '__m' + (++seq);
    return `const ${id} = require(${JSON.stringify(src)}); ` + names(list).map(([a, b]) => `exports[${JSON.stringify(b)}] = ${id}[${JSON.stringify(a)}];`).join(' ');
  });
  out = out.replace(/^[ \t]*export\s+\{([\s\S]*?)\}[ \t]*;?/gm, (m, list) => { names(list).forEach(([a, b]) => exportsList.push(a === b ? a : [a, b])); return ''; });

  const tail = exportsList.map((e) => (Array.isArray(e) ? `exports[${JSON.stringify(e[1])}] = ${e[0]};` : `exports[${JSON.stringify(e)}] = ${e};`)).join('\n');
  return `Object.defineProperty(exports, '__esModule', { value: true });\n${out}\n${tail}`;
}
module.exports = { toCjs };
