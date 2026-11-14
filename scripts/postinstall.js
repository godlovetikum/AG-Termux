'use strict';
// Android/Termux only: "#!/usr/bin/env node" does not resolve in every Termux terminal, so point the
// launcher at Termux's own env (the same fix termux-fix-shebang applies). Does nothing elsewhere,
// and can never make the install fail.
const fs = require('fs'), path = require('path');
try {
  const prefix = process.env.PREFIX || '';
  const isTermux = /com\.termux/.test(prefix) || !!process.env.TERMUX_VERSION;
  if (!isTermux) process.exit(0);
  const file = path.join(__dirname, '..', 'bin', 'agt.js');
  const text = fs.readFileSync(file, 'utf8');
  const first = text.split('\n', 1)[0];
  if (first !== '#!/usr/bin/env node') process.exit(0); // already fixed, or customised
  const env = prefix ? path.join(prefix, 'bin', 'env') : '';
  const interpreter = env && fs.existsSync(env) ? `${env} node` : process.execPath;
  fs.writeFileSync(file, text.replace(first, `#!${interpreter}`));
} catch { /* ignore: the install must not fail because of this */ }
