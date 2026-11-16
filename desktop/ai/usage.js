'use strict';
// Rough token count used when a program does not report its own: about 4 characters per token.
function estimateTokens(text) {
  const n = String(text == null ? '' : text).length;
  return n === 0 ? 0 : Math.ceil(n / 4);
}
module.exports = { estimateTokens };
