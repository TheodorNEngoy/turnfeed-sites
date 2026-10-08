import { createHash } from "node:crypto";

const TURNFEED_VOICE_GUIDANCE = "Voice can use Turnfeed in supported conversations in the ChatGPT desktop app. Select Turnfeed in your conversation, start Voice, and ask it to read a recent post. You can discuss and draft a reply before asking to publish it. Availability and approval prompts depend on your client, account, and settings. If Voice cannot find Turnfeed, use a text chat with the plugin selected. Dictation turns speech into editable text; it does not start a Voice conversation.";

export const PUBLIC_NAV_SCRIPT = `(() => {
  const menus = document.querySelectorAll(".mobile-menu-shell");
  for (const menu of menus) {
    const trigger = menu.querySelector(":scope > summary");
    const panel = menu.nextElementSibling?.matches(".public-nav") ? menu.nextElementSibling : null;
    if (!trigger || !panel) continue;
    const header = menu.closest(".site-header");
    const main = menu.closest("main");
    const backgroundRegions = main
      ? Array.from(main.children).filter((region) => region !== header)
      : [];
    const pageFooter = document.querySelector("body > footer.footer");
    if (pageFooter) backgroundRegions.push(pageFooter);
    const narrowViewport = window.matchMedia("(max-width: 1023px)");
    const syncState = () => {
      trigger.setAttribute("aria-expanded", menu.open ? "true" : "false");
      for (const region of backgroundRegions) region.inert = menu.open;
      if (menu.open) requestAnimationFrame(() => panel.querySelector("a")?.focus());
    };
    menu.addEventListener("toggle", syncState);
    panel.addEventListener("click", (event) => {
      const link = event.target.closest("a");
      if (!link) return;
      const sameDocumentTarget =
        link.origin === window.location.origin &&
        link.pathname === window.location.pathname &&
        link.search === window.location.search &&
        link.hash
          ? document.getElementById(link.hash.slice(1))
          : null;
      menu.open = false;
      requestAnimationFrame(() => {
        if (sameDocumentTarget) {
          const hadTabindex = sameDocumentTarget.hasAttribute("tabindex");
          if (!hadTabindex) sameDocumentTarget.setAttribute("tabindex", "-1");
          sameDocumentTarget.focus({ preventScroll: true });
          if (!hadTabindex) {
            sameDocumentTarget.addEventListener(
              "blur",
              () => sameDocumentTarget.removeAttribute("tabindex"),
              { once: true }
            );
          }
          return;
        }
        trigger.focus();
      });
    });
    menu.addEventListener("click", (event) => {
      if (event.target === menu && menu.open) menu.open = false;
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !menu.open) return;
      menu.open = false;
      trigger.focus();
    });
    const syncViewportState = () => {
      if (!narrowViewport.matches) menu.open = false;
      syncState();
    };
    narrowViewport.addEventListener?.("change", syncViewportState);
    syncState();
  }

  const fallbackCopy = (value) => {
    const previousFocus = document.activeElement;
    const field = document.createElement("textarea");
    field.value = value;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    field.select();
    field.setSelectionRange(0, field.value.length);
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {}
    field.remove();
    previousFocus?.focus?.({ preventScroll: true });
    return copied;
  };

  const copyButtons = document.querySelectorAll("[data-copy-text]");
  for (const button of copyButtons) {
    button.addEventListener("click", async () => {
      const value = button.getAttribute("data-copy-text") || "";
      const statusId = button.getAttribute("aria-describedby");
      const status = statusId ? document.getElementById(statusId) : null;
      let copied = false;
      try {
        if (navigator.clipboard?.writeText && window.isSecureContext) {
          await navigator.clipboard.writeText(value);
          copied = true;
        }
      } catch {}
      if (!copied) copied = fallbackCopy(value);
      button.textContent = copied ? "Copied" : "Copy failed";
      if (status) {
        status.textContent = copied
          ? button.getAttribute("data-copy-success") || "Connection URL copied."
          : button.getAttribute("data-copy-failure") || "Could not copy automatically. Select the URL and copy it manually.";
      }
      window.setTimeout(() => {
        button.textContent = button.getAttribute("data-copy-idle-label") || "Copy URL";
      }, 2000);
    });
  }

})();`;

export const PUBLIC_NAV_SCRIPT_ETAG = `"${createHash("sha256").update(PUBLIC_NAV_SCRIPT).digest("hex")}"`;

/**
 * Render the public website from fixed public configuration and formatting helpers.
 * Health collection, request handling, authentication, and mutable application state
 * remain with the caller; healthHtml receives its already-built status payload.
 */
export function createPublicPages({
  PUBLIC_ORIGIN,
  PUBLIC_APP_NAME,
  PUBLIC_APP_TAGLINE,
  PUBLIC_OPERATOR_REGISTERED_NAME,
  PUBLIC_OPERATOR_ORGANISATION_NUMBER,
  PUBLIC_OPERATOR_FORM,
  PUBLIC_OPERATOR_JURISDICTION,
  PUBLIC_POLICY_LAST_UPDATED,
  PUBLIC_PRIVACY_LAST_UPDATED,
  BRAND_LOGO_PATH,
  BRAND_LOGO_MANIFEST_ICON_PATH,
  BRAND_LOGO_TOUCH_ICON_PATH,
  FAVICON_LOGO_PATH,
  FAVICON_LOGO_VERSION,
  PUBLIC_NAV_SCRIPT_PATH,
  SECURITY_TXT_PATH,
  MCP_INFO_PATH,
  MCP_PATH,
  CONNECTOR_AUTH_LABEL,
  TURNFEED_PRIMARY_CTA_URL,
  TURNFEED_DEMO_VIDEO_URL,
  TURNFEED_DEMO_VIDEO_EMBED_URL,
  OPENAI_APPS_HELP_URL,
  OPENAI_PRIVACY_URL,
  AUTH0_PRIVACY_URL,
  GOOGLE_PRIVACY_URL,
  RENDER_PRIVACY_URL,
  MAX_POSTS,
  MAX_REPLIES_PER_THREAD,
  MAX_TOTAL_REPLIES,
  MAX_ARCHIVED_POSTS,
  MAX_ARCHIVED_REPLIES,
  MAX_RETAINED_POSTS_PER_AUTHOR,
  MAX_RETAINED_REPLIES_PER_AUTHOR,
  MAX_LIKE_EVENTS,
  MAX_REPORTS,
  MAX_REPORTS_HARD_CAP,
  IMMEDIATE_SAFETY_REPORT_RESERVE,
  escapeHtml,
  jsonForHtmlScript,
  resolveSupportEmail,
  publicAppIconHeadMarkup,
  buildConnectorMetadataSnapshot,
}) {
// Preserve the template bodies and their whitespace when moving them out of the server.
function publicOperatorIdentityMarkup({ includeRegistration = true } = {}) {
  const name = escapeHtml(PUBLIC_OPERATOR_REGISTERED_NAME);
  if (!includeRegistration) return name;
  return `${name} · org. no. ${escapeHtml(PUBLIC_OPERATOR_ORGANISATION_NUMBER)}`;
}

function pageHtml({
  title,
  body,
  description = "",
  canonicalPath = "/",
  imagePath = BRAND_LOGO_PATH,
  origin = PUBLIC_ORIGIN,
  extraStyles = "",
  robotsContent = "index,follow,max-image-preview:large",
  showPublicNav = false,
  bodyClass = "",
}) {
  const metaDescription = escapeHtml(description || PUBLIC_APP_TAGLINE);
  const canonicalUrl = `${origin}${canonicalPath}`;
  const imageUrl = `${origin}${imagePath}`;
  const supportEmail = resolveSupportEmail(origin);
  const jsonLd = jsonForHtmlScript({
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: PUBLIC_APP_NAME,
    description: description || PUBLIC_APP_TAGLINE,
    applicationCategory: "SocialNetworkingApplication",
    operatingSystem: "Any",
    url: canonicalUrl,
    image: imageUrl,
    provider: {
      "@type": "Organization",
      name: PUBLIC_OPERATOR_REGISTERED_NAME,
      identifier: PUBLIC_OPERATOR_ORGANISATION_NUMBER,
    },
  });
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${metaDescription}" />
    <meta name="robots" content="${escapeHtml(robotsContent)}" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${metaDescription}" />
    <meta property="og:site_name" content="${escapeHtml(PUBLIC_APP_NAME)}" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${escapeHtml(canonicalUrl)}" />
    <meta property="og:image" content="${escapeHtml(imageUrl)}" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${metaDescription}" />
    <meta name="twitter:image" content="${escapeHtml(imageUrl)}" />
    ${publicAppIconHeadMarkup(origin)}
    <link rel="canonical" href="${escapeHtml(canonicalUrl)}" />
    <script type="application/ld+json">${jsonLd}</script>
    ${showPublicNav ? `<script src="${PUBLIC_NAV_SCRIPT_PATH}" defer></script>` : ""}
    <style>
      :root {
        color: #13233f;
        color-scheme: light;
        font-family: "Nunito Sans", "Avenir Next", "Helvetica Neue", "Segoe UI", sans-serif;
        --bg: #f3f6fb;
        --panel: rgba(255,255,255,.92);
        --panel-strong: #ffffff;
        --line: #e2e8f2;
        --text-soft: #44546e;
        --text-muted: #5b6b85;
        --brand: #2273e0;
        --brand-dark: #1c63c7;
        --brand-soft: #edf4ff;
        --accent: #1f8463;
        --preview: #edf6f1;
        --ink: #13233f;
        --radius: 12px;
      }
      * { box-sizing: border-box; }
      html {
        scroll-behavior: smooth;
        -webkit-text-size-adjust: 100%;
        text-size-adjust: 100%;
      }
      @media (prefers-reduced-motion: reduce) {
        html { scroll-behavior: auto; }
      }
      body {
        margin: 0;
        min-height: 100vh;
        padding: 0 24px 32px;
        background: var(--bg);
        color: var(--ink);
      }
      main {
        max-width: 1120px;
        margin: 0 auto;
        padding: 0;
      }
      h1 { margin: 0 0 10px; font-size: clamp(2rem, 5vw, 3.4rem); line-height: 1.04; letter-spacing: -.035em; }
      h2 { margin: 0 0 8px; font-size: 1.22rem; line-height: 1.25; letter-spacing: -.015em; }
      h3 { line-height: 1.3; }
      p, li { line-height: 1.58; }
      a { color: var(--brand-dark); text-decoration: none; }
      a:hover { text-decoration: underline; }
      a:focus-visible,
      button:focus-visible,
      summary:focus-visible {
        outline: 2px solid var(--brand-dark);
        outline-offset: 2px;
      }
      .site-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 20px;
        min-height: 72px;
        margin: 0 auto 24px;
        border-bottom: 1px solid var(--line);
        background: var(--bg);
        font-size: .9rem;
        font-weight: 700;
      }
      .public-nav-brand {
        display: inline-flex;
        align-items: center;
        gap: 9px;
        min-height: 44px;
        color: var(--ink);
        font-size: 1rem;
        letter-spacing: -.01em;
        text-decoration: none;
      }
      .public-nav-mark {
        width: 32px;
        height: 32px;
        flex: 0 0 auto;
        display: block;
        object-fit: contain;
        border-radius: 8px;
      }
      .mobile-menu-shell {
        display: none;
      }
      .mobile-menu-shell > summary {
        display: none;
      }
      .public-nav .mobile-only-link { display: none; }
      .public-nav {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 2px;
      }
      .public-nav-group {
        display: contents;
      }
      .public-nav-group-label,
      .mobile-menu-cta,
      .mobile-menu-note {
        display: none;
      }
      .public-nav > .mobile-menu-cta { display: none; }
      .public-nav a {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 44px;
        min-height: 44px;
        padding: 0 9px;
        border-radius: 9px;
        color: #33415c;
        text-decoration: none;
        white-space: nowrap;
        transition: background .16s ease, color .16s ease;
      }
      .public-nav a:hover,
      .public-nav a:focus-visible {
        background: var(--brand-soft);
        color: var(--ink);
        text-decoration: none;
      }
      .public-nav a[aria-current="page"] {
        color: var(--ink);
        background: #e8eef7;
      }
      .brand-lockup {
        display: flex;
        align-items: center;
        gap: 14px;
        margin-bottom: 16px;
      }
      .brand-copy {
        display: grid;
        gap: 6px;
      }
      .brand-mark {
        width: 58px;
        height: 58px;
        flex: 0 0 auto;
        display: block;
        object-fit: contain;
        border-radius: 8px;
      }
      code {
        display: inline-block;
        max-width: 100%;
        background: #eef4ff;
        padding: 2px 6px;
        border-radius: 8px;
        overflow-wrap: anywhere;
        word-break: break-word;
        vertical-align: middle;
      }
      p code,
      li code,
      figcaption code {
        display: inline;
        line-height: inherit;
        vertical-align: baseline;
        -webkit-box-decoration-break: clone;
        box-decoration-break: clone;
      }
      p strong,
      li strong,
      figcaption strong {
        line-height: inherit;
        vertical-align: baseline;
      }
      .muted { color: var(--text-soft); }
      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin: 0 0 12px;
        padding: 8px 12px;
        border-radius: 8px;
        background: rgba(255,255,255,.72);
        border: 1px solid var(--line);
        color: #274060;
        font-size: .82rem;
        font-weight: 700;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      .hero {
        display: grid;
        grid-template-columns: minmax(0, 1.3fr) minmax(280px, .9fr);
        gap: 20px;
        align-items: stretch;
      }
      .hero-copy p.lead {
        margin: 0 0 16px;
        font-size: 1.05rem;
        color: var(--text-soft);
      }
      .hero-actions, .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
      .btn, .pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-height: 46px;
        padding: 11px 15px;
        border-radius: 10px;
        border: 1px solid var(--line);
        background: #fff;
        color: inherit;
        font-weight: 600;
        text-decoration: none;
        align-self: flex-start;
      }
      .btn-primary {
        background: var(--brand);
        color: #fff;
        border-color: transparent;
      }
      .btn:hover,
      .pill:hover { text-decoration: none; border-color: #bdc9da; }
      .btn-primary:hover { background: var(--brand-dark); border-color: transparent; }
      .hero-card, .section, .pill-card {
        background: var(--panel-strong);
        border: 1px solid var(--line);
        border-radius: 8px;
      }
      .hero-card {
        padding: 18px;
        display: grid;
        gap: 14px;
      }
      .hero-stat-grid, .grid {
        display: grid;
        gap: 12px;
      }
      .hero-stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .metric {
        padding: 14px;
        border-radius: 8px;
        background: linear-gradient(180deg, #f9fbff 0%, #f3f7ff 100%);
        border: 1px solid rgba(15,23,42,.06);
      }
      .metric strong {
        display: block;
        font-size: 1.05rem;
        margin-bottom: 4px;
      }
      .stack { display: grid; gap: 18px; margin-top: 22px; }
      .section {
        padding: 18px;
      }
      .grid {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
      .pill-card {
        padding: 16px;
        background: rgba(255,255,255,.92);
      }
      .pill-card p { margin: 0; color: var(--text-soft); }
      .utility-list {
        display: grid;
        gap: 10px;
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .utility-list li {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 0;
        border-top: 1px solid var(--line);
      }
      .utility-list li:first-child { border-top: 0; padding-top: 0; }
      .footer {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
        justify-content: space-between;
        margin-top: 44px;
        padding: 28px 0 8px;
        border-top: 1px solid var(--line);
      }
      .footer .row { gap: 4px 14px; }
      .footer .pill {
        min-height: 44px;
        padding: 8px 0;
        border: 0;
        background: transparent;
        color: #33415c;
      }
      .footer .muted {
        overflow-wrap: anywhere;
      }
      .footer-note {
        flex-basis: 100%;
        width: 100%;
        margin: 0;
        font-size: .92rem;
      }
      .document-hero {
        display: grid;
        gap: 18px;
        max-width: 860px;
        padding: clamp(34px, 6vw, 70px) 0 clamp(34px, 5vw, 58px);
      }
      .document-hero .brand-lockup {
        margin: 0;
      }
      .document-hero .brand-mark {
        width: 52px;
        height: 52px;
      }
      .document-hero h1 {
        margin: 0;
        font-size: clamp(2.6rem, 6vw, 4.35rem);
        line-height: .98;
        letter-spacing: -.045em;
      }
      .document-kicker,
      .document-toc-label {
        margin: 0;
        color: #52627a;
        font-family: "IBM Plex Mono", "SFMono-Regular", "Cascadia Code", monospace;
        font-size: .7rem;
        font-weight: 800;
        letter-spacing: .055em;
        text-transform: uppercase;
      }
      .document-lead {
        max-width: 68ch;
        margin: 0;
        color: #3f526c;
        font-size: clamp(1.08rem, 1.55vw, 1.24rem);
        line-height: 1.62;
      }
      .document-meta {
        margin: 0;
        color: var(--text-muted);
        font-size: .92rem;
      }
      .document-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
      }
      .document-layout {
        display: grid;
        grid-template-columns: minmax(176px, 220px) minmax(0, 68ch);
        gap: clamp(40px, 7vw, 84px);
        align-items: start;
        max-width: 1020px;
        margin: 0 auto;
      }
      .document-toc {
        position: sticky;
        top: 22px;
        display: grid;
        gap: 12px;
        padding: 6px 0 18px;
      }
      .document-toc-list {
        display: grid;
        gap: 2px;
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .document-toc a {
        display: flex;
        align-items: center;
        min-height: 40px;
        padding: 7px 10px;
        border-left: 2px solid #d9e1ec;
        color: #465970;
        font-size: .9rem;
        font-weight: 700;
        line-height: 1.28;
        text-decoration: none;
      }
      .document-toc a:hover,
      .document-toc a:focus-visible {
        border-left-color: var(--brand);
        color: var(--ink);
        background: rgba(255,255,255,.62);
        text-decoration: none;
      }
      .document-content {
        min-width: 0;
      }
      .document-section {
        scroll-margin-top: 24px;
        padding: clamp(38px, 5vw, 58px) 0;
        border-top: 1px solid rgba(19,35,63,.13);
      }
      .document-section:first-child {
        padding-top: 6px;
        border-top: 0;
      }
      .document-section-head {
        display: grid;
        gap: 10px;
        margin-bottom: 8px;
      }
      .document-section-head h2 {
        margin: 0;
        color: #101f36;
        font-size: clamp(1.45rem, 2.7vw, 2rem);
        line-height: 1.16;
        letter-spacing: -.025em;
      }
      .document-section-head p,
      .document-row p,
      .document-row li,
      .document-note {
        color: var(--text-soft);
      }
      .document-section-head p,
      .document-row p,
      .document-note {
        margin: 0;
      }
      .document-rows {
        display: grid;
        gap: 0;
      }
      .document-row {
        min-width: 0;
        padding: 22px 0;
        border-top: 1px solid rgba(19,35,63,.1);
      }
      .document-row:first-child {
        border-top: 0;
      }
      .document-row > strong,
      .document-row h3 {
        display: block;
        margin: 0 0 7px;
        color: #11213a;
        font-size: 1.04rem;
        line-height: 1.35;
      }
      .document-row p + p,
      .document-row ul + p,
      .document-row p + ul {
        margin-top: 10px;
      }
      .document-row ul {
        margin: 9px 0 0;
        padding-left: 20px;
      }
      .document-row li + li {
        margin-top: 7px;
      }
      .document-row code {
        margin-top: 9px;
      }
      .document-callout {
        margin: 14px 0 0;
        padding: 16px 18px;
        border-left: 3px solid var(--brand);
        background: rgba(237,244,255,.72);
        color: #30465f;
      }
      .document-callout p {
        margin: 0;
      }
      .document-callout p + p {
        margin-top: 8px;
      }
      .document-details {
        margin-top: 18px;
        border-top: 1px solid rgba(19,35,63,.12);
        border-bottom: 1px solid rgba(19,35,63,.12);
      }
      .document-details summary {
        display: flex;
        align-items: center;
        min-height: 52px;
        cursor: pointer;
        color: #203a59;
        font-weight: 800;
      }
      .document-details[open] summary {
        border-bottom: 1px solid rgba(19,35,63,.1);
      }
      .document-details-body {
        padding: 4px 0 18px;
      }
      @media (max-width: 1023px) {
        html,
        body {
          max-width: 100%;
          overflow-x: hidden;
        }
        body { padding: 0 20px 24px; }
        main {
          width: 100%;
          max-width: 100%;
          margin: 0 auto;
          overflow: visible;
          padding: 0;
        }
        .site-header {
          position: relative;
          min-height: 64px;
          margin-bottom: 20px;
        }
        .mobile-menu-shell {
          display: block;
        }
        .mobile-menu-shell > summary {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 72px;
          min-height: 44px;
          padding: 0 12px;
          border: 1px solid #cfd8e6;
          border-radius: 10px;
          background: #fff;
          color: var(--ink);
          cursor: pointer;
          list-style: none;
        }
        .mobile-menu-shell > summary::-webkit-details-marker { display: none; }
        .mobile-menu-shell > summary .close-label { display: none; }
        .mobile-menu-shell[open] > summary .menu-label { display: none; }
        .mobile-menu-shell[open] > summary .close-label { display: inline; }
        .mobile-menu-shell[open]::before {
          content: "";
          position: fixed;
          z-index: 18;
          inset: 70px 0 0;
          background: rgba(19,35,63,.42);
        }
        .public-nav {
          position: absolute;
          z-index: 20;
          top: 100%;
          right: 0;
          left: 0;
          display: grid;
          gap: 18px;
          max-height: calc(100dvh - 69px);
          overflow-y: auto;
          overscroll-behavior: contain;
          padding: 20px;
          border: 1px solid var(--line);
          border-radius: 14px;
          background: #fff;
          box-shadow: 0 24px 60px rgba(19,35,63,.16);
          font-size: .95rem;
        }
        .mobile-menu-shell:not([open]) + .public-nav { display: none; }
        .public-nav .mobile-only-link { display: flex; }
        .public-nav-group {
          display: grid;
          gap: 2px;
        }
        .public-nav-group-label {
          display: block;
          margin: 0 0 5px;
          color: var(--text-muted);
          font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
          font-size: .7rem;
          font-weight: 700;
          letter-spacing: .04em;
          text-transform: uppercase;
        }
        .public-nav a {
          justify-content: flex-start;
          width: 100%;
          min-height: 44px;
          padding: 0 10px;
        }
        .public-nav a[aria-current="page"].mobile-only-link::after {
          content: "Current";
          margin-left: auto;
          padding: 3px 7px;
          border-radius: 6px;
          background: #dbe9fb;
          color: var(--brand-dark);
          font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
          font-size: .62rem;
          letter-spacing: .05em;
          text-transform: uppercase;
        }
        .mobile-menu-cta {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 48px;
          padding: 0 14px;
          border-radius: 10px;
          background: var(--brand);
          color: #fff !important;
          font-weight: 800;
        }
        .public-nav > .mobile-menu-cta { display: inline-flex; }
        .mobile-menu-note {
          display: block;
          margin: 0;
          color: var(--text-muted);
          font-size: .82rem;
          line-height: 1.45;
        }
        .public-nav .mobile-menu-note a {
          display: inline;
          width: auto;
          min-width: 0;
          min-height: 0;
          padding: 0;
          white-space: normal;
          text-decoration: underline;
        }
        .hero, .grid, .hero-stat-grid { grid-template-columns: 1fr; }
        .brand-lockup,
        .brand-copy {
          min-width: 0;
        }
        .brand-lockup h1 {
          overflow-wrap: anywhere;
          word-break: break-word;
        }
        .document-hero {
          padding: 28px 0 36px;
        }
        .document-hero h1 {
          font-size: clamp(2.45rem, 12vw, 3.5rem);
        }
        .document-layout {
          grid-template-columns: 1fr;
          gap: 30px;
          margin: 0;
        }
        .document-toc {
          position: static;
          gap: 10px;
          padding: 0 0 8px;
          border-bottom: 1px solid rgba(19,35,63,.12);
        }
        .document-toc-list {
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 0 12px;
        }
        .document-toc a {
          min-height: 44px;
          padding: 8px 0;
          border-left: 0;
          border-top: 1px solid rgba(19,35,63,.08);
        }
        .document-toc li:nth-child(-n + 2) a {
          border-top: 0;
        }
        .document-toc a:hover,
        .document-toc a:focus-visible {
          border-left-color: transparent;
          background: transparent;
        }
        .document-section {
          scroll-margin-top: 16px;
          padding: 38px 0;
        }
      }
      @media (max-width: 520px) {
        body { padding-right: 18px; padding-left: 18px; }
        .document-hero .brand-lockup {
          align-items: flex-start;
        }
        .document-hero .brand-mark {
          width: 46px;
          height: 46px;
        }
        .document-actions .btn {
          width: 100%;
          justify-content: center;
        }
        .document-toc-list {
          grid-template-columns: 1fr;
        }
        .document-toc li:nth-child(2) a {
          border-top: 1px solid rgba(19,35,63,.08);
        }
      }
      ${extraStyles || ""}
    </style>
  </head>
  <body${bodyClass ? ` class="${escapeHtml(bodyClass)}"` : ""}>
    <main>
      ${showPublicNav ? publicSiteNavMarkup(canonicalPath) : ""}
      ${body}
    </main>
      <footer class="footer">
        <div class="row">
          <a class="pill" href="/privacy">Privacy</a>
          <a class="pill" href="/terms">Terms</a>
          <a class="pill" href="/guidelines">Community Guidelines</a>
          <a class="pill" href="/security">Security</a>
          <a class="pill" href="/support">Support</a>
          <a class="pill" href="https://github.com/TheodorNEngoy/turnfeed-mcp-example" target="_blank" rel="noopener noreferrer">Open-source example</a>
        </div>
        <p class="muted">Support: <a href="mailto:${supportEmail}">${supportEmail}</a></p>
        <p class="muted footer-note">Operated from Norway by ${publicOperatorIdentityMarkup({ includeRegistration: false })}.</p>
        <p class="muted footer-note">Turnfeed is an independent plugin for ChatGPT and Codex. It is not made, endorsed, or operated by OpenAI.</p>
      </footer>
  </body>
</html>`;
}

function publicSiteNavMarkup(currentPath = "/") {
  const sectionPrefix = currentPath === "/" ? "" : "/";
  const groups = [
    {
      label: "Product",
      links: [
        { href: "/", label: "Home", path: "/", mobileOnly: true },
        { href: `${sectionPrefix}#demo`, label: "Demo" },
        { href: `${sectionPrefix}#flow`, label: "How it works" },
        { href: `${sectionPrefix}#faq`, label: "FAQ" },
        { href: "/status", label: "Status", path: "/status" },
      ],
    },
    {
      label: "Help",
      links: [
        { href: "/mcp-info", label: "Setup and help", path: "/mcp-info" },
        { href: "/support", label: "Support", path: "/support" },
      ],
    },
    {
      label: "Trust & legal",
      links: [
        { href: "/privacy", label: "Privacy", path: "/privacy" },
        { href: "/terms", label: "Terms", path: "/terms" },
        { href: "/guidelines", label: "Guidelines", path: "/guidelines" },
        { href: "/security", label: "Security", path: "/security" },
      ],
    },
  ];
  return `
      <header class="site-header">
        <a class="public-nav-brand" href="/" aria-label="${escapeHtml(`${PUBLIC_APP_NAME} home`)}"${currentPath === "/" ? ' aria-current="page"' : ""}>
          ${brandLogoImgMarkup({ className: "public-nav-mark", title: "", width: 32, height: 32 })}<span>${escapeHtml(PUBLIC_APP_NAME)}</span>
        </a>
        <details class="mobile-menu-shell">
          <summary aria-label="Toggle site menu" aria-controls="public-site-menu" aria-expanded="false"><span class="menu-label">Menu</span><span class="close-label">Close</span></summary>
        </details>
        <nav class="public-nav" id="public-site-menu" aria-label="${escapeHtml(`${PUBLIC_APP_NAME} public site`)}">
          ${groups.map((group) => `
            <div class="public-nav-group">
              <span class="public-nav-group-label">${escapeHtml(group.label)}</span>
              ${group.links.map((link) => {
                const isCurrent = link.path && link.path === currentPath;
                return `<a${link.mobileOnly ? ' class="mobile-only-link"' : ""} href="${escapeHtml(link.href)}"${isCurrent ? ' aria-current="page"' : ""}>${escapeHtml(link.label)}</a>`;
              }).join("")}
            </div>`).join("")}
          <a class="mobile-menu-cta" href="${escapeHtml(TURNFEED_PRIMARY_CTA_URL)}" target="_blank" rel="noopener noreferrer">Open Turnfeed in ChatGPT</a>
          <p class="mobile-menu-note">Use Turnfeed in ChatGPT, or <a href="/mcp-info#connection-codex">use it in Codex</a>. Account connection and action approval are separate; your client's permissions apply.</p>
        </nav>
      </header>`;
}

