// mend — one patch tool that applies AI-written edits in all four formats
// (unified diff, SEARCH/REPLACE blocks, V4A, JSON tool calls) to a tree of
// text files, exactly as SPEC.md in the kit describes. Node 22, standard
// library only. Run as: node main.ts [--format=NAME] [--check] [--strict]
// [PATCH]. When MAKEFUN_ENV_URL is set this file hands the trial to
// runner.ts (kept from the kit) at the bottom.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------- errors

/** An exit-2 failure: stdout is this one line and nothing is written. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: stdout gets `error: <code> <path>` for it. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

// ---------------------------------------------------------------- helpers

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r off each, no empty tail. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC section 3: a path is safe when no segment is empty, `.` or `..`. */
function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function requireSafe(p: string): void {
  if (!isSafe(p)) throw new Fail('unsafe', p);
}

/** Byte order (UTF-8) comparison for the exit-0 listing. */
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// ---------------------------------------------------------------- files

/** A text file as lines plus the two facts a rewrite must preserve. */
interface FileModel {
  lines: string[];
  br: string; // '\n' or '\r\n'
  finalBreak: boolean;
}

function parseFile(text: string): FileModel {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, finalBreak: false };
  const lines = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) lines.pop();
  return { lines, br, finalBreak };
}

function renderFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.finalBreak ? m.br : '');
}

/**
 * The tree as the edits leave it. Nothing touches the disk until every
 * edit has run: `now` overlays the original bytes, null means deleted.
 */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ from: string; to: string }> = [];

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

  set(p: string, text: string | null): void {
    this.now.set(p, text);
  }
}

type Edit = (tree: Tree, strict: boolean) => void;

// ---------------------------------------------------------------- matching

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

/** One line against one pattern line at a tier (SPEC section 5). */
function lineAtTier(fileLine: string, patLine: string, tier: number): boolean {
  if (tier === 0) return fileLine === patLine;
  if (tier === 1) return stripTrail(fileLine) === stripTrail(patLine);
  return stripBoth(fileLine) === stripBoth(patLine);
}

/** A block entry: context lines are shared by the old and the new side. */
interface BlockLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  noNl?: boolean; // a `\ No newline` marker followed this body line
  rawEmpty?: boolean; // the body line was completely empty (a bare context line)
}

interface Found {
  tier: number;
  positions: number[];
}

/**
 * Every occurrence of the old lines at the first tier that has one.
 * Occurrences may overlap. `from` skips earlier positions and `endOnly`
 * keeps only occurrences that end on the file's last line.
 */
