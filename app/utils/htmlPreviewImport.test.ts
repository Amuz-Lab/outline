import { readHtmlPreviewFile } from "./htmlPreviewImport";

function htmlFile(
  source: string,
  name = "Decision model.html",
  type = "text/html"
) {
  const file = new File([source], name, { type });
  Object.defineProperty(file, "text", { value: async () => source });
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
      readHtmlPreviewFile(htmlFile("x".repeat(512 * 1024 + 1)))
    ).rejects.toThrow("512 KiB");
  });
});
