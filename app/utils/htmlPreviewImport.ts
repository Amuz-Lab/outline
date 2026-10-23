import { unzipSync } from "fflate";
import { atRule, parse } from "postcss";
import type { ChildNode } from "postcss";
import valueParser from "postcss-value-parser";
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

function resourcePath(reference: string, basePath: string): string | undefined {
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
  return path;
}

function resourceUrl(
  reference: string,
  basePath: string,
  files: Record<string, Uint8Array>
): string | undefined {
  const path = resourcePath(reference, basePath);
  return path === undefined
    ? undefined
    : `${dataUrl(path, files)}${new URL(reference.trim(), `${archiveOrigin}${basePath}`).hash}`;
}

function rewriteCss(
  css: string,
  basePath: string,
  files: Record<string, Uint8Array>,
  stack: string[],
  budget: { bytes: number }
): string {
  budget.bytes += new TextEncoder().encode(css).byteLength;
  if (stack.length > 20 || budget.bytes > MAX_ARCHIVE_CONTENT_BYTES) {
    throw new Error("CSS @import expansion is too large or too deeply nested.");
  }
  try {
    const root = parse(css);
    root.walkAtRules(/^charset$/i, (rule) => {
      rule.remove();
    });
    root.walkAtRules(/^import$/i, (rule) => {
      const parts = valueParser(rule.params).nodes.filter(
        (node) => node.type !== "space" && node.type !== "comment"
      );
      const first = parts[0];
      const reference =
        first?.type === "string"
          ? first.value
          : first?.type === "function" && first.value.toLowerCase() === "url"
            ? first.nodes[0]?.value
            : undefined;
      if (reference === undefined) {
        throw new Error(`Invalid CSS @import: ${rule.params}`);
      }
      const path = resourcePath(reference, basePath);
      if (path === undefined) {
        return;
      }
      if (stack.includes(path)) {
        throw new Error(
          `Circular CSS @import: ${[...stack, path].join(" -> ")}`
        );
      }
      if (!files[path]) {
        throw new Error(`ZIP resource not found: ${path}`);
      }
      const imported = rewriteCss(
        new TextDecoder("utf-8", { fatal: true }).decode(files[path]),
        path.slice(0, path.lastIndexOf("/") + 1),
        files,
        [...stack, path],
        budget
      );
      const conditions: { name: string; params: string }[] = [];
      let offset = 1;
      const layer = parts[offset];
      if (
        (layer?.type === "word" || layer?.type === "function") &&
        layer.value.toLowerCase() === "layer"
      ) {
        conditions.push({
          name: "layer",
          params:
            layer.type === "function" ? valueParser.stringify(layer.nodes) : "",
        });
        offset++;
      }
      const supports = parts[offset];
      if (
        supports?.type === "function" &&
        supports.value.toLowerCase() === "supports"
      ) {
        conditions.push({
          name: "supports",
          params: `(${valueParser.stringify(supports.nodes)})`,
        });
        offset++;
      }
      const media = rule.params
        .slice(parts[offset]?.sourceIndex ?? rule.params.length)
        .trim();
      if (media) {
        conditions.push({ name: "media", params: media });
      }
      let nodes: ChildNode[] = parse(imported).nodes;
      for (const condition of conditions.reverse()) {
        const wrapper = atRule(condition);
        wrapper.append(nodes);
        nodes = [wrapper];
      }
      rule.replaceWith(...nodes);
    });
    root.walkDecls((declaration) => {
      const value = valueParser(declaration.value);
      value.walk((node) => {
        if (node.type !== "function" || node.value.toLowerCase() !== "url") {
          return;
        }
        const reference = node.nodes[0]?.value;
        if (reference === undefined) {
          return false;
        }
        const url = resourceUrl(reference, basePath, files);
        if (url) {
          budget.bytes += url.length;
          if (budget.bytes > MAX_ARCHIVE_CONTENT_BYTES) {
            throw new Error("Expanded CSS resources exceed 10 MiB.");
          }
          node.nodes = [
            {
              type: "string",
              quote: '"',
              value: url,
              sourceIndex: 0,
              sourceEndIndex: 0,
            },
          ];
        }
        return false;
      });
      declaration.value = valueParser.stringify(value.nodes);
    });
    return root.toString();
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`${error.message} (in ${stack.at(-1) ?? "inline CSS"})`);
    }
    throw error;
  }
}

