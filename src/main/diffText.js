// Turns two full-file texts into a compact, line-numbered diff for the
// Review & Apply screen — real diff of what previewArrayOps/previewFixedSlotOps
// computed, not a text summary (SPEC.md §4.3). Long unchanged runs are
// collapsed to keep the panel scannable.

const { diffLines } = require("diff");

const CONTEXT = 2;

function toRows(before, after) {
  const chunks = diffLines(before, after);
  let beforeLine = 0;
  let afterLine = 0;
  const rows = [];

  for (const chunk of chunks) {
    const lines = chunk.value.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    for (const text of lines) {
      if (chunk.added) {
        afterLine++;
        rows.push({ n: afterLine, mark: "+", text });
      } else if (chunk.removed) {
        beforeLine++;
        rows.push({ n: beforeLine, mark: "-", text });
      } else {
        beforeLine++;
        afterLine++;
        rows.push({ n: afterLine, mark: " ", text });
      }
    }
  }
  return rows;
}

/** Collapses runs of >2*CONTEXT unchanged rows down to CONTEXT on each side + a "…" marker. */
function collapseContext(rows) {
  const out = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].mark !== " ") {
      out.push(rows[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j].mark === " ") j++;
    const runLength = j - i;
    if (runLength <= CONTEXT * 2) {
      for (let k = i; k < j; k++) out.push(rows[k]);
    } else {
      const leading = out.length > 0 ? CONTEXT : 0;
      for (let k = i; k < i + leading; k++) out.push(rows[k]);
      out.push({ n: null, mark: "…", text: `${runLength - leading - CONTEXT} unchanged lines` });
      const trailing = j < rows.length ? CONTEXT : 0;
      for (let k = j - trailing; k < j; k++) out.push(rows[k]);
    }
    i = j;
  }
  return out;
}

function diffSummary(before, after) {
  const rows = collapseContext(toRows(before, after));
  const additions = rows.filter((r) => r.mark === "+").length;
  const deletions = rows.filter((r) => r.mark === "-").length;
  return { rows, additions, deletions };
}

module.exports = { diffSummary };
