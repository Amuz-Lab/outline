import { parser, serializer } from ".";

test("preserves HTML preview dimensions through server Markdown conversion", () => {
  const markdown = "```html-preview width=83 height=6500\n<p>Preview</p>\n```";
  const ast = parser.parse(markdown);
  expect(ast.firstChild?.attrs).toMatchObject({
    previewWidth: 83,
    previewHeight: 6500,
  });
  const restored = parser.parse(serializer.serialize(ast));
  expect(restored.firstChild?.attrs).toMatchObject({
    previewWidth: 83,
    previewHeight: 6500,
  });
});

test("renders an empty doc", () => {
  const ast = parser.parse("");

  expect(ast?.toJSON()).toEqual({
    content: [{ type: "paragraph" }],
    type: "doc",
  });
});

test("parses lowercase alpha lists", () => {
  const ast = parser.parse("a. First item\nb. Second item");

  expect(ast?.toJSON()).toEqual({
    content: [
      {
        attrs: { listStyle: "lower-alpha", order: 1 },
        content: [
          {
            content: [
              {
                content: [{ text: "First item", type: "text" }],
                type: "paragraph",
              },
            ],
            type: "list_item",
          },
          {
            content: [
              {
                content: [{ text: "Second item", type: "text" }],
                type: "paragraph",
              },
            ],
            type: "list_item",
          },
        ],
        type: "ordered_list",
      },
    ],
    type: "doc",
  });
});

test("parses uppercase alpha lists", () => {
  const ast = parser.parse("A. First item\nB. Second item");

  expect(ast?.toJSON()).toEqual({
    content: [
      {
        attrs: { listStyle: "upper-alpha", order: 1 },
        content: [
          {
            content: [
              {
                content: [{ text: "First item", type: "text" }],
                type: "paragraph",
              },
            ],
            type: "list_item",
          },
          {
            content: [
              {
                content: [{ text: "Second item", type: "text" }],
                type: "paragraph",
              },
            ],
            type: "list_item",
          },
        ],
        type: "ordered_list",
      },
    ],
    type: "doc",
  });
});

test("parses alpha lists with blank lines (issue example)", () => {
  const markdown = `## 3. Step Three

a. Do this.

b. Do that.`;

  const ast = parser.parse(markdown);
  const json = ast?.toJSON();

  // Find the ordered_list in the result
  const orderedList = json?.content?.find(
    (node: { type: string }) => node.type === "ordered_list"
  );

  expect(orderedList).toBeDefined();
  expect(orderedList?.attrs.listStyle).toBe("lower-alpha");
  expect(orderedList?.attrs.order).toBe(1);
  expect(orderedList?.content).toHaveLength(2);
});

test("preserves numeric lists", () => {
  const ast = parser.parse("1. First item\n2. Second item");

  expect(ast?.toJSON()).toEqual({
    content: [
      {
        attrs: { listStyle: "number", order: 1 },
        content: [
          {
            content: [
              {
                content: [{ text: "First item", type: "text" }],
                type: "paragraph",
              },
            ],
            type: "list_item",
          },
          {
            content: [
              {
                content: [{ text: "Second item", type: "text" }],
                type: "paragraph",
              },
            ],
            type: "list_item",
          },
        ],
        type: "ordered_list",
      },
    ],
    type: "doc",
  });
});

test("serializes lowercase alpha lists back to markdown", () => {
  const ast = parser.parse("a. First item\nb. Second item");
  const output = serializer.serialize(ast);

  expect(output.trim()).toBe("a. First item\nb. Second item");
});

test("serializes uppercase alpha lists back to markdown", () => {
  const ast = parser.parse("A. First item\nB. Second item");
  const output = serializer.serialize(ast);

  expect(output.trim()).toBe("A. First item\nB. Second item");
});