function findBlock(
  lines: string[],
  old: BlockLine[],
  strict: boolean,
  from = 0,
  endOnly = false,
): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = from; i + old.length <= lines.length; i += 1) {
      if (endOnly && i + old.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < old.length; j += 1) {
        if (!lineAtTier(lines[i + j]!, old[j]!.text, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/**
 * Write the new side of a matched block: context lines come from the file
 * itself, and at tier 2 the other lines are re-indented from the old
 * side's first-line prefix to the file's first matched line's prefix.
 */
function renderNew(
  fileLines: string[],
  pos: number,
  old: BlockLine[],
  neu: BlockLine[],
  tier: number,
): string[] {
  const ctxAt: number[] = [];
  old.forEach((l, idx) => {
    if (l.kind === 'ctx') ctxAt.push(idx);
  });
  let ctxSeen = 0;
  const fLead = fileLines.length > 0 && old.length > 0 ? leadWs(fileLines[pos] ?? '') : '';
  const pLead = old.length > 0 ? leadWs(old[0]!.text) : '';
  const out: string[] = [];
  for (const l of neu) {
    if (l.kind === 'ctx') {
      const at = ctxAt[ctxSeen];
      ctxSeen += 1;
      out.push(at === undefined ? l.text : (fileLines[pos + at] ?? l.text));
    } else if (tier === 2 && l.text.trim() !== '' && l.text.startsWith(pLead)) {
      out.push(fLead + l.text.slice(pLead.length));
    } else {
      out.push(l.text);
    }
  }
  return out;
}

// ---------------------------------------------------------------- unified

interface Hunk {
  a: number; // the A of @@ -A[,B] +C[,D] @@
  body: BlockLine[];
}

interface Section {
  gitOld?: string;
  gitNew?: string;
  pairOld?: string | null;
  pairNew?: string | null;
  hasPair: boolean;
  loneOld?: string | null;
  loneNew?: string | null;
  renameFrom?: string;
  renameTo?: string;
  createMode: boolean;
  deleteMode: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: to the first tab, trimmed, unprefixed. */
function headerPath(raw: string): string | null {
  const cut = raw.split('\t')[0]!.trim();
  if (cut === '/dev/null') return null;
  return cut.replace(/^[ab]\//, '');
}

const GIT_RE = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const fresh = (): Section => {
    const s: Section = { hasPair: false, createMode: false, deleteMode: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    if (line.startsWith('diff --git')) {
      const m = GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = fresh();
      s.gitOld = m[1]!;
      s.gitNew = m[2]!;
      i += 1;
      continue;
    }

    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const rest = line.slice(m[0].length);
      if (rest !== '' && !rest.startsWith(' ')) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const body: BlockLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') body.push({ kind: 'ctx', text: '', rawEmpty: true });
        else if (bl[0] === ' ') body.push({ kind: 'ctx', text: bl.slice(1) });
        else if (bl[0] === '-') body.push({ kind: 'old', text: bl.slice(1) });
        else if (bl[0] === '+') body.push({ kind: 'new', text: bl.slice(1) });
        else if (bl[0] === '\\') {
          const prev = body[body.length - 1];
          if (prev !== undefined) prev.noNl = true;
        } else break;
        j += 1;
      }
      // Empty lines at the end of a body are not part of it.
      while (body.length > 0 && body[body.length - 1]!.rawEmpty === true) body.pop();
      cur.hunks.push({ a: Number(m[1]), body });
      i = j;
      continue;
    }

    if (cur !== null && inHeader && line.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        cur.pairOld = headerPath(line.slice(4));
        cur.pairNew = headerPath(lines[i + 1]!.slice(4));
        cur.hasPair = true;
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }

    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const s = fresh();
      s.pairOld = headerPath(line.slice(4));
      s.pairNew = headerPath(lines[i + 1]!.slice(4));
      s.hasPair = true;
      i += 2;
      continue;
    }

    if (cur !== null && inHeader) {
      if (line.startsWith('+++ ')) cur.loneNew = headerPath(line.slice(4));
      else if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.createMode = true;
      else if (line.startsWith('deleted file mode')) cur.deleteMode = true;
      // index, mode, similarity and every other header line are ignored.
      i += 1;
      continue;
    }

    i += 1; // prose, code fences and other lines outside bodies
  }

  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => sectionEdit(s, strict));
}

function sectionPaths(s: Section): { oldP: string | null | undefined; newP: string | null | undefined } {
  if (s.hasPair) return { oldP: s.pairOld, newP: s.pairNew };
  if (s.renameFrom !== undefined || s.renameTo !== undefined) {
    return { oldP: s.renameFrom ?? s.gitOld, newP: s.renameTo ?? s.gitNew };
  }
  return { oldP: s.loneOld ?? s.gitOld, newP: s.loneNew ?? s.gitNew };
}

function sectionEdit(s: Section, strict: boolean): Edit {
  return (tree) => {
    const { oldP, newP } = sectionPaths(s);
    const isCreate = s.createMode || oldP === null;
    const isDelete = !isCreate && (s.deleteMode || newP === null);

    if (isCreate) {
      const target = (newP ?? oldP) as string;
      requireSafe(target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const out: string[] = [];
      let lastPlus: BlockLine | undefined;
      for (const h of s.hunks) {
        for (const l of h.body) {
          if (l.kind === 'new') {
            out.push(l.text);
            lastPlus = l;
          }
        }
      }
      const model: FileModel = {
        lines: out,
        br: '\n',
        finalBreak: out.length > 0 && lastPlus?.noNl !== true,
      };
      tree.set(target, renderFile(model));
      return;
    }

    const source = oldP as string;
    requireSafe(source);
    if (isDelete) {
      if (tree.get(source) === null) throw new Fail('missing', source);
      tree.set(source, null);
      return;
    }

    const target = (newP ?? source) as string;
    if (target !== source) requireSafe(target);
    const before = tree.get(source);
    if (before === null) throw new Fail('missing', source);
    if (target !== source && tree.get(target) !== null) throw new Fail('exists', target);

    const model = parseFile(before);
    let d = 0;
    for (const h of s.hunks) {
      applyHunk(model, h, d, source, strict);
      d += hunkDelta(h);
    }
    if (target !== source) {
      tree.set(target, renderFile(model));
      tree.set(source, null);
      tree.moves.push({ from: source, to: target });
    } else {
      tree.set(source, renderFile(model));
    }
  };
}

function hunkDelta(h: Hunk): number {
  const o = h.body.filter((l) => l.kind !== 'new').length;
  const n = h.body.filter((l) => l.kind !== 'old').length;
  return n - o;
}

/** Apply one hunk to the working model; a failure fails the section. */
function applyHunk(model: FileModel, h: Hunk, d: number, path: string, strict: boolean): void {
  const old = h.body.filter((l) => l.kind !== 'new');
  const neu = h.body.filter((l) => l.kind !== 'old');
  if (old.length === 0) {
    const pos = Math.min(Math.max(h.a + d, 0), model.lines.length);
    const atEnd = pos === model.lines.length;
    const rendered = neu.map((l) => l.text);
    model.lines.splice(pos, 0, ...rendered);
    if (atEnd && rendered.length > 0) {
      const lastPlus = [...neu].reverse().find((l) => l.kind === 'new');
      model.finalBreak = lastPlus?.noNl !== true;
    }
    return;
  }
  const found = findBlock(model.lines, old, strict);
  if (found === null) throw new Fail('no-match', path);
  const want = h.a - 1 + d;
  let pos = found.positions[0]!;
  for (const p of found.positions) {
    if (Math.abs(p - want) < Math.abs(pos - want)) pos = p;
  }
  const rendered = renderNew(model.lines, pos, old, neu, found.tier);
  const runsToEnd = pos + old.length === model.lines.length;
  model.lines.splice(pos, old.length, ...rendered);
  if (runsToEnd) {
    const tail = [...neu].reverse().find((l) => l.kind === 'ctx' || l.kind === 'new');
    if (tail !== undefined) model.finalBreak = tail.noNl !== true;
    else model.finalBreak = model.lines.length > 0;
  }
}

// ---------------------------------------------------------------- search/replace

const SR_OPEN = '<<<<<<< SEARCH';
const SR_MID = '=======';
const SR_CLOSE = '>>>>>>> REPLACE';

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): Edit[] {
  const blocks: SrBlock[] = [];
  let prevPath: string | undefined;
  let bound = 0; // first line index a path may be read from
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== SR_OPEN) {
      i += 1;
      continue;
    }
    const searchAt = i;
    // The path: the nearest line above, at or after the bound, that is
    // not blank and does not open a code fence once trimmed.
    let path: string | undefined;
    for (let k = searchAt - 1; k >= bound; k -= 1) {
      const cand = lines[k]!;
      if (isBlank(cand)) continue;
      const trimmed = cand.trim();
      if (trimmed.startsWith('```')) continue;
      path = trimmed;
      break;
    }
    if (path === undefined) path = prevPath;
    if (path === undefined) throw new Exit2(`error: parse ${searchAt + 1}`);

    let mid = -1;
    for (let k = searchAt + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === SR_MID) {
        mid = k;
        break;
      }
    }
    let close = -1;
    if (mid >= 0) {
      for (let k = mid + 1; k < lines.length; k += 1) {
        if (lines[k]!.trimEnd() === SR_CLOSE) {
          close = k;
          break;
        }
      }
    }
    if (mid < 0 || close < 0) throw new Exit2(`error: parse ${searchAt + 1}`);

    blocks.push({
      path,
      oldLines: lines.slice(searchAt + 1, mid),
      newLines: lines.slice(mid + 1, close),
    });
    prevPath = path;
    bound = close + 1;
    i = close + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => srEdit(b));
}

