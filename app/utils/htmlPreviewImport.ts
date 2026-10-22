import { MAX_HTML_PREVIEW_BYTES } from "@shared/editor/extensions/htmlPreviewSource";
import type { ProsemirrorData } from "@shared/types";

interface HtmlPreviewDocument {
  title: string;
  data: ProsemirrorData;
}

/** Read a standalone HTML file into an opt-in preview document, preserving source.
 *
 * @param file - the dropped file.
 * @returns document content for HTML files, otherwise undefined.
 */
export async function readHtmlPreviewFile(
  file: File
): Promise<HtmlPreviewDocument | undefined> {
  if (!/\.html?$/i.test(file.name)) {
    return undefined;
  }
  if (file.size > MAX_HTML_PREVIEW_BYTES) {
    throw new Error("HTML must be at most 512 KiB.");
  }
  const source = await file.text();
  if (new TextEncoder().encode(source).byteLength > MAX_HTML_PREVIEW_BYTES) {
    throw new Error("HTML must be at most 512 KiB.");
  }
  return {
    title: file.name.replace(/\.html?$/i, "").trim() || "HTML document",
    data: {
      type: "doc",
      content: [
        {
          type: "code_fence",
          attrs: { language: "html-preview", wrap: false },
          content: source ? [{ type: "text", text: source }] : [],
        },
      ],
    },
  };
}
