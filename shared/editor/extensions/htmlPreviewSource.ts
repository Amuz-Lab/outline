/** Maximum source size accepted by the preview renderer. */
export const MAX_HTML_PREVIEW_BYTES = 1024 * 1024;

/** Prepare a parsed HTML page for a sandboxed srcdoc without weakening parent CSP. */
export function createHtmlPreviewSource(
  source: string,
  nonce: string,
  channel?: string
): string {
  if (new TextEncoder().encode(source).byteLength > MAX_HTML_PREVIEW_BYTES) {
    throw new Error(
      "HTML must be at most 1 MiB. Source is still available for editing."
    );
  }
  const doc = new DOMParser().parseFromString(source, "text/html");
  const nonceAttribute = "data-preview-nonce-" + uuidv4();
  if (channel) {
    const bridge = doc.createElement("script");
    bridge.textContent = `(() => {
      const channel = ${JSON.stringify(channel).replace(/</g, "\\u003c")};
      let previous = 0, pending = false;
      const report = () => {
        pending = false;
        const body = document.body;
        if (!body) return;
        const style = getComputedStyle(body);
        const margin = (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
        const height = Math.ceil(Math.max(body.scrollHeight, body.offsetHeight) + margin + 2);
        if (height !== previous) {
          previous = height;
          parent.postMessage({type: 'outline-html-height', channel, height}, '*');
        }
      };
      const schedule = () => { if (!pending) { pending = true; requestAnimationFrame(report); } };
      new ResizeObserver(schedule).observe(document.body);
      addEventListener('load', schedule);
      addEventListener('resize', schedule);
      document.fonts?.ready.then(schedule);
      schedule();
    })();`;
    doc.body.append(bridge);
  }
  doc
    .querySelectorAll("script[src], meta[http-equiv=refresh i], base")
    .forEach((el) => el.remove());
  doc.querySelectorAll("script").forEach((script) => {
    script.removeAttribute("nonce");
    if (nonce) {
      // Chromium hides nonce attributes during serialization; restore them afterwards.
      script.setAttribute(nonceAttribute, nonce);
    }
  });
  const policy = doc.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    "img-src data: blob:",
    "font-src https://fonts.gstatic.com data:",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  doc.head.prepend(policy);
  return (
    "<!doctype html>" +
    doc.documentElement.outerHTML.split(nonceAttribute + "=").join("nonce=")
  );
}
import { v4 as uuidv4 } from "uuid";