function srEdit(b: SrBlock): Edit {
  return (tree, strict) => {
    requireSafe(b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      const model: FileModel = {
        lines: [...b.newLines],
        br: '\n',
        finalBreak: b.newLines.length > 0,
      };
      tree.set(b.path, renderFile(model));
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const model = parseFile(before);
    const old: BlockLine[] = b.oldLines.map((text) => ({ kind: 'old', text }));
    const neu: BlockLine[] = b.newLines.map((text) => ({ kind: 'new', text }));
    const found = findBlock(model.lines, old, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.positions[0]!;
    const rendered = renderNew(model.lines, pos, old, neu, found.tier);
    model.lines.splice(pos, old.length, ...rendered);
    tree.set(b.path, renderFile(model));
  };
}

// ---------------------------------------------------------------- v4a

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BlockLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  atLine: number; // 1-based line of the section header
  addLines: Array<{ text: string; rawEmpty?: boolean }>;
  moveTo?: string;
  chunks: VChunk[];
}

function parseV4a(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && isBlank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: VSection[] = [];
  let cur: VSection | null = null;
  let chunk: VChunk | null = null;

  const endSection = (): void => {
    if (cur !== null && cur.kind === 'update' && cur.chunks.length === 0 && cur.moveTo === undefined) {
      throw new Exit2(`error: parse ${cur.atLine}`);
    }
    cur = null;
    chunk = null;
  };

  for (let i = first + 1; i < last; i += 1) {
    const line = lines[i]!;
    const secKind = line.startsWith('*** Add File: ')
      ? 'add'
      : line.startsWith('*** Delete File: ')
        ? 'delete'
        : line.startsWith('*** Update File: ')
          ? 'update'
          : null;
    if (secKind !== null) {
      endSection();
      const prefix = secKind === 'add' ? '*** Add File: ' : secKind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
      cur = {
        kind: secKind,
        path: line.slice(prefix.length).trim(),
        atLine: i + 1,
        addLines: [],
        chunks: [],
      };
      sections.push(cur);
      continue;
    }
    if (cur === null) {
      if (isBlank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'add') {
      if (isBlank(line) && isSectionTail(lines, i, last)) continue;
      if (line.startsWith('+')) cur.addLines.push({ text: line.slice(1) });
      else if (line === '') cur.addLines.push({ text: '', rawEmpty: true });
      else throw new Exit2(`error: parse ${i + 1}`);
      continue;
    }
    if (cur.kind === 'delete') {
      if (isBlank(line) && isSectionTail(lines, i, last)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    // update
    if (line.startsWith('*** Move to: ')) {
      const seenBody = cur.chunks.length > 0 || cur.moveTo !== undefined;
      if (seenBody) throw new Exit2(`error: parse ${i + 1}`);
      cur.moveTo = line.slice('*** Move to: '.length).trim();
      continue;
    }
    if (line.trim() === '*** End of File') {
      if (chunk === null) chunk = pushChunk(cur, null);
      chunk.eof = true;
      chunk = null;
      continue;
    }
    if (line.startsWith('@@')) {
      chunk = pushChunk(cur, line.slice(2).trim() || null);
      continue;
    }
    if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
      if (isBlank(line) && line !== '' && isSectionTail(lines, i, last)) continue;
      if (chunk === null) chunk = pushChunk(cur, null);
      if (line === '') chunk.body.push({ kind: 'ctx', text: '', rawEmpty: true });
      else if (line[0] === ' ') chunk.body.push({ kind: 'ctx', text: line.slice(1) });
      else if (line[0] === '-') chunk.body.push({ kind: 'old', text: line.slice(1) });
      else chunk.body.push({ kind: 'new', text: line.slice(1) });
      continue;
    }
    if (isBlank(line)) continue;
    throw new Exit2(`error: parse ${i + 1}`);
  }
  endSection();

  // Blank lines at the end of a section are not part of it.
  for (const s of sections) {
    while (s.addLines.length > 0 && s.addLines[s.addLines.length - 1]!.rawEmpty === true) s.addLines.pop();
    for (const c of s.chunks) {
      while (c.body.length > 0 && c.body[c.body.length - 1]!.rawEmpty === true) c.body.pop();
    }
  }

  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => vEdit(s));
}

function pushChunk(s: VSection, anchor: string | null): VChunk {
  const c: VChunk = { anchor, eof: false, body: [] };
  s.chunks.push(c);
  return c;
}

/** True when every line from i to the next section (or the end) is blank. */
function isSectionTail(lines: string[], i: number, last: number): boolean {
  for (let k = i; k < last; k += 1) {
    const l = lines[k]!;
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) return true;
    if (!isBlank(l)) return false;
  }
  return true;
}

function vEdit(s: VSection): Edit {
  return (tree, strict) => {
    requireSafe(s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      const texts = s.addLines.map((l) => l.text);
      const model: FileModel = {
        lines: texts,
        br: '\n',
        finalBreak: texts.length > 0,
      };
      tree.set(s.path, renderFile(model));
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.set(s.path, null);
      return;
    }
    if (s.moveTo !== undefined) requireSafe(s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== undefined && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const model = parseFile(before);
    let cursor = 0;
    for (const c of s.chunks) {
      cursor = applyChunk(model, c, cursor, s.path, strict);
    }
    if (s.moveTo !== undefined) {
      tree.set(s.moveTo, renderFile(model));
      tree.set(s.path, null);
      tree.moves.push({ from: s.path, to: s.moveTo });
    } else {
      tree.set(s.path, renderFile(model));
    }
  };
}

/** Apply one V4A chunk; returns the cursor just after the written lines. */
function applyChunk(model: FileModel, c: VChunk, cursor: number, path: string, strict: boolean): number {
  if (c.anchor !== null) {
    const tiers = strict ? [0] : [0, 1, 2];
    let at = -1;
    for (const tier of tiers) {
      for (let k = cursor; k < model.lines.length; k += 1) {
        if (lineAtTier(model.lines[k]!, c.anchor, tier)) {
          at = k;
          break;
        }
      }
      if (at >= 0) break;
    }
    if (at < 0) throw new Fail('no-match', path);
    cursor = at + 1;
  }
  const old = c.body.filter((l) => l.kind !== 'new');
  const neu = c.body.filter((l) => l.kind !== 'old');
  if (old.length === 0) {
    const pos = c.eof ? model.lines.length : Math.min(cursor, model.lines.length);
    model.lines.splice(pos, 0, ...neu.map((l) => l.text));
    return pos + neu.length;
  }
  const found = findBlock(model.lines, old, strict, cursor, c.eof);
  if (found === null) throw new Fail('no-match', path);
  const pos = found.positions[0]!;
  const rendered = renderNew(model.lines, pos, old, neu, found.tier);
  model.lines.splice(pos, old.length, ...rendered);
  return pos + rendered.length;
}

// ---------------------------------------------------------------- json

/** Validate one edit object (SPEC section 9); null when it is not one. */
function jsonEditOf(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  const existing = (tree: Tree): string => {
    requireSafe(p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };

  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      requireSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, text);
    };
  }

  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = existing(tree);
      const probe = before.indexOf('\n');
      const crlf = probe > 0 && before[probe - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
      const text = toLf(before);
      const needle = toLf(oldStr);
      let count = 0;
      for (let k = text.indexOf(needle); k >= 0; k = text.indexOf(needle, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = text.indexOf(needle);
      const merged = text.slice(0, at) + toLf(newStr) + text.slice(at + needle.length);
      tree.set(p, crlf ? merged.split('\n').join('\r\n') : merged);
    };
  }

  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const at = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = existing(tree);
      const model = parseFile(before);
      if (at < 0 || at > model.lines.length) throw new Fail('no-match', p);
      model.lines.splice(at, 0, ...add);
      tree.set(p, renderFile(model));
    };
  }

  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    const edits: Edit[] = [];
    for (const item of v) {
      const e = jsonEditOf(item);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    if (edits.length === 0) throw new Exit2('error: parse 1');
    return edits;
  }
  const edits: Edit[] = [];
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEditOf(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------- detection

/** SPEC section 4: the first of the four tests that holds, in order. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart().charAt(0);
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === SR_OPEN)) return 'search-replace';
  const unified = lines.some(
    (l, idx) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ')),
  );
  return unified ? 'unified' : null;
}

// ---------------------------------------------------------------- the run

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

function runCli(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const positional: string[] = [];
  let optionsDone = false;

  for (const a of args) {
    if (!optionsDone && a === '--') {
      optionsDone = true;
    } else if (!optionsDone && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice(9))) {
        format = a.slice(9);
      } else if (a === '--check' && !checkOnly) {
        checkOnly = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };

  const patchArg = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let text: string;
  if (patchArg === null) {
    try {
      text = readFileSync(0, 'utf8');
    } catch {
      text = '';
    }
  } else {
    try {
      text = readFileSync(patchArg, 'utf8');
    } catch {
      return { code: 2, out: ['error: no-patch'] };
    }
  }

  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines);
    else if (kind === 'v4a') edits = parseV4a(lines);
    else edits = parseJson(text, lines);
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.now);
    const moveCount = tree.moves.length;
    try {
      edit(tree, strict);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of snapshot) tree.now.set(k, v);
      tree.moves.length = moveCount;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }

  // Diff the final tree against the original bytes.
  interface Change {
    key: string;
    line: string;
    path: string;
    value: string | null;
  }
  const changes: Change[] = [];
  const deleted = new Map<string, string | null>();
  const added = new Map<string, string | null>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const nowV = tree.now.get(p)!;
    if (was === nowV) continue;
    if (was === null) added.set(p, nowV);
    else if (nowV === null) deleted.set(p, nowV);
    else changes.push({ key: p, line: `M ${p}`, path: p, value: nowV });
  }
  const pairedFrom = new Set<string>();
  const pairedTo = new Set<string>();
  for (const mv of tree.moves) {
    if (pairedFrom.has(mv.from) || pairedTo.has(mv.to)) continue;
    if (!deleted.has(mv.from) || !added.has(mv.to)) continue;
    pairedFrom.add(mv.from);
    pairedTo.add(mv.to);
    changes.push({
      key: mv.to,
      line: `R ${mv.from} -> ${mv.to}`,
      path: mv.to,
      value: added.get(mv.to)!,
    });
  }
  for (const [p, v] of deleted) {
    if (!pairedFrom.has(p)) changes.push({ key: p, line: `D ${p}`, path: p, value: v });
  }
  for (const [p, v] of added) {
    if (!pairedTo.has(p)) changes.push({ key: p, line: `A ${p}`, path: p, value: v });
  }
  changes.sort((x, y) => byteCompare(x.key, y.key));

  if (!checkOnly) {
    for (const c of changes) {
      if (c.line.startsWith('R ')) {
        const from = c.line.slice(2, c.line.indexOf(' -> '));
        rmSync(from, { force: true });
      }
      if (c.value === null) {
        if (!c.line.startsWith('R ')) rmSync(c.path, { force: true });
      } else {
        const dir = dirname(c.path);
        if (dir !== '.') mkdirSync(dir, { recursive: true });
        writeFileSync(c.path, c.value);
      }
    }
  }

  const rows = changes.map((c) => c.line);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

// ---------------------------------------------------------------- entry

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this
  // file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = runCli(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