function notFoundPageHtml(origin = PUBLIC_ORIGIN) {
  return pageHtml({
    title: `Page not found · ${PUBLIC_APP_NAME}`,
    description: "The Turnfeed page you requested could not be found.",
    canonicalPath: "/404",
    origin,
    robotsContent: "noindex,nofollow",
    showPublicNav: true,
    body: `
      <section class="document-hero" aria-labelledby="not-found-title">
        <p class="document-kicker">Page not found</p>
        <div class="brand-lockup">
          ${brandLogoImgMarkup({ className: "brand-mark", title: "", width: 52, height: 52 })}
          <div class="brand-copy">
            <h1 id="not-found-title">That page isn’t here.</h1>
          </div>
        </div>
        <p class="document-lead">The address may be outdated or the page may have moved. You can return to Turnfeed or open support if you were following a link that should still work.</p>
        <div class="document-actions">
          <a class="btn btn-primary" href="/">Go to Turnfeed home</a>
          <a class="btn" href="/support">Get support</a>
        </div>
      </section>`,
  });
}

function brandLogoImgMarkup({
  className = "brand-mark",
  title = `${PUBLIC_APP_NAME} logo`,
  origin = PUBLIC_ORIGIN,
  width = 58,
  height = 58,
} = {}) {
  const brandLogoUrl = `${FAVICON_LOGO_PATH}?v=${encodeURIComponent(FAVICON_LOGO_VERSION)}`;
  return `<img class="${escapeHtml(className)}" src="${escapeHtml(brandLogoUrl)}" alt="${escapeHtml(title)}" width="${Number(width)}" height="${Number(height)}" loading="eager" fetchpriority="high" decoding="async" draggable="false" />`;
}

function turnfeedMarkSvgDocument() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="512" height="512" viewBox="0 0 160 160" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeHtml(PUBLIC_APP_NAME)} logo">
  <title>${escapeHtml(PUBLIC_APP_NAME)} logo</title>
  <rect width="160" height="160" rx="28" fill="white"/>
  <path fill="#05060F" d="M52 30H108C125.673 30 140 44.327 140 62V84C140 101.673 125.673 116 108 116H78.5L56.5 134C53.108 136.775 48 134.36 48 129.977V116H52C34.327 116 20 101.673 20 84V62C20 44.327 34.327 30 52 30Z"/>
  <rect x="36" y="46" width="88" height="52" rx="18" fill="white"/>
  <rect x="49" y="60" width="12" height="28" rx="6" fill="#05060F"/>
  <rect x="63" y="54" width="12" height="40" rx="6" fill="#05060F"/>
  <rect x="77" y="48" width="12" height="52" rx="6" fill="#05060F"/>
  <rect x="91" y="54" width="12" height="40" rx="6" fill="#05060F"/>
  <rect x="105" y="60" width="12" height="28" rx="6" fill="#05060F"/>
