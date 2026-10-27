// What changed in a version, from CHANGELOG.md: the release on GitHub shows
// the section of its version as Markdown, addons.mozilla.org as plain text.

// changelogSection is the body of the "## <version>" section, or "" when the
// changelog has none.
export function changelogSection(text, version) {
  const lines = String(text || "").split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##? /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
}

// plainText is a section as addons.mozilla.org shows release notes, which
// renders no Markdown: no code marks or emphasis, a link as its text and
// address, and a list item's wrapped lines joined back into one.
export function plainText(md) {
  return String(md || "")
    .replace(/\n {2,}(?=\S)/g, " ")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, "$1$2")
    .trim();
}
