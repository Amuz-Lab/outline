/** Maximum source size accepted by the preview renderer. */
export const MAX_HTML_PREVIEW_BYTES = 1024 * 1024;

/** Maximum automatic or manually selected preview height, in pixels. */
export const MAX_HTML_PREVIEW_HEIGHT = 50000;

/** Prepare a parsed HTML page for a sandboxed srcdoc without weakening parent CSP. */
export function createHtmlPreviewSource(
  source: string,
  nonce: string,
  channel?: string,
  autoHeight = true,
  previewStateKey?: string
): string {
  if (new TextEncoder().encode(source).byteLength > MAX_HTML_PREVIEW_BYTES) {
    throw new Error(
      "HTML must be at most 1 MiB. Source is still available for editing."
    );
  }
  const doc = new DOMParser().parseFromString(source, "text/html");
  const autoLayout =
    "html, body { height: auto !important; min-height: 0 !important; max-height: none !important; overflow-y: visible !important; }";
  const layoutAttribute = "data-preview-layout-" + uuidv4();
  const layout = doc.createElement("style");
  layout.setAttribute(layoutAttribute, "");
  // Only the isolated preview receives this layout; stored/downloaded HTML is untouched.
  layout.textContent = autoHeight ? autoLayout : "";
  doc.head.append(layout);
  if (!doc.head.querySelector('meta[name="viewport" i]')) {
    const viewport = doc.createElement("meta");
    viewport.name = "viewport";
    viewport.content = "width=device-width, initial-scale=1";
    doc.head.append(viewport);
  }
  const nonceAttribute = "data-preview-nonce-" + uuidv4();
  if (channel) {
    const bridge = doc.createElement("script");
    bridge.textContent = `(() => {
      const channel = ${JSON.stringify(channel).replace(/</g, "\\u003c")};
      const stateKey = ${JSON.stringify(previewStateKey ?? "")};
      const sendDiagnostic = kind => parent.postMessage(
        {type: 'outline-html-diagnostic', channel, kind}, '*'
      );
      addEventListener('error', event => {
        if (event instanceof ErrorEvent) {
          sendDiagnostic('script-error');
        }
      });
      addEventListener('securitypolicyviolation', () => {
        sendDiagnostic('blocked-resource');
      });
      let previous = 0, pending = false, autoHeight = ${autoHeight};
      const layout = document.querySelector('style[' + ${JSON.stringify(layoutAttribute)} + ']');
      const updateLayout = () => {
        if (!layout || !document.body) return;
        const bodyStyle = getComputedStyle(document.body);
        const columnFlex = bodyStyle.display === 'flex' && bodyStyle.flexDirection.startsWith('column');
        layout.textContent = autoHeight
          ? ${JSON.stringify(autoLayout)} + (columnFlex ? ' body > * { flex: 0 0 auto !important; }' : '')
          : '';
      };
      const report = () => {
        pending = false;
        const body = document.body;
        if (!body) return;
        const style = getComputedStyle(body);
        const margin = (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
        // Viewport-sized roots must not feed margins or a safety pixel back into their own height.
        const fillsViewport = Math.abs(parseFloat(style.height) - innerHeight) <= 1;
        const height = fillsViewport && body.scrollHeight <= body.clientHeight + 1
          ? innerHeight
          : Math.ceil(Math.max(body.scrollHeight, body.offsetHeight) + margin);
        if (height !== previous) {
          previous = height;
          parent.postMessage({type: 'outline-html-height', channel, height}, '*');
        }
      };
      const schedule = () => { if (!pending) { pending = true; requestAnimationFrame(report); } };
      let restoredTabs = false;
      let restorePending = false;
      let savedTabs = [];
      let previousTabs = '';
      const restoreTabs = () => {
        if (!restorePending) return;
        let complete = true;
        for (const saved of savedTabs) {
          const target = [...document.querySelectorAll('nav [data-tab], nav [role="tab"], nav button')]
            .find(el =>
              (saved.tab && el.getAttribute('data-tab') === saved.tab) ||
              (saved.id && el.id === saved.id)
            );
          if (!target) {
            complete = false;
            continue;
          }
          if (target && !target.matches('[aria-selected="true"], .on, .active, .selected')) {
            target.click();
          }
        }
        if (complete) {
          restorePending = false;
          restoredTabs = true;
          reportTabs();
        }
      };
      document.addEventListener('click', event => {
        if (!restorePending || !event.isTrusted || !(event.target instanceof Element)) return;
        if (!event.target.closest('nav [data-tab], nav [role="tab"], nav button')) return;
        restorePending = false;
        restoredTabs = true;
        reportTabs();
      }, true);
      const reportTabs = () => {
        if (!restoredTabs) return;
        const tabs = [...document.querySelectorAll('nav [data-tab], nav [role="tab"], nav button')]
          .filter(el =>
            el.getAttribute('aria-selected') === 'true' ||
            ['on', 'active', 'selected'].some(name => el.classList.contains(name))
          )
          .map(el => ({ tab: el.getAttribute('data-tab'), id: el.id }))
          .filter(item => item.tab || item.id);
        const encoded = JSON.stringify(tabs);
        if (encoded === previousTabs) return;
        previousTabs = encoded;
        parent.postMessage({type: 'outline-html-tabs', channel, stateKey, tabs}, '*');
      };
      addEventListener('message', event => {
        if (event.source !== parent || event.data?.channel !== channel) return;
        if (event.data.type === 'outline-html-restore-tabs' && Array.isArray(event.data.tabs)) {
          savedTabs = event.data.tabs;
          restorePending = true;
          restoreTabs();
          reportTabs();
        }
        if (event.data.type === 'outline-html-layout' && typeof event.data.autoHeight === 'boolean') {
          autoHeight = event.data.autoHeight;
          updateLayout();
        }
        if (event.data.type === 'outline-html-measure' || event.data.type === 'outline-html-layout') {
          previous = 0;
          schedule();
        }
      });
      const observe = () => {
        updateLayout();
        if (document.body) new ResizeObserver(schedule).observe(document.body);
        if (document.body) {
          new MutationObserver(() => {
            updateLayout();
            restoreTabs();
            reportTabs();
          }).observe(document.body, {
            attributes: true,
            attributeFilter: ['class', 'aria-selected', 'style'],
            childList: true,
            subtree: true,
          });
        }
        schedule();
        reportTabs();
      };
      if (document.readyState === 'loading') {
        addEventListener('DOMContentLoaded', observe, {once: true});
      } else {
        observe();
      }
      addEventListener('load', () => {
        updateLayout();
        schedule();
      });
      addEventListener('resize', schedule);
      document.fonts?.ready.then(schedule);
    })();`;
    doc.head.prepend(bridge);
  }
  doc
    .querySelectorAll("meta[http-equiv=refresh i], base")
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
