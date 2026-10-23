import { Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { history, undo } from "prosemirror-history";
import type { Editor } from "../../../app/editor";
import { HtmlPreview } from "./HtmlPreview";

interface PreviewOptions {
  width?: number;
  height?: number;
}

declare global {
  interface Window {
    previewTest: {
      reset: (options?: PreviewOptions) => void;
      dimensions: () => { width: number; height: number };
    };
  }
}

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    text: { group: "inline" },
    code_fence: {
      group: "block",
      content: "text*",
      code: true,
      attrs: {
        language: { default: "html-preview" },
        previewWidth: { default: 100 },
        previewHeight: { default: 0 },
      },
      toDOM: () => ["pre", ["code", 0]],
    },
  },
});
const props = { readOnly: false };
const source =
  '<!doctype html><html><body style="margin:0"><div style="height:3200px;background:#eaf0fb;color:#172033;padding:24px;box-sizing:border-box"><h1>HTML Preview regression</h1><p>Long content remains visible after resizing.</p></div></body></html>';
function createView(options: PreviewOptions) {
  return new EditorView(document.querySelector("#editor"), {
    state: EditorState.create({
      schema,
      plugins: [HtmlPreview({ props } as Editor), history()],
      doc: schema.node("doc", null, [
        schema.node(
          "code_fence",
          {
            previewWidth: options.width ?? 100,
            previewHeight: options.height ?? 0,
          },
          schema.text(source)
        ),
      ]),
    }),
    editable: () => !props.readOnly,
  });
}
let view = createView({});
window.previewTest = {
  reset(options = {}) {
    view.destroy();
    props.readOnly = false;
    view = createView(options);
  },
  dimensions() {
    return {
      width: view.state.doc.firstChild?.attrs.previewWidth,
      height: view.state.doc.firstChild?.attrs.previewHeight,
    };
  },
};
document.querySelector("#edit")?.addEventListener("click", () => {
  props.readOnly = false;
  view.setProps({ editable: () => true });
});
document.querySelector("#done")?.addEventListener("click", () => {
  props.readOnly = true;
  view.setProps({ editable: () => false });
});
document.querySelector("#undo")?.addEventListener("click", () => {
  undo(view.state, view.dispatch);
});
