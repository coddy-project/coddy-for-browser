import test from "node:test";
import assert from "node:assert/strict";
import { render } from "../src/md.js";

// A document just big enough for the renderer: elements, text nodes and a
// fragment, serialized back to markup to compare. Text is escaped the way a
// browser would show it, so markup in an answer can only ever be text.
function fakeDocument() {
  const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const node = (tag) => ({
    tag,
    attrs: {},
    children: [],
    append(...nodes) {
      this.children.push(...nodes);
    },
    set textContent(t) {
      this.children = [{ text: String(t) }];
    },
    set href(v) {
      this.attrs.href = v;
    },
    set target(v) {
      this.attrs.target = v;
    },
    set rel(v) {
      this.attrs.rel = v;
    },
    html() {
      const inner = this.children.map((c) => (c.text !== undefined ? escape(c.text) : c.html())).join("");
      if (!this.tag) return inner;
      const attrs = Object.entries(this.attrs).map(([k, v]) => ` ${k}="${v}"`).join("");
      return this.tag === "br" ? "<br>" : `<${this.tag}${attrs}>${inner}</${this.tag}>`;
    },
  });
  return {
    createElement: (tag) => node(tag),
    createTextNode: (text) => ({ text }),
    createDocumentFragment: () => node(""),
  };
}

const html = (md) => render(md, fakeDocument()).html();

test("paragraphs, bold, inline code and safe links", () => {
  assert.equal(
    html("Open **the page** and run `make`.\nSee [docs](https://coddy.dev/docs)."),
    '<p>Open <strong>the page</strong> and run <code>make</code>.<br>See <a href="https://coddy.dev/docs" target="_blank" rel="noopener noreferrer">docs</a>.</p>',
  );
});

test("a link that is not http(s) and markup stay text", () => {
  assert.equal(html("[x](javascript:alert(1)) <img src=x onerror=alert(1)>"), "<p>[x](javascript:alert(1)) &lt;img src=x onerror=alert(1)&gt;</p>");
});

test("lists, headings and fenced code", () => {
  assert.equal(html("# Title\n- one\n- two\n1. first\n```\n<b>raw</b>\n```"),
    "<p><strong>Title</strong></p><ul><li>one</li><li>two</li></ul><ol><li>first</li></ol><pre><code>&lt;b&gt;raw&lt;/b&gt;</code></pre>");
});
