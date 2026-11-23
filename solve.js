// A faster drop-in for makefun-site 1.0.0: run(input) returns exactly the answer
// makefun-site 1.0.0's build returns for the same input, byte for byte.
//
// Written from the reference's stated semantics (its README) and its code, in my own
// words and structure. Nothing is copied from the vendor files: the pipeline is
// re-implemented with faster algorithms — chunked inline scanning instead of a
// per-character escape, a fused lex-and-render Markdown pass, memoised slugs and
// dates, cached link resolution, and cards computed once per source.
//
// Every case is answered alone: all caches live in one per-run context object
// created fresh by run() and dropped with it.

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The HTML escape table. */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_ALL = /[&<>"']/g;

/** `text` with & < > " and ' escaped. Fast when nothing needs escaping. */
function escapeHtml(text) {
  if (!ESCAPE_TEST.test(text)) return text;
  return text.replace(ESCAPE_ALL, (c) => ESCAPES[c]);
}

/** Whether code unit `c` is whitespace in the JavaScript \s sense. */
function isSpaceCode(c) {
  return (
    c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 || c === 160 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff
  );
}

/** The words of a body: its runs of characters other than whitespace. */
/** Whitespace code units below 128 (the JavaScript \s set's ASCII members). */
const WS_ASCII = new Uint8Array(128);
for (const c of [9, 10, 11, 12, 13, 32]) WS_ASCII[c] = 1;

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let sp;
    if (c < 128) sp = WS_ASCII[c] === 1;
    else {
      sp = c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
        c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    }
    if (sp) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/** The slug of `text`, exactly as makefun-site defines it (slow path: any non-ASCII). */
function slugifySlow(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** The slug of `text`, memoised per case; ASCII text skips normalisation entirely. */
function slugify(text, ctx) {
  const hit = ctx.slugCache.get(text);
  if (hit !== undefined) return hit;
  let out;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) {
      ascii = false;
      break;
    }
  }
  if (ascii) {
    out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
    out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
    if (out === '') out = 'untitled';
  } else {
    out = slugifySlow(text);
  }
  ctx.slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone, memoised per case. */
function longDate(date, ctx) {
  let v = ctx.dateCache.get(date);
  if (v === undefined) {
    const [y, m, d] = date.split('-');
    v = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
    ctx.dateCache.set(date, v);
  }
  return v;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** Whether `line` holds only spaces and tabs. */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A string value: "..." with \" and \\ its only escapes, or a bare string. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** Whether every character of `s` is a digit. */
function allDigits(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return s.length > 0;
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = false;
      let y = 0;
      let mo = 0;
      let d = 0;
      if (
        raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45 &&
        allDigits(raw.slice(0, 4)) && allDigits(raw.slice(5, 7)) && allDigits(raw.slice(8, 10))
      ) {
        y = Number(raw.slice(0, 4));
        mo = Number(raw.slice(5, 7));
        d = Number(raw.slice(8, 10));
        ok = y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
        return { error: 'key "tags": not a list [a, b]' };
      }
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length > 0 && raw.length <= 64;
      let prevDash = true; // a slug may not open on "-"
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else if (c === 45 && !prevDash) prevDash = true;
        else ok = false;
      }
      if (prevDash) ok = false; // may not close on "-" either
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason
 * it is refused. `text` has "\n" line ends. Lines are scanned by index, never split.
 */
function parseFrontMatter(text) {
  let nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first !== '---') return { error: 'no front matter' };
  // Find the closing line: the first line after the opener that is exactly "---".
  let pos = nl === -1 ? text.length : nl + 1;
  let closeStart = -1;
  let closeEnd = -1;
  while (pos < text.length) {
    const eol = text.indexOf('\n', pos);
    const lineEnd = eol === -1 ? text.length : eol;
    if (lineEnd - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closeStart = pos;
      closeEnd = eol === -1 ? text.length : eol + 1;
      break;
    }
    if (eol === -1) break;
    pos = eol + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let p = nl === -1 ? text.length : nl + 1;
  let lineNo = 1;
  while (p < closeStart) {
    const eol = text.indexOf('\n', p);
    const lineEnd = eol === -1 ? text.length : eol;
    const line = text.slice(p, lineEnd);
    lineNo++;
    if (!isBlankLine(line) && line.charCodeAt(0) !== 35) {
      // The line must read "key: value": a key of a-z and _, a colon, one space, a value.
      const colon = line.indexOf(':');
      let key = null;
      let raw = null;
      if (colon > 0) {
        let keyOk = true;
        for (let i = 0; i < colon; i++) {
          const c = line.charCodeAt(i);
          if (!((c >= 97 && c <= 122) || c === 95)) {
            keyOk = false;
            break;
          }
        }
        if (keyOk) {
          key = line.slice(0, colon);
          if (colon + 1 === line.length) raw = '';
          else if (line.charCodeAt(colon + 1) === 32) raw = line.slice(colon + 2);
        }
      }
      if (key === null || raw === null) return { error: `line ${lineNo} is not "key: value"` };
      // Trailing spaces and tabs of the value are dropped.
      let rEnd = raw.length;
      while (rEnd > 0) {
        const c = raw.charCodeAt(rEnd - 1);
        if (c !== 32 && c !== 9) break;
        rEnd--;
      }
      raw = raw.slice(0, rEnd);
      if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (eol === -1) break;
    p = eol + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- Markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** A line with its spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** Whether `line` is a fence opener; returns its language, or null. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45)) break;
    i++;
  }
  const langEnd = i;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  if (i !== line.length) return null;
  return line.slice(3, langEnd);
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 35) k++;
  if (k === 0 || k > 6) return null;
  let j = k;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  if (j === k) return null;
  let end = line.length;
  while (end > j && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  if (end === j) return null;
  return { depth: k, text: line.slice(j, end) };
}

/** Whether `line` is a thematic break: `---` or `***`, then spaces or tabs only. */
function isHr(line) {
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  if (line.charCodeAt(1) !== c || line.charCodeAt(2) !== c) return false;
  for (let i = 3; i < line.length; i++) {
    const d = line.charCodeAt(i);
    if (d !== 32 && d !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a break. */
function endsParagraph(line) {
  const c0 = line.length === 0 ? -1 : line.charCodeAt(0);
  if (c0 === -1) return true;
  if (c0 === 32 || c0 === 9) return isBlankLine(line);
  if (c0 === 96) return fenceOpen(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHr(line);
  return false;
}

/** Whether `line` opens a bullet item; returns its text, or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** Whether `line` opens an ordered item; returns [number, text], or null. */
function orderedOf(line) {
  let d = 0;
  while (d < line.length && d < 9) {
    const c = line.charCodeAt(d);
    if (c < 48 || c > 57) break;
    d++;
  }
  if (d === 0) return null;
  if (d === 9 && line.charCodeAt(9) >= 48 && line.charCodeAt(9) <= 57) return null; // 10 digits or more
  if (line.charCodeAt(d) !== 46 || line.charCodeAt(d + 1) !== 32) return null;
  return [Number(line.slice(0, d)), line.slice(d + 2)];
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 2;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i < line.length && !isSpaceCode(line.charCodeAt(i));
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Whether `s` holds whitespace (the link target test). */
const HAS_WS = /\s/;

/** The characters inline rendering stops at: backslash escapes, code spans, strong, emphasis, links and the HTML escape table. */
const INLINE_SPECIAL = /[\\`*\[&<>"']/g;

/** `s` rendered inline; `env.link(target)` is a link's href. Plain runs between the
 * characters above hold nothing that needs escaping, so they are copied verbatim. */
function inline(s, env) {
  let out = '';
  let i = 0;
  INLINE_SPECIAL.lastIndex = 0;
  let m;
  while ((m = INLINE_SPECIAL.exec(s)) !== null) {
    const j = m.index;
    const c = m[0];
    if (c === '\\') {
      if (j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
        if (j > i) out += s.slice(i, j);
        out += s[j + 1];
        i = j + 2;
        INLINE_SPECIAL.lastIndex = i;
      } else INLINE_SPECIAL.lastIndex = j + 1;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > i) out += s.slice(i, j);
        out += `<code>${escapeHtml(s.slice(j + 1, k))}</code>`;
        i = k + 1;
        INLINE_SPECIAL.lastIndex = i;
      } else INLINE_SPECIAL.lastIndex = j + 1;
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (j > i) out += s.slice(i, j);
          out += `<strong>${inline(s.slice(j + 2, k), env)}</strong>`;
          i = k + 2;
          INLINE_SPECIAL.lastIndex = i;
        } else INLINE_SPECIAL.lastIndex = j + 2;
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        if (j > i) out += s.slice(i, j);
        out += `<em>${inline(s.slice(j + 1, k), env)}</em>`;
        i = k + 1;
        INLINE_SPECIAL.lastIndex = i;
      } else INLINE_SPECIAL.lastIndex = j + 1;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', j + 1);
      const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !HAS_WS.test(target)) {
        if (j > i) out += s.slice(i, j);
        out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(j + 1, k), env)}</a>`;
        i = mm + 1;
        INLINE_SPECIAL.lastIndex = i;
      } else INLINE_SPECIAL.lastIndex = j + 1;
      continue;
    }
    if (j > i) out += s.slice(i, j);
    out += ESCAPES[c];
    i = j + 1;
    INLINE_SPECIAL.lastIndex = i;
  }
  if (i < s.length) out += s.slice(i);
  return out;
}

/**
 * `src` rendered in one pass: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading: level, id and its inline
 * HTML) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env, ctx) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const len = lines.length;
  while (i < len) {
    const line = lines[i];
    const c0 = line.length === 0 ? -1 : line.charCodeAt(0);
    if (c0 === -1 || c0 === 32 || c0 === 9) {
      if (isBlankLine(line)) {
        i++;
        continue;
      }
    } else if (c0 === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < len && !fenceClose(lines[i])) body.push(lines[i++]);
        i++;
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        let code = '';
        for (const l of body) {
          code += escapeHtml(l);
          code += '\n';
        }
        blocks.push(`<pre><code${cls}>${code}</code></pre>\n`);
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text, ctx), ids);
        const html = inline(heading.text, env);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        blocks.push('<hr>\n');
        i++;
        continue;
      }
      const bulletText = bulletOf(line);
      if (bulletText !== null) {
        const items = [];
        while (i < len) {
          const b = bulletOf(lines[i]);
          if (b !== null) {
            items.push([trimLine(b)]);
            i++;
          } else if (isContinued(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        let list = '<ul>\n';
        for (const parts of items) list += `<li>${inline(parts.join('\n'), env)}</li>\n`;
        blocks.push(`${list}</ul>\n`);
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < len && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const ordered = orderedOf(line);
      if (ordered !== null) {
        const items = [];
        while (i < len) {
          const m = orderedOf(lines[i]);
          if (m !== null) {
            items.push([trimLine(m[1])]);
            i++;
          } else if (isContinued(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        const open = ordered[0] !== 1 ? `<ol start="${ordered[0]}">` : '<ol>';
        let list = `${open}\n`;
        for (const parts of items) list += `<li>${inline(parts.join('\n'), env)}</li>\n`;
        blocks.push(`${list}</ol>\n`);
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < len && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone =
      isBlankLine(src.slice(lineStart, open)) && isBlankLine(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the flat scope: its first name is the innermost binding
 * (a flat scope overlays each enclosing loop's bindings, innermost last), then each
 * next name is an own property of the value so far, or the path is undefined. */
function lookup(scope, path) {
  if (!Object.hasOwn(scope, path[0])) return undefined;
  let v = scope[path[0]];
  if (path.length === 1) return v;
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[1])) return undefined;
  v = v[path[1]];
  if (path.length === 2) return v;
  for (let k = 2; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Whether the path `path` reads only case-invariant values under `bound` (a Map of
 * the names a for has bound, each to whether what it bound is invariant). */
function pathInvariant(path, bound) {
  const first = path[0];
  if (bound.has(first)) return bound.get(first);
  return first === 'site' || first === 'tags' || first === 'recent';
}

/**
 * Whether template `name` renders the same output in every scope of this case, given
 * the bound names `bound`: it reads only site, tags and recent, or values a for over
 * one of those bound. Computed over the parsed trees, transitively through includes;
 * a cycle back to a template already being analysed contributes nothing new. Results
 * are memoised per case.
 */
function analyzeInvariant(ctx, name, bound, analyzing) {
  const sig = `${name}\n${[...bound.entries()].map(([k, v]) => `${k}=${v ? 1 : 0}`).sort().join(',')}`;
  const hit = ctx.invariantMemo.get(sig);
  if (hit !== undefined) return hit;
  if (analyzing.has(sig)) return true;
  const nodes = ctx.templates.get(name);
  if (nodes === undefined) return true;
  analyzing.add(sig);
  const ok = analyzeNodes(ctx, nodes, bound, analyzing);
  analyzing.delete(sig);
  ctx.invariantMemo.set(sig, ok);
  return ok;
}

function analyzeNodes(ctx, nodes, bound, analyzing) {
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        break;
      case 'var':
      case 'raw':
        if (!pathInvariant(node.path, bound)) return false;
        break;
      case 'if':
        if (!pathInvariant(node.path, bound)) return false;
        if (!analyzeNodes(ctx, node.then, bound, analyzing)) return false;
        if (node.else !== null && !analyzeNodes(ctx, node.else, bound, analyzing)) return false;
        break;
      case 'for': {
        if (!pathInvariant(node.path, bound)) return false;
        const inner = new Map(bound);
        inner.set(node.name, true);
        inner.set('loop', true);
        if (!analyzeNodes(ctx, node.body, inner, analyzing)) return false;
        break;
      }
      case 'include':
        if (!analyzeInvariant(ctx, node.name, bound, analyzing)) return false;
        break;
    }
  }
  return true;
}

/** `nodes` rendered in the flat `scope`, appended to `out`. */
function renderNodes(nodes, scope, ctx, depth, out, inLoop) {
  for (let n = 0; n < nodes.length; n++) {
    const node = nodes[n];
    switch (node.kind) {
      case 'text':
        out.push(node.text);
        break;
      case 'var':
        out.push(ctx.escape(textOf(lookup(scope, node.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, node.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, node.path));
        const branch = v !== node.not ? node.then : node.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out, inLoop);
        break;
      }
      case 'for': {
        const xs = lookup(scope, node.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const inner = {
            ...scope,
            [node.name]: xs[k],
            loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length },
          };
          renderNodes(node.body, inner, ctx, depth, out, true);
        }
        break;
      }
      case 'include': {
        if (!inLoop && ctx.invariant.has(node.name)) {
          const key = `${node.name}\n${depth + 1}`;
          let s = ctx.memo.get(key);
          if (s === undefined) {
            const out2 = [];
            renderNodes(ctx.templates.get(node.name), scope, ctx, depth + 1, out2, false);
            s = out2.join('');
            ctx.memo.set(key, s);
          }
          out.push(s);
          break;
        }
        const t = ctx.templates.get(node.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out, inLoop);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A page's link record as templates read it. */
function linkOf(s, ctx) {
  return s === null
    ? null
    : {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date, ctx),
      };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const ctx = {
    slugCache: new Map(),
    dateCache: new Map(),
    linkCache: new Map(),
    templates: null,
    invariantMemo: new Map(),
    invariant: new Set(),
    memo: new Map(),
    escape: escapeHtml,
  };

  // Templates, parsed in code-unit order of their name; one that does not parse
  // is reported and left out.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  ctx.templates = templates;
  for (const name of templates.keys()) {
    if (analyzeInvariant(ctx, name, new Map(), new Set())) ctx.invariant.add(name);
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.text = null;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, ctx), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const urlOfPath = new Map();
  for (const s of kept) urlOfPath.set(s.path, s.url);
  for (const f of statics) if (!urlOfPath.has(f.path)) urlOfPath.set(f.path, `${base}/${f.path}`);
  const broken = new Set();
  const schemeRe = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (schemeRe.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const key = `${dir}\n${rel}`;
      let path = ctx.linkCache.get(key);
      if (path === undefined) {
        path = rel === '' ? null : resolvePath(dir, rel);
        ctx.linkCache.set(key, path);
      }
      if (path !== null) {
        const url = urlOfPath.get(path);
        if (url !== undefined) return `${url}${frag}`;
      }
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, { link }, ctx);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order.
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, ctx);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, ctx);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name, ctx);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  // A card per source, computed once and shared wherever the source is listed.
  for (const s of kept) {
    s.card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date, ctx),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  }
  const cards = new Map(posts.map((p) => [p, p.card]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, scope) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, scope, ctx, 0, out, false);
    return out.join('');
  };
  for (const s of kept) {
    output[`${s.outDir}/index.html`] = render(s.layout, {
      site,
      tags: allTags,
      recent,
      page: {
        ...s.card,
        slug: s.slug,
        content: s.html,
        toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
        newer: linkOf(s.newer ?? null, ctx),
        older: linkOf(s.older ?? null, ctx),
        is_post: s.post,
      },
    });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      site,
      tags: allTags,
      recent,
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      site,
      tags: allTags,
      recent,
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', { site, tags: allTags, recent });
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
