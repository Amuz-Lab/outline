import {
  createHtmlPreviewSource,
  MAX_HTML_PREVIEW_BYTES,
} from "./htmlPreviewSource";
import { HtmlPreview } from "./HtmlPreview";
import { EditorState, TextSelection } from "prosemirror-state";
import type { Editor } from "../../../app/editor";
import { schema, parser, serializer } from "../../test/editor";

describe("HTML preview source", () => {
  it("parses a complete page and places a restrictive policy before source content", () => {
    const result = createHtmlPreviewSource(
      "<html><head><title>한글</title></head><body><svg></svg><script>window.x=1</script></body></html>",
      "test-nonce"
    );
    const doc = new DOMParser().parseFromString(result, "text/html");
    expect(doc.title).toBe("한글");
    expect(doc.head.firstElementChild?.getAttribute("http-equiv")).toBe(
      "Content-Security-Policy"
    );
    expect(doc.querySelector("script")?.getAttribute("nonce")).toBe(
      "test-nonce"
    );
    expect(doc.querySelector("svg")).not.toBeNull();
    expect(doc.head.firstElementChild?.getAttribute("content")).toContain(
      "connect-src 'none'"
    );
  });
  it("adds a viewport for responsive previews and reports runtime restrictions", () => {
    const result = createHtmlPreviewSource("<p>responsive</p>", "n", "channel");
    const doc = new DOMParser().parseFromString(result, "text/html");
    expect(
      doc.querySelector('meta[name="viewport"]')?.getAttribute("content")
    ).toBe("width=device-width, initial-scale=1");
    expect(result).toContain("outline-html-diagnostic");
    expect(result).toContain("securitypolicyviolation");
  });
  it("preserves an existing viewport setting", () => {
    const result = createHtmlPreviewSource(
      '<meta name="viewport" content="width=900">',
      "n"
    );
    const doc = new DOMParser().parseFromString(result, "text/html");
    expect(doc.querySelectorAll('meta[name="viewport"]')).toHaveLength(1);
    expect(
      doc.querySelector('meta[name="viewport"]')?.getAttribute("content")
    ).toBe("width=900");
  });
  it("leaves external scripts to the frame policy and removes redirects and base elements", () => {
    const result = createHtmlPreviewSource(
      '<base href="https://example.com"><meta http-equiv="refresh" content="0;url=https://example.com"><script src="https://example.com/a.js"></script><p>retained</p>',
      "n"
    );
    const doc = new DOMParser().parseFromString(result, "text/html");
    expect(doc.querySelector("script[src]")).not.toBeNull();
    expect(doc.querySelector("base, meta[http-equiv=refresh]")).toBeNull();
    expect(doc.head.firstElementChild?.getAttribute("content")).toContain(
      "script-src 'unsafe-inline'"
    );
    expect(doc.body.textContent).toContain("retained");
  });
  it("preserves literal closing tags and backticks without injecting into the parent", () => {
    const result = createHtmlPreviewSource(
      "<pre>``` &lt;/iframe&gt;</pre>",
      "n"
    );
    const doc = new DOMParser().parseFromString(result, "text/html");
    expect(doc.querySelector("pre")?.textContent).toBe("``` </iframe>");
  });
  it("enforces a UTF-8 byte limit", () => {
    expect(() =>
      createHtmlPreviewSource("가".repeat(MAX_HTML_PREVIEW_BYTES / 3 + 1), "n")
    ).toThrow("1 MiB");
  });
  it("round trips HTML source through Markdown with embedded backticks", () => {
    const source = "<html>\n<body><pre>``` example</pre></body>\n</html>\n";
    const doc = schema.node("doc", null, [
      schema.node(
        "code_fence",
        { language: "html-preview" },
        schema.text(source)
      ),
    ]);
    const markdown = serializer.serialize(doc);
    const restored = parser.parse(markdown)?.firstChild;
    expect(restored?.attrs.language).toBe("html-preview");
    expect(restored?.textContent).toBe(source.replace(/\n$/, ""));
  });
  it("persists customized preview width and height in the fence", () => {
    const doc = schema.node("doc", null, [
      schema.node(
        "code_fence",
        { language: "html-preview", previewWidth: 75, previewHeight: 650 },
        schema.text("<p>Preview</p>")
      ),
    ]);
    const markdown = serializer.serialize(doc);
    const restored = parser.parse(markdown)?.firstChild;

    expect(markdown).toContain("html-preview width=75 height=650");
    expect(restored?.attrs.previewWidth).toBe(75);
    expect(restored?.attrs.previewHeight).toBe(650);
  });
  it("recreates preview controls when saved dimensions change", () => {
    const plugin = HtmlPreview({ props: { readOnly: false } } as Editor);
    const doc = schema.node("doc", null, [
      schema.node(
        "code_fence",
        { language: "html-preview" },
        schema.text("<p>Preview</p>")
      ),
      schema.node("paragraph"),
    ]);
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, doc.firstChild!.nodeSize + 1),
      plugins: [plugin],
    });
    const widgetKey = (current: EditorState) =>
      plugin
        .getState(current)
        ?.decorations.find()
        .find((decoration) => decoration.spec.key?.startsWith("html-preview"))
        ?.spec.key;

    const resized = state.apply(
      state.tr.setNodeMarkup(0, undefined, {
        ...doc.firstChild?.attrs,
        previewWidth: 90,
      })
    );

    expect(widgetKey(resized)).not.toBe(widgetKey(state));
  });
  it("recreates preview widgets when editing completes", () => {
    const props = { readOnly: false };
    const plugin = HtmlPreview({ props } as Editor);
    const doc = schema.node("doc", null, [
      schema.node(
        "code_fence",
        { language: "html-preview" },
        schema.text("<p>Preview</p>")
      ),
    ]);
    const state = EditorState.create({ schema, doc, plugins: [plugin] });
    const widgetKey = (current: EditorState) =>
      plugin
        .getState(current)!
        .decorations.find()
        .find((decoration) => decoration.spec.key)?.spec.key;
    const editableKey = widgetKey(state);

    props.readOnly = true;
    const completed = state.apply(state.tr.setMeta(plugin, null));

    expect(widgetKey(completed)).not.toBe(editableKey);
  });
  it("does not reopen source when undo restores preview dimensions", () => {
    const plugin = HtmlPreview({ props: { readOnly: false } } as Editor);
    const doc = schema.node("doc", null, [
      schema.node(
        "code_fence",
        { language: "html-preview" },
        schema.text("<p>Preview</p>")
      ),
    ]);
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 1),
      plugins: [plugin],
    });
    const resized = state.apply(
      state.tr
        .setNodeMarkup(0, undefined, {
          ...doc.firstChild!.attrs,
          previewWidth: 90,
        })
        .setMeta(plugin, null)
    );
    const undone = resized.apply(
      resized.tr.setNodeMarkup(0, undefined, doc.firstChild!.attrs)
    );

    expect(plugin.getState(resized)?.editingPos).toBeNull();
    expect(plugin.getState(undone)?.editingPos).toBeNull();
  });
});
