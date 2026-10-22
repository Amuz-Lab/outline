import useImportDocument from "./useImportDocument";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  importFile: vi.fn(),
  push: vi.fn(),
  addDocument: vi.fn(),
  error: vi.fn(),
}));
vi.mock("react", () => ({
  useState: () => [false, vi.fn()],
  useCallback: (callback: object) => callback,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (text: string) => text }),
}));
vi.mock("react-router-dom", () => ({
  useHistory: () => ({ push: mocks.push }),
}));
vi.mock("sonner", () => ({
  toast: { loading: vi.fn(), dismiss: vi.fn(), error: mocks.error },
}));
vi.mock("~/hooks/useStores", () => ({
  default: () => ({
    documents: { create: mocks.create, import: mocks.importFile },
    collections: { get: () => ({ addDocument: mocks.addDocument }) },
  }),
}));
vi.mock("~/components/Sidebar/components/SidebarContext", () => ({
  useSidebarContext: () => "sidebar",
}));
vi.mock("~/utils/routeHelpers", () => ({ documentPath: () => "/doc/new" }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({ id: "new" });
  mocks.importFile.mockResolvedValue({ id: "imported" });
});

function file(source: string, name = "Decision model.html") {
  const result = new File([source], name);
  Object.defineProperty(result, "text", { value: async () => source });
  return result;
}

it("creates and opens a preview document for collection HTML drops", async () => {
  const source = "<html><script>test()</script></html>";
  await useImportDocument("collection", undefined, true).handleFiles([
    file(source),
  ]);
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Decision model",
      collectionId: "collection",
      data: expect.objectContaining({
        content: [
          expect.objectContaining({
            attrs: { language: "html-preview", wrap: false },
            content: [{ type: "text", text: source }],
          }),
        ],
      }),
    }),
    { publish: true }
  );
  expect(mocks.importFile).not.toHaveBeenCalled();
  expect(mocks.addDocument).toHaveBeenCalled();
  expect(mocks.push).toHaveBeenCalledWith({
    pathname: "/doc/new",
    state: { sidebarContext: "sidebar" },
  });
});

it("keeps dialog imports and non-HTML drops on the original import path", async () => {
  const html = file("<p>text</p>");
  await useImportDocument("collection").handleFiles([html]);
  const markdown = file("# text", "notes.md");
  await useImportDocument("collection", undefined, true).handleFiles([
    markdown,
  ]);
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.importFile).toHaveBeenCalledTimes(2);
  expect(mocks.importFile).toHaveBeenCalledWith(html, undefined, "collection", {
    publish: true,
  });
});

it("does not create a document when HTML exceeds the preview limit", async () => {
  await useImportDocument("collection", undefined, true).handleFiles([
    file("x".repeat(512 * 1024 + 1)),
  ]);
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.importFile).not.toHaveBeenCalled();
  expect(mocks.error).toHaveBeenCalledWith("HTML must be at most 512 KiB.");
});
