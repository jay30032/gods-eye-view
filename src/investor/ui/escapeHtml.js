const HTML_ESCAPES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

/**
 * Every string that reaches an investor template comes from the mock dataset
 * or from generated text built out of it. Escaping is cheap; auditing which of
 * those strings will stay punctuation-only forever is not.
 */
export function escapeHtml(value) {
  if (value == null) return '';
  return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}
