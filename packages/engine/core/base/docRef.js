// A pointer to one section of the docs: one spelling, one formatter, one parser. Why one: error codes, check hints, describe() pointers and threedog how
// each built their own ("#anchor", "§1b", "\"Post effect chain\""), so an AI saw three shapes and the tools could not read them all back; now all go through
// here, and `threedog how --read <pointer>` prints the section for any of them.
// Spelling: `recipes/34-environment-lighting.md §"Light you can see in the air"` (the heading as written, so a text search finds it; a " or \ in it is
// written \" or \\ and read back as itself), or only the number when the heading starts with one, `recipes/62-picture-code.md §3b` (shorter, and it
// survives a reworded heading). The file alone means its card (the top of the page).
// The command that prints a section uses the #anchor form (docReadCommand): an anchor holds only letters, digits, - and _, so it needs no quotes in bash
// or PowerShell, where a heading with an apostrophe (`NPCs don't clump`) or a quote would break any quoting.
// Plain data, no imports: the browser (warnings) and the node tools (how, check) both load it.

/** GitHub-style heading anchor: "4b. Third-person action" -> "4b-third-person-action" (letters of any script kept) @param {string} h */
export const docSlug = h => h.trim().toLowerCase().replace(/[`*]/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');

/** The pointer to a section; no heading = the whole page (its card). @param {string} file path under docs/, e.g. recipes/34-x.md  @param {string} [heading] the heading as written */
export function docRef(file, heading) {
  if (!heading) return file;
  const num = /^(\d+[a-z]?)\.\s/.exec(heading);
  return `${file} §${num ? num[1] : `"${heading.replace(/[\\"]/g, c => '\\' + c)}"`}`;
}

// the whole input or nothing: a path, then at most one selector that parses completely (§number, §"heading" with \" \\ escapes, #anchor, or the
// older bare "heading"); `§1.2`, `§不存在` or a stray tail is no pointer, so a typo is reported instead of reading as the whole page
const REF = /^\s*([^\s#§"]+\.md)\s*(?:§(\d+[a-z]?)|§"((?:\\.|[^"\\])+)"|#([\p{L}\p{N}_-]+)|"((?:\\.|[^"\\])+)")?\s*$/u;
const unescape = s => s.replace(/\\(.)/g, '$1');

/** One pointer read back: { file, sec?: number, title?: start of the heading, anchor?: #anchor }, or null when any part of it does not parse. @param {string} ref */
export function parseDocRef(ref) {
  const m = REF.exec(String(ref));
  if (!m) return null;
  const title = m[3] ?? m[5];
  return { file: m[1], ...(m[2] ? { sec: m[2] } : {}), ...(title ? { title: unescape(title) } : {}), ...(m[4] ? { anchor: m[4] } : {}) };
}

/**
 * The shell command that prints a section in full, safe to paste in bash and PowerShell: the #anchor form, no quotes. A section number becomes `#3b`
 * and a heading its anchor (`#light-you-can-see-in-the-air`); --read takes an anchor that starts the heading's anchor, so a heading start is enough.
 * @param {string} ref any pointer parseDocRef reads; '' when it does not parse
 */
export function docReadCommand(ref) {
  const r = parseDocRef(ref);
  if (!r) return '';
  const a = r.sec ?? (r.title ? docSlug(r.title) : r.anchor);
  return `threedog how --read ${r.file}${a ? '#' + a : ''} --full`;
}

/** Pointers printed as one line, with the command that prints the first one: the AI need not open a whole page to find the section. @param {string[]} refs */
export function docRefsLine(refs) {
  if (!refs?.length) return '';
  const cmd = docReadCommand(refs[0]);
  return `${refs.join(', ')}${cmd ? ` (${cmd})` : ''}`;
}
