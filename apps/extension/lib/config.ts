/** Where Yungle lives. See wxt.config.ts; a local build overrides it. */
export const ORIGIN: string = (import.meta.env.WXT_YUNGLE_ORIGIN as string | undefined) ?? 'https://yungle.co';

export const API_BASE = `${ORIGIN}/api/v1`;

/** A first-party client on the server: authorization code + PKCE, fixed redirect URIs. */
export const CLIENT_ID = 'yungle-extension';

/** Everything the extension does, and nothing else — the server clamps to this too. */
export const SCOPES = ['transfers:read', 'transfers:write', 'transfers:send', 'contacts:read'] as const;

export const PRICING_URL = `${ORIGIN}/pricing?ref=extension`;
export const DASHBOARD_URL = `${ORIGIN}/dashboard`;
