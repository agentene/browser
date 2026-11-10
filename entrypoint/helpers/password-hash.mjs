// password-hash.mjs — a salted scrypt hash of the password on stdin, in the
// format the CDP gateway's console-auth.mjs verifies (that of
// auth-server/src/secrets.mjs too): scrypt$N$r$p$<salt>$<hash>, base64url.
// Run by entrypoint/lib/cdp-gateway.sh, so the gateway gets the hash of
// Selkies' master password instead of the password (or a fast, unsalted
// digest of it).

import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEYLEN = 32;

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const password = Buffer.concat(chunks).toString('utf8');
const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(password, salt, KEYLEN, SCRYPT);
const b64 = (buf) => buf.toString('base64url');
process.stdout.write(['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, b64(salt), b64(hash)].join('$') + '\n');
