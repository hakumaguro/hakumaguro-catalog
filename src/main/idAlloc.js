// Id allocation — SPEC.md §6. New entries always get max-existing-number+1
// within their prefix; deleted numbers are never reused or reflowed.

function nextId(existingIds, idPrefix) {
  let max = 0;
  const re = new RegExp("^" + idPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "-(\\d+)$");
  for (const id of existingIds) {
    const m = re.exec(id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${idPrefix}-${max + 1}`;
}

module.exports = { nextId };
