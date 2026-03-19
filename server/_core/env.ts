export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",

  // Auth mode
  localAuth: process.env.LOCAL_AUTH === "true",

  // Ghost service API keys
  capsolverApiKey: process.env.CAPSOLVER_API_KEY ?? "",
  smsbowerApiKey: process.env.SMSBOWER_API_KEY ?? "",
  webshareApiKey: process.env.WEBSHARE_API_KEY ?? "",
  zohoClientId: process.env.ZOHO_CLIENT_ID ?? "",
  zohoClientSecret: process.env.ZOHO_CLIENT_SECRET ?? "",
  zohoRefreshToken: process.env.ZOHO_REFRESH_TOKEN ?? "",
  zohoAccountId: process.env.ZOHO_ACCOUNT_ID ?? "",
  twocaptchaApiKey: process.env.TWOCAPTCHA_API_KEY ?? "",
  captchaProvider: process.env.CAPTCHA_PROVIDER ?? "capsolver",
  // TLS Impersonation (curl-impersonate)
  // Path to libcurl-impersonate-chrome.so for Chrome TLS/HTTP2 fingerprint impersonation
  // If not set, impers will try to auto-download or fall back to native fetch
  libcurlImpersonatePath: process.env.LIBCURL_IMPERSONATE_PATH ?? "",

  // Admin password hash (bcrypt) para autenticação local
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH ?? "",
};