function rewriteSrcset(
  srcset: string,
  basePath: string,
  files: Record<string, Uint8Array>
): string {
  const candidates: string[] = [];
  let position = 0;
  while (position < srcset.length) {
    while (position < srcset.length && /[\s,]/.test(srcset[position])) {
      position++;
    }
    if (position === srcset.length) {
      break;
    }
    const start = position;
    while (position < srcset.length && !/\s/.test(srcset[position])) {
      position++;
    }
    const token = srcset.slice(start, position);
    const url = token.replace(/,+$/, "");
    const endedWithComma = token.length !== url.length;
    const descriptorStart = position;
    let parentheses = 0;
    if (!endedWithComma) {
      while (position < srcset.length) {
        const character = srcset[position];
        if (character === "(") {
          parentheses++;
        }
        if (character === ")") {
          parentheses = Math.max(0, parentheses - 1);
        }
        if (character === "," && parentheses === 0) {
          break;
        }
        position++;
      }
    }
    const descriptor = endedWithComma
      ? ""
      : srcset.slice(descriptorStart, position).trim();
    const rewritten = resourceUrl(url, basePath, files) ?? url;
    candidates.push(`${rewritten}${descriptor ? ` ${descriptor}` : ""}`);
    if (position < srcset.length && srcset[position] === ",") {
      position++;
    }
  }
  return candidates.join(", ");
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
  const inlineStyles = doc.querySelectorAll("style");
  const cssBudget = { bytes: 0 };

  doc.querySelectorAll('link[rel~="stylesheet"][href]').forEach((link) => {
    if (link.hasAttribute("disabled")) {
      link.remove();
      return;
    }
    const href = link.getAttribute("href");
    if (!href) {
      return;
    }
    const cssPath = resourcePath(href, basePath);
    if (cssPath !== undefined) {
      if (!files[cssPath]) {
        throw new Error(`ZIP resource not found: ${cssPath} (in ${htmlPath})`);
      }
      const stylesheet = doc.createElement("style");
      stylesheet.textContent = rewriteCss(
        new TextDecoder("utf-8").decode(files[cssPath]),
        cssPath.slice(0, cssPath.lastIndexOf("/") + 1),
        files,
        [cssPath],
        cssBudget
      );
      for (const attribute of ["media", "title"]) {
        if (link.hasAttribute(attribute)) {
          stylesheet.setAttribute(
            attribute,
            link.getAttribute(attribute) ?? ""
          );
        }
      }
      link.replaceWith(stylesheet);
    }
  });

  inlineStyles.forEach((style) => {
    style.textContent = rewriteCss(
      style.textContent ?? "",
      basePath,
      files,
      [htmlPath],
      cssBudget
    );
  });
  doc.querySelectorAll("[style]").forEach((element) => {
    const style = element.getAttribute("style");
    if (style) {
      element.setAttribute(
        "style",
        rewriteCss(style, basePath, files, [htmlPath], cssBudget)
      );
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

  doc.querySelectorAll("img[srcset], source[srcset]").forEach((element) => {
    const srcset = element.getAttribute("srcset");
    if (srcset) {
      element.setAttribute("srcset", rewriteSrcset(srcset, basePath, files));
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
  const sourceBytes = new TextEncoder().encode(preview.source).byteLength;
  if (sourceBytes > MAX_HTML_PREVIEW_BYTES) {
    throw new Error(
      `HTML with embedded resources must be at most 1 MiB (converted size: ${(sourceBytes / 1024 / 1024).toFixed(2)} MiB). Reduce image or font sizes.`
    );
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
