/**
 * Google Form Auto-Filler — Form Identifier Utility
 * Extracts a stable, canonical form identifier to prevent duplicate configs.
 */

/**
 * Extracts the most stable available identifier from a URL or document context.
 * @param {string} [url] 
 * @param {Document} [doc]
 * @returns {string} Stable form ID
 */
export function getFormIdentifier(url = window.location.href, doc = document) {
  try {
    const parsed = new URL(url);

    // Standard Google Forms public URL: /forms/d/e/FORM_ID/viewform or /formResponse
    const eMatch = parsed.pathname.match(/\/forms\/(?:u\/\d+\/)?d\/e\/([a-zA-Z0-9_-]+)/);
    if (eMatch && eMatch[1]) {
      return `gform_${eMatch[1]}`;
    }

    // Google Forms direct edit/view URL: /forms/d/FORM_ID/...
    const dMatch = parsed.pathname.match(/\/forms\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]+)/);
    if (dMatch && dMatch[1]) {
      return `gform_${dMatch[1]}`;
    }

    // Check DOM for embedded form action or hidden inputs (FB_PUBLIC_LOAD_DATA_)
    if (doc) {
      const formEl = doc.querySelector('form[action*="/forms/d/e/"]');
      if (formEl) {
        const action = formEl.getAttribute('action') || '';
        const actionMatch = action.match(/\/forms\/d\/e\/([a-zA-Z0-9_-]+)/);
        if (actionMatch && actionMatch[1]) {
          return `gform_${actionMatch[1]}`;
        }
      }

      // Check title for mock / test pages
      const heading = doc.querySelector('h1#formTitle, h1');
      if (heading && heading.textContent.trim()) {
        const cleanTitle = heading.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
        return `mock_${cleanTitle}`;
      }
    }

    // Fallback: Origin + Pathname (stripping query params and hash)
    const cleanPath = (parsed.origin + parsed.pathname).replace(/\/formResponse$/, '/viewform');
    return `url_${cleanPath.replace(/[^a-zA-Z0-9]+/g, '_')}`;
  } catch (err) {
    return 'default_form_id';
  }
}
