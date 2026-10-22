import { MAX_HTML_PREVIEW_BYTES } from "@shared/editor/extensions/htmlPreviewSource";

interface HtmlPreviewDocument {
  title: string;
  text: string;
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
  // documents.create accepts Markdown text, not editor JSON.
  let fenceLength = 3;
  for (const run of source.matchAll(/`{3,}/g)) {
    fenceLength = Math.max(fenceLength, run[0].length + 1);
  }
  const fence = "`".repeat(fenceLength);
  return {
    title: file.name.replace(/\.html?$/i, "").trim() || "HTML document",
    text: `${fence}html-preview\n${source}${source.endsWith("\n") ? "" : "\n"}${fence}`,
  };
}
