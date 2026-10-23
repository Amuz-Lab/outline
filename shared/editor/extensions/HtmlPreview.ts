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
import { createHtmlPreviewSource } from "./htmlPreviewSource";
import { readHtmlPreviewSource } from "~/utils/htmlPreviewImport";

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
            wrapper.className = "outline-html-preview";
            wrapper.contentEditable = "false";
            wrapper.setAttribute("aria-label", "HTML preview");
            const toolbar = document.createElement("div");
            toolbar.className = "outline-html-preview-toolbar";
            const notice = document.createElement("p");
            notice.setAttribute("role", "status");
            notice.className = "outline-html-preview-notice";
            const addButton = (label: string, handleClick: () => void) => {
              const button = document.createElement("button");
              button.type = "button";
              button.className = "outline-html-preview-button";
              button.textContent = label;
              button.addEventListener("mousedown", (event) =>
                event.preventDefault()
              );
              button.addEventListener("click", handleClick);
              toolbar.append(button);
            };
            const setDimensions = (width: number, height: number) => {
              view.dispatch(
                view.state.tr
                  .setNodeMarkup(block.pos, undefined, {
                    ...block.node.attrs,
                    previewWidth: Math.max(25, Math.min(100, width)),
                    previewHeight:
                      height === 0 ? 0 : Math.max(200, Math.min(2000, height)),
                  })
                  .setMeta(previewKey, block.pos)
              );
            };
            if (editing && !editor.props.readOnly) {
              const width = Math.max(
                25,
                Math.min(100, Number(block.node.attrs.previewWidth) || 100)
              );
              const height = Number(block.node.attrs.previewHeight) || 0;
              const rangeControl = (
                name: string,
                min: number,
                max: number,
                step: number,
                value: number,
                onChange: (value: number) => void
              ) => {
                const label = document.createElement("label");
                label.className = "outline-html-preview-control";
                const title = document.createElement("span");
                title.textContent = name;
                const output = document.createElement("output");
                output.textContent = `${value}${name === "Width" ? "%" : " px"}`;
                const input = document.createElement("input");
                input.type = "range";
                input.min = String(min);
                input.max = String(max);
                input.step = String(step);
                input.value = String(value);
                input.setAttribute("aria-label", name);
                input.addEventListener("input", () => {
                  output.textContent = `${input.value}${name === "Width" ? "%" : " px"}`;
                });
                input.addEventListener("change", () =>
                  onChange(Number(input.value))
                );
                label.append(title, input, output);
                return { label, input };
              };
              const widthControl = rangeControl(
                "Width",
                25,
                100,
                5,
                width,
                (value) => setDimensions(value, height)
              );
              const heightControl = rangeControl(
                "Height",
                200,
                2000,
                50,
                height || 600,
                (value) => setDimensions(width, value)
              );
              const autoHeight = document.createElement("label");
              autoHeight.className = "outline-html-preview-auto-height";
              const checkbox = document.createElement("input");
              checkbox.type = "checkbox";
              checkbox.checked = height === 0;
              checkbox.addEventListener("change", () => {
                heightControl.input.disabled = checkbox.checked;
                setDimensions(
                  width,
                  checkbox.checked ? 0 : Number(heightControl.input.value)
                );
              });
              autoHeight.append(
                checkbox,
                document.createTextNode("Auto height")
              );
              heightControl.input.disabled = height === 0;
              toolbar.append(
                widthControl.label,
                heightControl.label,
                autoHeight
              );
            }
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
              input.accept = ".html,.htm,.zip,text/html,application/zip";
              input.hidden = true;
              input.addEventListener("change", async () => {
                const file = input.files?.[0];
                if (!file) {
                  return;
                }
                try {
                  const preview = await readHtmlPreviewSource(file);
                  if (!preview) {
                    return;
                  }
                  const { source: text } = preview;
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
              const title = window.document.title
                .split(" - ")
                .slice(0, -1)
                .join(" - ");
              const fileName =
                title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() ||
                "document";
              link.download = `${fileName}.html`;
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            });
            wrapper.append(toolbar, notice);
            if (!editing && source.trim()) {
              try {
                const iframe = document.createElement("iframe");
                iframe.title = "HTML document preview";
                iframe.setAttribute("sandbox", "allow-scripts");
                iframe.allowFullscreen = true;
                iframe.referrerPolicy = "no-referrer";
                const previewWidth = Math.max(
                  25,
                  Math.min(100, Number(block.node.attrs.previewWidth) || 100)
                );
                const previewHeight =
                  Number(block.node.attrs.previewHeight) || 0;
                iframe.style.cssText = `display:block;width:${previewWidth}%;max-width:100%;height:${previewHeight || 200}px;border:0;margin:0 auto;`;
                const diagnostics = new Set<string>();
                addButton("Full screen", () => {
                  void iframe.requestFullscreen().catch(() => {
                    notice.textContent =
                      "Could not open the full-screen preview.";
                  });
                });
                const script = document.querySelector("script[nonce]");
                const nonce =
                  script instanceof HTMLScriptElement ? script.nonce : "";
                const channel = uuidv4();
                const handleMessage = (event: MessageEvent) => {
                  if (
                    event.source !== iframe.contentWindow ||
                    !event.data ||
                    event.data.channel !== channel ||
                    typeof event.data.type !== "string"
                  ) {
                    return;
                  }
                  if (event.data.type === "outline-html-diagnostic") {
                    if (
                      event.data.kind === "script-error" ||
                      event.data.kind === "blocked-resource"
                    ) {
                      diagnostics.add(
                        event.data.kind === "script-error"
                          ? "A script failed in the preview."
                          : "Some external resources were blocked by the preview security policy."
                      );
                      notice.textContent = [...diagnostics].join(" ");
                    }
                    return;
                  }
                  if (
                    event.data.type !== "outline-html-height" ||
                    previewHeight !== 0 ||
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
            key: `html-preview-${block.pos}-${hashString(source)}-${block.node.attrs.previewWidth}-${block.node.attrs.previewHeight}-${editing}`,
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
