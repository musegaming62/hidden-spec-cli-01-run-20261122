// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function fileState(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinState(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.final ? s.br : '');
}

function leadWs(s: string): string {
  const m = s.match(/^[ \t]*/);
  return m ? m[0]! : '';
}

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrences(lines: string[], o: string[], tier: number, start: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = start; i + o.length <= lines.length; i += 1) {
    if (eofOnly && i + o.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (normLine(lines[i + j]!, tier) !== normLine(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function firstTier(lines: string[], o: string[], strict: boolean, start: number, eofOnly: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const pos = occurrences(lines, o, tier, start, eofOnly);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

interface NewEntry {
  ctx: boolean;
  oIdx: number;
  text: string;
}

function buildNew(o: string[], n: NewEntry[], matched: string[], tier: number): string[] {
  if (tier !== 2 || o.length === 0) return n.map((e) => (e.ctx ? matched[e.oIdx]! : e.text));
  const f = leadWs(matched[0]!);
  const p = leadWs(o[0]!);
  return n.map((e) => {
    if (e.ctx) return matched[e.oIdx]!;
    if (e.text === '' || e.text.trim() === '') return e.text;
    if (!e.text.startsWith(p)) return e.text;
    return f + e.text.slice(p.length);
  });
}

interface BodyEntry {
  kind: string;
  text: string;
}

function lastNoNewline(body: BodyEntry[]): boolean {
  for (let i = body.length - 1; i >= 0; i -= 1) {
    if (body[i]!.kind === 'ctx' || body[i]!.kind === 'new') {
      return i + 1 < body.length && body[i + 1]!.kind === 'back';
    }
  }
  return false;
}

function splitBody(body: BodyEntry[]): { o: string[]; n: NewEntry[] } {
  const o: string[] = [];
  const n: NewEntry[] = [];
  for (const e of body) {
    if (e.kind === 'ctx') {
      o.push(e.text);
      n.push({ ctx: true, oIdx: o.length - 1, text: e.text });
    } else if (e.kind === 'old') {
      o.push(e.text);
    } else if (e.kind === 'new') {
      n.push({ ctx: false, oIdx: -1, text: e.text });
    }
  }
  return { o, n };
}

function applyHunksToState(state: FileState, hunks: Array<{ a: number; body: BodyEntry[] }>, strict: boolean, path: string, unifiedFinal: boolean): void {
  let d = 0;
  for (const hunk of hunks) {
    const { o, n } = splitBody(hunk.body);
    if (o.length === 0) {
      const atEnd = Math.min(Math.max(hunk.a + d, 0), state.lines.length) === state.lines.length;
      const noNl = unifiedFinal ? lastNoNewline(hunk.body) : false;
      const pos = Math.min(Math.max(hunk.a + d, 0), state.lines.length);
      const made = buildNew(o, n, [], 0);
      state.lines.splice(pos, 0, ...made);
      if (unifiedFinal && atEnd) state.final = !noNl;
      d += n.length;
    } else {
      const found = firstTier(state.lines, o, strict, 0, false);
      if (found === null) throw new Fail('no-match', path);
      const target = hunk.a - 1 + d;
      let pos = found.pos[0]!;
      for (const p of found.pos) {
        if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      }
      const atEnd = pos + o.length === state.lines.length;
      const noNl = unifiedFinal ? lastNoNewline(hunk.body) : false;
      const matched = state.lines.slice(pos, pos + o.length);
      const made = buildNew(o, n, matched, found.tier);
      state.lines.splice(pos, o.length, ...made);
      if (unifiedFinal && atEnd) state.final = !noNl;
      d += n.length - o.length;
    }
  }
}

function headerPath(line: string): string | null {
  let raw = line.slice(4);
  const tab = raw.indexOf('\t');
  if (tab >= 0) raw = raw.slice(0, tab);
  const p = raw.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

interface UnifiedSection {
  pairOld?: string | null;
  pairNew?: string | null;
  renameOld?: string;
  renameNew?: string;
  diffOld?: string;
  diffNew?: string;
  createFlag: boolean;
  deleteFlag: boolean;
  hunks: Array<{ a: number; body: BodyEntry[] }>;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      if (m === null || m[1] === '' || m[2] === '') throw new Exit2(`error: parse ${i + 1}`);
      cur = { createFlag: false, deleteFlag: false, hunks: [] };
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && cur.pairOld === undefined) {
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      cur = { createFlag: false, deleteFlag: false, hunks: [] };
      cur.pairOld = headerPath(line);
      cur.pairNew = headerPath(lines[i + 1]!);
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hm = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/);
      if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
      let j = i + 1;
      const body: BodyEntry[] = [];
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl.startsWith(' ')) body.push({ kind: 'ctx', text: bl.slice(1) });
        else if (bl.startsWith('-')) body.push({ kind: 'old', text: bl.slice(1) });
        else if (bl.startsWith('+')) body.push({ kind: 'new', text: bl.slice(1) });
        else if (bl.startsWith('\\')) body.push({ kind: 'back', text: bl.slice(1) });
        else if (bl === '') body.push({ kind: 'ctx', text: '' });
        else break;
        j += 1;
      }
      while (j > i + 1 && lines[j - 1] === '') {
        body.pop();
        j -= 1;
      }
      cur.hunks.push({ a: Number(hm[1]), body });
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader && line.startsWith('--- ')) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('+++ ')) cur.pairNew = headerPath(line);
      else if (line.startsWith('rename from ')) cur.renameOld = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.createFlag = true;
      else if (line.startsWith('deleted file mode')) cur.deleteFlag = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  const edits: Edit[] = [];
  for (const s of sections) {
    const oldP = s.pairOld !== undefined ? s.pairOld : s.renameOld !== undefined ? s.renameOld : s.diffOld;
    const newP = s.pairNew !== undefined ? s.pairNew : s.renameNew !== undefined ? s.renameNew : s.diffNew;
    const hunks = s.hunks;
    if (oldP === null || s.createFlag) {
      const p = newP;
      if (p === undefined || p === null) continue;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus: string[] = [];
        let noNl = false;
        for (const hunk of hunks) {
          for (const e of hunk.body) if (e.kind === 'new') plus.push(e.text);
          if (hunk.body.some((e) => e.kind === 'new')) noNl = lastNoNewline(hunk.body);
        }
        tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noNl ? '' : '\n'));
      });
      continue;
    }
    if (newP === null || s.deleteFlag) {
      const p = oldP;
      if (p === undefined || p === null) continue;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    if (oldP !== undefined && newP !== undefined && oldP !== newP) {
      const oldPath = oldP;
      const newPath = newP;
      edits.push((tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        const before = tree.get(oldPath);
        if (before === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const state = fileState(before);
        applyHunksToState(state, hunks, strict, oldPath, true);
        tree.now.set(oldPath, null);
        tree.now.set(newPath, joinState(state));
        tree.moves.push([oldPath, newPath]);
      });
      continue;
    }
    const p = oldP !== undefined ? oldP : newP;
    if (p === undefined || p === null) continue;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const state = fileState(before);
      applyHunksToState(state, hunks, strict, p, true);
      tree.now.set(p, joinState(state));
    });
  }
  return edits;
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let j = s + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') j += 1;
    if (j >= lines.length) throw new Exit2(`error: parse ${s + 1}`);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k += 1;
    if (k >= lines.length) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, j);
    const newLines = lines.slice(j + 1, k);
    let path: string | null = null;
    for (let p = s - 1; p >= prevEnd; p -= 1) {
      if (blank(lines[p]!)) continue;
      if (lines[p]!.trim().startsWith('```')) continue;
      path = lines[p]!.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    const blockPath = path;
    const blockOld = oldLines;
    const blockNew = newLines;
    edits.push((tree) => {
      if (!safe(blockPath)) throw new Fail('unsafe', blockPath);
      if (blockOld.length === 0) {
        if (tree.get(blockPath) !== null) throw new Fail('exists', blockPath);
        tree.now.set(blockPath, blockNew.length === 0 ? '' : blockNew.join('\n') + '\n');
        return;
      }
      const before = tree.get(blockPath);
      if (before === null) throw new Fail('missing', blockPath);
      const state = fileState(before);
      const found = firstTier(state.lines, blockOld, strict, 0, false);
      if (found === null) throw new Fail('no-match', blockPath);
      if (found.pos.length > 1) throw new Fail('ambiguous', blockPath);
      const pos = found.pos[0]!;
      const matched = state.lines.slice(pos, pos + blockOld.length);
      const n: NewEntry[] = blockNew.map((t) => ({ ctx: false, oIdx: -1, text: t }));
      const made = buildNew(blockOld, n, matched, found.tier);
      state.lines.splice(pos, blockOld.length, ...made);
      tree.now.set(blockPath, joinState(state));
    });
    prevPath = path;
    prevEnd = k + 1;
    i = k + 1;
  }
  return edits;
}

