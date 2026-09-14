// Forces all outbound HTTP (including Transformers.js model downloads) to use
// IPv4. On some networks DNS returns IPv6 (AAAA) records first, and Node's
// fetch/undici attempts IPv6 and times out (ETIMEDOUT) instead of falling back
// to IPv4 the way curl does. Pinning the undici connector to family 4 fixes the
// "fetch failed" / "Could not download the model" errors.
//
// This must be imported BEFORE @xenova/transformers is required anywhere.

const dns = require('node:dns');

try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  /* older Node: no-op */
}

let applied = false;

function enforceIpv4() {
  if (applied) return;
  applied = true;

  let undici;
  try {
    undici = require('undici');
  } catch {
    // No undici available; the dns ordering above is the best we can do.
    return;
  }

  const { Agent, setGlobalDispatcher } = undici;
  if (Agent && setGlobalDispatcher) {
    setGlobalDispatcher(new Agent({ connect: { family: 4, autoSelectFamily: true } }));
  }
}

enforceIpv4();

module.exports = { enforceIpv4 };
