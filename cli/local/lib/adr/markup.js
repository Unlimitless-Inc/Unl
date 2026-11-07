"use strict";
/*
 * Decision records written in reStructuredText, made readable as the markdown the reader knows.
 *
 * WHY. Python projects keep their records as .rst files because their documentation is built from
 * it. The records say the same things in the same order as any other ADR: a title, a status, the
 * context, the decision, the consequences. Only the punctuation differs, so the punctuation is
 * translated and the one reader does the rest. Nothing is reworded.
 *
 * WHAT IS TRANSLATED. Titles and section headings (a line of words with a line of punctuation under
 * it), links, the field list some records open with (":Status: Accepted"), and inline code. A
 * directive or a comment is not part of what the record says, so its marker line is left out.
 *
 * Pure. Text in, text out.
 */

const UNDERLINE = /^([=\-~^"'`#*+.:_])\1{2,}\s*$/;

/** reStructuredText, as markdown the reader can read. Line count is kept, so line numbers still point at the source. */
function rstToMarkdown(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  // Links can be named in one place and given their address in another (".. _Name: address").
  const named = new Map();
  for (const l of lines) {
    const m = l.match(/^\s*\.\.\s+_`?([^`:]+)`?:\s+(\S+)\s*$/);
    if (m) named.set(m[1].trim().toLowerCase(), m[2]);
  }
  const out = [];
  const levels = [];
  const levelOf = (style) => {
    let at = levels.indexOf(style);
    if (at < 0) { levels.push(style); at = levels.length - 1; }
    return Math.min(at + 1, 6);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    const after = lines[i + 2];
    // A title with a line above and below it.
    if (UNDERLINE.test(line) && next !== undefined && next.trim() && !UNDERLINE.test(next) && after !== undefined && UNDERLINE.test(after) && after.trim()[0] === line.trim()[0]) {
      out.push("", `${"#".repeat(levelOf(`over:${line.trim()[0]}`))} ${next.trim()}`, "");
      i += 2;
      continue;
    }
    // A heading with a line under it. The line above a heading is blank or the start of the file.
    if (line.trim() && !UNDERLINE.test(line) && next !== undefined && UNDERLINE.test(next) && !/^\s/.test(line) && (i === 0 || !lines[i - 1].trim() || UNDERLINE.test(lines[i - 1]))) {
      out.push(`${"#".repeat(levelOf(`under:${next.trim()[0]}`))} ${line.trim()}`, "");
      i += 1;
      continue;
    }
    // A directive, a comment or a link target: its own line says nothing the record says.
    if (/^\s*\.\.\s+(?:[\w-]+::|_[^:]*:|\[[^\]]*\])/.test(line) || /^\s*\.\.\s*$/.test(line)) { out.push(""); continue; }
    out.push(
      line
        .replace(/^:([A-Za-z][A-Za-z -]{1,28}):\s*(.*)$/, "$1: $2")
        .replace(/:(?:doc|ref|download|any):`([^`<]+?)\s*<([^>]+)>`/g, "[$1]($2)")
        .replace(/:(?:doc|ref|download|any):`([^`]+)`/g, "[$1]($1)")
        .replace(/`([^`<]+?)\s*<([^>]+)>`__?/g, "[$1]($2)")
        .replace(/:[a-z:]+:`([^`]+)`/g, "`$1`")
        .replace(/``([^`]+)``/g, "`$1`")
        .replace(/`([^`]+)`__?(?=$|[\s.,;:)])/g, (m, name) => (named.has(name.trim().toLowerCase()) ? `[${name}](${named.get(name.trim().toLowerCase())})` : name)),
    );
  }
  return out.join("\n");
}

/** The text of a record as markdown, whatever it was written in. */
function toMarkdown(text, file = "") {
  return /\.rst$/i.test(String(file)) ? rstToMarkdown(text) : String(text || "");
}

module.exports = { toMarkdown, rstToMarkdown };
