/**
 * Third-party console instructions for the setup wizard, kept in one place so they can be
 * re-checked each release. Links point at vendor documentation pages rather than deep console
 * paths, which change more often.
 */
export const INSTRUCTIONS_LAST_VERIFIED = '2026-10-11'

export interface OidcPreset {
  id: string
  label: string
  /** Pre-filled issuer, when the provider has a fixed one. */
  issuer?: string
  /** Where to find the issuer when it is tenant-specific. */
  issuerHint?: string
  docsUrl: string
  /** Where to register the web application, in plain words. */
  register: string
}

export const OIDC_PRESETS: OidcPreset[] = [
  {
    id: 'google',
    label: 'Google',
    issuer: 'https://accounts.google.com',
    docsUrl: 'https://developers.google.com/identity/openid-connect/openid-connect',
    register: 'Google Cloud console → APIs &amp; Services → Credentials → Create credentials → OAuth client ID → Web application.',
  },
  {
    id: 'entra',
    label: 'Microsoft Entra ID',
    issuerHint: 'https://login.microsoftonline.com/&lt;tenant-id&gt;/v2.0 (the tenant ID is on the app registration Overview page).',
    docsUrl: 'https://learn.microsoft.com/entra/identity-platform/quickstart-register-app',
    register: 'Microsoft Entra admin center → App registrations → New registration → Web platform.',
  },
  {
    id: 'okta',
    label: 'Okta',
    issuerHint: 'https://&lt;your-org&gt;.okta.com (or your custom authorization server, such as https://&lt;your-org&gt;.okta.com/oauth2/default).',
    docsUrl: 'https://developer.okta.com/docs/guides/sign-into-web-app-redirect/',
    register: 'Okta Admin Console → Applications → Create App Integration → OIDC → Web Application.',
  },
  {
    id: 'auth0',
    label: 'Auth0',
    issuerHint: 'https://&lt;your-tenant&gt;.&lt;region&gt;.auth0.com/ (with the trailing slash, exactly as Auth0 shows it).',
    docsUrl: 'https://auth0.com/docs/get-started/applications',
    register: 'Auth0 Dashboard → Applications → Create Application → Regular Web Application.',
  },
  {
    id: 'keycloak',
    label: 'Keycloak',
    issuerHint: 'https://&lt;keycloak-host&gt;/realms/&lt;realm&gt;.',
    docsUrl: 'https://www.keycloak.org/docs/latest/server_admin/#_oidc_clients',
    register: 'Keycloak admin console → your realm → Clients → Create client → OpenID Connect, with client authentication on.',
  },
  {
    id: 'pocket-id',
    label: 'Pocket ID',
    issuerHint: 'Your Pocket ID address, such as https://id.example.com (its APP_URL).',
    docsUrl: 'https://pocket-id.org/docs/',
    register: 'Pocket ID → Administration → OIDC Clients → Add OIDC Client. Leave it a confidential client (not public) so it issues a client secret.',
  },
  {
    id: 'other',
    label: 'Other OIDC provider',
    issuerHint: 'The issuer URL from your provider. StatusPing reads &lt;issuer&gt;/.well-known/openid-configuration.',
    docsUrl: 'https://openid.net/specs/openid-connect-discovery-1_0.html',
    register: 'Register a confidential web application that uses the authorization code flow.',
  },
]

export const presetById = (id: string | undefined) => OIDC_PRESETS.find((preset) => preset.id === id)

/** Cloudflare Access team domains look like <team>.cloudflareaccess.com. */
export const TEAM_DOMAIN = /^[a-z0-9-]+\.cloudflareaccess\.com$/i

export const ACCESS_DOCS_URL = 'https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/'
