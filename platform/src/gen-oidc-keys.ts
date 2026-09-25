// Prints fresh values for the OAuth server's keys (§13.1) as two `KEY=value`
// lines, OIDC_JWKS and OIDC_COOKIE_KEYS, on stdout and nothing else, so the
// output can go straight into Railway's variables or `platform/.env`:
//
//   pnpm -s --filter @ogremcp/platform gen-oidc-keys
//   node platform/dist/gen-oidc-keys.js
//
// Both need a build first. `-s` keeps pnpm's own lines out of stdout. The
// values are secrets: do not print them anywhere they are kept.
import { formatOidcKeys, generateOidcKeys } from "./oidc-keys.js";

process.stdout.write(formatOidcKeys(generateOidcKeys()));
