import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";
import { zipSync, strToU8 } from "fflate";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const server = await createServer({
  configFile: false,
  root,
  logLevel: "error",
  resolve: {
    alias: {
      "@shared": path.join(root, "shared"),
      "~": path.join(root, "app"),
    },
  },
  server: { host: "127.0.0.1", port: 0 },
});
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== "string");
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    `http://127.0.0.1:${address.port}/shared/editor/extensions/htmlPreview.browser.html`
  );
  await page.waitForFunction(() => !!window.previewTest);
  const frame = page.locator(".outline-html-preview-frame");
  const dimensions = () => page.evaluate(() => window.previewTest.dimensions());
  const reset = async (options) => {
    await page.evaluate((value) => window.previewTest.reset(value), options);
    await frame.waitFor();
  };
  const uploadZip = (files) =>
    page.locator('input[type="file"]').setInputFiles({
      name: "site.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(
        zipSync(
          Object.fromEntries(
            Object.entries(files).map(([name, text]) => [name, strToU8(text)])
          )
        )
      ),
    });
  const handle = (axis) =>
    page.getByRole("button", {
      name: `Resize HTML preview ${axis}`,
      exact: true,
    });
  const startDrag = async (axis, dx, dy) => {
    const target = handle(axis);
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box.x + box.width / 2 + dx,
      box.y + box.height / 2 + dy,
      { steps: 5 }
    );
  };
  const assertPreview = async () => {
    assert.equal(await page.locator("iframe").count(), 1);
    assert.equal(await page.locator(".ProseMirror > pre").isVisible(), false);
  };

  for (const sourceMode of [false, true]) {
    await reset({ width: 80, height: 480 });
    if (sourceMode) {
      await page.getByRole("button", { name: "Source", exact: true }).click();
    }
    await page.locator("#done").click();
    await page.waitForFunction(
      () => !document.querySelector(".outline-html-preview-resize")
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Load HTML file", exact: true })
        .count(),
      0
    );
    await assertPreview();
  }

  await reset({ width: 83, height: 569 });
  await page.getByRole("button", { name: "Source", exact: true }).click();
  assert.equal(
    await page.getByRole("slider", { name: "Width", exact: true }).inputValue(),
    "83"
  );
  assert.equal(
    await page
      .getByRole("slider", { name: "Height", exact: true })
      .inputValue(),
    "569"
  );

  for (const [axis, dx, dy] of [
    ["width", -50, 0],
    ["height", 0, 100],
    ["both", -50, 100],
  ]) {
    await reset({ width: 80, height: 480 });
    await startDrag(axis, dx, dy);
    await page.mouse.up();
    const after = await dimensions();
    assert.equal(after.width < 80, axis !== "height");
    assert.equal(after.height, axis === "width" ? 480 : 580);
    await assertPreview();
    await page.locator("#undo").click();
    assert.deepEqual(await dimensions(), { width: 80, height: 480 });
    await assertPreview();
  }

  await reset({ width: 80, height: 0 });
  await page.waitForFunction(
    () =>
      document.querySelector(".outline-html-preview-frame").clientHeight > 3000
  );
  const initialHeight = await frame.evaluate((element) => element.clientHeight);
  await startDrag("height", 30, 0);
  await page.mouse.up();
  assert.deepEqual(await dimensions(), { width: 80, height: 0 });
  assert.equal(
    await frame.evaluate((element) => element.clientHeight),
    initialHeight
  );

  await startDrag("height", 0, -100);
  const draggedHeight = await frame.evaluate((element) => element.clientHeight);
  const child = page
    .frames()
    .find((candidate) => candidate !== page.mainFrame());
  assert.ok(child);
  await child.evaluate(() => {
    const script = [...document.scripts].find((node) =>
      node.textContent.includes("const channel =")
    );
    const channel = JSON.parse(
      script.textContent.match(/const channel = ("[^"]+");/)[1]
    );
    parent.postMessage(
      { type: "outline-html-height", channel, height: 45000 },
      "*"
    );
  });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(
    await frame.evaluate((element) => element.clientHeight),
    draggedHeight
  );
  await page.mouse.up();
  assert.equal((await dimensions()).height, initialHeight - 100);
  assert.ok((await dimensions()).height > 2000);

  await reset({ width: 80, height: 0 });
  await page.waitForFunction(
    () =>
      document.querySelector(".outline-html-preview-frame").clientHeight > 3000
  );
  await startDrag("both", -50, -100);
  await handle("both").dispatchEvent("pointercancel", { pointerId: 1 });
  await page.mouse.up();
  assert.deepEqual(await dimensions(), { width: 80, height: 0 });
  await page.waitForFunction(
    (before) =>
      document.querySelector(".outline-html-preview-frame").clientHeight ===
      before,
    initialHeight
  );

  await reset({ width: 60, height: 480 });
  await page.getByRole("button", { name: "Auto height", exact: true }).click();
  assert.deepEqual(await dimensions(), { width: 60, height: 0 });
  await page.getByRole("button", { name: "Reset size", exact: true }).click();
  assert.deepEqual(await dimensions(), { width: 100, height: 0 });
  assert.equal(
    await page
      .getByRole("button", { name: "Reset size", exact: true })
      .isDisabled(),
    true
  );
  await uploadZip({
    "index.html":
      '<link rel="stylesheet" href="styles/main.css"><link rel="stylesheet" href="disabled.css" disabled><p id="css-test">Imported CSS</p>',
    "styles/main.css":
      '@import "nested/theme.css" layer(theme) supports(display: grid) screen;',
    "styles/nested/theme.css":
      "#css-test { color: rgb(1, 2, 3); background-image: url(../../images/logo.svg) }",
    "images/logo.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
    "disabled.css": "#css-test { color: red }",
  });
  const cssTarget = page.frameLocator("iframe").locator("#css-test");
  await cssTarget.waitFor();
  assert.equal(
    await cssTarget.evaluate((element) => getComputedStyle(element).color),
    "rgb(1, 2, 3)"
  );
  assert.ok(
    (
      await cssTarget.evaluate(
        (element) => getComputedStyle(element).backgroundImage
      )
    ).includes("data:image/svg+xml;base64,")
  );
  await uploadZip({
    "index.html": '<link rel="stylesheet" href="styles/main.css">',
    "styles/main.css": '@import "missing.css";',
  });
  await page.waitForFunction(() =>
    document
      .querySelector(".outline-html-preview-notice")
      .textContent.includes("styles/missing.css")
  );
  assert.ok(
    (await page.locator(".outline-html-preview-notice").textContent()).includes(
      "styles/main.css"
    )
  );
  assert.equal(await cssTarget.textContent(), "Imported CSS");
  assert.deepEqual(errors, []);
  await reset({ width: 80, height: 480 });
  await mkdir(path.join(root, "build"), { recursive: true });
  await page.screenshot({
    path: path.join(root, "build/html-preview-browser.png"),
  });
  console.log(
    "PASS: Preview/Source completion, exact dimension controls, three resize directions, undo, tall auto height, ignored-axis movement, drag/auto-height isolation, pointer cancel, Auto height, Reset size, nested CSS import rendering, disabled CSS, missing-resource errors without data loss"
  );
} finally {
  await browser?.close();
  await server.close();
}
