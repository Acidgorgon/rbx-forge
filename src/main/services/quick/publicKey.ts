// Public half of the quick update signing key (Ed25519, base64 SPKI DER). Quick bundles whose
// manifest does not verify with this key are refused, both when they are downloaded and at every
// launch. The private half is only in the repository's QUICK_UPDATE_SIGNING_KEY Actions secret;
// .github/workflows/quick.yml refuses to publish when the secret does not match this key.
//
// The key that counts at launch is the one in the installed app, so a new key reaches users with a
// full release.
export const QUICK_UPDATE_PUBLIC_KEY = 'MCowBQYDK2VwAyEAHMGGt8guaPAKI0GLGIXfCWM9GXi9bif0qDMMZRByy9I='