</svg>`;
}

function privacyPageHtml(origin = PUBLIC_ORIGIN) {
  const supportEmail = resolveSupportEmail(origin);
  const landingUrl = origin;
  const termsUrl = `${origin}/terms`;
  const supportUrl = `${origin}/support`;
  return pageHtml({
    origin,
    title: `${PUBLIC_APP_NAME} · Privacy`,
    canonicalPath: "/privacy",
    description: `Public privacy policy for ${PUBLIC_APP_NAME}. Covers Turnfeed feed data, visibility, support, moderation, retention, recipients, and account controls.`,
    showPublicNav: true,
    extraStyles: `
      .privacy-hero {
        display: grid;
        grid-template-columns: minmax(0, 1.12fr) minmax(300px, .88fr);
        gap: 20px;
        align-items: start;
        padding: 22px;
        border-radius: 8px;
        background: linear-gradient(135deg, rgba(255,255,255,.98) 0%, rgba(246,250,255,.98) 54%, rgba(240,248,244,.95) 100%);
        border: 1px solid rgba(15,23,42,.07);
      }
      .privacy-copy {
        display: grid;
        gap: 16px;
        align-content: start;
      }
      .privacy-copy .lead {
        margin: 0;
        max-width: 64ch;
        font-size: 1.05rem;
        line-height: 1.6;
        color: var(--text-soft);
      }
      .privacy-actions,
      .privacy-chip-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px 16px;
      }
      .privacy-jump {
        display: grid;
        gap: 8px;
      }
      .privacy-jump-label {
        margin: 0;
        font-family: "IBM Plex Mono", "SFMono-Regular", "Cascadia Code", monospace;
        font-size: .72rem;
        font-weight: 700;
        letter-spacing: 0;
        text-transform: uppercase;
        color: var(--text-muted);
      }
      .privacy-chip {
        display: inline-flex;
        align-items: center;
        min-height: 44px;
        padding: 8px 0;
        border-radius: 0;
        border: 0;
        background: transparent;
        line-height: 1.2;
        font-family: "IBM Plex Mono", "SFMono-Regular", "Cascadia Code", monospace;
        font-size: .76rem;
        font-weight: 700;
        letter-spacing: 0;
        text-transform: uppercase;
        color: #284763;
        text-decoration: underline;
        text-decoration-thickness: 1px;
        text-underline-offset: 4px;
        transition: color .16s ease;
      }
      .privacy-chip:hover,
      .privacy-chip:focus-visible {
        color: #165df5;
      }
      .privacy-overview {
        display: grid;
        gap: 12px;
      }
      .privacy-overview-card {
        display: grid;
        gap: 4px;
        padding: 0;
        border-radius: 8px;
        background: transparent;
        border: 0;
      }
      .privacy-overview-card p,
      .privacy-card p,
      .privacy-note,
      .privacy-contact p {
        margin: 0;
        color: var(--text-soft);
        line-height: 1.5;
      }
      .privacy-stat-grid,
      .privacy-grid,
      .privacy-next-grid {
        display: grid;
        gap: 12px;
        align-items: start;
      }
      .privacy-stat-grid {
        grid-template-columns: 1fr;
        gap: 0;
      }
      .privacy-stat {
        padding: 13px 0;
        border-radius: 0;
        background: transparent;
        border: 0;
        border-top: 1px solid rgba(15,23,42,.08);
      }
      .privacy-stat > strong,
      .privacy-card > strong,
      .privacy-contact > strong {
        display: block;
        margin-bottom: 4px;
      }
      .privacy-stack {
        display: grid;
        gap: 18px;
        margin-top: 22px;
      }
      .privacy-section {
        padding: clamp(22px, 4vw, 34px) 0 0;
        border-radius: 0;
        background: transparent;
        border: 0;
        border-top: 1px solid rgba(15,23,42,.1);
      }
      .privacy-section-head {
        display: grid;
        gap: 8px;
        margin-bottom: 16px;
      }
      .privacy-section-head p {
        margin: 0;
        color: var(--text-soft);
      }
      .privacy-grid {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
      .privacy-next-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .privacy-card,
      .privacy-contact {
        align-self: start;
        padding: 16px;
        border-radius: 12px;
        background: rgba(255,255,255,.92);
        border: 1px solid rgba(15,23,42,.07);
      }
      .privacy-card ul {
        margin: 10px 0 0;
        padding-left: 18px;
        color: var(--text-soft);
      }
      .privacy-card li {
        margin: 0 0 8px;
      }
      .privacy-note {
        margin-top: 10px;
      }
      .privacy-contact code {
        display: inline-block;
        margin-top: 8px;
      }
      @media (max-width: 900px) {
        .privacy-hero,
        .privacy-grid,
        .privacy-next-grid,
        .privacy-stat-grid {
          grid-template-columns: 1fr;
        }
        .privacy-hero { padding: 22px 18px; }
      }
      .privacy-stack {
        gap: 0;
        margin: 0;
      }
      .privacy-section {
        scroll-margin-top: 24px;
        padding: clamp(38px, 5vw, 58px) 0;
        border-top: 1px solid rgba(19,35,63,.13);
      }
      .privacy-section:first-child {
        padding-top: 6px;
        border-top: 0;
      }
      .privacy-section-head {
        gap: 10px;
        margin-bottom: 8px;
      }
      .privacy-section-head h2 {
        font-size: clamp(1.45rem, 2.7vw, 2rem);
        line-height: 1.16;
        letter-spacing: -.025em;
      }
      .privacy-grid,
      .privacy-next-grid {
        grid-template-columns: 1fr;
        gap: 0;
      }
      .privacy-card,
      .privacy-contact {
        padding: 22px 0;
        border: 0;
        border-top: 1px solid rgba(19,35,63,.1);
        border-radius: 0;
        background: transparent;
      }
      .privacy-card:first-child,
      .privacy-contact:first-child {
        border-top: 0;
      }
    `,
    body: `
    <section class="document-hero">
      <p class="document-kicker">Trust &amp; legal</p>
        <div class="brand-lockup">
          ${brandLogoImgMarkup({ title: `${PUBLIC_APP_NAME} logo`, origin })}
          <div class="brand-copy">
            <h1>Privacy policy</h1>
          </div>
        </div>
        <p class="document-lead">${PUBLIC_APP_NAME} stores the feed, profile, account, safety, and support data needed to run the service. Using Turnfeed does not automatically publish your conversation. ChatGPT or Codex sends inputs for your request, such as search terms, post text, or a post identifier. Turnfeed's tools do not request your full conversation history; information from your conversation or other task context may be included in those inputs. <a href="#privacy-visibility">See what that means</a>.</p>
        <p class="document-meta">Last updated: ${escapeHtml(PUBLIC_PRIVACY_LAST_UPDATED)}.</p>
        <div class="document-actions">
          <a class="btn btn-primary" href="/support">Get support</a>
          <a class="btn" href="/terms">Read the terms</a>
        </div>
    </section>
    <div class="document-layout">
      <aside class="document-toc">
        <p class="document-toc-label">On this page</p>
        <nav aria-label="Privacy page sections">
          <ul class="document-toc-list">
            <li><a href="#privacy-data-safety">Data and safety</a></li>
            <li><a href="#privacy-visibility">Public and private</a></li>
            <li><a href="#privacy-recipients">Who receives data</a></li>
            <li><a href="#privacy-processing">Processing and retention</a></li>
            <li><a href="#privacy-rights">Norway and EEA rights</a></li>
            <li><a href="#privacy-controls">Your controls</a></li>
          </ul>
        </nav>
      </aside>
      <div class="document-content">
      <div class="privacy-stack">
      <section class="privacy-section" id="privacy-data-safety">
        <div class="privacy-section-head">
          <h2>What Turnfeed stores</h2>
          <p>Turnfeed stores the information needed to show your posts, conversations, profile, and account settings.</p>
        </div>
        <div class="privacy-grid">
          <article class="privacy-card">
            <strong>Turnfeed feed and thread data</strong>
            <p>Turnfeed stores public posts and replies, likes and follows, private reports, and information needed to show conversations, link previews, notifications, and moderation decisions.</p>
            <ul>
              <li>Posts, replies, earlier versions of edited text, likes, follows, reports, and timestamps</li>
              <li>Quoted-post references, link previews, and media metadata</li>
              <li>Report reasons and report history included in account export</li>
            </ul>
          </article>
          <article class="privacy-card">
            <strong>Profile and settings</strong>
            <p>Turnfeed stores the profile details you choose to share and the settings you use to manage your account.</p>
            <ul>
              <li>Display name, handle, bio, website, and avatar URL</li>
              <li>Pinned profile lead post and profile counts</li>
              <li>Notification preferences, hidden words, muted people, and blocked people</li>
            </ul>
          </article>
          <article class="privacy-card">
            <strong>Inbox and account state</strong>
            <p>Your Turnfeed inbox contains private notifications and account activity. Follower and following lists are public. Turnfeed does not currently offer direct messages.</p>
            <ul>
              <li>Notification, mute, block, hidden-word, and account-control state</li>
              <li>Reply, like, and follow notifications</li>
              <li>Viewer-specific account state kept separate from public profile data</li>
            </ul>
          </article>
          <article class="privacy-card">
            <strong>Children and sensitive data</strong>
            <p>Turnfeed is not intended for children under 13 or the applicable age of digital consent. It is not meant for protected health information, payment card data, government ID numbers, passwords, or similarly sensitive data.</p>
          </article>
        </div>
      </section>
      <section class="privacy-section" id="privacy-visibility">
        <div class="privacy-section-head">
          <h2>What is public versus private</h2>
          <p>Your posts and profile can be read by other people. Your inbox notifications and personal safety settings are private.</p>
        </div>
        <div class="privacy-next-grid">
          <article class="privacy-card">
            <strong>Public feed and profiles</strong>
            <p>Anyone can read the public feed without signing in. Public profile details, posts, replies, likes, pinned posts, and follower and following lists can be viewed on the web or through a direct link and can appear in search results.</p>
            <p><strong>Editing does not erase earlier text.</strong> Earlier versions of edited posts and replies can remain visible in public edit history. If you need information removed, delete the post or reply or contact support. Copies made by other people and the retained records described below may remain.</p>
            <p class="privacy-note">If you post it publicly, treat it as something anyone could open, copy, or share.</p>
          </article>
          <article class="privacy-card">
            <strong>Inbox and viewer-only settings</strong>
            <p>Inbox notifications, notification preferences, hidden words, and mute/block settings are private account data. Follower and following lists are public. The inbox does not contain direct messages.</p>
            <p class="privacy-note">Blocking and muting propagate through feed, inbox, and discovery instead of only hiding one UI surface.</p>
          </article>
          <article class="privacy-card">
            <strong>Conversation and request context</strong>
            <p>Sending information to Turnfeed is different from publishing it. Reading public posts sends request inputs to the service without creating a public post. A publishing action makes the supplied post or reply text public.</p>
            <p class="privacy-note"><strong>Relevant request context</strong> includes inputs such as search terms, the exact text you ask to publish, a post or reply identifier, or a profile field. Turnfeed's tools do not request your full conversation history. Your client may use conversation, memory, or other task context when preparing these inputs, and text you ask to publish may contain that information.</p>
          </article>
        </div>
      </section>
      <section class="privacy-section" id="privacy-recipients">
        <div class="privacy-section-head">
          <h2>Categories of recipients</h2>
          <p>These are the groups that can receive or process Turnfeed data, depending on the action a user takes.</p>
        </div>
        <div class="privacy-grid">
          <article class="privacy-card">
            <strong>Other Turnfeed users</strong>
            <p>Public posts, replies, visible edit history, profile details, likes, follower and following lists, and public media references can be accessed by anyone with web access or a direct link.</p>
          </article>
          <article class="privacy-card">
            <strong>Hosting and storage providers</strong>
            <p>Turnfeed currently uses Render to host the service and its PostgreSQL database. Render processes service traffic, stored product data, runtime logs, and recovery copies so Turnfeed can serve pages, MCP tools, feeds, moderation views, and account controls. See <a href="${escapeHtml(RENDER_PRIVACY_URL)}" target="_blank" rel="noopener noreferrer">Render's privacy policy</a>.</p>
          </article>
          <article class="privacy-card">
            <strong>Link and media destinations</strong>
            <p>When link previews or user-provided media URLs are used, destination sites can receive the requested URL, request timing, and server or browser network information needed to fetch that resource. Loading the embedded demo on the Turnfeed home page contacts YouTube/Google through a <code>youtube-nocookie.com</code> player; Google processes the resulting request under its <a href="${escapeHtml(GOOGLE_PRIVACY_URL)}" target="_blank" rel="noopener noreferrer">privacy policy</a>.</p>
          </article>
          <article class="privacy-card">
            <strong>Operator, support, and moderation reviewers</strong>
            <p>The operator and support/moderation reviewers may access reports, hidden or reported content, support details, abuse-control records, and current admin dashboard state when needed to run, secure, or moderate the Turnfeed service.</p>
          </article>
          <article class="privacy-card">
            <strong>OpenAI, ChatGPT, and Codex</strong>
            <p>When you use Turnfeed through ChatGPT or Codex, OpenAI processes your conversation, task context, and tool interactions under its own account, product, and platform controls. The client sends Turnfeed inputs for the request. Turnfeed separately processes those inputs and the account, network, and operational data described on this page. See <a href="${escapeHtml(OPENAI_PRIVACY_URL)}" target="_blank" rel="noopener noreferrer">OpenAI's privacy policy</a>.</p>
          </article>
          <article class="privacy-card">
            <strong>Identity provider</strong>
            <p>Turnfeed uses Auth0 for the Connect flow and for scoped identity on private reads and actions. This Turnfeed/Auth0 identity is separate from your ChatGPT account. Auth0 issues scoped access tokens under Okta's <a href="${escapeHtml(AUTH0_PRIVACY_URL)}" target="_blank" rel="noopener noreferrer">privacy policy</a>. Turnfeed verifies those tokens but does not receive your sign-in password.</p>
          </article>
          <article class="privacy-card">
            <strong>Legal or safety recipients</strong>
            <p>Information may be shared when required to comply with law, enforce terms, investigate abuse, protect users, or respond to a valid legal or safety request.</p>
          </article>
        </div>
      </section>
      <section class="privacy-section" id="privacy-processing">
        <div class="privacy-section-head">
          <h2>Preview fetches, abuse prevention, and retention</h2>
          <p>These are the main places where Turnfeed processes supporting data beyond the core post and profile record.</p>
        </div>
        <div class="privacy-grid">
          <article class="privacy-card">
            <strong>Link previews</strong>
            <p>If a posted URL generates a link preview, the server may fetch that URL to read metadata like title, description, and image.</p>
            <p class="privacy-note">That reveals the URL to the destination site and uses this service's server IP address.</p>
          </article>
          <article class="privacy-card">
            <strong>Abuse prevention</strong>
            <p>Installing the Turnfeed plugin in your client is separate from connecting a Turnfeed identity through Auth0. Turnfeed can serve public feed, thread, and profile reads without using that identity. Private inbox data and actions require scoped Auth0 authentication. Turnfeed derives its internal pseudonymous account key with a keyed one-way hash of the verified token issuer and subject.</p>
            <p class="privacy-note">That derived account key is pseudonymous personal data, not anonymous data. Turnfeed does not receive your sign-in password and does not persist the raw access token or raw subject. Auth0 may separately process login details under its own privacy notice. Turnfeed may also process network and request signals for rate limits, spam prevention, service health, and abuse review.</p>
          </article>
          <article class="privacy-card">
            <strong>Anonymous aggregate activation measurement</strong>
            <p>When enabled, Turnfeed counts successful website-to-ChatGPT redirect requests and successful first-page feed and thread reads by UTC date so the operator can tell whether the requested product flow is working.</p>
            <p class="privacy-note">These process-local counters are successful-call totals, not unique people, and platform retries can increment them. They contain no user, session, IP, content, query, referrer, campaign, or cookie dimension, keep at most 14 UTC daily buckets, and reset whenever the server process restarts.</p>
          </article>
          <article class="privacy-card">
            <strong>Storage and retention</strong>
            <p>Data is stored in server-side storage managed by the Turnfeed service. Core product data follows the event- and capacity-based rules below. Turnfeed-managed support, moderation, and security records follow the review cadence below. Under Turnfeed's current Render workspace configuration, runtime logs are retained for up to 7 days and the active paid PostgreSQL database has a point-in-time recovery window of up to 3 days.</p>
            <ul>
              <li>Active beta storage keeps up to ${MAX_POSTS.toLocaleString("en-US")} posts, with up to ${MAX_RETAINED_POSTS_PER_AUTHOR.toLocaleString("en-US")} active posts per account. When an eligible limit is reached, a least-recently-active thread can become read-only and leave feeds while remaining available from its direct link and author profile.</li>
              <li>The active service holds up to ${MAX_TOTAL_REPLIES.toLocaleString("en-US")} replies across active threads, with up to ${MAX_RETAINED_REPLIES_PER_AUTHOR.toLocaleString("en-US")} active replies per account and ${MAX_REPLIES_PER_THREAD.toLocaleString("en-US")} replies per active thread. A new reply never archives its own target thread; if no other eligible thread can safely make room, publishing pauses without storing the reply.</li>
              <li>The read-only archive is normally capped at ${MAX_ARCHIVED_POSTS.toLocaleString("en-US")} threads and ${MAX_ARCHIVED_REPLIES.toLocaleString("en-US")} replies. When it fills, eligible least-recently-active whole threads roll out. A thread containing a live target of a retained report is not automatically evicted. If a legacy or recovered store is already above the normal cap and cannot be brought back within it without deleting protected evidence, Turnfeed preserves that evidence and pauses new content admissions for operator review until space can be made safely.</li>
              <li>The active moderation queue stops ordinary report admission at ${MAX_REPORTS.toLocaleString("en-US")} retained records. A protected reserve of ${IMMEDIATE_SAFETY_REPORT_RESERVE.toLocaleString("en-US")} additional records is available only for immediate child-safety, illegal-content, or self-harm reasons, with a hard intake cap of ${MAX_REPORTS_HARD_CAP.toLocaleString("en-US")} records. Existing distinct moderation evidence is preserved even if legacy state is already above either threshold. New reports pause when the queue is full for their priority band; Turnfeed does not automatically replace a retained report, reporter receipt, or moderation-evidence record to make room. Contact Support if the queue cannot accept a report.</li>
              <li>Profiles, follows, and settings remain in active storage until removed through applicable user controls, <strong>Reset Turnfeed activity</strong>, or moderation. Recent like, follow, and group-invite notification event logs are each capacity-limited to ${MAX_LIKE_EVENTS.toLocaleString("en-US")} records. An event can outlast the feed item that generated it until its queue rolls over or applicable account, boundary, deletion, or moderation controls remove it.</li>
              <li>For publishing requests with a request ID, Turnfeed keeps an account-linked hash to stop an old request from publishing again after its post or reply is removed. These records contain no post or reply text, original request ID, or timestamp, but remain personal data because they are linked to your account. They have no automatic expiry and survive content deletion and <strong>Reset Turnfeed activity</strong>. They are removed through support's verified account-data erasure process after sign-in access has ended. If this storage is full, publishing requests that need a new record pause; reading and deletion remain available.</li>
              <li>Turnfeed-managed reports, moderation records, abuse-prevention records, support messages, security records, and related operational records are reviewed at least once every 12 months and deleted when their safety, legal, security, support, or service-operation purpose ends. After <strong>Reset Turnfeed activity</strong>, a private target-scoped keyed token may remain with a retained report solely to prevent the same account from repeatedly inflating that target's report count. It is not included in account or moderator exports and does not restore report history by itself. If the account explicitly reports that target again, Turnfeed creates a new current-account receipt without adding a second moderation record.</li>
              <li>Render runtime logs are retained for up to 7 days. Deleted active data can remain in Render's PostgreSQL recovery copies until the current recovery window of up to 3 days expires. These periods can change if the Render workspace or database configuration changes; this policy will be updated when they do. Short-lived in-memory rate-limit and abuse-prevention identifiers can expire sooner.</li>
              <li><strong>Manual database backups are separate.</strong> Render keeps database exports for 7 days after creation. An export can therefore contain deleted data after the 3-day recovery window has passed. Downloaded copies do not expire automatically when Render's copy expires; Turnfeed-managed recovery copies follow the operational-record review and deletion rules above. See <a href="https://render.com/docs/postgresql-backups" target="_blank" rel="noopener noreferrer">Render's backup retention details</a>.</li>
              <li>Records may be kept longer while an active legal matter, safety investigation, security incident, abuse case, or dispute requires them, and are deleted when that longer purpose ends.</li>
            </ul>
            <p class="privacy-note">These are the current Turnfeed product limits and service-managed retention commitments. Auth0, YouTube/Google, and OpenAI account and provider data, including ChatGPT and Codex, follow the providers' configured controls and policies linked on this page.</p>
          </article>
          <article class="privacy-card">
            <strong>Read-only browser preview</strong>
            <p><code>/social</code> is a read-only browser preview for verification and direct links to public feeds, profiles, and threads. It is not the Turnfeed plugin and does not expose account controls. Account-bound actions require a supported client and a scoped Turnfeed connection. See <a href="/mcp-info">client instructions and availability</a>.</p>
            <p class="privacy-note">Turnfeed does not use third-party ad pixels or analytics cookies in this service.</p>
          </article>
          <article class="privacy-card">
            <strong>No advertising sale</strong>
            <p>This service does not sell personal data, run third-party advertising, or use personal data for cross-context behavioral advertising.</p>
            <p class="privacy-note">If that changes, this policy will be updated before that processing starts.</p>
          </article>
          <article class="privacy-card">
            <strong>Security model</strong>
            <p>Turnfeed protects transport with HTTPS/TLS and uses server-side access controls, verified scoped OAuth access tokens, hashing, rate limits, and moderation controls where they fit the product.</p>
            <p class="privacy-note">Public posts and replies are not end-to-end encrypted because feed rendering, search, reports, and moderation need server-side processing. No online service can guarantee perfect security, but Turnfeed aims to apply controls proportionate to a public social product.</p>
          </article>
        </div>
      </section>
      <section class="privacy-section" id="privacy-rights">
        <div class="privacy-section-head">
          <h2>Norway and EEA privacy rights</h2>
          <p>Turnfeed is operated from ${escapeHtml(PUBLIC_OPERATOR_JURISDICTION)} by ${publicOperatorIdentityMarkup()}, a ${escapeHtml(PUBLIC_OPERATOR_FORM)}, so EEA privacy rights and Norwegian privacy oversight matter for how Turnfeed handles personal data.</p>
        </div>
        <div class="privacy-grid">
          <article class="privacy-card">
            <strong>Controller</strong>
            <p>${publicOperatorIdentityMarkup()} determines why and how Turnfeed product data is processed for the public feed, account controls, moderation, support, and security.</p>
            <p class="privacy-note">Use <a href="mailto:${supportEmail}">${supportEmail}</a> for controller requests until a separate privacy contact is published.</p>
          </article>
          <article class="privacy-card">
            <strong>Legal bases</strong>
            <p>Turnfeed generally relies on processing necessary to provide requested account and feed features, legitimate interests for safety, abuse prevention, service health, proportionate product-flow measurement, and moderation, consent where a feature asks for it, and legal obligation when law requires a response.</p>
            <p class="privacy-note">Providing the data needed for account, feed, moderation, and support features is generally required to use those parts of the service. Public posting and replying remain user-controlled actions.</p>
          </article>
          <article class="privacy-card">
            <strong>Your GDPR rights</strong>
            <p>Depending on context, you can ask to access, correct, export, delete, restrict, or object to processing of your personal data. <strong>Reset Turnfeed activity</strong> clears ordinary Turnfeed profile and activity data and reopens a clean profile shell for the same connected identity; it keeps the publishing-request hashes described above and does not delete the separate Auth0 identity. Turnfeed does not currently expose self-service Turnfeed/Auth0 identity deletion. Use support for identity deletion or unlinking requests, export, mute and hidden-word management, and broader privacy requests. Retained records described above may remain.</p>
            <p class="privacy-note">Privacy requests receive a response without undue delay and normally within one month.</p>
          </article>
          <article class="privacy-card">
            <strong>Processors and transfers</strong>
            <p>Turnfeed's service and main PostgreSQL database are hosted by Render in Virginia, United States. Product data is therefore processed outside ${escapeHtml(PUBLIC_OPERATOR_JURISDICTION)} and the EEA. Auth0/Okta, OpenAI, YouTube/Google, and destinations you link to can also process data in other countries under the provider policies linked above.</p>
            <p class="privacy-note"><a href="https://render.com/dpa" target="_blank" rel="noopener noreferrer">Render's data processing agreement</a> describes its international-transfer safeguards, including standard contractual clauses, and its use of subprocessors. For Auth0's contractual documents, see <a href="https://www.okta.com/agreements" target="_blank" rel="noopener noreferrer">Okta's agreements and privacy documentation</a>. Contact support for details of the providers, transfer safeguards, and records that apply to Turnfeed.</p>
          </article>
          <article class="privacy-card">
            <strong>Automated decisions and consent</strong>
            <p>Turnfeed may use ranking, rate limits, filters, and moderation signals to run a public feed, but it does not make decisions about you that produce legal or similarly significant effects solely by automated means.</p>
            <p class="privacy-note">Where Turnfeed relies on consent for a feature, you can withdraw that consent through the relevant control or support route. Withdrawal does not affect processing that already happened.</p>
          </article>
          <article class="privacy-card">
            <strong>Datatilsynet</strong>
            <p>If you believe your privacy rights have not been handled properly, you can contact the Norwegian Data Protection Authority, Datatilsynet.</p>
            <p class="privacy-note">The support route above is the fastest way to ask Turnfeed to fix something first.</p>
          </article>
          <article class="privacy-card">
            <strong>Data minimization</strong>
            <p>Turnfeed is designed to collect what the feed, account controls, moderation, support, and security features need, and aims to avoid sensitive categories that do not belong in a public social product.</p>
            <p class="privacy-note">This is especially important for a small operator with a public social surface.</p>
          </article>
        </div>
      </section>
      <section class="privacy-section" id="privacy-controls">
        <div class="privacy-section-head">
          <h2>Your control paths</h2>
          <p>Turnfeed keeps removal, export, and support routes visible instead of burying them behind a generic email line.</p>
        </div>
        <div class="privacy-next-grid">
          <article class="privacy-contact">
            <strong>Inside Turnfeed</strong>
            <p>In ChatGPT, ask Turnfeed to <strong>delete all my posts</strong> to remove your threads while keeping your profile, settings, follows, and activity elsewhere. Review the displayed post and reply counts before confirming: replies inside those threads, including replies by other people, are removed too. Bounded moderation, safety, legal, and backup records may remain.</p>
            <p><strong>Disconnect</strong> stops the selected client connection from accessing Turnfeed but does not erase stored Turnfeed data or delete the separate Auth0 identity. <strong>Reset Turnfeed activity</strong> clears broader ordinary profile and activity data and reopens a clean profile shell for that same identity. Account-linked publishing-request hashes remain after posts-only deletion or reset; bounded moderation, safety, legal, and backup records may also remain. Neither posts-only deletion nor reset deletes your separate sign-in identity. Turnfeed does not currently expose self-service identity deletion or self-service mute/hidden-word management. Use support for those requests, export, and broader privacy requests.</p>
          </article>
          <article class="privacy-contact">
            <strong>Contact and policy paths</strong>
            <p>If you want content removed or need help with a privacy issue, email <a href="mailto:${supportEmail}">${supportEmail}</a> or open the <a href="${escapeHtml(supportUrl)}">support page</a>.</p>
            <p class="privacy-note">The public landing page is <a href="${escapeHtml(landingUrl)}">${escapeHtml(landingUrl)}</a>. Terms for Turnfeed live at <a href="${escapeHtml(termsUrl)}">${escapeHtml(termsUrl)}</a>.</p>
          </article>
        </div>
        <p class="privacy-note">This policy stays aligned with the live product and its stored fields as Turnfeed evolves.</p>
      </section>
    </div>
      </div>
    </div>
  `,
  });
}

function supportHtml(origin = PUBLIC_ORIGIN) {
  const supportEmail = resolveSupportEmail(origin);
  return pageHtml({
    origin,
    title: `${PUBLIC_APP_NAME} · Support`,
    canonicalPath: "/support",
    description: `Support details for ${PUBLIC_APP_NAME}.`,
    body: `
    <p class="eyebrow">Support</p>
    <h1>Support</h1>
    <p>Email: <a href="mailto:${supportEmail}">${supportEmail}</a></p>
    <p>Include:</p>
    <ul>
      <li>What you were doing</li>
      <li>Screenshot / exact error text</li>
      <li>Time (and your timezone)</li>
      <li>The page or ChatGPT surface where it happened</li>
    </ul>
  `,
  });
}

function supportPageHtml(origin = PUBLIC_ORIGIN) {
  const supportEmail = resolveSupportEmail(origin);
  const landingUrl = origin;
  const mcpInfoUrl = `${origin}${MCP_INFO_PATH}`;
  const statusUrl = `${origin}/status`;
  const privacyUrl = `${origin}/privacy`;
  const termsUrl = `${origin}/terms`;
  const guidelinesUrl = `${origin}/guidelines`;
  return pageHtml({
    origin,
    title: `${PUBLIC_APP_NAME} · Support`,
    canonicalPath: "/support",
    description: `Support for ${PUBLIC_APP_NAME}. Get help using ChatGPT or Codex, content and safety reports, privacy or account requests, and service status.`,
    showPublicNav: true,
    extraStyles: `
      .support-hero {
        display: grid;
        grid-template-columns: minmax(0, 1.12fr) minmax(300px, .88fr);
        gap: 20px;
        align-items: start;
        padding: 22px;
        border-radius: 8px;
        background: linear-gradient(135deg, rgba(255,255,255,.98) 0%, rgba(246,250,255,.98) 54%, rgba(240,248,244,.95) 100%);
        border: 1px solid rgba(15,23,42,.07);
      }
      .support-copy {
        display: grid;
        gap: 16px;
        align-content: start;
      }
      .support-copy .lead {
        margin: 0;
        max-width: 64ch;
        font-size: 1.05rem;
        line-height: 1.6;
        color: var(--text-soft);
      }
      .support-actions,
      .support-chip-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px 16px;
      }
      .support-jump {
        display: grid;
        gap: 8px;
      }
      .support-jump-label {
        margin: 0;
        font-family: "IBM Plex Mono", "SFMono-Regular", "Cascadia Code", monospace;
        font-size: .72rem;
        font-weight: 700;
        letter-spacing: 0;
        text-transform: uppercase;
        color: var(--text-muted);
      }
      .support-chip {
        display: inline-flex;
        align-items: center;
        min-height: 44px;
        padding: 8px 0;
        border-radius: 0;
        border: 0;
        background: transparent;
        line-height: 1.2;
        font-family: "IBM Plex Mono", "SFMono-Regular", "Cascadia Code", monospace;
        font-size: .76rem;
        font-weight: 700;
        letter-spacing: 0;
        text-transform: uppercase;
        color: #284763;
        text-decoration: underline;
        text-decoration-thickness: 1px;
        text-underline-offset: 4px;
        transition: color .16s ease;
      }
      .support-chip:hover,
      .support-chip:focus-visible {
        color: #165df5;
      }
      .support-overview {
        display: grid;
        gap: 12px;
      }
      .support-overview-card {
        display: grid;
        gap: 4px;
        padding: 0;
        border-radius: 8px;
        background: transparent;
        border: 0;
      }
      .support-overview-card p,
      .support-card p,
      .support-note,
      .support-contact p {
        margin: 0;
        color: var(--text-soft);
        line-height: 1.5;
      }
      .support-stat-grid,
      .support-grid,
      .support-next-grid {
        display: grid;
        gap: 12px;
      }
      .support-stat-grid {
        grid-template-columns: 1fr;
        gap: 0;
      }
      .support-stat {
        min-width: 0;
        padding: 13px 0;
        border-radius: 0;
        background: transparent;
        border: 0;
        border-top: 1px solid rgba(15,23,42,.08);
      }
      .support-stat > strong,
      .support-card > strong,
      .support-contact > strong {
        display: block;
        margin-bottom: 4px;
      }
      .support-stack {
        display: grid;
        gap: 18px;
        margin-top: 22px;
      }
      .support-section {
        padding: clamp(22px, 4vw, 34px) 0 0;
        border-radius: 0;
        background: transparent;
        border: 0;
        border-top: 1px solid rgba(15,23,42,.1);
      }
      .support-section-head {
        display: grid;
        gap: 8px;
        margin-bottom: 16px;
      }
      .support-section-head p {
        margin: 0;
        color: var(--text-soft);
      }
      .support-grid {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
      .support-next-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .support-card,
      .support-contact {
        min-width: 0;
        padding: 16px;
        border-radius: 8px;
        background: rgba(255,255,255,.92);
        border: 1px solid rgba(15,23,42,.07);
      }
      .support-card ul {
        margin: 10px 0 0;
        padding-left: 18px;
        color: var(--text-soft);
      }
      .support-card li {
        margin: 0 0 8px;
      }
      .support-note {
        margin-top: 10px;
      }
      .support-contact code {
        display: inline-block;
        margin-top: 8px;
      }
      .support-inline-link {
        display: inline-flex;
        min-height: 44px;
        align-items: center;
        margin-top: 8px;
        color: var(--brand-dark);
        font-weight: 800;
      }
      .support-link-list {
        display: grid;
        gap: 0;
        margin: 10px 0 0;
        padding: 0;
        list-style: none;
      }
      .support-link-list li {
        margin: 0;
        border-top: 1px solid rgba(19,35,63,.1);
      }
      .support-link-list a {
        display: flex;
        min-height: 44px;
        align-items: center;
        font-weight: 750;
      }
      @media (max-width: 900px) {
        .support-hero,
        .support-grid,
        .support-next-grid,
        .support-stat-grid {
          grid-template-columns: 1fr;
        }
      }
      .support-stack {
        gap: 0;
        margin: 0;
      }
      .support-section {
        scroll-margin-top: 24px;
        padding: clamp(38px, 5vw, 58px) 0;
        border-top: 1px solid rgba(19,35,63,.13);
      }
      .support-section:first-child {
        padding-top: 6px;
        border-top: 0;
      }
      .support-section-head {
        gap: 10px;
        margin-bottom: 8px;
      }
      .support-section-head h2 {
        font-size: clamp(1.45rem, 2.7vw, 2rem);
        line-height: 1.16;
        letter-spacing: -.025em;
      }
      .support-grid,
      .support-next-grid {
        grid-template-columns: 1fr;
        gap: 0;
      }
      .support-card,
      .support-contact {
        padding: 22px 0;
        border: 0;
        border-top: 1px solid rgba(19,35,63,.1);
        border-radius: 0;
        background: transparent;
      }
      .support-card:first-child,
      .support-contact:first-child {
        border-top: 0;
      }
    `,
    body: `
    <section class="document-hero">
      <p class="document-kicker">Help</p>
        <div class="brand-lockup">
          ${brandLogoImgMarkup({ title: `${PUBLIC_APP_NAME} logo`, origin })}
          <div class="brand-copy">
            <h1>Support</h1>
          </div>
        </div>
        <p class="document-lead">Use this page when something in ${PUBLIC_APP_NAME} feels broken, unclear, or unsafe. Tell us what happened, where it happened, and roughly when; support will route it to the right place.</p>
        <div class="document-actions">
          <a class="btn btn-primary" href="mailto:${supportEmail}">Email support</a>
          <a class="btn" href="/status">Check status</a>
        </div>
    </section>
    <div class="document-layout">
      <aside class="document-toc">
        <p class="document-toc-label">On this page</p>
        <nav aria-label="Support page sections">
          <ul class="document-toc-list">
            <li><a href="#support-checks">Quick checks</a></li>
            <li><a href="#support-account">Account and deletion</a></li>
            <li><a href="#support-request-types">Choose a request</a></li>
            <li><a href="#support-message">What to include</a></li>
            <li><a href="#support-links">Useful links</a></li>
          </ul>
        </nav>
      </aside>
      <div class="document-content">
      <div class="support-stack">
      <section class="support-section" id="support-checks">
        <div class="support-section-head">
          <h2>If you want to check first</h2>
          <p>You do not need to troubleshoot before emailing. These links are here if you want to check whether Turnfeed is online or find the instructions for your client.</p>
        </div>
        <div class="support-grid">
          <article class="support-card">
            <strong>Setup and help</strong>
            <p>Find ChatGPT setup, Codex setup instructions, and the server URL if your client asks for it.</p>
            <p><a class="support-inline-link" href="${escapeHtml(mcpInfoUrl)}">Setup and help</a></p>
          </article>
          <article class="support-card">
            <strong>Check service status</strong>
            <p>Use this page to see whether the live service is online.</p>
            <p><a class="support-inline-link" href="${escapeHtml(statusUrl)}">Open service status</a></p>
          </article>
          <article class="support-card">
            <strong>Account connection and action approval</strong>
            <p>Installing the plugin, connecting your Turnfeed identity, and approving an individual action are separate steps. Public reading does not require a Turnfeed identity; private reads and actions require a supported client with scoped access. For Codex, start with the <a class="support-inline-link" href="${escapeHtml(mcpInfoUrl)}#connection-codex">setup instructions</a>.</p>
            <p>ChatGPT decides whether to ask before a Turnfeed action based on your current ChatGPT permission setting and workspace controls. When it asks about a public post or reply, review the exact text. Turnfeed’s write and open-world annotations help ChatGPT apply those controls; Turnfeed does not add a separate server-side approval prompt.</p>
          </article>
          <article class="support-card">
            <strong>Check availability, Voice, Dictation, and billing</strong>
            <p>${TURNFEED_VOICE_GUIDANCE}</p>
            <p>As of August 27, 2026, Turnfeed does not charge a separate fee or run its own billing or payment flow. OpenAI controls plan eligibility, usage limits, plugin availability, workspace access, supported surfaces, and regional availability. See <a class="support-inline-link" href="${escapeHtml(OPENAI_APPS_HELP_URL)}" target="_blank" rel="noopener noreferrer">OpenAI's current availability guidance</a>.</p>
          </article>
        </div>
      </section>
      <section class="support-section" id="support-account">
        <div class="support-section-head">
          <h2>Account and deletion</h2>
          <p>Disconnecting, deleting posts, resetting activity, and deleting your sign-in identity do different things. Choose the option that matches what you want removed.</p>
        </div>
        <div class="support-grid">
          <article class="support-card">
            <strong>Choose what you want to change</strong>
            <ul>
              <li><strong>Reconnect:</strong> remove the old Turnfeed connection, reconnect through Auth0, and authorize only the scopes ChatGPT shows. Your Turnfeed/Auth0 identity is separate from your ChatGPT account. Signing back in with the same Auth0 identity normally returns you to the same Turnfeed account state, as long as that Auth0 identity and the stored Turnfeed account still exist.</li>
              <li><strong>Disconnect:</strong> remove Turnfeed through ChatGPT settings. This stops ChatGPT from using that connection but does not erase stored Turnfeed data, reset activity, or delete the separate Auth0 identity.</li>
              <li><strong>Delete all my posts:</strong> in ChatGPT, ask Turnfeed to delete all your posts while keeping your profile, settings, follows, and activity elsewhere. Review the displayed post and reply counts before confirming. Replies inside those threads, including replies by other people, are removed too. Your separate sign-in identity remains, and bounded moderation, safety, legal, and backup records may remain.</li>
              <li><strong>Reset activity:</strong> <strong>Reset Turnfeed activity</strong> clears ordinary profile and activity data and opens a clean profile shell for the same connected identity. Account-linked publishing-request hashes remain; bounded moderation, safety, legal, and backup records may also remain as described in <a class="support-inline-link" href="${escapeHtml(privacyUrl)}#privacy-processing">Privacy</a>.</li>
              <li><strong>Delete identity:</strong> Turnfeed does not currently expose self-service Turnfeed/Auth0 identity deletion. Email support with a privacy/account request. A request is not a promise of immediate provider-side deletion; support will confirm the available process and any retained records.</li>
            </ul>
          </article>
        </div>
      </section>
      <section class="support-section" id="support-request-types">
        <div class="support-section-head">
          <h2>Choose the right support request</h2>
          <p>Use the subject line that matches the issue. It helps separate safety, privacy, and connection work quickly.</p>
        </div>
        <div class="support-grid">
          <article class="support-card">
            <strong>Content or safety report</strong>
            <p>Use this for harassment, impersonation, spam, illegal content, privacy exposure, hate, misinformation, self-harm, child safety, copyright or IP concerns, abusive replies, report abuse, or misuse of likes, follows, blocks, mutes, and hidden words.</p>
            <p><strong>Do not retrieve, download, screenshot, or attach suspected child sexual abuse material or other exploitative material.</strong> Send the URL or Turnfeed identifier and a brief description instead.</p>
            <code>Subject: Turnfeed content/safety report</code>
          </article>
          <article class="support-card">
            <strong>Privacy or account request</strong>
            <p>Use this for data access, correction, export, activity reset, Turnfeed/Auth0 identity deletion or unlinking, mute or hidden-word management, privacy exposure, or questions about stored Turnfeed feed, thread, profile, safety, or support data. Turnfeed does not currently expose self-service identity deletion or mute/hidden-word management.</p>
            <code>Subject: Turnfeed privacy/account request</code>
          </article>
          <article class="support-card">
            <strong>ChatGPT or Codex connection issue</strong>
            <p>Use this when Turnfeed is unavailable in ChatGPT or Codex, your client asks for the server URL, or the service status page looks degraded.</p>
            <code>Subject: Turnfeed connection issue</code>
          </article>
        </div>
      </section>
      <section class="support-section" id="support-message">
        <div class="support-section-head">
          <h2>What to include in the message</h2>
          <p>A short note is enough. These details make it easier to understand the issue quickly.</p>
        </div>
        <div class="support-next-grid">
          <article class="support-card">
            <strong>Essential context</strong>
            <ul>
              <li>What you were doing</li>
              <li>Screenshot or exact error text, unless the report involves suspected child sexual abuse material or other exploitative material</li>
              <li>Time and your timezone</li>
              <li>The URL you connected or opened</li>
            </ul>
            <p class="support-note">For connection issues, name the client and surface you used, such as ChatGPT web or a Codex desktop task. Say whether you were reading public posts, opening private account activity, or requesting an action.</p>
            <p class="support-note">Do not send passwords, API keys, full private conversations, repository secrets, payment details, government IDs, protected health details, or other sensitive personal data in support messages.</p>
          </article>
          <article class="support-card">
            <strong>Useful product details</strong>
            <ul>
              <li>Whether it happened in ChatGPT, Codex, the read-only website preview, or a Turnfeed information page</li>
              <li>Which surface failed: feed, thread, profile, inbox, composer, or media. The inbox is notifications and account activity, not direct messages.</li>
              <li>Whether a refresh, reopen, or retry changed anything</li>
              <li>Whether the issue affects one post/profile or the whole Turnfeed service</li>
            </ul>
          </article>
        </div>
      </section>
      <section class="support-section" id="support-links">
        <div class="support-section-head">
          <h2>Useful links</h2>
          <p>These are the public Turnfeed pages that are most useful for checking the product, status, and policies.</p>
        </div>
        <div class="support-next-grid">
          <article class="support-contact">
            <strong>Turnfeed home</strong>
            <p>The landing page explains how to use Turnfeed in ChatGPT and Codex.</p>
            <p><a class="support-inline-link" href="${escapeHtml(landingUrl)}">Open Turnfeed home</a></p>
          </article>
          <article class="support-contact">
            <strong>Connection, status, and policy</strong>
            <p>Use these for technical connection details, service status, privacy, terms, Community Guidelines, or <a href="mailto:${supportEmail}">direct support</a>.</p>
            <ul class="support-link-list">
              <li><a href="${escapeHtml(mcpInfoUrl)}">Connection details</a></li>
              <li><a href="${escapeHtml(statusUrl)}">Service status</a></li>
              <li><a href="${escapeHtml(privacyUrl)}">Privacy</a></li>
              <li><a href="${escapeHtml(termsUrl)}">Terms</a></li>
              <li><a href="${escapeHtml(guidelinesUrl)}">Community Guidelines</a></li>
            </ul>
          </article>
        </div>
      </section>
    </div>
      </div>
    </div>
  `,
  });
}

function termsHtml(origin = PUBLIC_ORIGIN) {
  return pageHtml({
    origin,
    title: `${PUBLIC_APP_NAME} · Terms`,
    canonicalPath: "/terms",
    description: `Terms of use for ${PUBLIC_APP_NAME}.`,
    body: `
    <p class="eyebrow">Terms</p>
    <h1>Terms</h1>
    <p>${PUBLIC_APP_NAME} is provided as an online social product and may change as the service evolves.</p>
    <p>Do not post sensitive personal information. Content in shared feeds may be visible to other people using Turnfeed.</p>
    <p>Turnfeed is not intended for children under 13 or the applicable age of digital consent. Do not submit protected health information, payment card data, government ID numbers, or other highly sensitive data.</p>
    <p>Do not use the service for harassment, impersonation, spam, or other abuse. Accounts or content may be removed to protect users and keep the feed usable.</p>
    <p class="muted">Last updated: ${escapeHtml(PUBLIC_POLICY_LAST_UPDATED)}.</p>
  `,
  });
}

function termsPageHtml(origin = PUBLIC_ORIGIN) {
  const supportEmail = resolveSupportEmail(origin);
  const landingUrl = origin;
  const privacyUrl = `${origin}/privacy`;
  const supportUrl = `${origin}/support`;
  const guidelinesUrl = `${origin}/guidelines`;
  return pageHtml({
    origin,
    title: `${PUBLIC_APP_NAME} · Terms`,
    canonicalPath: "/terms",
    description: `Terms for ${PUBLIC_APP_NAME}. Covers acceptable use, public content, moderation, reports, content rights, account controls, and support paths.`,
    showPublicNav: true,
    extraStyles: `
      .terms-hero {
        display: grid;
        grid-template-columns: minmax(0, 1.12fr) minmax(300px, .88fr);
        gap: 20px;
        align-items: start;
        padding: 22px;
        border-radius: 8px;
        background: linear-gradient(135deg, rgba(255,255,255,.98) 0%, rgba(246,250,255,.98) 54%, rgba(240,247,252,.95) 100%);
        border: 1px solid rgba(15,23,42,.07);
      }
      .terms-copy {
        display: grid;
        gap: 16px;
        align-content: start;
      }
      .terms-copy .lead {
        margin: 0;
        max-width: 64ch;
        font-size: 1.05rem;
        line-height: 1.6;
        color: var(--text-soft);
      }
      .terms-actions,
      .terms-chip-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px 16px;
      }
      .terms-jump {
        display: grid;
        gap: 8px;
      }
      .terms-jump-label {
        margin: 0;
        font-family: "IBM Plex Mono", "SFMono-Regular", "Cascadia Code", monospace;
        font-size: .72rem;
        font-weight: 700;
        letter-spacing: 0;
        text-transform: uppercase;
        color: var(--text-muted);
      }
      .terms-chip {
        display: inline-flex;
        align-items: center;
        min-height: 44px;
        padding: 8px 0;
        border-radius: 0;
        border: 0;
        background: transparent;
        line-height: 1.2;
        font-family: "IBM Plex Mono", "SFMono-Regular", "Cascadia Code", monospace;
        font-size: .76rem;
        font-weight: 700;
        letter-spacing: 0;
        text-transform: uppercase;
        color: #284763;
        text-decoration: underline;
        text-decoration-thickness: 1px;
        text-underline-offset: 4px;
        transition: color .16s ease;
      }
      .terms-chip:hover,
      .terms-chip:focus-visible {
        color: #165df5;
      }
      .terms-overview {
        display: grid;
        gap: 12px;
      }
      .terms-overview-card {
        display: grid;
        gap: 4px;
        padding: 0;
        border-radius: 8px;
        background: transparent;
        border: 0;
      }
      .terms-overview-card p,
      .terms-card p,
      .terms-note,
      .terms-contact p {
        margin: 0;
        color: var(--text-soft);
        line-height: 1.5;
      }
      .terms-stat-grid,
      .terms-grid,
      .terms-next-grid {
        display: grid;
        gap: 12px;
        align-items: start;
      }
      .terms-stat-grid {
        grid-template-columns: 1fr;
        gap: 0;
      }
      .terms-stat {
        padding: 13px 0;
        border-radius: 0;
        background: transparent;
        border: 0;
        border-top: 1px solid rgba(15,23,42,.08);
      }
      .terms-stat > strong,
      .terms-card > strong,
      .terms-contact > strong {
        display: block;
        margin-bottom: 4px;
      }
      .terms-stack {
        display: grid;
        gap: 18px;
        margin-top: 22px;
      }
      .terms-section {
        padding: clamp(22px, 4vw, 34px) 0 0;
        border-radius: 0;
        background: transparent;
        border: 0;
        border-top: 1px solid rgba(15,23,42,.1);
      }
      .terms-section-head {
        display: grid;
        gap: 8px;
        margin-bottom: 16px;
      }
      .terms-section-head p {
        margin: 0;
        color: var(--text-soft);
      }
      .terms-grid {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
      .terms-next-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .terms-card,
      .terms-contact {
        align-self: start;
        padding: 16px;
        border-radius: 12px;
        background: rgba(255,255,255,.92);
        border: 1px solid rgba(15,23,42,.07);
      }
      .terms-card ul {
        margin: 10px 0 0;
        padding-left: 18px;
        color: var(--text-soft);
      }
      .terms-card li {
        margin: 0 0 8px;
      }
      .terms-note {
        margin-top: 10px;
      }
      .terms-contact code {
        display: inline-block;
        margin-top: 8px;
      }
      @media (max-width: 900px) {
        .terms-hero,
        .terms-grid,
        .terms-next-grid,
        .terms-stat-grid {
          grid-template-columns: 1fr;
        }
        .terms-hero { padding: 22px 18px; }
      }
      .terms-stack {
        gap: 0;
        margin: 0;
      }
      .terms-section {
        scroll-margin-top: 24px;
        padding: clamp(38px, 5vw, 58px) 0;
        border-top: 1px solid rgba(19,35,63,.13);
      }
      .terms-section:first-child {
        padding-top: 6px;
        border-top: 0;
      }
      .terms-section-head {
        gap: 10px;
        margin-bottom: 8px;
      }
      .terms-section-head h2 {
        font-size: clamp(1.45rem, 2.7vw, 2rem);
        line-height: 1.16;
        letter-spacing: -.025em;
      }
      .terms-grid,
      .terms-next-grid {
        grid-template-columns: 1fr;
        gap: 0;
      }
      .terms-card,
      .terms-contact {
        padding: 22px 0;
        border: 0;
        border-top: 1px solid rgba(19,35,63,.1);
        border-radius: 0;
        background: transparent;
      }
      .terms-card:first-child,
      .terms-contact:first-child {
        border-top: 0;
      }
    `,
    body: `
    <section class="document-hero">
      <p class="document-kicker">Trust &amp; legal</p>
        <div class="brand-lockup">
          ${brandLogoImgMarkup({ title: `${PUBLIC_APP_NAME} logo`, origin })}
          <div class="brand-copy">
            <h1>Terms of use</h1>
          </div>
        </div>
        <p class="document-lead">${PUBLIC_APP_NAME} is a public social feed you can use in ChatGPT and Codex. These terms apply across Turnfeed clients and explain public content, ownership, responsible use, moderation, account controls, and support.</p>
        <p class="document-meta">Last updated: ${escapeHtml(PUBLIC_POLICY_LAST_UPDATED)}.</p>
        <div class="document-actions">
          <a class="btn btn-primary" href="/support">Get support</a>
          <a class="btn" href="/guidelines">Read the guidelines</a>
        </div>
    </section>
    <div class="document-layout">
      <aside class="document-toc">
        <p class="document-toc-label">On this page</p>
        <nav aria-label="Terms page sections">
          <ul class="document-toc-list">
            <li><a href="#terms-responsible-use">Responsible use</a></li>
            <li><a href="#terms-sensitive-data">Age and sensitive data</a></li>
            <li><a href="#terms-content-rights">Content rights</a></li>
            <li><a href="#terms-enforcement">Moderation and controls</a></li>
            <li><a href="#terms-reporting">Reports and review</a></li>
            <li><a href="#terms-support">Provider and support</a></li>
          </ul>
        </nav>
      </aside>
      <div class="document-content">
      <div class="terms-stack">
      <section class="terms-section" id="terms-responsible-use">
        <div class="terms-section-head">
          <h2>How to use Turnfeed responsibly</h2>
          <p>The goal is public conversation that feels readable, trustworthy, and worth reopening.</p>
        </div>
        <div class="terms-grid">
          <article class="terms-card">
            <strong>Post as if other people will open it</strong>
            <p>Public feed posts, replies, profile details, and follower and following lists can be read on the web without a Turnfeed account. People can open, copy, and share them. Earlier versions of edited posts and replies can remain visible in public edit history; editing does not erase that information.</p>
            <ul>
              <li>Do not post sensitive personal information you would not want others to read</li>
              <li>Assume public feed content can be searched, opened, quoted, and reported</li>
              <li>Keep profile details truthful enough that trust signals are not misleading</li>
              <li>Do not submit personal information from children under 13 or the applicable age of digital consent</li>
            </ul>
          </article>
          <article class="terms-card">
            <strong>Do not abuse the social surfaces</strong>
            <p>Turnfeed is not meant for harassment, impersonation, spam, evasion, illegal content, privacy exposure, or manipulation of feed, discovery, inbox, or profile flows.</p>
            <ul>
              <li>No harassment, impersonation, spam, illegal content, or abusive engagement farming</li>
              <li>No display name, handle, avatar, bio, or website that makes you look like Turnfeed, OpenAI, ChatGPT, an admin, a moderator, a public figure, or another person when you are not</li>
              <li>No attempts to bypass boundary controls, rate limits, or moderation tooling</li>
              <li>No using reports, follows, likes, or replies as a harassment channel</li>
            </ul>
          </article>
          <article class="terms-card">
            <strong>Account controls are not a safety bypass</strong>
            <p>Block, hidden words, export, <strong>Reset Turnfeed activity</strong>, mute, and support requests are user controls, not permission to ignore the rest of the product rules.</p>
            <ul>
              <li>Respect mute, block, and hidden-word boundaries</li>
              <li>Do not use account controls to evade moderation or recreate abuse</li>
              <li>Abusive behavior can still lead to moderation or access loss</li>
            </ul>
          </article>
        </div>
      </section>
      <section class="terms-section" id="terms-sensitive-data">
        <div class="terms-section-head">
          <h2>Age and sensitive data limits</h2>
          <p>Turnfeed is a public social surface, so some categories of data do not belong here.</p>
        </div>
        <div class="terms-next-grid">
          <article class="terms-card">
            <strong>Age boundary</strong>
            <p>Turnfeed is not intended for children under 13 or the applicable age of digital consent. Do not use Turnfeed to submit personal information from children in that category.</p>
          </article>
          <article class="terms-card">
            <strong>Sensitive data boundary</strong>
            <p>Do not submit protected health information, payment card data, government ID numbers, passwords, secrets, or other highly sensitive data to Turnfeed public posts, replies, profiles, or support flows.</p>
          </article>
        </div>
      </section>
      <section class="terms-section" id="terms-content-rights">
        <div class="terms-section-head">
          <h2>Content rights</h2>
          <p>Turnfeed is built around human-controlled public posts and replies. ChatGPT may help people read, draft, or navigate, but posting something does not transfer ownership to Turnfeed.</p>
        </div>
        <div class="terms-next-grid">
          <article class="terms-card">
            <strong>You keep ownership</strong>
            <p>You retain whatever rights you have in the public posts, replies, profile text, media, and links you submit to Turnfeed.</p>
            <p class="terms-note">Do not submit content you do not have the right to share publicly.</p>
          </article>
          <article class="terms-card">
            <strong>Turnfeed can operate the service</strong>
            <p>By posting, replying, or adding profile details, you give Turnfeed a limited, non-exclusive permission to host, store, display, format, index, search, moderate, export, remove, and otherwise process that content as needed to run Turnfeed.</p>
            <p class="terms-note">This permission is for operating, improving, protecting, and explaining the product. It is not a transfer of ownership.</p>
          </article>
        </div>
      </section>
      <section class="terms-section" id="terms-enforcement">
        <div class="terms-section-head">
          <h2>Product boundaries and enforcement</h2>
          <p>These terms matter because the product includes moderation, boundary, and recovery tools that are expected to be used when needed.</p>
        </div>
        <div class="terms-next-grid">
          <article class="terms-card">
            <strong>What Turnfeed may do</strong>
            <p>Accounts or content may be removed, hidden, deprioritized, blocked from interaction, or otherwise limited to protect users and keep the feed usable.</p>
            <p class="terms-note">That can include public feed content, replies, like/follow paths, inbox visibility, profile reach, and temporary or permanent account limits.</p>
          </article>
          <article class="terms-card">
            <strong>What users can do</strong>
            <p>Use block, reporting, export, <strong>Reset Turnfeed activity</strong>, and support contact when you need to protect yourself, report a problem, or ask for review. Turnfeed currently handles mute and hidden-word management through support rather than a self-service control.</p>
            <p class="terms-note">Those controls are part of the intended product behavior, not exceptional side channels.</p>
          </article>
          <article class="terms-card">
            <strong>Beta capacity and availability</strong>
            <p>Turnfeed is capacity-limited during beta. It can move eligible least-recently-active whole threads out of feeds into a normally capped read-only archive when active limits are reached. Archived threads remain readable from direct links and profiles while retained, but cannot accept new replies. Eligible older archived threads can roll out when the archive fills. Threads containing live retained-report targets are not automatically evicted; a protected legacy or recovered overflow is preserved, and publishing pauses until space can be made safely.</p>
            <p class="terms-note">See <a href="/privacy#privacy-processing">Privacy</a> for the active storage limits and retention targets.</p>
          </article>
        </div>
      </section>
      <section class="terms-section" id="terms-reporting">
        <div class="terms-section-head">
          <h2>Reports, IP concerns, and moderation review</h2>
          <p>Turnfeed needs clear report paths because public posts, replies, profile details, media, and links can affect other people.</p>
        </div>
        <div class="terms-grid">
          <article class="terms-card">
            <strong>Illegal content or abuse reports</strong>
            <p>Report harassment, impersonation, spam, illegal content, privacy exposure, threats, or misuse of reports, replies, likes, follows, blocks, mutes, and hidden words through the product report paths or support.</p>
            <p class="terms-note">Include the post, reply, profile, URL, account handle, and a short explanation when possible. Do not retrieve, download, screenshot, or attach suspected child sexual abuse material or other exploitative material; send the URL or Turnfeed identifier instead.</p>
          </article>
          <article class="terms-card">
            <strong>Copyright or IP concerns</strong>
            <p>If you believe content on Turnfeed infringes copyright, trademark, publicity, or other rights, contact support with the content URL or identifier, your contact details, the right at issue, and the action you are requesting.</p>
            <p class="terms-note">Turnfeed may remove or limit content while reviewing a rights complaint.</p>
          </article>
          <article class="terms-card">
            <strong>Moderation review</strong>
            <p>If your content or account is limited, Turnfeed aims to give a reason where practical and safe, and you can ask support to review the decision. Turnfeed may consider the content, context, abuse risk, repeat behavior, and applicable law.</p>
            <p class="terms-note">A review request does not guarantee reinstatement, but it gives the operator a clear route to re-check the decision.</p>
          </article>
          <article class="terms-card">
            <strong>Mandatory rights still apply</strong>
            <p>Nothing in these terms is intended to limit privacy rights, consumer rights, or other mandatory rights that apply under law.</p>
            <p class="terms-note">These terms may be updated as Turnfeed grows; material changes will be reflected in the Last updated date above.</p>
          </article>
        </div>
      </section>
      <section class="terms-section" id="terms-support">
        <div class="terms-section-head">
          <h2>Support and policy paths</h2>
          <p>These companion pages make policy, support, and product boundaries easy to find.</p>
        </div>
        <div class="terms-next-grid">
          <article class="terms-contact">
            <strong>Who provides Turnfeed</strong>
            <p>${publicOperatorIdentityMarkup()}, a ${escapeHtml(PUBLIC_OPERATOR_FORM)}, provides Turnfeed from ${escapeHtml(PUBLIC_OPERATOR_JURISDICTION)}.</p>
          </article>
          <article class="terms-contact">
            <strong>Privacy, Community Guidelines, and support</strong>
            <p>Privacy details live at <a href="${escapeHtml(privacyUrl)}">${escapeHtml(privacyUrl)}</a>, community rules live at <a href="${escapeHtml(guidelinesUrl)}">${escapeHtml(guidelinesUrl)}</a>, and support requests go to <a href="mailto:${supportEmail}">${supportEmail}</a>.</p>
            <code>${escapeHtml(supportUrl)}</code>
          </article>
          <article class="terms-contact">
            <strong>Turnfeed home</strong>
            <p>The landing page explains how Turnfeed works inside ChatGPT.</p>
            <code>${escapeHtml(landingUrl)}</code>
          </article>
        </div>
        <p class="terms-note">These terms stay aligned with the live product surfaces and moderation behavior as Turnfeed evolves.</p>
      </section>
    </div>
      </div>
    </div>
  `,
  });
}

function guidelinesPageHtml(origin = PUBLIC_ORIGIN) {
  const supportEmail = resolveSupportEmail(origin);
  return pageHtml({
    origin,
    title: `${PUBLIC_APP_NAME} · Community Guidelines`,
    canonicalPath: "/guidelines",
    description: `Community Guidelines for ${PUBLIC_APP_NAME}. Plain rules for respectful participation, safety reports, moderation review, privacy, and support.`,
    showPublicNav: true,
    extraStyles: `
      .guidelines-hero {
        display: grid;
        gap: 16px;
        padding: clamp(22px, 4vw, 36px);
        border-radius: 8px;
        background: linear-gradient(135deg, rgba(255,255,255,.98) 0%, rgba(246,250,255,.98) 54%, rgba(240,248,244,.95) 100%);
        border: 1px solid rgba(15,23,42,.07);
      }
      .guidelines-hero .lead {
        max-width: 68ch;
        margin: 0;
        color: var(--text-soft);
        font-size: 1.08rem;
        line-height: 1.6;
      }
      .guidelines-stack {
        display: grid;
        gap: 18px;
        margin-top: 22px;
      }
      .guidelines-section {
        padding: clamp(22px, 4vw, 34px) 0 0;
        border-top: 1px solid rgba(15,23,42,.1);
      }
      .guidelines-section-head {
        display: grid;
        gap: 8px;
        margin-bottom: 16px;
      }
      .guidelines-section-head p,
      .guidelines-card p,
      .guidelines-note {
        margin: 0;
        color: var(--text-soft);
        line-height: 1.52;
      }
      .guidelines-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
        align-items: start;
      }
      .guidelines-card {
        display: grid;
        align-content: start;
        gap: 7px;
        padding: 17px;
        border-radius: 8px;
        background: rgba(255,255,255,.92);
        border: 1px solid rgba(15,23,42,.07);
      }
      .guidelines-card h3 {
        margin: 0;
        color: #0f172a;
        font-size: 1.04rem;
      }
      .guidelines-note {
        margin-top: 14px;
      }
      @media (max-width: 760px) {
        .guidelines-grid {
          grid-template-columns: 1fr;
        }
      }
      .guidelines-stack {
        gap: 0;
        margin: 0;
      }
      .guidelines-section {
        scroll-margin-top: 24px;
        padding: clamp(38px, 5vw, 58px) 0;
        border-top: 1px solid rgba(19,35,63,.13);
      }
      .guidelines-section:first-child {
        padding-top: 6px;
        border-top: 0;
      }
      .guidelines-section-head {
        gap: 10px;
        margin-bottom: 8px;
      }
      .guidelines-section-head h2 {
        font-size: clamp(1.45rem, 2.7vw, 2rem);
        line-height: 1.16;
        letter-spacing: -.025em;
      }
      .guidelines-grid {
        grid-template-columns: 1fr;
        gap: 0;
      }
      .guidelines-card {
        padding: 22px 0;
        border: 0;
        border-top: 1px solid rgba(19,35,63,.1);
        border-radius: 0;
        background: transparent;
      }
      .guidelines-card:first-child {
        border-top: 0;
      }
    `,
    body: `
    <section class="document-hero">
      <p class="document-kicker">Trust &amp; safety</p>
      <div class="brand-lockup">
        ${brandLogoImgMarkup({ title: `${PUBLIC_APP_NAME} logo`, origin })}
        <div class="brand-copy">
          <h1>Community Guidelines</h1>
        </div>
      </div>
      <p class="document-lead">Turnfeed is for people who want public conversation to feel readable, useful, and human. These rules apply to posts, replies, profiles, links, and media.</p>
      <p class="document-meta">Last updated: ${escapeHtml(PUBLIC_POLICY_LAST_UPDATED)}.</p>
      <div class="document-actions">
        <a class="btn btn-primary" href="/support">Report a concern</a>
        <a class="btn" href="/terms">Read the terms</a>
      </div>
    </section>
    <div class="document-layout">
      <aside class="document-toc">
        <p class="document-toc-label">On this page</p>
        <nav aria-label="Community Guidelines sections">
          <ul class="document-toc-list">
            <li><a href="#community-rules">Rules for taking part</a></li>
            <li><a href="#reports-and-review">Reports and review</a></li>
          </ul>
        </nav>
      </aside>
      <div class="document-content">
      <div class="guidelines-stack">
      <section class="guidelines-section" id="community-rules">
        <div class="guidelines-section-head">
          <h2>Rules for taking part</h2>
          <p>Context matters, but these are the boundaries everyone should be able to understand.</p>
        </div>
        <div class="guidelines-grid">
          <article class="guidelines-card">
            <h3>Respect people</h3>
            <p>No harassment, threats, hateful attacks, slurs, dehumanizing language, or encouragement of violence.</p>
          </article>
          <article class="guidelines-card">
            <h3>Be who you say you are</h3>
            <p>No impersonation or deceptive claims that you are another person, organization, official source, or Turnfeed operator.</p>
          </article>
          <article class="guidelines-card">
            <h3>Do not spam or scam</h3>
            <p>No repetitive promotion, engagement manipulation, fraudulent links, scams, or copy-paste noise that makes conversation harder to use.</p>
          </article>
          <article class="guidelines-card">
            <h3>Protect privacy</h3>
            <p>Do not expose personal data, credentials, intimate material, financial details, or someone else's private information without permission.</p>
          </article>
          <article class="guidelines-card">
            <h3>Protect children</h3>
            <p>No sexual exploitation of children, grooming, endangerment, or content that facilitates abuse of a child.</p>
          </article>
          <article class="guidelines-card">
            <h3>No illegal content or exploitation</h3>
            <p>Do not use Turnfeed for trafficking, non-consensual exploitation, or instructions that facilitate serious wrongdoing.</p>
          </article>
          <article class="guidelines-card">
            <h3>Respect copyright and IP</h3>
            <p>Do not post material that credibly infringes copyright, trademark, publicity, or another person's intellectual-property rights.</p>
          </article>
          <article class="guidelines-card">
            <h3>Self-harm and crisis</h3>
            <p>Do not encourage or glorify self-harm. Supportive recovery discussion and good-faith requests for help are allowed.</p>
          </article>
          <article class="guidelines-card">
            <h3>Harmful misinformation</h3>
            <p>Do not share clearly false claims likely to cause real-world harm. Good-faith disagreement and correction are allowed.</p>
          </article>
          <article class="guidelines-card">
            <h3>Do not manipulate AI systems</h3>
            <p>Do not embed deceptive instructions intended to make ChatGPT or another agent ignore its rules, expose private data, or take an action the person did not request.</p>
          </article>
          <article class="guidelines-card">
            <h3>No unattended or deceptive automation</h3>
            <p>Do not use scripts or agents to act in bulk, evade limits, publish without a person's current instruction, or bypass any approval required by ChatGPT, Codex, or another client under its current settings.</p>
          </article>
        </div>
      </section>
      <section class="guidelines-section" id="reports-and-review">
        <div class="guidelines-section-head">
          <h2>Reports and moderation review</h2>
          <p>Reports enter a review queue; they do not automatically hide content. The operator can hide or restore content after reviewing the target and its context.</p>
        </div>
        <div class="guidelines-grid">
          <article class="guidelines-card">
            <h3>How to report</h3>
            <p>Use Turnfeed's report action for a post or reply, or <a href="/support">contact support</a> with the URL or identifier, what happened, and why it matters. Do not retrieve, download, screenshot, or attach suspected child sexual abuse material or other exploitative material. Send the URL or Turnfeed identifier instead.</p>
          </article>
          <article class="guidelines-card">
            <h3>Ask for another review</h3>
            <p>If a moderation decision affects your content, you can <a href="/support">ask support to review</a> the decision. A review request does not guarantee reinstatement.</p>
          </article>
          <article class="guidelines-card">
            <h3>Urgent danger</h3>
            <p>Turnfeed is not an emergency service. If someone is in immediate danger, contact local emergency services first.</p>
          </article>
          <article class="guidelines-card">
            <h3>Questions</h3>
            <p>Email <a href="mailto:${supportEmail}">${supportEmail}</a> for a safety, privacy, legal, or account concern that does not fit the in-product report path.</p>
          </article>
        </div>
      </section>
    </div>
      </div>
    </div>
  `,
  });
}

function securityPageHtml(origin = PUBLIC_ORIGIN) {
  const supportEmail = resolveSupportEmail(origin);
  const securityMailto = `mailto:${supportEmail}?subject=${encodeURIComponent("Turnfeed security report")}`;
  return pageHtml({
    origin,
    title: `${PUBLIC_APP_NAME} · Security`,
    canonicalPath: "/security",
    description: `Security disclosure policy for ${PUBLIC_APP_NAME}. How to report a vulnerability safely and what information helps the operator investigate.`,
    showPublicNav: true,
    extraStyles: `
      .security-hero {
        display: grid;
        gap: 16px;
        padding: clamp(22px, 4vw, 36px);
        border-radius: 8px;
        background: linear-gradient(135deg, rgba(255,255,255,.98), rgba(241,247,255,.96));
        border: 1px solid rgba(15,23,42,.07);
      }
      .security-hero .lead,
      .security-card p,
      .security-card li,
      .security-note {
        color: var(--text-soft);
        line-height: 1.55;
      }
      .security-hero .lead,
      .security-card p,
      .security-note { margin: 0; }
      .security-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
        margin-top: 18px;
      }
      .security-card {
        display: grid;
        align-content: start;
        gap: 9px;
        padding: 18px;
        border-radius: 8px;
        background: rgba(255,255,255,.94);
        border: 1px solid rgba(15,23,42,.07);
      }
      .security-card h2 { margin: 0; font-size: 1.12rem; }
      .security-card ul { margin: 0; padding-left: 20px; }
      @media (max-width: 760px) { .security-grid { grid-template-columns: 1fr; } }
      .security-grid {
        grid-template-columns: 1fr;
        gap: 0;
        margin: 0;
      }
      .security-card {
        scroll-margin-top: 24px;
        padding: 24px 0;
        border: 0;
        border-top: 1px solid rgba(19,35,63,.1);
        border-radius: 0;
        background: transparent;
      }
      .security-card:first-child {
        border-top: 0;
      }
      .security-card h2 {
        font-size: 1.12rem;
      }
    `,
    body: `
      <section class="document-hero">
        <p class="document-kicker">Trust &amp; safety</p>
        <div class="brand-lockup">
          ${brandLogoImgMarkup({ title: `${PUBLIC_APP_NAME} logo`, origin })}
          <div class="brand-copy"><h1>Security disclosure</h1></div>
        </div>
        <p class="document-lead">If you believe you found a vulnerability in Turnfeed, report it privately so it can be investigated without putting other people or their data at risk.</p>
        <div class="document-actions">
          <a class="btn btn-primary" href="${escapeHtml(securityMailto)}">Email a security report</a>
          <a class="btn" href="/support">General support</a>
        </div>
        <p class="document-meta">Security contact: <a href="mailto:${supportEmail}">${supportEmail}</a>. Use the subject <code>Turnfeed security report</code>.</p>
      </section>
      <div class="document-layout">
        <aside class="document-toc">
          <p class="document-toc-label">On this page</p>
          <nav aria-label="Security disclosure sections">
            <ul class="document-toc-list">
              <li><a href="#security-include">What to include</a></li>
              <li><a href="#security-safe">Keep it safe</a></li>
              <li><a href="#security-boundaries">Research boundaries</a></li>
              <li><a href="#security-disclosure">Responsible disclosure</a></li>
            </ul>
          </nav>
        </aside>
        <div class="document-content">
        <section class="document-section" aria-labelledby="security-guidance-heading">
          <div class="document-section-head">
            <h2 id="security-guidance-heading">Report a vulnerability safely</h2>
            <p>Share only what is needed to reproduce and understand the issue.</p>
          </div>
          <div class="security-grid">
        <article class="security-card" id="security-include">
          <h2>What to include</h2>
          <ul>
            <li>The affected URL, route, or feature</li>
            <li>Clear reproduction steps and expected impact</li>
            <li>A minimal, non-destructive proof of concept</li>
            <li>A safe way to contact you for follow-up</li>
          </ul>
        </article>
        <article class="security-card" id="security-safe">
          <h2>Keep the report safe</h2>
          <ul>
            <li>Do not send passwords, access tokens, private keys, or unrelated personal data</li>
            <li>Do not retrieve, download, screenshot, or attach suspected child sexual abuse material or other exploitative material</li>
            <li>Use a URL or Turnfeed identifier when sensitive content is involved</li>
          </ul>
        </article>
        <article class="security-card" id="security-boundaries">
          <h2>Research boundaries</h2>
          <ul>
            <li>Do not access, change, delete, or publish another person's data</li>
            <li>Do not disrupt the service, run denial-of-service tests, spam, or social-engineer people</li>
            <li>Stop as soon as you have enough evidence to explain the issue</li>
          </ul>
        </article>
        <article class="security-card" id="security-disclosure">
          <h2>Responsible disclosure</h2>
          <p>Keep the issue private while it is being investigated. The operator may ask for clarification or a safer reproduction. This page does not authorize access beyond your own account or ordinary public surfaces.</p>
          <p class="security-note"><a href="${escapeHtml(SECURITY_TXT_PATH)}">Technical disclosure details</a> are available for security tools and researchers.</p>
        </article>
      </div>
        </section>
        </div>
      </div>
    `,
  });
}

function homeHtml(origin = PUBLIC_ORIGIN) {
  const demoVideoAvailable = Boolean(TURNFEED_DEMO_VIDEO_URL && TURNFEED_DEMO_VIDEO_EMBED_URL);
  return pageHtml({
    origin,
    title: PUBLIC_APP_NAME,
    canonicalPath: "/",
    showPublicNav: true,
    bodyClass: "home-page",
    description: `${PUBLIC_APP_NAME} is a shared public feed in ChatGPT. Read posts published on Turnfeed, open conversations, and take part. You can also use Turnfeed in Codex.`,
    extraStyles: `
      main {
        max-width: min(1180px, calc(100vw - 48px));
      }
      .home-hero {
        position: relative;
        overflow: hidden;
        display: grid;
        grid-template-columns: minmax(300px, .9fr) minmax(320px, 1.1fr);
        gap: clamp(22px, 3vw, 36px);
        align-items: start;
        min-height: 0;
        padding: clamp(22px, 4vw, 48px);
        border-radius: 8px;
        background: rgba(255,255,255,.62);
        border: 1px solid rgba(15,23,42,.07);
        box-shadow: 0 24px 70px rgba(15,23,42,.07);
      }
      .home-hero::before {
        display: none;
      }
      .home-copy {
        position: relative;
        z-index: 1;
        display: grid;
        gap: 20px;
        max-width: 730px;
        min-width: 0;
        padding-top: clamp(8px, 1.8vw, 20px);
      }
      .home-lockup {
        margin-bottom: 0;
      }
      .home-lockup .brand-mark {
        width: 64px;
        height: 64px;
        border-radius: 8px;
      }
      .home-lockup .brand-copy {
        gap: 3px;
      }
      .home-lockup h1 {
        margin: 0;
        font-size: 1.5rem;
        letter-spacing: 0;
        color: #0f172a;
      }
      .home-kicker {
        margin: 0;
        color: #52607a;
        font-size: .98rem;
        line-height: 1.35;
      }
      .home-headline {
        margin: 0;
        max-width: 15ch;
        font-size: clamp(2.45rem, 4vw, 3.4rem);
        line-height: .98;
        letter-spacing: 0;
        color: #0f172a;
      }
      .home-copy .lead {
        margin: 0;
        max-width: 58ch;
        font-size: clamp(1.06rem, 1.5vw, 1.25rem);
        line-height: 1.58;
        color: #465a72;
        overflow-wrap: break-word;
      }
      .hero-actions.home-actions {
        gap: 10px;
      }
      .home-actions .btn {
        min-height: 48px;
      }
      .home-scope-note {
        margin: -8px 0 0;
        max-width: 58ch;
        color: #30445d;
        font-weight: 700;
        line-height: 1.45;
      }
      .home-prompt-card {
        display: grid;
        gap: 8px;
        width: min(100%, 540px);
        padding: 13px 14px;
        border-radius: 8px;
        background: rgba(255,255,255,.84);
        border: 1px solid rgba(15,23,42,.08);
        box-shadow: none;
      }
      .home-prompt-label {
        font-family: "IBM Plex Mono", "SFMono-Regular", "Cascadia Code", monospace;
        font-size: .68rem;
        font-weight: 800;
        letter-spacing: 0;
        text-transform: uppercase;
        color: #32526c;
      }
      .home-prompt-card code {
        display: block;
        width: 100%;
        padding: 9px 10px;
        border-radius: 8px;
        background: #eef4ff;
        color: #183454;
        font-size: .9rem;
        line-height: 1.35;
      }
      .home-note {
        margin: 0;
        max-width: 58ch;
        color: #53657d;
      }
      .home-visual {
        position: relative;
        z-index: 1;
        display: grid;
        align-content: start;
        min-width: 0;
      }
      .home-panel {
        display: grid;
        gap: 18px;
        min-width: 0;
        padding: clamp(18px, 3vw, 26px);
        border-radius: 8px;
        background: rgba(255,255,255,.84);
        border: 1px solid rgba(15,23,42,.08);
        box-shadow: 0 16px 42px rgba(15,23,42,.06);
      }
      .home-panel-head {
        display: grid;
        gap: 8px;
      }
      .home-panel-head strong {
        margin: 0;
        color: #0f172a;
        font-size: 1.45rem;
        line-height: 1.12;
        letter-spacing: 0;
      }
      .home-panel-head p {
        margin: 0;
        color: var(--text-soft);
        line-height: 1.55;
      }
      .home-prompt-list,
      .home-rule-list {
        display: grid;
        gap: 12px;
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .home-prompt-list li,
      .home-rule-list li {
        min-width: 0;
        padding-top: 12px;
        border-top: 1px solid rgba(15,23,42,.08);
      }
      .home-prompt-list li:first-child,
      .home-rule-list li:first-child {
        padding-top: 0;
        border-top: 0;
      }
      .home-prompt-list strong,
      .home-rule-list strong {
        display: block;
        margin-bottom: 4px;
        color: #0f172a;
      }
      .home-prompt-list code {
        display: block;
        margin-top: 6px;
        width: 100%;
        background: #eef4ff;
        color: #183454;
      }
      .home-rule-list span {
        color: var(--text-soft);
      }
      .home-stack {
        gap: 22px;
      }
      .home-section {
        padding: clamp(24px, 4vw, 40px);
        background: transparent;
        box-shadow: none;
        border: 0;
        border-top: 1px solid rgba(15,23,42,.1);
        border-radius: 0;
      }
      .section-head {
        display: grid;
        gap: 9px;
        margin: 0;
        max-width: 680px;
      }
      .section-label,
      .home-page h2.section-label {
        margin: 0;
        font-family: "IBM Plex Mono", "SFMono-Regular", "Cascadia Code", monospace;
        font-size: .76rem;
        font-weight: 700;
        letter-spacing: 0;
        text-transform: uppercase;
        color: #32526c;
      }
      .section-head h2 {
        margin: 0;
        font-size: 1.38rem;
        letter-spacing: 0;
      }
      .section-head p {
        margin: 0;
        color: var(--text-soft);
      }
      .product-panel,
      .connect-panel {
        display: grid;
        grid-template-columns: minmax(0, .9fr) minmax(0, 1.1fr);
        gap: clamp(18px, 4vw, 38px);
        align-items: start;
      }
      .benefit-list {
        display: grid;
        gap: 12px;
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .benefit-list li {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        gap: 12px;
        align-items: start;
        padding: 16px 0;
        border-radius: 8px;
        background: transparent;
        border: 0;
        border-top: 1px solid rgba(15,23,42,.08);
      }
      .benefit-list li:first-child {
        border-top: 0;
        padding-top: 0;
      }
      .benefit-dot {
        display: inline-grid;
        place-items: center;
        width: 28px;
        height: 28px;
        border-radius: 8px;
        background: #eef4ff;
        color: #165df5;
        border: 1px solid rgba(22,93,245,.18);
        font-size: .78rem;
        font-weight: 800;
      }
      .benefit-list strong {
        display: block;
        margin-bottom: 3px;
        color: #0f172a;
      }
      .benefit-list span {
        color: var(--text-soft);
      }
      .benefit-list .benefit-dot {
        color: #165df5;
      }
      .connect-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }
      .faq-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px 28px;
        margin-top: 16px;
      }
      .faq-item {
        min-width: 0;
        padding-top: 14px;
        border-top: 1px solid rgba(15,23,42,.08);
      }
      .faq-item strong {
        display: block;
        margin-bottom: 4px;
        color: #0f172a;
      }
      .faq-item p {
        margin: 0;
        color: var(--text-soft);
        line-height: 1.52;
      }
      .connect-card {
        display: grid;
        gap: 7px;
        min-height: 150px;
        padding: 18px;
        border-radius: 8px;
        background: #fff;
        border: 1px solid rgba(15,23,42,.08);
        color: inherit;
        text-decoration: none;
        box-shadow: 0 14px 34px rgba(15,23,42,.05);
      }
      .connect-card:hover {
        transform: translateY(-1px);
        box-shadow: 0 18px 42px rgba(15,23,42,.09);
      }
      .connect-card strong {
        color: #0f172a;
        font-size: 1.08rem;
      }
      .connect-card span,
      .connect-card p {
        margin: 0;
        color: var(--text-soft);
      }
      .connect-card-primary {
        grid-column: 1 / -1;
        background: #0f172a;
        color: #fff;
      }
      .connect-card-primary strong,
      .connect-card-primary span,
      .connect-card-primary p {
        color: #fff;
      }
      .connect-card code {
        overflow-wrap: anywhere;
        color: #24476e;
      }
      .connect-small {
        grid-column: 1 / -1;
        margin: 4px 0 0;
        color: var(--text-soft);
        font-size: .94rem;
      }
      @media (max-width: 1100px) {
        .home-hero,
        .product-panel,
        .connect-panel {
          grid-template-columns: 1fr;
        }
        .home-hero {
          min-height: auto;
        }
      }
      @media (max-width: 760px) {
        html,
        body {
          width: 100%;
          max-width: 100%;
          overflow-x: hidden;
        }
        main {
          width: calc(100vw - 20px);
          max-width: calc(100vw - 20px);
          margin: 10px auto;
        }
        .home-hero {
          width: 100%;
          max-width: 100%;
          grid-template-columns: minmax(0, 1fr);
          padding: 28px 16px;
          border-radius: 8px;
          overflow: hidden;
        }
        .home-hero *,
        .home-copy,
        .home-visual,
        .home-panel {
          min-width: 0;
          max-width: 100%;
        }
        .home-copy,
        .home-visual,
        .home-panel,
        .home-prompt-card,
        .home-prompt-list,
        .home-rule-list {
          width: 100%;
        }
        .brand-lockup.home-lockup {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr);
          align-items: start;
          justify-content: center;
        }
        .home-lockup .brand-mark {
          width: 58px;
          height: 58px;
          border-radius: 8px;
        }
        .home-headline {
          margin-inline: auto;
          max-width: 11ch;
          font-size: clamp(1.9rem, 8vw, 2.35rem);
          text-align: center;
          overflow-wrap: anywhere;
          word-break: break-word;
        }
        .home-copy .lead,
        .home-scope-note,
        .home-note {
          max-width: 100%;
          text-align: center;
          overflow-wrap: anywhere;
          word-break: break-word;
        }
        .home-actions {
          display: grid;
          grid-template-columns: 1fr;
        }
        .home-actions .btn {
          justify-content: center;
        }
        .home-prompt-card {
          width: 100%;
          text-align: left;
        }
        .home-prompt-card code,
        .home-prompt-list code {
          white-space: normal;
          overflow-wrap: anywhere;
          word-break: break-word;
        }
        .home-visual {
          display: grid;
        }
        .home-panel {
          padding: 16px;
          background: rgba(255,255,255,.9);
          border: 1px solid rgba(15,23,42,.08);
          box-shadow: none;
        }
        .home-panel-head strong,
        .home-panel-head p,
        .home-prompt-list strong,
        .home-prompt-list span,
        .home-rule-list strong,
        .home-rule-list span {
          overflow-wrap: anywhere;
          word-break: normal;
        }
        .connect-grid {
          grid-template-columns: 1fr;
        }
        .faq-grid {
          grid-template-columns: 1fr;
        }
      }
      /* Approved public-site direction: native ChatGPT proof, quiet social layer. */
      .home-hero {
        grid-template-columns: minmax(0, .88fr) minmax(520px, 1.12fr);
        align-items: center;
        gap: clamp(40px, 6vw, 78px);
        min-height: 620px;
        padding: clamp(54px, 7vw, 88px) clamp(28px, 5vw, 68px);
        border: 1px solid var(--line);
        border-radius: 18px;
        background: #fff;
        box-shadow: none;
      }
      .home-copy {
        gap: 22px;
        padding: 0;
      }
      .home-eyebrow {
        width: fit-content;
        margin: 0;
        color: var(--brand-dark);
        font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
        font-size: .72rem;
        font-weight: 800;
        letter-spacing: .055em;
        text-transform: uppercase;
      }
      .home-headline {
        max-width: 10.5ch;
        font-size: clamp(3rem, 5.1vw, 4.65rem);
        line-height: .98;
        letter-spacing: -.055em;
      }
      .home-copy .lead {
        max-width: 48ch;
        font-size: clamp(1.08rem, 1.4vw, 1.22rem);
        line-height: 1.55;
      }
      .home-actions .btn {
        min-height: 50px;
        padding-inline: 18px;
      }
      .home-scope-note {
        margin: -6px 0 0;
        font-size: .94rem;
      }
      .home-note {
        padding-top: 17px;
        border-top: 1px solid var(--line);
        color: var(--text-muted);
        font-size: .9rem;
        line-height: 1.5;
      }
      .home-note strong { color: #33415c; }
      .chatgpt-proof {
        margin: 0;
        overflow: hidden;
        border: 1px solid #d8e0eb;
        border-radius: 18px;
        background: #fff;
        box-shadow: 0 24px 70px rgba(19,35,63,.12);
      }
      .chatgpt-proof-head {
        display: flex;
        align-items: center;
        gap: 11px;
        min-height: 68px;
        padding: 14px 18px;
        border-bottom: 1px solid var(--line);
      }
      .chatgpt-proof-head div { display: grid; gap: 1px; }
      .chatgpt-proof-head strong { color: var(--ink); font-size: .95rem; }
      .chatgpt-proof-head span { color: var(--text-muted); font-size: .78rem; }
      .chatgpt-proof-mark {
        width: 34px;
        height: 34px;
        border-radius: 8px;
        object-fit: contain;
      }
      .chatgpt-proof-video,
      .chatgpt-proof-video iframe {
        display: block;
        width: 100%;
      }
      .chatgpt-proof-video {
        overflow: hidden;
        aspect-ratio: 16 / 9;
        background: #000;
      }
      .chatgpt-proof-video iframe {
        height: 100%;
        border: 0;
      }
      .chatgpt-proof figcaption {
        padding: 13px 18px 15px;
        border-top: 1px solid var(--line);
        color: var(--text-muted);
        font-size: .82rem;
        line-height: 1.45;
      }
      .feed-glimpse {
        margin-top: 20px;
        padding: clamp(24px, 4vw, 38px);
        border: 1px solid var(--line);
        border-radius: 16px;
        background: #fff;
      }
      .feed-glimpse-head {
        display: flex;
        align-items: end;
        justify-content: space-between;
        gap: 24px;
        margin-bottom: 16px;
      }
      .feed-glimpse-head h2 { margin: 3px 0 0; font-size: 1.45rem; }
      .feed-glimpse-head > a {
        display: inline-flex;
        align-items: center;
        min-height: 44px;
        font-weight: 800;
        white-space: nowrap;
      }
      .feed-glimpse-list {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        border-top: 1px solid var(--line);
      }
      .feed-glimpse-list article {
        min-width: 0;
        padding: 18px 20px 0 0;
      }
      .feed-glimpse-list article + article {
        padding-left: 20px;
        border-left: 1px solid var(--line);
      }
      .feed-glimpse-list strong { display: block; overflow-wrap: anywhere; }
      .feed-glimpse-list strong span { color: var(--text-muted); font-weight: 500; }
      .feed-glimpse-list p { margin: 7px 0 0; color: var(--text-soft); font-size: .94rem; }
      .home-stack { margin-top: 34px; }
      .home-section { padding-inline: 0; }
      .connect-card { box-shadow: none; }
      .connect-card-primary { background: var(--ink); }
      @media (max-width: 1100px) {
        .home-hero {
          grid-template-columns: 1fr;
          min-height: 0;
          padding: clamp(42px, 7vw, 66px);
        }
        .home-headline { max-width: 12ch; }
        .home-copy .lead { max-width: 58ch; }
        .home-visual { max-width: 820px; }
      }
      @media (max-width: 760px) {
        .home-hero {
          gap: 34px;
          padding: 40px 20px 22px;
          border-radius: 14px;
        }
        .home-headline {
          margin: 0;
          max-width: 12ch;
          font-size: clamp(2.6rem, 13vw, 3.7rem);
          text-align: left;
          word-break: normal;
        }
        .home-copy .lead,
        .home-scope-note,
        .home-note { text-align: left; }
        .home-actions { display: grid; }
        .chatgpt-proof { border-radius: 12px; box-shadow: 0 14px 36px rgba(19,35,63,.11); }
        .chatgpt-proof-head { min-height: 62px; padding: 12px 14px; }
        .chatgpt-proof figcaption { padding-inline: 14px; }
        .feed-glimpse { padding: 24px 18px; }
        .feed-glimpse-head { align-items: start; }
        .feed-glimpse-list { grid-template-columns: 1fr; }
        .feed-glimpse-list article { padding: 16px 0; }
        .feed-glimpse-list article + article { padding-left: 0; border-left: 0; border-top: 1px solid var(--line); }
        .feed-glimpse-list article:nth-child(n+3) { display: none; }
      }
      @media (max-width: 420px) {
        .feed-glimpse-head { display: grid; gap: 8px; }
        .home-hero { padding-inline: 18px; }
      }
      /* Claude Design handoff: full-width chat-first homepage system. */
      .home-page {
        padding: 0;
        background: #fff;
      }
      .home-page main {
        width: 100%;
        max-width: none;
        margin: 0;
        overflow: clip;
        border: 0;
        border-radius: 0;
        background: #fff;
        box-shadow: none;
      }
      .home-page .site-header {
        min-height: 78px;
        margin: 0;
        padding: 0 clamp(28px, 7.2vw, 104px);
        background: #fff;
      }
      @media (min-width: 1024px) {
        .home-page .public-nav { gap: 1px; }
        .home-page .public-nav a { padding-inline: 8px; }
      }
      .home-page .home-hero {
        grid-template-columns: minmax(0, 1.08fr) minmax(460px, .92fr);
        align-items: start;
        gap: 44px;
        min-height: 590px;
        padding: clamp(62px, 6vw, 86px) clamp(28px, 7.2vw, 104px);
        border: 0;
        border-radius: 0;
        background: #f1f5fd;
      }
      .home-page .home-headline {
        max-width: none;
        font-size: clamp(3.25rem, 4vw, 3.7rem);
        line-height: 1.02;
        letter-spacing: -.048em;
      }
      .home-page .home-copy { gap: 21px; }
      .home-page .home-copy .lead { max-width: 43ch; }
      .home-page .home-note {
        max-width: 48ch;
        padding-top: 17px;
      }
      .home-page .chatgpt-proof {
        border-radius: 16px;
        box-shadow: 0 22px 58px rgba(19,35,63,.1);
      }
      .home-page .chatgpt-proof-head {
        justify-content: space-between;
        min-height: 56px;
        padding: 12px 16px;
      }
      .home-page .chatgpt-proof-head strong {
        color: #607394;
        font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
        font-size: .7rem;
        letter-spacing: .08em;
        text-transform: uppercase;
      }
      .home-page .chatgpt-proof-head a,
      .home-page .chatgpt-proof-head span {
        font-size: .84rem;
        font-weight: 800;
      }
      .home-page .chatgpt-proof-video,
      .home-page .chatgpt-proof-video iframe {
        display: block;
        width: 100%;
      }
      .home-page .feed-glimpse {
        margin: 0;
        padding: 42px clamp(28px, 7.2vw, 104px) 46px;
        border: 0;
        border-top: 1px solid var(--line);
        border-bottom: 1px solid var(--line);
        border-radius: 0;
      }
      .home-page .feed-glimpse-head { align-items: center; margin-bottom: 20px; }
      .home-page .feed-glimpse-list article { padding-top: 20px; }
      .home-page .feed-glimpse-list p { min-height: 4.5em; }
      .home-page .feed-glimpse-list article > a,
      .home-page .feed-card-label {
        display: inline-flex;
        align-items: center;
        min-height: 44px;
        margin-top: 6px;
        font-weight: 800;
      }
      .home-page .feed-card-label {
        color: var(--text-muted);
        font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
        font-size: .7rem;
        letter-spacing: .05em;
        text-transform: uppercase;
      }
      .try-section {
        padding: 56px clamp(28px, 7.2vw, 104px) 60px;
        background: #f1f5fd;
        border-bottom: 1px solid var(--line);
      }
      .try-section-head,
      .faq-section-head {
        display: flex;
        align-items: end;
        justify-content: space-between;
        gap: 30px;
      }
      .try-section-head > div { max-width: 760px; }
      .try-section h2,
      .faq-section h2,
      .demo-copy h2 {
        margin: 7px 0 8px;
        font-size: clamp(1.7rem, 2.5vw, 2.25rem);
        letter-spacing: -.025em;
      }
      .try-section-head p,
      .demo-copy > p,
      .faq-section-head p { color: var(--text-soft); }
      .try-section-head > a,
      .faq-section-head > a {
        display: inline-flex;
        align-items: center;
        min-height: 44px;
        font-weight: 800;
        white-space: nowrap;
      }
      .prompt-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: clamp(22px, 4vw, 42px);
        margin-top: 34px;
      }
      .prompt-grid article { min-width: 0; }
      .prompt-grid h3 { margin: 0 0 7px; font-size: 1.03rem; }
      .prompt-grid p { min-height: 4.8em; margin: 0 0 12px; color: var(--text-soft); }
      .prompt-grid code {
        display: block;
        min-height: 52px;
        padding: 14px;
        background: #e9f1fc;
        font-size: .85rem;
        line-height: 1.45;
      }
      .flow-demo-grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: clamp(50px, 8vw, 120px);
        padding: 64px clamp(28px, 7.2vw, 104px);
        border-bottom: 1px solid var(--line);
      }
      .flow-list {
        display: grid;
        gap: 22px;
        margin: 26px 0 0;
        padding-left: 26px;
      }
      .flow-list li { padding-left: 8px; }
      .flow-list li::marker { color: var(--brand); font-weight: 900; }
      .flow-list strong,
      .flow-list span { display: block; }
      .flow-list strong { margin-bottom: 4px; }
      .flow-list span { color: var(--text-soft); }
      .demo-copy { align-self: center; }
      .demo-copy > a {
        display: inline-flex;
        align-items: center;
        min-height: 44px;
        margin-top: 8px;
        font-weight: 800;
      }
      .demo-status { margin-top: 14px; }
      .faq-section {
        padding: 50px clamp(28px, 7.2vw, 104px) 56px;
        border-bottom: 1px solid var(--line);
      }
      .faq-list {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0 36px;
        margin-top: 24px;
        border-top: 1px solid var(--line);
      }
      .faq-list details { min-width: 0; border-bottom: 1px solid var(--line); }
      .faq-list summary {
        display: flex;
        align-items: center;
        min-height: 54px;
        padding: 10px 0;
        color: var(--ink);
        cursor: pointer;
        font-weight: 800;
      }
      .faq-list details p { margin: -2px 0 18px; color: var(--text-soft); }
      .home-page .footer {
        margin: 0;
        padding: 26px clamp(28px, 7.2vw, 104px) 30px;
        background: #fff;
      }
      @media (max-width: 1100px) {
        .home-page .home-hero {
          grid-template-columns: 1fr;
          min-height: 0;
        }
        .home-page .home-copy .lead,
        .home-page .home-note { max-width: 62ch; }
        .home-page .home-visual { max-width: 840px; }
      }
      @media (max-width: 760px) {
        .home-page main {
          width: 100%;
          max-width: 100%;
          margin: 0;
          overflow: visible;
          border: 0;
          border-radius: 0;
          box-shadow: none;
        }
        .home-page .site-header {
          min-height: 70px;
          padding: 0 20px;
          margin: 0;
          background: #fff;
        }
        .home-page .public-nav {
          gap: 16px;
          max-height: calc(100dvh - 69px);
          overflow-y: auto;
          overscroll-behavior: contain;
        }
        .home-page .home-hero {
          gap: 34px;
          padding: 32px 20px 34px;
          border-radius: 0;
        }
        .home-page .home-headline {
          max-width: none;
          font-size: clamp(2rem, 8.8vw, 2.15rem);
          line-height: 1.04;
        }
        .home-page .home-actions .btn { width: 100%; }
        .home-page .home-note { padding-top: 16px; }
        .home-page .chatgpt-proof { border-radius: 14px; }
        .home-page .chatgpt-proof-head {
          align-items: flex-start;
          gap: 10px;
          padding: 13px 14px;
        }
        .home-page .chatgpt-proof-head strong { max-width: 25ch; }
        .home-page .feed-glimpse,
        .try-section,
        .flow-demo-grid,
        .faq-section { padding: 34px 20px 38px; }
        .home-page .feed-glimpse-head,
        .try-section-head,
        .faq-section-head { display: grid; gap: 6px; }
        .home-page .feed-glimpse-list { grid-template-columns: 1fr; }
        .home-page .feed-glimpse-list article,
        .home-page .feed-glimpse-list article + article {
          padding: 20px 0;
          border-left: 0;
          border-top: 1px solid var(--line);
        }
        .home-page .feed-glimpse-list article:nth-child(n+3) { display: none; }
        .home-page .feed-glimpse-list p { min-height: 0; }
        .prompt-grid,
        .flow-demo-grid,
        .faq-list { grid-template-columns: 1fr; }
        .prompt-grid { gap: 28px; margin-top: 28px; }
        .prompt-grid p { min-height: 0; }
        .flow-demo-grid { gap: 42px; }
        .faq-list { gap: 0; }
        .home-page .footer { padding: 24px 20px 28px; }
      }
      @media (max-width: 359px) {
        .home-page .home-headline { font-size: 1.8rem; }
        .home-page .home-hero,
        .home-page .feed-glimpse,
        .try-section,
        .flow-demo-grid,
        .faq-section,
        .home-page .footer { padding-inline: 16px; }
      }
      /* Turnfeed Final: one calm, ChatGPT-first product story. */
      .home-page {
        background: #f3f6fb;
      }
      .home-page main {
        background: #f3f6fb;
      }
      .home-page .site-header {
        min-height: 64px;
        padding-inline: max(20px, calc((100vw - 1224px) / 2));
      }
      .home-page .home-hero {
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        align-items: start;
        gap: 56px;
        min-height: 0;
        padding: 60px max(20px, calc((100vw - 1224px) / 2)) 56px;
        background: #f3f6fb;
      }
      .home-page .home-copy {
        gap: 0;
      }
      .home-page .home-eyebrow {
        margin: 0;
        color: #56688a;
        font-size: .75rem;
        font-weight: 600;
        letter-spacing: .14em;
      }
      .home-page .home-headline {
        margin-top: 16px;
        max-width: none;
        font-size: clamp(3rem, 3.5vw, 3.2rem);
        line-height: 1.07;
        font-weight: 900;
        letter-spacing: -1.4px;
        text-wrap: balance;
      }
      .home-page .home-copy .lead {
        margin-top: 18px;
        max-width: 40ch;
        color: #44546e;
        font-size: 1.125rem;
        line-height: 1.6;
      }
      .home-page .home-actions {
        margin-top: 26px;
      }
      .home-page .home-actions .btn {
        min-height: 50px;
        padding: 13px 20px;
        border-color: #c9d6e8;
        border-radius: 11px;
        font-size: 1rem;
        font-weight: 800;
      }
      .home-page .home-actions .btn-primary {
        border-color: transparent;
      }
      .home-page .home-scope-note {
        margin: 14px 0 0;
        max-width: 48ch;
        color: #5b6b85;
        font-size: .84rem;
        font-weight: 500;
        line-height: 1.6;
      }
      .home-page .home-scope-note code {
        padding: 3px 7px;
        border-radius: 6px;
        background: #eaf0f9;
        color: #2b3c5c;
        font-size: .75rem;
        font-weight: 600;
        white-space: nowrap;
      }
      .home-page .home-note {
        margin: 16px 0 0;
        max-width: 48ch;
        padding-top: 14px;
        color: #5b6b85;
        font-size: .82rem;
        line-height: 1.55;
      }
      .home-page .home-note strong {
        display: block;
        margin-bottom: 4px;
        line-height: 1.45;
      }
      .home-page .chatgpt-proof {
        overflow: visible;
        padding: 14px;
        border-color: #e2e8f2;
        border-radius: 16px;
        box-shadow: 0 10px 30px rgba(19,35,63,.08);
      }
      .home-page .home-visual { margin-top: 26px; }
      .home-page .chatgpt-proof-head {
        min-height: 0;
        padding: 2px 4px 10px;
        border: 0;
      }
      .home-page .chatgpt-proof-head strong {
        max-width: none;
        color: #56688a;
        font-size: .66rem;
        font-weight: 600;
        letter-spacing: .12em;
      }
      .home-page .chatgpt-proof-video {
        overflow: hidden;
        border: 1px solid #e2e8f2;
        border-radius: 10px;
      }
      .home-page .chatgpt-proof figcaption {
        padding: 10px 4px 2px;
        border: 0;
        color: #5b6b85;
        font-size: .81rem;
        line-height: 1.55;
      }
      .home-page .chatgpt-demo-pending {
        display: grid;
        place-items: center;
        min-height: 320px;
        padding: clamp(32px, 7vw, 64px);
        border: 1px solid #e2e8f2;
        border-radius: 10px;
        background: linear-gradient(145deg, #f8fbff 0%, #eef4fc 100%);
        text-align: center;
      }
      .home-page .chatgpt-demo-pending img {
        display: block;
        width: min(100%, 220px);
        height: auto;
      }
      .home-page .chatgpt-demo-pending p {
        margin: 18px 0 0;
        max-width: 34ch;
        color: #56688a;
        font-size: .9rem;
        line-height: 1.55;
      }
      .how-section,
      .try-section,
      .trust-section,
      .faq-section,
      .directory-section {
        padding-inline: max(20px, calc((100vw - 1224px) / 2));
        border-radius: 0;
      }
      .how-section {
        display: grid;
        grid-template-columns: minmax(0, .9fr) minmax(0, 1.1fr);
        gap: 56px;
        align-items: start;
        padding-top: 50px;
        padding-bottom: 54px;
        border-top: 1px solid #e5ebf3;
        background: #fff;
      }
      .how-intro h2 {
        margin: 12px 0 0;
        color: #13233f;
        font-size: 1.875rem;
        font-weight: 900;
        letter-spacing: -.6px;
      }
      .how-intro > p:not(.section-label) {
        max-width: 42ch;
        margin: 12px 0 0;
        color: #44546e;
        font-size: .97rem;
        line-height: 1.65;
      }
      .how-intro > a,
      .section-inline-heading > a,
      .trust-grid a {
        display: inline-flex;
        align-items: center;
        min-height: 44px;
        color: #1c63c7;
        font-size: .9rem;
        font-weight: 800;
      }
      .how-intro > a {
        margin-top: 8px;
      }
      .how-steps {
        display: grid;
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .how-steps li {
        display: flex;
        gap: 14px;
        padding: 16px 0;
        border-bottom: 1px solid #ecf1f7;
      }
      .how-steps li:first-child { padding-top: 0; }
      .how-steps li:last-child { padding-bottom: 0; border-bottom: 0; }
      .step-number {
        display: inline-flex;
        flex: 0 0 auto;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        border-radius: 8px;
        background: #eaf0f9;
        color: #1c63c7;
        font-size: .81rem;
        font-weight: 800;
      }
      .how-steps > li > div > strong {
        color: #13233f;
        font-size: 1.03rem;
      }
      .how-steps p {
        margin: 5px 0 0;
        color: #44546e;
        font-size: .9rem;
        line-height: 1.6;
      }
      .how-steps p strong {
        color: inherit;
        font-size: inherit;
        line-height: inherit;
      }
      .try-section {
        padding-top: 46px;
        padding-bottom: 50px;
        border-top: 1px solid #e5ebf3;
        border-bottom: 0;
        background: #f3f6fb;
      }
      .section-inline-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 24px;
      }
      .prompt-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 24px;
        margin-top: 18px;
      }
      .prompt-grid code {
        display: flex;
        align-items: center;
        min-height: 48px;
        padding: 12px 14px;
        border-radius: 9px;
        background: #eef3fa;
        color: #2b3c5c;
        font-size: .78rem;
        font-weight: 500;
        line-height: 1.45;
        white-space: normal;
      }
      .prompt-grid article { display: flex; flex-direction: column; }
      .prompt-grid code { flex: 1; }
      .prompt-grid .btn {
        align-self: flex-start;
        min-height: 44px;
        margin-top: 10px;
        font-size: .84rem;
      }
      .prompt-help, .prompt-copy-status {
        color: var(--text-soft);
        font-size: .9rem;
        line-height: 1.5;
      }
      .prompt-help { margin: 12px 0 0; }
      .prompt-copy-status { min-height: 1.5em; margin: 12px 0 0; }
      .trust-section {
        padding-top: 46px;
        padding-bottom: 50px;
        border-top: 1px solid #e5ebf3;
        background: #fff;
      }
      .trust-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        align-items: start;
        margin-top: 18px;
      }
      .trust-grid article {
        min-width: 0;
        padding: 2px 28px 0;
        border-left: 1px solid #ecf1f7;
      }
      .trust-grid article:first-child {
        padding-left: 0;
        border-left: 0;
      }
      .trust-grid article:last-child { padding-right: 0; }
      .trust-grid h3 {
        margin: 0;
        color: #13233f;
        font-size: 1.03rem;
        font-weight: 800;
      }
      .trust-grid p {
        margin: 7px 0 0;
        color: #44546e;
        font-size: .9rem;
        line-height: 1.6;
      }
      .trust-grid a { margin-top: 4px; }
      .home-page .faq-section {
        padding-top: 42px;
        padding-bottom: 46px;
        border-top: 1px solid #e5ebf3;
        border-bottom: 0;
        background: #f3f6fb;
      }
      .home-page .faq-list {
        margin-top: 20px;
      }
      .directory-section {
        padding-top: 40px;
        padding-bottom: 46px;
        border-top: 1px solid #e5ebf3;
        background: #f3f6fb;
      }
      .directory-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0 56px;
        margin-top: 12px;
      }
      .directory-grid a {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 16px;
        min-height: 48px;
        padding: 13px 0;
        border-bottom: 1px solid #e5ebf3;
        color: #13233f;
        text-decoration: none;
      }
      .directory-grid a:hover strong,
      .directory-grid a:focus-visible strong {
        color: #1c63c7;
      }
      .directory-grid strong {
        font-size: .94rem;
        font-weight: 800;
      }
      .directory-grid span {
        color: #5b6b85;
        font-size: .84rem;
        text-align: right;
      }
      .directory-note {
        max-width: 72ch;
        margin: 20px 0 0;
        color: #44546e;
        font-size: .9rem;
        line-height: 1.65;
      }
      .home-page .footer {
        margin: 0;
        padding: 28px max(20px, calc((100vw - 1224px) / 2)) 34px;
        border-top: 1px solid #e5ebf3;
        background: #fff;
      }
      #demo,
      #flow,
      #try,
      #faq { scroll-margin-top: 76px; }
      @media (max-width: 1023px) {
        .home-page .home-hero {
          grid-template-columns: 1fr;
          gap: 42px;
          padding-top: 48px;
          padding-bottom: 48px;
        }
        .home-page .home-copy .lead,
        .home-page .home-note { max-width: 60ch; }
        .home-page .home-visual { max-width: 840px; margin-top: 0; }
      }
      @media (max-width: 760px) {
        .home-page .site-header { min-height: 64px; }
        .home-page .home-hero {
          gap: 32px;
          padding: 38px 20px 40px;
        }
        .home-page .home-headline {
          max-width: 100%;
          font-size: 2.06rem;
          line-height: 1.12;
          letter-spacing: -.75px;
        }
        .home-page .home-copy .lead {
          font-size: 1rem;
          line-height: 1.6;
        }
        .home-page .home-actions { display: grid; }
        .home-page .home-actions .btn { width: 100%; }
        .home-page .chatgpt-proof { padding: 12px; }
        .how-section,
        .try-section,
        .trust-section,
        .home-page .faq-section,
        .directory-section {
          padding: 36px 20px 40px;
        }
        .how-section,
        .prompt-grid,
        .trust-grid,
        .home-page .faq-list,
        .directory-grid {
          grid-template-columns: 1fr;
        }
        .how-section { gap: 30px; }
        .prompt-grid { gap: 12px; margin-top: 16px; }
        .trust-grid { margin-top: 12px; }
        .trust-grid article,
        .trust-grid article:first-child,
        .trust-grid article:last-child {
          padding: 20px 0;
          border-left: 0;
          border-top: 1px solid #ecf1f7;
        }
        .trust-grid article:first-child { border-top: 0; }
        .directory-grid { gap: 0; }
        .directory-grid a { flex-direction: column; align-items: flex-start; gap: 4px; }
        .directory-grid span { text-align: left; }
        .home-page .footer { padding: 24px 20px 28px; }
      }
      @media (max-width: 359px) {
        .home-page .home-hero,
        .how-section,
        .try-section,
        .trust-section,
        .home-page .faq-section,
        .directory-section,
        .home-page .footer { padding-inline: 16px; }
        .home-page .home-headline { font-size: 1.9rem; }
        .section-inline-heading { align-items: flex-start; }
      }
    `,
    body: `
    <section class="home-hero">
      <div class="home-copy">
        <p class="home-eyebrow">A shared public feed inside ChatGPT</p>
        <h1 class="home-headline">Social media in ChatGPT.</h1>
        <p class="lead">Read posts published on Turnfeed, join conversations, and share your own.</p>
        <div class="hero-actions home-actions">
          <a class="btn btn-primary" href="${escapeHtml(TURNFEED_PRIMARY_CTA_URL)}" target="_blank" rel="noopener noreferrer">Open Turnfeed in ChatGPT</a>
          <a class="btn btn-secondary" href="#codex">Use in Codex</a>
        </div>
        <p class="home-scope-note">Sign in to ChatGPT. Choose <strong>Install plugin</strong> or <strong>Try in chat</strong>, then type <code>Open Turnfeed</code>.</p>
        <p class="home-note">Using Turnfeed does not automatically publish your conversation. ChatGPT or Codex sends information to Turnfeed to carry out your request. This may include parts of your conversation. <a href="/privacy#privacy-visibility">Privacy details</a>.</p>
      </div>
      <div class="home-visual" id="demo">
        <figure class="chatgpt-proof">
          <div class="chatgpt-proof-head">
            <strong>${demoVideoAvailable ? "Real demo — Turnfeed inside ChatGPT" : "Turnfeed demo"}</strong>
            ${demoVideoAvailable
              ? `<a href="${escapeHtml(TURNFEED_DEMO_VIDEO_URL)}" target="_blank" rel="noopener noreferrer">Open on YouTube</a>`
              : ''}
          </div>
          ${demoVideoAvailable
            ? `<div class="chatgpt-proof-video"><iframe src="${escapeHtml(TURNFEED_DEMO_VIDEO_EMBED_URL)}" title="Turnfeed demo: a public social feed inside ChatGPT" width="1920" height="1080" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" allow="autoplay; encrypted-media; picture-in-picture; web-share" allowfullscreen aria-describedby="turnfeed-demo-caption"></iframe></div>`
            : `<div class="chatgpt-demo-pending"><div><img src="${BRAND_LOGO_PATH}" alt="Turnfeed" width="580" height="136" loading="eager" decoding="async" /><p>The real Turnfeed recording will appear here. No mock product screenshots.</p></div></div>`}
          <figcaption id="turnfeed-demo-caption">${demoVideoAvailable
            ? "A real Turnfeed session in ChatGPT. This video is hosted on YouTube."
            : "The final proof will use a real frame from the same Turnfeed demo recording."}</figcaption>
        </figure>
      </div>
    </section>
    <section class="how-section" id="flow" aria-labelledby="how-title">
      <div class="how-intro">
        <p class="section-label">How it works</p>
        <h2 id="how-title">Read, reply, and post in chat.</h2>
        <p>Ask ChatGPT to show recent posts, find a topic, or open a conversation. Read what people are saying, then join in when you have something to share.</p>
        <p>Search covers posts and conversations published on Turnfeed. It does not search other social networks or the wider web.</p>
        <a href="#try">Try the prompts</a>
      </div>
      <ol class="how-steps">
        <li><span class="step-number">1</span><div><strong>Find something to read</strong><p>Ask for recent posts or a topic you care about. Reading does not post or change anything.</p></div></li>
        <li><span class="step-number">2</span><div><strong>Open a conversation</strong><p>Choose a post and ask to see its replies. Read the conversation before you join in.</p></div></li>
        <li><span class="step-number">3</span><div><strong>Share when you are ready</strong><p>Use <strong>Connect</strong> to sign in to your Turnfeed account when you want to post, reply, or check your inbox. Check your Turnfeed profile so you know which name people will see. <a href="/mcp-info">Setup and help</a>.</p><p>Ask ChatGPT to post or reply with your words. Whether it asks you to confirm depends on your ChatGPT settings and any rules set by your organization. When it asks, check the text before approving.</p></div></li>
      </ol>
    </section>
    <section class="try-section" id="try" aria-labelledby="try-title">
      <div class="section-inline-heading">
        <h2 class="section-label" id="try-title">Try it first</h2>
        <a href="#faq">More in the FAQ</a>
      </div>
      <p class="prompt-help">Copy a prompt, then paste it into a ChatGPT text chat or Codex task with Turnfeed selected.</p>
      <div class="prompt-grid">
        ${["Open Turnfeed", "What happened on Turnfeed today?", "Show me the latest posts about AI."].map((prompt) => `<article><code>${escapeHtml(prompt)}</code><button class="btn btn-secondary" type="button" data-copy-text="${escapeHtml(prompt)}" data-copy-idle-label="Copy prompt" data-copy-success="Prompt copied. Paste it into ChatGPT or Codex with Turnfeed selected." data-copy-failure="Could not copy automatically. Select the prompt text and copy it manually." aria-label="Copy prompt: ${escapeHtml(prompt)}" aria-describedby="prompt-copy-status">Copy prompt</button></article>`).join("\n        ")}
      </div>
      <p class="prompt-copy-status" id="prompt-copy-status" role="status" aria-live="polite" aria-atomic="true"></p>
    </section>
    <section class="try-section" id="codex" aria-labelledby="codex-title">
      <div class="section-inline-heading">
        <h2 id="codex-title">Use Turnfeed in Codex</h2>
        <a href="/mcp-info#connection-codex">Codex setup and help</a>
      </div>
      <p class="prompt-help">In the desktop app, open <strong>Plugins</strong>, find Turnfeed, and install it if needed. Start a new Codex task, type <code>@</code> and select <strong>Turnfeed</strong>, then ask <code>Open Turnfeed</code>.</p>
      <p class="prompt-help">Read posts and conversations, or ask Turnfeed to publish your exact words. Posting and replying require a connected Turnfeed account with permission to make changes. Codex controls which actions are available and when it asks you to confirm.</p>
    </section>
    <section class="trust-section" aria-labelledby="trust-title">
      <h2 class="section-label" id="trust-title">Built to be trusted</h2>
      <div class="trust-grid">
        <article><h3>Reading does not publish a post</h3><p>ChatGPT or Codex sends information to Turnfeed to answer your request. This may include parts of your conversation. Posts and replies you ask to publish are public.</p><a href="/privacy#privacy-visibility">Privacy and examples</a></article>
        <article><h3>Check before you share</h3><p>Whether ChatGPT asks you to confirm an action depends on your settings and any rules set by your organization. When it asks about a post or reply, check the text before approving. Reading never posts or changes anything.</p><a href="#faq">Permission details</a></article>
        <article><h3>Quality and safety checks</h3><p>Turnfeed checks for direct threats, obvious spam, repetitive filler, and duplicate content before publishing. Reports go to moderation review.</p><a href="/guidelines">Community Guidelines</a></article>
      </div>
    </section>
    <section class="faq-section" id="faq" aria-labelledby="faq-title">
      <div class="faq-section-head">
        <div><p class="section-label">FAQ</p><h2 id="faq-title">Quick answers before you start</h2></div>
        <a href="/support">More help and support</a>
      </div>
      <div class="faq-list">
        <details><summary>How do I start Turnfeed?</summary><p><a href="${escapeHtml(TURNFEED_PRIMARY_CTA_URL)}" target="_blank" rel="noopener noreferrer">Open Turnfeed in ChatGPT</a> and sign in.</p><p>New to Turnfeed? Choose <strong>Install plugin</strong>. If you already have it, choose <strong>Try in chat</strong>. Then type <code>Open Turnfeed</code> in a text chat.</p></details>
        <details><summary>Can I use Turnfeed in Codex?</summary><p>Yes. You can read posts and conversations, and Turnfeed includes tools for posting and replying. Follow the <a href="#codex">desktop Codex steps</a>. Posting and replying require a connected Turnfeed account with permission to make changes; Codex also applies its own permissions and approval settings. See <a href="/mcp-info#connection-codex">setup and account access</a>.</p></details>
        <details><summary>What becomes public, and when does ChatGPT ask?</summary><p>Posts, replies, quotes, pinned posts, and profile details you publish are public. People can read them on the web without a Turnfeed account, copy them, and share them. Likes and follows can also create public signals. Follower and following lists are public. Editing updates the current text, but earlier versions of posts and replies can remain visible in public edit history. Editing is not a way to erase information. Blocks, mutes, hidden words, inbox notifications, and reports are private account data.</p><p>Installing the plugin, connecting your Turnfeed account, and approving an action are separate steps. ChatGPT decides whether to ask before an action based on your current ChatGPT permission setting and workspace controls. When it asks about a public post or reply, review the exact text. Codex uses its own host permissions and approval settings.</p></details>
        <details><summary>Do I need an account or password?</summary><p>Using Turnfeed in ChatGPT requires a signed-in ChatGPT account. Public posts, threads, and profiles can be read without a separate Turnfeed account, including in the read-only website preview. For Codex, follow the <a href="/mcp-info#connection-codex">desktop setup instructions</a>; client and workspace availability still apply. Private notifications and actions require a Turnfeed connection with the relevant access. Turnfeed never receives your sign-in password.</p></details>
        <details><summary>Is the inbox private messaging?</summary><p>No. Your Turnfeed inbox contains private notifications about replies, mentions, likes, and follows. Follower and following lists are public. Turnfeed does not currently offer direct messages.</p></details>
        <details><summary>Can I use Turnfeed in Voice mode?</summary><p>${TURNFEED_VOICE_GUIDANCE}</p></details>
        <details><summary>Does Turnfeed charge a fee?</summary><p>As of August 27, 2026, Turnfeed does not charge a separate fee or run its own billing or payment flow. ChatGPT plan, workspace, region, and usage limits are controlled by OpenAI.</p></details>
        <details><summary>Is my private conversation posted?</summary><p>Using Turnfeed does not automatically publish your conversation. Turnfeed receives the inputs your client sends for the request, such as search terms, post text, or profile changes. Its tools do not request your full conversation history. Text you include in a request or ask to publish may contain information from your conversation.</p></details>
        <details><summary>What can I do on Turnfeed?</summary><p>You can read and search public posts, open full Turnfeed threads and profiles, check your inbox, post or reply, quote a post, like or follow, pin a post to your profile, edit or delete your own posts and replies, and use block or report for safety.</p></details>
        <details><summary>How do I delete my posts or account data?</summary><p>You can ask Turnfeed to delete your posts or reset your activity. Disconnecting the plugin does not delete stored data, and resetting activity keeps your sign-in identity. For a broader deletion request, email support. See <a href="/support#support-account">account and deletion help</a> for what each option removes and which records may remain.</p></details>
      </div>
    </section>
    <section class="directory-section" aria-labelledby="directory-title">
      <h2 class="section-label" id="directory-title">More about Turnfeed</h2>
      <div class="directory-grid">
        <a href="#demo"><strong>Demo</strong><span>The ChatGPT flow, end to end</span></a>
        <a href="/status"><strong>Status</strong><span>Live service health</span></a>
        <a href="#faq"><strong>FAQ</strong><span>Quick answers before you start</span></a>
        <a href="/mcp-info"><strong>Setup and help</strong><span>ChatGPT and Codex setup</span></a>
        <a href="/guidelines"><strong>Community Guidelines</strong><span>Plain rules for taking part</span></a>
        <a href="/support"><strong>Support</strong><span>Content, safety, privacy, and connection help</span></a>
        <a href="/support#support-account"><strong>Account and deletion</strong><span>Choose what to remove</span></a>
        <a href="https://github.com/TheodorNEngoy/turnfeed-mcp-example" target="_blank" rel="noopener noreferrer"><strong>Open-source example</strong><span>Explore the code on GitHub</span></a>
      </div>
      <p class="directory-note">For developers: our open-source example uses real Turnfeed code to display fictional posts and conversations. It is a small, read-only learning example, not the full Turnfeed product or access to the live community.</p>
    </section>
  `,
  });
}

function healthStatusTone(payload) {
  return payload.serviceStatus === "degraded" ? "Degraded" : "Healthy";
}

function healthAllSystemsOperational(payload) {
  return payload.serviceStatus === "healthy"
    && payload.storageStatus === "available"
    && payload.publicWriteStatus === "available"
    && payload.moderationReportIntakeStatus === "available";
}

function healthStatusSummary(payload) {
  return healthAllSystemsOperational(payload)
    ? "All systems operational"
    : "Some Turnfeed systems are degraded";
}

function healthStatusDetail(payload) {
  return payload.publicWriteStatus === "paused"
    ? `${payload.healthSummary} Reading, setup, and support checks can still run.`
    : payload.moderationReportIntakeStatus !== "available"
      ? payload.healthSummary
      : "The website and Turnfeed server are responding. This page does not test a live request from ChatGPT or Codex.";
}

function healthUpdatedLabel(payload) {
  return new Date(payload.updatedAt).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });
}

function healthStorageLabel(payload) {
  if (payload.storageStatus === "available") return "Available";
  if (payload.storageStatus === "reconnecting") return "Reconnecting";
  return "Degraded";
}

function healthChatGptSurfaceLabel(payload) {
  return payload.chatGptSurface === "chat-only"
    ? "Chat-first"
    : String(payload.chatGptSurface || "Chat-first");
}

function healthConnectorAuthDisplay(payload) {
  return payload.connectorAuth === "none"
    ? "No separate OAuth sign-in"
    : String(payload.connectorAuthLabel || CONNECTOR_AUTH_LABEL);
}

function buildHealthDiagnostics(payload) {
  const diagnostics = [
    {
      label: "Data store",
      value: healthStorageLabel(payload),
      note: "Public health reports only user-visible availability, not database paths, secrets, or transport internals.",
    },
    {
      label: "Turnfeed server for ChatGPT",
      value: healthConnectorAuthDisplay(payload),
      note: "This service exposes Turnfeed connection details. This page does not test a request from ChatGPT.",
    },
    {
      label: "Public origin",
      value: payload.publicOrigin,
      note: "The public website, status page, and technical connection details all use this same service origin.",
    },
    {
      label: "ChatGPT surface",
      value: healthChatGptSurfaceLabel(payload),
      note: payload.renderToolsEnabled
        ? "A compact card can display public text in ChatGPT. ChatGPT still applies the user's current permissions."
        : "This server is configured for Turnfeed reads and writes through ChatGPT; this health check does not test a live ChatGPT request.",
    },
    {
      label: "Public writes",
      value: payload.publicWriteStatus === "paused" ? "Paused" : "Available",
      note: payload.publicWriteStatus === "paused"
        ? "Public write actions are paused until storage recovers."
        : "Public post and reply tools still require clear user intent and exact supplied text.",
    },
  ];
  if (payload.deploymentProvider) {
    diagnostics.push({
      label: "Service host",
      value: payload.deploymentProvider,
      note: "Public service metadata is sanitized before rendering.",
    });
  }
  return diagnostics;
}

function buildStatusComponentRows(payload) {
  return [
    {
      name: "Website and public pages",
      status: payload.ok === true ? "Operational" : "Degraded",
      detail: "Landing page, status, support, and policy pages.",
    },
    {
      name: "Turnfeed server for ChatGPT",
      status: payload.serviceStatus === "healthy" && payload.connectorMcpUrl ? "Operational" : "Degraded",
      detail: "Turnfeed server endpoint, plugin metadata, and server-side tools. This page does not test a request from ChatGPT.",
    },
    {
      name: "Storage",
      status: payload.storageStatus === "available"
        ? "Operational"
        : payload.storageStatus === "reconnecting"
          ? "Reconnecting"
          : "Degraded",
      detail: "Server-side storage for public posts, replies, profile data, and notifications.",
    },
    {
      name: "Public writes",
      status: payload.publicWriteStatus === "available" ? "Operational" : "Paused",
      detail: payload.publicWriteStatus === "available"
        ? "Public post and reply tools are enabled, and storage is available. This check does not submit an action or test the client approval flow."
        : "Public posts and replies are paused until storage recovers.",
    },
  ];
}

function healthHtml(payload, origin = PUBLIC_ORIGIN, {
  canonicalPath = "/health",
  heading = "Health",
  jsonPath = "/health?format=json",
} = {}) {
  const mcpInfoUrl = `${origin}${MCP_INFO_PATH}`;
  const mcpUrl = `${origin}${MCP_PATH}`;
  const healthJsonUrl = `${origin}${jsonPath}`;
  const supportUrl = `${origin}/support`;
  const isStatusPage = canonicalPath === "/status";
  const statusTone = healthStatusTone(payload);
  const statusSummary = healthStatusSummary(payload);
  const statusDetail = healthStatusDetail(payload);
  const updatedLabel = healthUpdatedLabel(payload);
  const diagnostics = buildHealthDiagnostics(payload);
  const componentRows = buildStatusComponentRows(payload);
  const pageEyebrow = isStatusPage ? "Live service" : "Service status";
  const pageHeading = isStatusPage ? "Service status" : heading;
  return pageHtml({
    origin,
    title: `${PUBLIC_APP_NAME} · ${heading}`,
    canonicalPath,
    robotsContent: "noindex,nofollow",
    description: `${PUBLIC_APP_NAME} service status for the website, Turnfeed server endpoint, and storage state.`,
    showPublicNav: true,
    bodyClass: isStatusPage ? "status-page" : "health-page",
    extraStyles: `
      .health-hero {
        display: grid;
        grid-template-columns: minmax(0, 1.14fr) minmax(300px, .86fr);
        gap: 20px;
        padding: 24px;
        border-radius: 8px;
        background: linear-gradient(135deg, rgba(255,255,255,.98) 0%, rgba(246,250,255,.98) 54%, rgba(240,248,244,.95) 100%);
        border: 1px solid rgba(15,23,42,.07);
      }
      .health-copy {
        display: grid;
        gap: 16px;
        align-content: start;
      }
      .health-copy .lead {
        margin: 0;
        max-width: 62ch;
        font-size: 1.05rem;
        line-height: 1.6;
        color: var(--text-soft);
      }
      .health-status-badge {
        width: fit-content;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 9px 13px;
        border-radius: 8px;
        background: rgba(255,255,255,.82);
        border: 1px solid rgba(15,23,42,.08);
        font-family: "IBM Plex Mono", "SFMono-Regular", "Cascadia Code", monospace;
        font-size: .76rem;
        font-weight: 700;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      .health-status-badge strong {
        font-size: .92rem;
        letter-spacing: 0;
        text-transform: none;
      }
      .health-actions {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        align-items: center;
      }
      .health-overview {
        display: grid;
        gap: 12px;
      }
      .health-overview-card {
        display: grid;
        gap: 10px;
        padding: 18px;
        border-radius: 8px;
        background: linear-gradient(180deg, rgba(255,255,255,.96) 0%, rgba(246,250,255,.94) 100%);
        border: 1px solid rgba(15,23,42,.08);
      }
      .health-stat-grid,
      .health-grid {
        display: grid;
        gap: 12px;
      }
      .health-stat-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .health-stat {
        padding: 14px;
        border-radius: 8px;
        background: rgba(255,255,255,.9);
        border: 1px solid rgba(15,23,42,.07);
      }
      .health-stat strong,
      .health-check strong,
      .health-next strong {
        display: block;
        margin-bottom: 4px;
      }
      .health-stat span,
      .health-check span,
      .health-next span {
        color: var(--text-soft);
        line-height: 1.45;
      }
      .health-stack {
        display: grid;
        gap: 18px;
        margin-top: 22px;
      }
      .health-section {
        padding: clamp(22px, 4vw, 34px) 0 0;
        border-radius: 0;
        background: transparent;
        border: 0;
        border-top: 1px solid rgba(15,23,42,.1);
      }
      .health-section-head {
        display: grid;
        gap: 8px;
        margin-bottom: 16px;
      }
      .health-section-head p {
        margin: 0;
        color: var(--text-soft);
      }
      .health-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .health-check,
      .health-next {
        padding: 16px;
        border-radius: 8px;
        background: rgba(255,255,255,.92);
        border: 1px solid rgba(15,23,42,.07);
      }
      .health-next-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
      }
      .health-utility-list {
        display: grid;
        gap: 10px;
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .health-utility-list li {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 0;
        border-top: 1px solid rgba(15,23,42,.08);
      }
      .health-utility-list li:first-child {
        padding-top: 0;
        border-top: 0;
      }
      .health-utility-list span {
        color: var(--text-soft);
      }
      .health-note {
        margin: 0;
        color: var(--text-soft);
      }
      .status-summary-card {
        display: grid;
        gap: 12px;
        padding: 20px;
        border-radius: 8px;
        background: rgba(255,255,255,.94);
        border: 1px solid rgba(15,23,42,.08);
      }
      .status-summary-card strong {
        font-size: clamp(1.35rem, 2.6vw, 2rem);
        letter-spacing: 0;
      }
      .status-summary-card p {
        margin: 0;
        color: var(--text-soft);
        line-height: 1.5;
      }
      .status-component-list {
        display: grid;
        gap: 0;
        border: 1px solid rgba(15,23,42,.08);
        border-radius: 8px;
        overflow: hidden;
        background: rgba(255,255,255,.94);
      }
      .status-component-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 14px;
        align-items: center;
        padding: 16px;
        border-top: 1px solid rgba(15,23,42,.08);
      }
      .status-component-row:first-child {
        border-top: 0;
      }
      .status-component-row p {
        margin: 4px 0 0;
        color: var(--text-soft);
        line-height: 1.45;
      }
      .status-pill {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 112px;
        padding: 8px 10px;
        border-radius: 8px;
        background: rgba(14,165,164,.1);
        color: #0f766e;
        font-weight: 800;
        font-size: .78rem;
      }
      .status-pill-degraded {
        background: rgba(245,158,11,.14);
        color: #92400e;
      }
      @media (max-width: 900px) {
        .health-hero,
        .health-grid,
        .health-next-grid,
        .health-stat-grid {
          grid-template-columns: 1fr;
        }
      }
      .status-page .health-stack,
      .health-page .health-stack {
        gap: 0;
        margin: 0;
      }
      .status-page .health-section,
      .health-page .health-section {
        scroll-margin-top: 24px;
        padding: clamp(38px, 5vw, 58px) 0;
        border-top: 1px solid rgba(19,35,63,.13);
      }
      .status-page .health-section:first-child,
      .health-page .health-section:first-child {
        padding-top: 6px;
        border-top: 0;
      }
      .status-page .status-summary-card,
      .health-page .health-overview-card {
        padding: 0 0 8px;
        border: 0;
        border-radius: 0;
        background: transparent;
      }
      .status-page .status-component-list,
      .health-page .health-stat-grid {
        border: 0;
        border-radius: 0;
        background: transparent;
      }
      .health-page .health-stat-grid {
        gap: 0;
        margin-top: 16px;
      }
      .health-page .health-stat {
        padding: 18px 0;
        border: 0;
        border-top: 1px solid rgba(19,35,63,.1);
        border-radius: 0;
        background: transparent;
      }
      .status-page .status-component-row {
        padding: 20px 0;
      }
      .status-page .health-grid,
      .status-page .health-next-grid,
      .health-page .health-grid,
      .health-page .health-next-grid {
        grid-template-columns: 1fr;
        gap: 0;
      }
      .status-page .health-check,
      .status-page .health-next,
      .health-page .health-check,
      .health-page .health-next {
        padding: 20px 0;
        border: 0;
        border-top: 1px solid rgba(19,35,63,.1);
        border-radius: 0;
        background: transparent;
      }
      .status-page .health-check:first-child,
      .status-page .health-next:first-child,
      .health-page .health-check:first-child,
      .health-page .health-next:first-child {
        border-top: 0;
      }
    `,
    body: `
    <section class="document-hero">
      <div class="health-copy">
        <p class="document-kicker">${escapeHtml(pageEyebrow)}</p>
        <div class="brand-lockup">
          ${brandLogoImgMarkup({ title: `${PUBLIC_APP_NAME} logo`, origin })}
          <div class="brand-copy">
            <h1>${escapeHtml(pageHeading)}</h1>
          </div>
        </div>
        <div class="health-status-badge">
          <span>Current status</span>
          <strong>${escapeHtml(isStatusPage ? statusSummary : statusTone)}</strong>
        </div>
        <p class="document-lead">${escapeHtml(statusDetail)}</p>
        <div class="document-actions">
          ${isStatusPage
            ? '<a class="btn btn-primary" href="/support">Get support</a><a class="btn" href="/">Turnfeed home</a>'
            : '<a class="btn btn-primary" href="/status">View service status</a><a class="btn" href="/support">Get support</a>'}
        </div>
        <p class="document-meta">${isStatusPage ? `For raw diagnostic checks, use <code>/health</code> or <a href="${escapeHtml(jsonPath)}">Raw JSON</a>.` : `Health is the live diagnostic endpoint. Open <a href="/status">Status</a> for the human-facing summary, or inspect <a href="${escapeHtml(jsonPath)}">Raw JSON</a>.`}</p>
      </div>
    </section>
    <div class="document-layout">
      <aside class="document-toc">
        <p class="document-toc-label">On this page</p>
        <nav aria-label="${isStatusPage ? "Status" : "Health diagnostics"} page sections">
          <ul class="document-toc-list">
            ${isStatusPage ? `
              <li><a href="#status-summary">Current status</a></li>
              <li><a href="#status-systems">System status</a></li>
              <li><a href="#status-diagnostics">Technical details</a></li>
              <li><a href="#status-support">Next checks</a></li>
              <li><a href="#status-surfaces">Public surfaces</a></li>
            ` : `
              <li><a href="#health-summary">Current snapshot</a></li>
              <li><a href="#health-diagnostics">Service checks</a></li>
              <li><a href="#health-next">Next checks</a></li>
              <li><a href="#health-surfaces">Public surfaces</a></li>
            `}
          </ul>
        </nav>
      </aside>
      <div class="document-content">
    <div class="health-stack">
      ${isStatusPage ? `
      <section class="health-section" id="status-summary">
        <div class="status-summary-card">
          <strong>${escapeHtml(statusSummary)}</strong>
          <p>${escapeHtml(statusDetail)}</p>
          <p>Turnfeed reports current live status from the running service. Use <code>/health</code> for raw diagnostic checks; uptime percentages and incident history are not published yet.</p>
          <p class="document-meta">Last checked by this service: <strong>${escapeHtml(updatedLabel)} UTC</strong>.</p>
        </div>
      </section>
      <section class="health-section" id="status-systems">
        <div class="health-section-head">
          <h2>System status</h2>
          <p>Current component health for the public Turnfeed surfaces people depend on.</p>
        </div>
        <div class="status-component-list">
          ${componentRows.map((item) => {
            const degraded = !["Operational"].includes(item.status);
            return `
            <article class="status-component-row">
              <div>
                <strong>${escapeHtml(item.name)}</strong>
                <p>${escapeHtml(item.detail)}</p>
              </div>
              <span class="status-pill${degraded ? " status-pill-degraded" : ""}">${escapeHtml(item.status)}</span>
            </article>
          `;
          }).join("")}
        </div>
      </section>
      ` : `
      <section class="health-section" id="health-summary">
        <div class="health-overview-card">
          <div class="health-section-head">
            <h2>What this confirms right now</h2>
            <p>A compact snapshot from the running Turnfeed service.</p>
          </div>
          <div class="health-stat-grid">
            <div class="health-stat">
              <strong>${escapeHtml(PUBLIC_APP_NAME)}</strong>
              <span>Service name reported by the running server.</span>
            </div>
            <div class="health-stat">
              <strong>${escapeHtml(healthConnectorAuthDisplay(payload))}</strong>
              <span>Sign-in mode configured for the Turnfeed server used by ChatGPT.</span>
            </div>
            <div class="health-stat">
              <strong>${escapeHtml(healthChatGptSurfaceLabel(payload))}</strong>
              <span>Configured MCP surface for public reads and, after scoped Auth0 Connect, private reads and actions.</span>
            </div>
            <div class="health-stat">
              <strong>${escapeHtml(updatedLabel)} UTC</strong>
              <span>Last timestamp emitted by the health endpoint itself.</span>
            </div>
          </div>
        </div>
      </section>
      `}
      <section class="health-section" id="${isStatusPage ? "status-diagnostics" : "health-diagnostics"}">
        <div class="health-section-head">
          <h2>Service checks</h2>
          <p>Everything below comes from the same live health payload the JSON endpoint returns, but organized for faster human verification.</p>
        </div>
        <div class="health-grid">
          ${diagnostics.map((item) => `
            <article class="health-check">
              <strong>${escapeHtml(item.label)}</strong>
              <code>${escapeHtml(item.value)}</code>
              <span>${escapeHtml(item.note)}</span>
            </article>
          `).join("")}
        </div>
      </section>
      <section class="health-section" id="${isStatusPage ? "status-support" : "health-next"}">
        <div class="health-section-head">
          <h2>Best next checks</h2>
          <p>Once health looks right, these are the fastest ways to confirm the website and Turnfeed server endpoint around it.</p>
        </div>
        <div class="health-next-grid">
          <article class="health-next">
            <strong>Verify connection details</strong>
            <span>Use the connection details page for the exact MCP server URL and nearby support links.</span>
            <code>${escapeHtml(mcpInfoUrl)}</code>
          </article>
          <article class="health-next">
            <strong>Inspect the raw payload</strong>
            <span>Keep the machine-readable health response one click away for scripts, screenshots, or support handoff.</span>
            <code>${escapeHtml(healthJsonUrl)}</code>
          </article>
        </div>
      </section>
      <section class="health-section" id="${isStatusPage ? "status-surfaces" : "health-surfaces"}">
        <div class="health-section-head">
          <h2>Public support surfaces</h2>
          <p>These links make the rest of the public Turnfeed service easy to inspect instead of forcing you to guess URLs.</p>
        </div>
        <ul class="health-utility-list">
          <li><span>Human status page</span><code>${escapeHtml(`${origin}/status`)}</code></li>
          <li><span>Connection details</span><code>${escapeHtml(mcpInfoUrl)}</code></li>
          <li><span>MCP server endpoint</span><code>${escapeHtml(mcpUrl)}</code></li>
          <li><span>Support</span><code>${escapeHtml(supportUrl)}</code></li>
          <li><span>Raw health JSON</span><code>${escapeHtml(healthJsonUrl)}</code></li>
        </ul>
      </section>
    </div>
      </div>
    </div>
  `,
  });
}

function mcpInfoHtml(origin = PUBLIC_ORIGIN) {
  return pageHtml({
    origin,
    title: `${PUBLIC_APP_NAME} · Connection Details`,
    canonicalPath: MCP_INFO_PATH,
    robotsContent: "noindex,nofollow",
    description: `Technical MCP connection details for ${PUBLIC_APP_NAME}.`,
    body: `
    <div class="brand-lockup">
      ${brandLogoImgMarkup({ title: `${PUBLIC_APP_NAME} logo`, origin })}
      <div class="brand-copy">
        <h1>${PUBLIC_APP_NAME} MCP connection details</h1>
      </div>
    </div>
    <p class="muted">Use this page only when ChatGPT asks for technical server details. Most visitors do not need it; Turnfeed itself runs inside ChatGPT when connected.</p>
    <ul>
      <li>MCP server URL: <code>${origin}${MCP_PATH}</code></li>
      <li>Sign-in mode: <code>${escapeHtml(CONNECTOR_AUTH_LABEL)}</code></li>
      <li>Transport: <code>Streamable HTTP</code></li>
      <li>Public health: <code>${origin}/health</code></li>
    </ul>
    <p class="muted">Opening <code>${MCP_PATH}</code> in a browser redirects here so the endpoint stays easier to verify and support.</p>
  `,
  });
}

function mcpInfoPageHtml(origin = PUBLIC_ORIGIN) {
  const connector = buildConnectorMetadataSnapshot(origin);
  const mcpUrl = connector.connectorMcpUrl;
  const healthUrl = `${origin}/health`;
  const healthJsonUrl = `${healthUrl}?format=json`;
  const supportUrl = `${origin}/support`;
  return pageHtml({
    origin,
    title: `${PUBLIC_APP_NAME} · Setup and Help`,
    canonicalPath: MCP_INFO_PATH,
    robotsContent: "noindex,nofollow",
    description: `Set up ${PUBLIC_APP_NAME} in ChatGPT or Codex, with connection details if you need them.`,
    showPublicNav: true,
    body: `
    <section class="document-hero">
      <p class="document-kicker">Connection help</p>
        <div class="brand-lockup">
          ${brandLogoImgMarkup({ title: `${PUBLIC_APP_NAME} logo`, origin })}
          <div class="brand-copy">
            <h1>Set up Turnfeed</h1>
          </div>
        </div>
        <p class="document-lead">Start reading posts in ChatGPT or Codex. Follow the steps below, or find help if Turnfeed does not open.</p>
        <div class="document-actions">
          <a class="btn btn-primary" href="${escapeHtml(TURNFEED_PRIMARY_CTA_URL)}" target="_blank" rel="noopener noreferrer">Open Turnfeed in ChatGPT</a>
          <a class="btn" href="/support">Get support</a>
          <a class="btn" href="/status">Check status</a>
        </div>
    </section>
    <div class="document-layout">
      <aside class="document-toc">
        <p class="document-toc-label">On this page</p>
        <nav aria-label="Connection details sections">
          <ul class="document-toc-list">
            <li><a href="#connection-chatgpt">Use in ChatGPT</a></li>
            <li><a href="#connection-codex">Use in Codex</a></li>
            <li><a href="#connection-setup">Connection help</a></li>
            <li><a href="#connection-summary">Technical connection details</a></li>
            <li><a href="#connection-help">Health and support</a></li>
          </ul>
        </nav>
      </aside>
      <div class="document-content">
      <section class="document-section" id="connection-chatgpt">
        <div class="document-section-head">
          <h2>How Turnfeed works in ChatGPT</h2>
          <p>Install Turnfeed, open a text chat, and ask to see some posts.</p>
        </div>
        <div class="document-rows">
          <article class="document-row">
            <strong>Start here</strong>
            <ol>
              <li><a href="${escapeHtml(TURNFEED_PRIMARY_CTA_URL)}" target="_blank" rel="noopener noreferrer">Open Turnfeed in ChatGPT</a> and sign in to ChatGPT.</li>
              <li>Choose <strong>Install plugin</strong> if you are new to Turnfeed, or <strong>Try in chat</strong> if it is already installed.</li>
              <li>Type <code>Open Turnfeed</code> in the text chat. If ChatGPT asks you to choose an app, select <strong>Turnfeed</strong>.</li>
            </ol>
            <p>You can read public posts before signing in to a Turnfeed account. Use <strong>Connect</strong> when you want your inbox or actions such as posting and replying. Before posting, check your Turnfeed profile so you know which name people will see.</p>
          </article>
          <article class="document-row">
            <strong>Use chat first</strong>
            <p>When Turnfeed is connected, ask ChatGPT to catch you up, show active threads, read replies before you answer, review exact post text before publishing, review exact reply text before sending, or update your profile.</p>
          </article>
          <article class="document-row">
            <strong>ChatGPT controls action prompts</strong>
            <p>ChatGPT decides whether to ask before a Turnfeed action based on your current ChatGPT permission setting and workspace controls. When it asks about a public post or reply, review the exact text. Turnfeed labels mutation tools as writes and, where applicable, open-world actions so ChatGPT can apply those controls; Turnfeed does not add a separate server-side approval prompt.</p>
          </article>
          <article class="document-row">
            <strong>Public information</strong>
            <p>The website explains how Turnfeed works, publishes service status, and keeps support, privacy, safety, and legal information easy to find. <code>/social</code> is only a read-only browser preview for verification and direct links; it is not the Turnfeed plugin and cannot take actions.</p>
          </article>
          <article class="document-row">
            <strong>Availability, Voice, Dictation, and billing</strong>
            <p>${TURNFEED_VOICE_GUIDANCE}</p>
            <p>As of August 27, 2026, Turnfeed does not charge a separate fee or run its own billing or payment flow. OpenAI controls plan eligibility, usage limits, plugin availability, workspace access, supported surfaces, and regional availability. See <a href="${escapeHtml(OPENAI_APPS_HELP_URL)}" target="_blank" rel="noopener noreferrer">OpenAI's current availability guidance</a>.</p>
          </article>
        </div>
      </section>
      <section class="document-section" id="connection-codex">
        <div class="document-section-head">
          <h2>Use Turnfeed in Codex</h2>
          <p>Read posts and conversations, then connect your Turnfeed account when you want to post or reply.</p>
        </div>
        <div class="document-rows">
          <article class="document-row">
            <strong>Install, select, and read</strong>
            <ol>
              <li>Open <strong>Plugins</strong> in the desktop app, find Turnfeed, and install it if needed.</li>
              <li>Start a new Codex task. Type <code>@</code> and select <strong>Turnfeed</strong>.</li>
              <li>Ask <code>Open Turnfeed</code>, then choose a post and ask to read its thread.</li>
            </ol>
            <p>Public feed, thread, and profile reads do not require a separate Turnfeed identity. You may still see client permission prompts. See <a href="https://learn.chatgpt.com/docs/plugins" target="_blank" rel="noopener noreferrer">OpenAI's current plugin instructions</a> for installation and supported surfaces.</p>
          </article>
          <article class="document-row">
            <strong>Posting and replying</strong>
            <p>Turnfeed includes posting and reply tools in Codex. To post, select Turnfeed and ask <code>Post this on Turnfeed:</code> followed by your exact text. Sign in to your Turnfeed account if prompted and allow the required access. Your post will be public under your Turnfeed profile. Codex controls which tools are available and when it asks you to confirm. If an action is unavailable, check the plugin connection and your account or workspace permissions.</p>
          </article>
          <article class="document-row">
            <strong>If Turnfeed is missing or cannot read</strong>
            <p>Check that Turnfeed is installed and available to your account or workspace, then start a new Codex task and select it with <code>@</code>. If it is still unavailable, check service status or contact support with your client, surface, exact error, and approximate time.</p>
          </article>
        </div>
      </section>
      <section class="document-section" id="connection-setup">
        <div class="document-section-head">
          <h2>If you need connection help</h2>
          <p>Try the steps below if Turnfeed does not open. If your client asks for a server URL, use the <a href="#connection-summary">technical connection details</a>.</p>
        </div>
        <div class="document-rows">
          <article class="document-row">
            <strong>First test prompts</strong>
            <p>After adding the plugin, start a supported text conversation where it is available and try a public feed prompt. Auth0 Connect is not needed for that public read; use Connect only for inbox or other private reads and actions. If ChatGPT asks you to choose an app or source, select Turnfeed using the control available on that surface.</p>
            <ul>
              <li><code>Open Turnfeed</code></li>
              <li><code>What happened on Turnfeed today?</code></li>
              <li><code>Show me the latest posts about AI.</code></li>
            </ul>
          </article>
          <article class="document-row">
            <strong>If ChatGPT says it cannot access Turnfeed</strong>
            <p>Confirm that the Turnfeed plugin and its connection are available for your plan, workspace, role, surface, and region. Start a supported text conversation and select Turnfeed if ChatGPT offers an app/source control, rather than asking an unattached conversation to simulate the plugin.</p>
            <div class="document-callout">
              <p>If a private read or action cannot authenticate, disconnect and reconnect Turnfeed through Auth0, then authorize only the scopes ChatGPT shows. Disconnecting stops that ChatGPT connection; it does not delete stored Turnfeed data, reset activity, or delete the separate Auth0 identity. Signing back in with the same Auth0 identity normally returns you to the same Turnfeed account state, as long as that Auth0 identity and the stored Turnfeed account still exist. Contact support for identity-deletion requests; no self-service control is currently exposed.</p>
            </div>
          </article>
        </div>
      </section>
      <section class="document-section" id="connection-summary">
        <div class="document-section-head">
          <h2>Technical connection details</h2>
          <p>You do not need these details to follow the steps above. Use the server URL only if ChatGPT or another app asks for it. Installing Turnfeed, signing in to your Turnfeed account, and confirming an action are separate steps.</p>
        </div>
        <div class="document-rows">
          <article class="document-row">
            <strong>Turnfeed server URL</strong>
            <p>Use this exact URL only when your client asks for the Turnfeed server.</p>
            <code>${escapeHtml(mcpUrl)}</code>
            <div class="document-actions">
              <button class="btn" type="button" data-copy-text="${escapeHtml(mcpUrl)}" data-copy-idle-label="Copy URL" aria-describedby="mcp-copy-status">Copy URL</button>
            </div>
            <p id="mcp-copy-status" class="document-meta" role="status" aria-live="polite"></p>
          </article>
          <article class="document-row">
            <strong>Public reads and Connect</strong>
            <p>Install and select Turnfeed in a supported client. Public feed, thread, and profile reads can run before Auth0 Connect. Use Connect for your inbox, other private reads, or actions where the client supports them. Auth0 supplies a separate Turnfeed identity and scoped OAuth access; Turnfeed never receives your sign-in password. Check your Turnfeed profile before contributing so you know which public name other people will see.</p>
          </article>
          <article class="document-row">
            <strong><code>turnfeed:read</code></strong>
            <p>Allows your private inbox, notifications, and other account context. Follower and following lists are public even though your inbox requires sign-in. The inbox is account activity, not direct messages.</p>
          </article>
          <article class="document-row">
            <strong><code>turnfeed:write</code></strong>
            <p>Allows posts, replies, profile changes, likes, follows, blocks, reports, post and reply deletion, and other non-account mutations. Posts-only bulk deletion also uses this scope; it preserves your profile, settings, follows, and activity outside the deleted threads.</p>
          </article>
          <article class="document-row">
            <strong><code>turnfeed:account</code></strong>
            <p>Allows the only account-wide destructive control: <strong>Reset Turnfeed activity</strong>. Individual posts and replies can also be deleted under <code>turnfeed:write</code>. Reset clears ordinary profile and activity data and reopens a clean profile shell for the same Turnfeed/Auth0 identity. Account-linked publishing-request hashes remain; bounded moderation, safety, legal, and backup records may also remain under the retention policy. It does not delete the Auth0 identity, and the Turnfeed plugin has no self-service identity-deletion control.</p>
          </article>
          <article class="document-row">
            <strong>Transport</strong>
            <p>The connection uses <code>${escapeHtml(connector.connectorTransportLabel)}</code>.</p>
          </article>
          <article class="document-row">
            <strong>Browser behavior</strong>
            <p>Opening <code>${escapeHtml(MCP_PATH)}</code> in a normal browser redirects back here, because the MCP endpoint is meant for a client connection rather than a web page.</p>
          </article>
        </div>
      </section>
      <section class="document-section" id="connection-help">
        <div class="document-section-head">
          <h2>Health and support</h2>
          <p>Use these routes to tell whether the website, client connection, or live service is the issue.</p>
        </div>
        <div class="document-rows">
          <article class="document-row">
            <strong>Service status</strong>
            <p>See whether Turnfeed is online and whether its main public systems are available.</p>
            <p><a href="/status">Open service status</a></p>
          </article>
          <article class="document-row">
            <strong>Health JSON</strong>
            <p>Use the raw health response when a technical check needs the public origin, server URL, plugin surface, and availability status.</p>
            <p><a href="${escapeHtml(healthJsonUrl)}">Open Health JSON</a></p>
          </article>
          <article class="document-row">
            <strong>Authentication mode</strong>
            <p>Turnfeed uses mixed access: anonymous public reads plus OAuth 2.1 for private reads, public writes, profile changes, and account controls. Tool-specific scopes limit access; write and open-world annotations let ChatGPT apply the user's current ChatGPT permission setting.</p>
            <code>${escapeHtml(connector.connectorAuthLabel)}</code>
          </article>
          <article class="document-row">
            <strong>Need help?</strong>
            <p>If connection problems continue after the status and health pages look good, use the support page.</p>
            <p><a href="${escapeHtml(supportUrl)}">Open support</a></p>
          </article>
        </div>
      </section>
      </div>
    </div>
  `,
  });
}

function manifestJson(origin = PUBLIC_ORIGIN) {
  return JSON.stringify({
    id: "/",
    name: PUBLIC_APP_NAME,
    short_name: PUBLIC_APP_NAME,
    description: PUBLIC_APP_TAGLINE,
    start_url: "/",
    scope: "/",
    display: "standalone",
    display_override: ["standalone", "browser"],
    background_color: "#eff4fb",
    theme_color: "#165df5",
    categories: ["social", "communication"],
    icons: [
      {
        src: `${origin}${BRAND_LOGO_TOUCH_ICON_PATH}`,
        sizes: "160x160",
        type: "image/png",
        purpose: "any",
      },
      {
        src: `${origin}${BRAND_LOGO_MANIFEST_ICON_PATH}`,
        sizes: "160x160",
        type: "image/png",
        purpose: "any",
      },
      {
        src: `${origin}${BRAND_LOGO_PATH}`,
        sizes: "160x160",
        type: "image/png",
        purpose: "any",
      },
    ],
  });
}

function sitemapXml(origin = PUBLIC_ORIGIN) {
  const urls = [
    "/",
    "/guidelines",
    "/security",
    "/privacy",
    "/terms",
    "/support",
  ];
  const body = urls
    .map((path) => `  <url><loc>${escapeHtml(`${origin}${path}`)}</loc></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

function securityTxt(origin = PUBLIC_ORIGIN) {
  const supportEmail = resolveSupportEmail(origin);
  const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 180).toISOString().replace(/\.\d{3}Z$/, "Z");
  return [
    `Contact: mailto:${supportEmail}`,
    `Policy: ${origin}/security`,
    `Canonical: ${origin}${SECURITY_TXT_PATH}`,
    "Preferred-Languages: en, nb",
    `Expires: ${expires}`,
    "",
  ].join("\n");
}

  return {
    homeHtml,
    notFoundPageHtml,
    privacyPageHtml,
    supportPageHtml,
    termsPageHtml,
    guidelinesPageHtml,
    securityPageHtml,
    healthHtml,
    mcpInfoPageHtml,
    turnfeedMarkSvgDocument,
    manifestJson,
    sitemapXml,
    securityTxt,
  };
}
