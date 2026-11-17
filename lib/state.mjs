export function cleanState(state, { favs, notes }) {
  const keep = new Set([...(favs?.videos || []).map((v) => v.bvid), ...Object.keys(notes)]);
  const next = {}, removed = [], repaired = [];
  for (const [bvid, entry] of Object.entries(state)) {
    if (!keep.has(bvid)) { removed.push(bvid); continue; }
    const note = notes[bvid];
    if (note && (entry.status !== "written" || entry.note !== note.path)) {
      next[bvid] = { ...entry, status: "written", note: note.path };
      repaired.push(bvid);
    } else next[bvid] = entry;
  }
  return { state: next, removed, repaired };
}
