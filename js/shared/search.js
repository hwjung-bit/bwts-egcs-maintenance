// Free-text search shared by the mail and repairs tabs.
// Whitespace splits the query into terms; every term must appear somewhere
// in the joined fields (AND), case-insensitive. "KMU 검교정" finds rows that
// mention both, in any field.
export function matchQuery(q, ...fields) {
  const terms = (q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const txt = fields.map(f => (f == null ? '' : String(f))).join(' ').toLowerCase();
  return terms.every(t => txt.indexOf(t) >= 0);
}
