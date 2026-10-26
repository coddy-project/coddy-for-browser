// A small Markdown renderer for the side panel's answers. It builds DOM nodes
// and never parses HTML, so nothing an answer or a page put into it can run:
// paragraphs, headings, lists, fenced code, inline code, bold and links to
// http(s) addresses. Everything else stays text.

function inline(text, doc) {
  const out = [];
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) out.push(doc.createTextNode(text.slice(last, m.index)));
    if (m[1]) {
      const code = doc.createElement("code");
      code.textContent = m[1].slice(1, -1);
      out.push(code);
    } else if (m[2]) {
      const b = doc.createElement("strong");
      b.textContent = m[2].slice(2, -2);
      out.push(b);
    } else {
      const a = doc.createElement("a");
      a.textContent = m[3].slice(1, m[3].indexOf("]"));
      a.href = m[4];
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      out.push(a);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(doc.createTextNode(text.slice(last)));
  return out;
}

// render turns Markdown into a fragment of document doc.
export function render(markdown, doc = document) {
  const root = doc.createDocumentFragment();
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let paragraph = [];
  const flush = () => {
    if (!paragraph.length) return;
    const p = doc.createElement("p");
    paragraph.forEach((line, n) => {
      if (n) p.append(doc.createElement("br"));
      p.append(...inline(line, doc));
    });
    root.append(p);
    paragraph = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush();
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      const pre = doc.createElement("pre");
      const code = doc.createElement("code");
      code.textContent = body.join("\n");
      pre.append(code);
      root.append(pre);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const h = doc.createElement("p");
      const b = doc.createElement("strong");
      b.append(...inline(heading[2], doc));
      h.append(b);
      root.append(h);
      i++;
      continue;
    }
    const item = /^\s*([-*]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[1]);
      const list = doc.createElement(ordered ? "ol" : "ul");
      while (i < lines.length) {
        const m = /^\s*([-*]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!m || /\d/.test(m[1]) !== ordered) break;
        const li = doc.createElement("li");
        li.append(...inline(m[2], doc));
        list.append(li);
        i++;
      }
      root.append(list);
      continue;
    }
    if (!line.trim()) flush();
    else paragraph.push(line);
    i++;
  }
  flush();
  return root;
}
