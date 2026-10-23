import { Plugin, PluginKey, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { EditorState } from "prosemirror-state";
import type { Node as ProsemirrorNode } from "prosemirror-model";
import type { Editor } from "../../../app/editor";
import { findBlockNodes } from "../queries/findChildren";
import { findParentNode } from "../queries/findParentNode";
import { hashString } from "../../utils/string";
import { isRemoteTransaction } from "../lib/multiplayer";
import { v4 as uuidv4 } from "uuid";
import {
  createHtmlPreviewSource,
  MAX_HTML_PREVIEW_BYTES,
} from "./htmlPreviewSource";

interface PreviewState {
  editingPos: number | null;
  decorations: DecorationSet;
}

const previewKey = new PluginKey<PreviewState>("html-preview");
const isHtmlPreview = (node: ProsemirrorNode) =>
  (node.type.name === "code_fence" || node.type.name === "code_block") &&
  node.attrs.language === "html-preview";

/** Display opt-in HTML code fences in isolated frames, retaining the source. */
export function HtmlPreview(editor: Editor) {
  const cleanups = new WeakMap<Node, () => void>();
  function build(state: EditorState, editingPos: number | null): PreviewState {
    const decorations: Decoration[] = [];
    for (const block of findBlockNodes(state.doc, true).filter((b) =>
      isHtmlPreview(b.node)
    )) {
      const source = block.node.textContent;
      const editing = editingPos === block.pos || !source.trim();
      if (!editing) {
        decorations.push(
          Decoration.node(block.pos, block.pos + block.node.nodeSize, {
            style: "display:none",
          })
        );
      }
      decorations.push(
        Decoration.widget(
          block.pos,
          (view) => {
            const wrapper = document.createElement("section");
            wrapper.contentEditable = "false";
            wrapper.setAttribute("aria-label", "HTML preview");
            wrapper.style.cssText =
              "border:1px solid #90909066;border-radius:8px;margin:12px 0;padding:10px;";
            const toolbar = document.createElement("div");
            toolbar.style.cssText =
              "display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;";
            const notice = document.createElement("p");
            notice.setAttribute("role", "status");
            notice.style.cssText = "font-size:13px;margin:4px 0;";
            const addButton = (label: string, handleClick: () => void) => {
              const button = document.createElement("button");
              button.type = "button";
              button.textContent = label;
              button.addEventListener("mousedown", (event) =>
                event.preventDefault()
              );
              button.addEventListener("click", handleClick);
              toolbar.append(button);
            };
            addButton(editing ? "Preview" : "Source", () => {
              const tr = view.state.tr.setMeta(
                previewKey,
                editing ? null : block.pos
              );
              if (!editing && !editor.props.readOnly) {
                tr.setSelection(
                  TextSelection.create(view.state.doc, block.pos + 1)
                );
              }
              view.dispatch(tr.setMeta("addToHistory", false));
              if (!editing) {
                view.focus();
              }
            });
            if (!editor.props.readOnly) {
              const input = document.createElement("input");
              input.type = "file";
              input.accept = ".html,.htm,text/html";
              input.hidden = true;
              input.addEventListener("change", async () => {
                const file = input.files?.[0];
                if (!file) {
                  return;
                }
                try {
                  if (file.size > MAX_HTML_PREVIEW_BYTES) {
                    throw new Error("HTML must be at most 1 MiB.");
                  }
                  const text = await file.text();
                  if (view.state.doc.nodeAt(block.pos) !== block.node) {
                    throw new Error(
                      "Document changed. Select the HTML block again."
                    );
                  }
                  view.dispatch(
                    view.state.tr
                      .insertText(
                        text,
                        block.pos + 1,
                        block.pos + block.node.nodeSize - 1
                      )
                      .setMeta(previewKey, null)
                  );
                } catch (error) {
                  notice.textContent =
                    error instanceof Error
                      ? error.message
                      : "Could not load HTML.";
                } finally {
                  input.value = "";
                }
              });
              wrapper.append(input);
              addButton("Load HTML file", () => input.click());
            }
            addButton("Download HTML", () => {
              const url = URL.createObjectURL(
                new Blob([source], { type: "text/html;charset=utf-8" })
              );
              const link = document.createElement("a");
              link.href = url;
              link.download = "document.html";
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            });
            wrapper.append(toolbar, notice);
            if (!editing && source.trim()) {
              try {
                const iframe = document.createElement("iframe");
                iframe.title = "HTML document preview";
                iframe.setAttribute("sandbox", "allow-scripts");
                iframe.referrerPolicy = "no-referrer";
                iframe.style.cssText =
                  "display:block;width:100%;height:200px;border:0;";
                const script = document.querySelector("script[nonce]");
                const nonce =
                  script instanceof HTMLScriptElement ? script.nonce : "";
                const channel = uuidv4();
                const handleMessage = (event: MessageEvent) => {
                  if (
                    event.source !== iframe.contentWindow ||
                    !event.data ||
                    event.data.type !== "outline-html-height" ||
                    event.data.channel !== channel ||
                    typeof event.data.height !== "number" ||
                    !Number.isFinite(event.data.height)
                  ) {
                    return;
                  }
                  iframe.style.height = `${Math.min(50000, Math.max(100, Math.ceil(event.data.height)))}px`;
                };
                window.addEventListener("message", handleMessage);
                cleanups.set(wrapper, () =>
                  window.removeEventListener("message", handleMessage)
                );
                iframe.srcdoc = createHtmlPreviewSource(source, nonce, channel);
                wrapper.append(iframe);
              } catch (error) {
                notice.textContent =
                  error instanceof Error
                    ? error.message
                    : "Could not display HTML.";
              }
            } else if (!source.trim()) {
              notice.textContent =
                "Paste a complete HTML page into the code block, or load an HTML file.";
            }
            return wrapper;
          },
          {
            side: -1,
            key: `html-preview-${block.pos}-${hashString(source)}-${editing}`,
            stopEvent: () => true,
            ignoreSelection: true,
            destroy: (dom: Node) => {
              cleanups.get(dom)?.();
              cleanups.delete(dom);
            },
          }
        )
      );
    }
    return {
      editingPos,
      decorations: DecorationSet.create(state.doc, decorations),
    };
  }
  return new Plugin<PreviewState>({
    key: previewKey,
    state: {
      init: (_, state) => build(state, null),
      apply: (tr, previous, _old, state) => {
        let editingPos =
          previous.editingPos === null
            ? null
            : tr.mapping.map(previous.editingPos);
        const meta: number | null | undefined = tr.getMeta(previewKey);
        if (meta !== undefined) {
          editingPos = meta;
        } else if (tr.docChanged && !isRemoteTransaction(tr, state)) {
          const selected = findParentNode(isHtmlPreview)(state.selection);
          if (selected) {
            editingPos = selected.pos;
          }
        }
        if (
          editingPos !== null &&
          !isHtmlPreview(state.doc.nodeAt(editingPos) ?? state.doc)
        ) {
          editingPos = null;
        }
        if (tr.docChanged || meta !== undefined) {
          return build(state, editingPos);
        }
        return previous;
      },
    },
    props: {
      decorations(state) {
        return this.getState(state)?.decorations;
      },
    },
  });
}
