import { unzipSync } from "fflate";
import { MAX_HTML_PREVIEW_BYTES } from "@shared/editor/extensions/htmlPreviewSource";

const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const MAX_ARCHIVE_CONTENT_BYTES = 10 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 200;
const archiveOrigin = "https://html-preview.invalid/";
const mimeTypes: Record<string, string> = {
  avif: "image/avif",
  css: "text/css",
  eot: "application/vnd.ms-fontobject",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  otf: "font/otf",
  png: "image/png",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
};

interface HtmlPreviewSource {
  title: string;
  source: string;
}

interface HtmlPreviewDocument extends HtmlPreviewSource {
  text: string;
}

function dataUrl(path: string, files: Record<string, Uint8Array>): string {
  const bytes = files[path];
  if (!bytes) {
    throw new Error(`ZIP resource not found: ${path}`);
  }
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  const contentType = mimeTypes[extension] ?? "application/octet-stream";
  return `data:${contentType};base64,${btoa(binary)}`;
}

function resourceUrl(
  reference: string,
  basePath: string,
  files: Record<string, Uint8Array>
): string | undefined {
  const trimmed = reference.trim();
  if (!trimmed || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(trimmed)) {
    return undefined;
  }
  const resolved = new URL(trimmed, `${archiveOrigin}${basePath}`);
  if (resolved.origin !== new URL(archiveOrigin).origin) {
    return undefined;
  }
  let path: string;
  try {
    path = decodeURIComponent(resolved.pathname.slice(1));
  } catch {
    throw new Error(`Invalid ZIP resource path: ${reference}`);
  }
  return `${dataUrl(path, files)}${resolved.hash}`;
}

function rewriteCss(
  css: string,
  basePath: string,
  files: Record<string, Uint8Array>
): string {
  for (const match of css.matchAll(
    /@import\s+(?:url\()?\s*["']?([^"')\s;]+)/gi
  )) {
    if (resourceUrl(match[1], basePath, files)) {
      throw new Error(
        "Local CSS @import is not supported. Combine the stylesheets first."
      );
    }
  }
  return css.replace(
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi,
    (match, doubleQuoted: string, singleQuoted: string, bare: string) => {
      const reference = doubleQuoted ?? singleQuoted ?? bare;
      const url = resourceUrl(reference, basePath, files);
      return url ? `url("${url}")` : match;
    }
  );
}

function inlineArchiveResources(
  source: string,
  htmlPath: string,
  files: Record<string, Uint8Array>
): string {
  const doc = new DOMParser().parseFromString(source, "text/html");
  const basePath = htmlPath.includes("/")
    ? htmlPath.slice(0, htmlPath.lastIndexOf("/") + 1)
    : "";

  doc.querySelectorAll('link[rel~="stylesheet"][href]').forEach((link) => {
    const href = link.getAttribute("href");
    if (!href) {
      return;
    }
    const url = resourceUrl(href, basePath, files);
    if (url?.startsWith("data:")) {
      const cssPath = decodeURIComponent(
        new URL(href, `${archiveOrigin}${basePath}`).pathname.slice(1)
      );
      const stylesheet = doc.createElement("style");
      stylesheet.textContent = rewriteCss(
        new TextDecoder("utf-8").decode(files[cssPath]),
        cssPath.slice(0, cssPath.lastIndexOf("/") + 1),
        files
      );
      link.replaceWith(stylesheet);
    }
  });

  doc.querySelectorAll("style").forEach((style) => {
    style.textContent = rewriteCss(style.textContent ?? "", basePath, files);
  });
  doc.querySelectorAll("[style]").forEach((element) => {
    const style = element.getAttribute("style");
    if (style) {
      element.setAttribute("style", rewriteCss(style, basePath, files));
    }
  });
  doc
    .querySelectorAll(
      "img[src], source[src], video[poster], link[rel~='icon'][href]"
    )
    .forEach((element) => {
      const attribute = element.hasAttribute("src")
        ? "src"
        : element.hasAttribute("poster")
          ? "poster"
          : "href";
      const reference = element.getAttribute(attribute);
      if (reference) {
        const url = resourceUrl(reference, basePath, files);
        if (url) {
          element.setAttribute(attribute, url);
        }
      }
    });

  return "<!doctype html>" + doc.documentElement.outerHTML;
}

async function readZip(file: File): Promise<HtmlPreviewSource> {
  if (file.size > MAX_ARCHIVE_BYTES) {
    throw new Error("ZIP must be at most 10 MiB.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let fileCount = 0;
  let expandedBytes = 0;
  const files = unzipSync(bytes, {
    filter: (entry) => {
      if (entry.name.endsWith("/")) {
        return false;
      }
      if (
        entry.name.startsWith("/") ||
        entry.name.includes("\\") ||
        entry.name.split("/").includes("..")
      ) {
        throw new Error("ZIP contains an unsafe file path.");
      }
      if (++fileCount > MAX_ARCHIVE_FILES) {
        throw new Error("ZIP must contain 200 files or fewer.");
      }
      expandedBytes += entry.originalSize;
      if (expandedBytes > MAX_ARCHIVE_CONTENT_BYTES) {
        throw new Error("ZIP contents must be 10 MiB or smaller.");
      }
      return true;
    },
  });
  const htmlFiles = Object.keys(files).filter((path) => /\.html?$/i.test(path));
  if (htmlFiles.length !== 1) {
    throw new Error("ZIP must contain exactly one .html or .htm file.");
  }
  const htmlPath = htmlFiles[0];
  const source = new TextDecoder("utf-8", { fatal: true }).decode(
    files[htmlPath]
  );
  return {
    title:
      htmlPath
        .split("/")
        .at(-1)
        ?.replace(/\.html?$/i, "")
        .trim() || "HTML document",
    source: inlineArchiveResources(source, htmlPath, files),
  };
}

/** Read an HTML file or a ZIP containing one HTML page and its static assets.
 *
 * @param file - the selected or dropped file.
 * @returns HTML source and title, or undefined for other file types.
 */
export async function readHtmlPreviewSource(
  file: File
): Promise<HtmlPreviewSource | undefined> {
  let preview: HtmlPreviewSource;
  if (/\.zip$/i.test(file.name)) {
    preview = await readZip(file);
  } else if (/\.html?$/i.test(file.name)) {
    if (file.size > MAX_HTML_PREVIEW_BYTES) {
      throw new Error("HTML must be at most 1 MiB.");
    }
    preview = {
      title: file.name.replace(/\.html?$/i, "").trim() || "HTML document",
      source: await file.text(),
    };
  } else {
    return undefined;
  }
  if (
    new TextEncoder().encode(preview.source).byteLength > MAX_HTML_PREVIEW_BYTES
  ) {
    throw new Error("HTML with embedded resources must be at most 1 MiB.");
  }
  return preview;
}

/** Read a standalone HTML file or a ZIP into an opt-in preview document.
 *
 * @param file - the dropped file.
 * @returns document content for HTML/ZIP files, otherwise undefined.
 */
export async function readHtmlPreviewFile(
  file: File
): Promise<HtmlPreviewDocument | undefined> {
  const preview = await readHtmlPreviewSource(file);
  if (!preview) {
    return undefined;
  }
  // documents.create accepts Markdown text, not editor JSON.
  let fenceLength = 3;
  for (const run of preview.source.matchAll(/`{3,}/g)) {
    fenceLength = Math.max(fenceLength, run[0].length + 1);
  }
  const fence = "`".repeat(fenceLength);
  return {
    ...preview,
    text: `${fence}html-preview\n${preview.source}${preview.source.endsWith("\n") ? "" : "\n"}${fence}`,
  };
}
