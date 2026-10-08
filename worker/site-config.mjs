// Set these for your own deployment before building. Keep the origin canonical:
// HTTPS, no trailing slash, path, credentials, query or fragment.
export const siteOrigin = 'https://turnfeed.example';
export const supportEmail = 'support@example.com';

const configuredOrigin = new URL(siteOrigin);
if (configuredOrigin.protocol !== 'https:' || configuredOrigin.origin !== siteOrigin) {
  throw new Error('siteOrigin must be a canonical HTTPS origin.');
}