interface V4aChunk {
  anchor: string | null;
  body: BodyEntry[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  const last = lines.length - 1 - [...lines].reverse().findIndex((l) => !blank(l));
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const line = lines[i]!;
    const headerAt = i;
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File: '.length).trim();
      const content: string[] = [];
      let j = i + 1;
      while (j < last) {
        const bl = lines[j]!;
        if (bl.startsWith('*** Add File: ') || bl.startsWith('*** Delete File: ') || bl.startsWith('*** Update File: ')) break;
        if (bl.startsWith('+')) {
          content.push(bl.slice(1));
          j += 1;
        } else if (bl === '' || blank(bl)) {
          content.push('');
          j += 1;
        } else throw new Exit2(`error: parse ${j + 1}`);
      }
      while (content.length > 0 && content[content.length - 1] === '') content.pop();
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, content.length === 0 ? '' : content.join('\n') + '\n');
      });
      i = j;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File: '.length).trim();
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      i += 1;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const p = line.slice('*** Update File: '.length).trim();
      let j = i + 1;
      let moveTo: string | null = null;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice('*** Move to: '.length).trim();
        j += 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      while (j < last) {
        const bl = lines[j]!;
        if (bl.startsWith('*** Add File: ') || bl.startsWith('*** Delete File: ') || bl.startsWith('*** Update File: ')) break;
        if (bl === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${j + 1}`);
          cur.eof = true;
          cur = null;
          j += 1;
          continue;
        }
        if (bl.startsWith('@@')) {
          cur = { anchor: bl.slice(2).trim(), body: [], eof: false };
          chunks.push(cur);
          j += 1;
          continue;
        }
        if (blank(bl)) {
          let k = j + 1;
          while (k < last && blank(lines[k]!)) k += 1;
          if (k >= last || lines[k]!.startsWith('*** Add File: ') || lines[k]!.startsWith('*** Delete File: ') || lines[k]!.startsWith('*** Update File: ')) break;
          if (cur === null) {
            cur = { anchor: null, body: [], eof: false };
            chunks.push(cur);
          }
          cur.body.push({ kind: 'ctx', text: '' });
          j += 1;
          continue;
        }
        if (bl.startsWith(' ')) {
          if (cur === null) {
            cur = { anchor: null, body: [], eof: false };
            chunks.push(cur);
          }
          cur.body.push({ kind: 'ctx', text: bl.slice(1) });
          j += 1;
          continue;
        }
        if (bl.startsWith('-')) {
          if (cur === null) {
            cur = { anchor: null, body: [], eof: false };
            chunks.push(cur);
          }
          cur.body.push({ kind: 'old', text: bl.slice(1) });
          j += 1;
          continue;
        }
        if (bl.startsWith('+')) {
          if (cur === null) {
            cur = { anchor: null, body: [], eof: false };
            chunks.push(cur);
          }
          cur.body.push({ kind: 'new', text: bl.slice(1) });
          j += 1;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      while (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1]!;
        if (lastChunk.body.length === 0) break;
        const lastBody = lastChunk.body[lastChunk.body.length - 1]!;
        if (lastBody.kind === 'ctx' && lastBody.text === '') lastChunk.body.pop();
        else break;
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerAt + 1}`);
      const movePath = moveTo;
      const sectionChunks = chunks;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (movePath !== null && !safe(movePath)) throw new Fail('unsafe', movePath);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (movePath !== null && tree.get(movePath) !== null) throw new Fail('exists', movePath);
        const state = fileState(before);
        let cursor = 0;
        for (const chunk of sectionChunks) {
          if (chunk.anchor !== null && chunk.anchor !== '') {
            const anchor = chunk.anchor;
            let foundPos: number | null = null;
            const tiers = strict ? [0] : [0, 1, 2];
            for (const tier of tiers) {
              for (let q = cursor; q < state.lines.length; q += 1) {
                if (normLine(state.lines[q]!, tier) === normLine(anchor, tier)) {
                  foundPos = q;
                  break;
                }
              }
              if (foundPos !== null) break;
            }
            if (foundPos === null) throw new Fail('no-match', p);
            cursor = foundPos + 1;
          }
          const { o, n } = splitBody(chunk.body);
          if (o.length === 0) {
            const pos = chunk.eof ? state.lines.length : cursor;
            const made = buildNew(o, n, [], 0);
            state.lines.splice(pos, 0, ...made);
            cursor = pos + made.length;
          } else {
            const found = firstTier(state.lines, o, strict, cursor, chunk.eof);
            if (found === null) throw new Fail('no-match', p);
            const pos = found.pos[0]!;
            const matched = state.lines.slice(pos, pos + o.length);
            const made = buildNew(o, n, matched, found.tier);
            state.lines.splice(pos, o.length, ...made);
            cursor = pos + made.length;
          }
        }
        const out = joinState(state);
        if (movePath !== null) {
          tree.now.set(p, null);
          tree.now.set(movePath, out);
          tree.moves.push([p, movePath]);
        } else {
          tree.now.set(p, out);
        }
      });
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const consumed = new Set<string>();
  const entries: Array<{ key: string; text: string }> = [];
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.now.get(oldP) === null && tree.original(newP) === null && tree.now.get(newP) !== null) {
      consumed.add(oldP);
      consumed.add(newP);
      entries.push({ key: newP, text: `R ${oldP} -> ${newP}` });
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    entries.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = entries.map((e) => e.text);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
