import { readHtmlPreviewFile } from "./htmlPreviewImport";
import JSZip from "jszip";

function htmlFile(
  source: string,
  name = "Decision model.html",
  type = "text/html"
) {
  const file = new File([source], name, { type });
  Object.defineProperty(file, "text", { value: async () => source });
  return file;
}

async function zipFile(files: Record<string, string>) {
  const zip = new JSZip();
  Object.entries(files).forEach(([path, content]) => zip.file(path, content));
  const bytes = await zip.generateAsync({ type: "uint8array" });
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const file = new File([copy.buffer], "site.zip", { type: "application/zip" });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => copy.buffer,
  });
  return file;
}

describe("collection HTML preview import", () => {
  it("creates a preview document named after the file without converting HTML", async () => {
    const source =
      '<html><script>const x = "```";</script><svg></svg>한글</html>\n';
    const result = await readHtmlPreviewFile(htmlFile(source));
    expect(result?.title).toBe("Decision model");
    expect(result?.text).toBe(`\`\`\`\`html-preview\n${source}\`\`\`\``);
  });
  it("supports uppercase HTM with an empty MIME type", async () => {
    const file = htmlFile("<p>ok</p>", "Page.HTM", "");
    expect((await readHtmlPreviewFile(file))?.title).toBe("Page");
  });
  it("leaves other imports on their existing path", async () => {
    expect(
      await readHtmlPreviewFile(htmlFile("# markdown", "report.md"))
    ).toBeUndefined();
    expect(
      await readHtmlPreviewFile(htmlFile("MIME archive", "report.mhtml"))
    ).toBeUndefined();
  });
  it("rejects oversized HTML before document creation", async () => {
    await expect(
      readHtmlPreviewFile(htmlFile("x".repeat(1024 * 1024 + 1)))
    ).rejects.toThrow("1 MiB");
  });
  it("embeds relative CSS and images from a ZIP", async () => {
    const file = await zipFile({
      "index.html":
        '<link rel="stylesheet" href="styles/site.css"><img src="images/logo.svg">',
      "styles/site.css": "body { background: url('../images/bg.png') }",
      "images/logo.svg": "<svg></svg>",
      "images/bg.png": "image bytes",
    });
    const result = await readHtmlPreviewFile(file);

    expect(result?.title).toBe("index");
    expect(result?.text).toContain("data:image/svg+xml;base64,");
    expect(result?.text).toContain("data:image/png;base64,");
    expect(result?.text).toContain("<style>");
  });
  it("rewrites responsive ZIP images and preserves stylesheet media settings", async () => {
    const file = await zipFile({
      "index.html":
        '<link rel="stylesheet" href="styles/site.css" media="print" title="Print"><picture><source srcset="images/small.png 1x, images/large.png 2x"><img srcset="images/small.png 400w, images/large.png 800w"></picture>',
      "styles/site.css": "body { color: red }",
      "images/small.png": "small",
      "images/large.png": "large",
    });
    const result = await readHtmlPreviewFile(file);
    const doc = new DOMParser().parseFromString(result!.source, "text/html");

    expect(doc.querySelector("source")?.getAttribute("srcset")).toContain(
      "data:image/png;base64,"
    );
    expect(doc.querySelector("source")?.getAttribute("srcset")).toContain("2x");
    expect(doc.querySelector("img")?.getAttribute("srcset")).toContain("800w");
    expect(doc.querySelector("style")?.getAttribute("media")).toBe("print");
    expect(doc.querySelector("style")?.getAttribute("title")).toBe("Print");
  });
  it("excludes disabled ZIP stylesheets from the preview", async () => {
    const file = await zipFile({
      "index.html":
        '<link rel="stylesheet" href="active.css"><link rel="stylesheet" href="disabled.css" disabled><link rel="stylesheet" href="missing.css" disabled>',
      "active.css": "body { color: green }",
      "disabled.css": "body { color: red }",
    });
    const result = await readHtmlPreviewFile(file);
    const doc = new DOMParser().parseFromString(result!.source, "text/html");

    expect(doc.querySelectorAll("style")).toHaveLength(1);
    expect(doc.querySelector("style")?.textContent).toBe(
      "body { color: green }"
    );
    expect(doc.querySelector("link[disabled]")).toBeNull();
  });
  it("requires exactly one HTML page in a ZIP", async () => {
    const file = await zipFile({ "one.html": "", "two.htm": "" });
    await expect(readHtmlPreviewFile(file)).rejects.toThrow(
      "exactly one .html or .htm file"
    );
  });
  it("expands nested CSS imports with relative assets and import conditions", async () => {
    const file = await zipFile({
      "index.html": '<link rel="stylesheet" href="styles/site.css">',
      "styles/site.css":
        '@import "nested/theme.css" layer(theme) supports(display: grid) screen and (min-width: 400px); body { margin: 0 }',
      "styles/nested/theme.css":
        "@import url(../base.css); .logo { background: url(../../images/logo.svg) }",
      "styles/base.css": 'p::before { content: "@import ignored.css;" }',
      "images/logo.svg": "<svg></svg>",
    });
    const result = await readHtmlPreviewFile(file);

    expect(result?.source).toContain("@layer theme");
    expect(result?.source).toContain("@supports (display: grid)");
    expect(result?.source).toContain("@media screen and (min-width: 400px)");
    expect(result?.source).toContain("data:image/svg+xml;base64,");
    expect(result?.source).toContain('content: "@import ignored.css;"');
  });
  it("rejects circular CSS imports with the affected paths", async () => {
    const file = await zipFile({
      "index.html": '<link rel="stylesheet" href="a.css">',
      "a.css": '@import "b.css";',
      "b.css": '@import "a.css";',
    });
    await expect(readHtmlPreviewFile(file)).rejects.toThrow(
      "Circular CSS @import: a.css -> b.css -> a.css"
    );
  });
  it("names the importing CSS when a nested resource is missing", async () => {
    const file = await zipFile({
      "index.html": '<link rel="stylesheet" href="styles/site.css">',
      "styles/site.css": '@import "missing.css";',
    });
    await expect(readHtmlPreviewFile(file)).rejects.toThrow(
      /styles\/missing.css.*styles\/site.css/
    );
  });
  it("reports the converted size when embedded ZIP resources exceed the limit", async () => {
    const file = await zipFile({
      "index.html": '<img src="large.png">',
      "large.png": "x".repeat(800 * 1024),
    });
    await expect(readHtmlPreviewFile(file)).rejects.toThrow(
      /1 MiB.*converted size: [\d.]+ MiB/
    );
  });
});
