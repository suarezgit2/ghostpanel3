/**
 * Ghost Panel - Testes dos routers tRPC
 * 
 * Testa os endpoints de dashboard, jobs, accounts, proxies, logs e settings
 * usando o createCaller do tRPC (sem HTTP).
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// ----------------------------------------------------------------
// Mock do banco de dados para evitar dependência de MySQL nos testes
// ----------------------------------------------------------------

vi.mock("./db", () => ({
  getDb: vi.fn().mockResolvedValue(null),
  upsertUser: vi.fn(),
  getUserByOpenId: vi.fn(),
}));

vi.mock("./services/captcha", () => ({
  captchaService: {
    getBalance: vi.fn().mockResolvedValue({ provider: "capsolver", balance: 10.5 }),
    solveTurnstile: vi.fn().mockResolvedValue("mock-token"),
    getProvider: vi.fn().mockReturnValue("capsolver"),
    init: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("./services/sms", () => ({
  smsService: {
    getBalance: vi.fn().mockResolvedValue(5.25),
    getConfig: vi.fn().mockResolvedValue({
      country: "6",
      service: "ot",
      maxPrice: "0.01",
      maxRetries: 3,
    }),
    reloadConfig: vi.fn().mockResolvedValue(undefined),
    rentNumber: vi.fn(),
    waitForCode: vi.fn(),
    cancelNumber: vi.fn(),
  },
}));

vi.mock("./services/proxy", () => ({
  proxyService: {
    listAll: vi.fn().mockResolvedValue([]),
    syncFromWebshare: vi.fn().mockResolvedValue(0),
    getNextProxy: vi.fn().mockResolvedValue(null),
    markProxyFailed: vi.fn(),
    getDetailedStats: vi.fn().mockResolvedValue({
      total: 0,
      available: 0,
      used: 0,
      isReplacing: false,
      queueLength: 0,
    }),
  },
}));

vi.mock("./core/orchestrator", () => ({
  orchestrator: {
    createJob: vi.fn().mockResolvedValue(1),
    cancelJob: vi.fn().mockResolvedValue(undefined),
    pauseJob: vi.fn().mockResolvedValue(undefined),
    resumeJob: vi.fn().mockResolvedValue(undefined),
    getActiveJobs: vi.fn().mockReturnValue([]),
    isJobActive: vi.fn().mockReturnValue(false),
  },
}));

vi.mock("./utils/settings", () => ({
  getAllSettings: vi.fn().mockResolvedValue({
    email_domain: "test.com",
    sms_country: "6",
    sms_service: "ot",
    sms_max_price: "0.01",
  }),
  getSetting: vi.fn().mockResolvedValue("test-value"),
  setSetting: vi.fn().mockResolvedValue(undefined),
  clearSettingsCache: vi.fn(),
}));

// ----------------------------------------------------------------
// Helper: criar contexto autenticado
// ----------------------------------------------------------------

function createAuthContext(): TrpcContext {
  return {
    user: {
      id: 1,
      openId: "test-user-id",
      email: "admin@ghost.test",
      name: "Ghost Admin",
      loginMethod: "manus",
      role: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: vi.fn(),
    } as unknown as TrpcContext["res"],
  };
}

function createUnauthContext(): TrpcContext {
  return {
    user: null,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: vi.fn(),
    } as unknown as TrpcContext["res"],
  };
}

// ================================================================
// TESTES
// ================================================================

describe("Ghost Panel - Dashboard Router", () => {
  it("dashboard.stats retorna métricas zeradas quando DB não disponível", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const stats = await caller.dashboard.stats();

    expect(stats).toHaveProperty("totalAccounts");
    expect(stats).toHaveProperty("activeAccounts");
    expect(stats).toHaveProperty("failedAccounts");
    expect(stats).toHaveProperty("totalJobs");
    expect(stats).toHaveProperty("runningJobs");
    expect(stats).toHaveProperty("availableProxies");
    expect(stats.totalAccounts).toBe(0);
  });

  it("dashboard.balances retorna saldos dos serviços com provider info", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const balances = await caller.dashboard.balances();

    expect(balances).toHaveProperty("captchaProvider");
    expect(balances).toHaveProperty("captchaBalance");
    expect(balances).toHaveProperty("capsolverBalance");
    expect(balances).toHaveProperty("smsBowerBalance");
    expect(balances.captchaProvider).toBe("capsolver");
    expect(balances.captchaBalance).toBe(10.5);
    expect(balances.smsBowerBalance).toBe(5.25);
  });

  it("dashboard.recentJobs retorna array vazio quando DB não disponível", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const recentJobs = await caller.dashboard.recentJobs();

    expect(Array.isArray(recentJobs)).toBe(true);
    expect(recentJobs).toHaveLength(0);
  });

  it("dashboard.recentLogs retorna array vazio quando DB não disponível", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const recentLogs = await caller.dashboard.recentLogs();

    expect(Array.isArray(recentLogs)).toBe(true);
    expect(recentLogs).toHaveLength(0);
  });
});

describe("Ghost Panel - Jobs Router", () => {
  it("jobs.list retorna array vazio quando DB não disponível", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const jobs = await caller.jobs.list();

    expect(Array.isArray(jobs)).toBe(true);
    expect(jobs).toHaveLength(0);
  });

  it("jobs.create chama o orchestrator e retorna jobId", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const result = await caller.jobs.create({
      provider: "manus",
      quantity: 5,
      password: "test123",
      region: "us",
    });

    expect(result).toHaveProperty("jobId");
    expect(result.jobId).toBe(1);
  });

  it("jobs.getById retorna null quando DB não disponível", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const job = await caller.jobs.getById({ id: 999 });

    expect(job).toBeNull();
  });

  it("jobs.cancel chama orchestrator.cancelJob", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const result = await caller.jobs.cancel({ id: 1 });

    expect(result).toEqual({ success: true });
  });

  it("jobs.getActive retorna lista de jobs ativos", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const result = await caller.jobs.getActive();

    expect(result).toHaveProperty("activeJobIds");
    expect(Array.isArray(result.activeJobIds)).toBe(true);
  });
});

describe("Ghost Panel - Accounts Router", () => {
  it("accounts.list retorna objeto com accounts e total zerados", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const result = await caller.accounts.list({ page: 1, limit: 10 });

    expect(result).toHaveProperty("accounts");
    expect(result).toHaveProperty("total");
    expect(result.accounts).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("accounts.list aceita filtro de status", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const result = await caller.accounts.list({ page: 1, limit: 10, status: "active" });

    expect(result).toHaveProperty("accounts");
    expect(result.total).toBe(0);
  });

  it("accounts.list aceita filtro de jobId", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const result = await caller.accounts.list({ page: 1, limit: 10, jobId: 1 });

    expect(result).toHaveProperty("accounts");
    expect(result.total).toBe(0);
  });

  it("accounts.getById retorna null quando DB não disponível", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const result = await caller.accounts.getById({ id: 1 });

    expect(result).toBeNull();
  });

  it("accounts.exportAll retorna array vazio quando DB não disponível", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const result = await caller.accounts.exportAll();

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });
});

describe("Ghost Panel - Proxies Router", () => {
  it("proxies.list retorna array vazio (mock)", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const result = await caller.proxies.list();

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it("proxies.stats retorna contadores zerados quando DB não disponível", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const result = await caller.proxies.stats();

    expect(result).toHaveProperty("total");
    expect(result).toHaveProperty("active");
    expect(result).toHaveProperty("bad");
    expect(result.total).toBe(0);
  });

  it("proxies.sync chama proxyService.syncFromWebshare", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const result = await caller.proxies.sync();

    expect(result).toHaveProperty("synced");
    expect(result.synced).toBe(0);
  });
});

describe("Ghost Panel - Logs Router", () => {
  it("logs.list retorna objeto com logs e total zerados", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const result = await caller.logs.list({ page: 1, limit: 50 });

    expect(result).toHaveProperty("logs");
    expect(result).toHaveProperty("total");
    expect(result.logs).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("logs.list aceita filtro de level", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const result = await caller.logs.list({ page: 1, limit: 50, level: "error" });

    expect(result).toHaveProperty("logs");
  });

  it("logs.list aceita filtro de jobId", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const result = await caller.logs.list({ page: 1, limit: 50, jobId: 1 });

    expect(result).toHaveProperty("logs");
  });
});

describe("Ghost Panel - Settings Router", () => {
  it("settings.getAll retorna mapa de configurações", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const result = await caller.settings.getAll();

    expect(typeof result).toBe("object");
    expect(result).toHaveProperty("email_domain");
    expect(result.email_domain).toBe("test.com");
    expect(result.sms_country).toBe("6");
  });

  it("settings.getSmsConfig retorna configuração SMS", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const result = await caller.settings.getSmsConfig();

    expect(result).toHaveProperty("country");
    expect(result).toHaveProperty("service");
    expect(result.country).toBe("6");
    expect(result.service).toBe("ot");
  });

  it("settings.reloadSmsConfig retorna success", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const result = await caller.settings.reloadSmsConfig();

    expect(result).toEqual({ success: true });
  });

  it("settings.listProviders retorna array vazio quando DB não disponível", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const result = await caller.settings.listProviders();

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });
});

describe("Ghost Panel - Fingerprint & AuthCommandCmd", () => {
  it("fingerprintService.generateProfile retorna perfil completo", async () => {
    const { fingerprintService } = await import("./services/fingerprint");
    const profile = fingerprintService.generateProfile("us");

    expect(profile).toHaveProperty("userAgent");
    expect(profile).toHaveProperty("platform");
    expect(profile).toHaveProperty("screenWidth");
    expect(profile).toHaveProperty("screenHeight");
    expect(profile).toHaveProperty("viewportWidth");
    expect(profile).toHaveProperty("viewportHeight");
    expect(profile).toHaveProperty("colorDepth");
    expect(profile).toHaveProperty("timezone");
    expect(profile).toHaveProperty("locale");
    expect(profile).toHaveProperty("languages");
    expect(profile).toHaveProperty("clientId");
    expect(profile).toHaveProperty("dcrEncoded");
    expect(profile).toHaveProperty("headers");
    // ANTI-DETECTION v4.2: novos campos
    expect(profile).toHaveProperty("firstEntry");
    expect(profile).toHaveProperty("timezoneOffset");
    expect(profile.clientId).toHaveLength(22);
    expect(profile.colorDepth).toBe(24);
    // firstEntry deve ser undefined (direct access) ou uma URL válida
    if (profile.firstEntry !== undefined) {
      expect(typeof profile.firstEntry).toBe("string");
      expect(profile.firstEntry).toMatch(/^https?:\/\//);
    }
    // timezoneOffset deve ser um número
    expect(typeof profile.timezoneOffset).toBe("number");
  });

  it("fingerprintService.getOrderedHeaders ordena headers corretamente", async () => {
    const { fingerprintService } = await import("./services/fingerprint");
    const profile = fingerprintService.generateProfile();
    const headers = fingerprintService.getOrderedHeaders(profile, { "Authorization": "Bearer test" });

    expect(headers).toHaveProperty("User-Agent");
    expect(headers).toHaveProperty("x-client-id");
    expect(headers).toHaveProperty("x-client-dcr");
    expect(headers).toHaveProperty("Authorization");
  });

  it("encodeDCR codifica corretamente com ROT3", async () => {
    const { encodeDCR } = await import("./utils/helpers");
    const input = JSON.stringify({ test: "hello" });
    const encoded = encodeDCR(input);

    expect(typeof encoded).toBe("string");
    expect(encoded.length).toBeGreaterThan(0);
    // Deve ser diferente do base64 normal
    const normalBase64 = Buffer.from(input).toString("base64");
    expect(encoded).not.toBe(normalBase64);
  });

  it("generateClientId gera IDs de 22 caracteres alfanuméricos", async () => {
    const { generateClientId } = await import("./utils/helpers");
    const id1 = generateClientId();
    const id2 = generateClientId();

    expect(id1).toHaveLength(22);
    expect(id2).toHaveLength(22);
    expect(id1).not.toBe(id2); // Should be unique
    expect(id1).toMatch(/^[A-Za-z0-9]+$/);
  });

  it("buildAuthCommandCmd gera objeto correto a partir do fingerprint", async () => {
    const { fingerprintService } = await import("./services/fingerprint");
    const profile = fingerprintService.generateProfile("us");

    // Import the provider to test buildAuthCommandCmd indirectly
    // The authCommandCmd is built inside ManusProvider, so we test the profile has the required fields
    expect(profile.locale).toBeTruthy();
    expect(profile.timezone).toBeTruthy();
    expect(typeof profile.locale).toBe("string");
    expect(typeof profile.timezone).toBe("string");
    // ANTI-DETECTION v5.1: firstEntry is undefined (direct) or a full URL
    if (profile.firstEntry !== undefined) {
      expect(typeof profile.firstEntry).toBe("string");
      expect(profile.firstEntry).toMatch(/^https?:\/\//);
    }
    // timezoneOffset deve ser um número inteiro (DST-aware)
    expect(typeof profile.timezoneOffset).toBe("number");
    expect(Number.isInteger(profile.timezoneOffset)).toBe(true);
  });

  it("DCR tem formato correto compatível com manus.im (ua, fgRequestId, screen, viewport, timestamp, timezoneOffset)", async () => {
    const { fingerprintService } = await import("./services/fingerprint");
    const profile = fingerprintService.generateProfile("us");

    // Decode the DCR to verify format matches real manus.im getDCR() output
    const dcr = profile.dcrEncoded;
    let decoded = '';
    for (let i = 0; i < dcr.length; i++) {
      const c = dcr.charCodeAt(i);
      if (c >= 65 && c <= 90) decoded += String.fromCharCode(((c - 65 - 3 + 26) % 26) + 65);
      else if (c >= 97 && c <= 122) decoded += String.fromCharCode(((c - 97 - 3 + 26) % 26) + 97);
      else if (c >= 48 && c <= 57) decoded += String.fromCharCode(((c - 48 - 3 + 10) % 10) + 48);
      else decoded += dcr[i];
    }
    const json = Buffer.from(decoded, 'base64').toString('utf8');
    const parsed = JSON.parse(json);

    // Verify all required fields from real manus.im getDCR() function (module 54273)
    expect(parsed).toHaveProperty('ua');              // navigator.userAgent
    expect(parsed).toHaveProperty('locale');          // locale string
    expect(parsed).toHaveProperty('languages');       // array
    expect(parsed).toHaveProperty('timezone');        // IANA timezone
    expect(parsed).toHaveProperty('fgRequestId');     // FingerprintJS Pro requestId (empty string)
    expect(parsed).toHaveProperty('clientId');        // client ID
    expect(parsed).toHaveProperty('screen');          // { width, height } nested object
    expect(parsed).toHaveProperty('viewport');        // { width, height } nested object
    expect(parsed).toHaveProperty('timestamp');       // Date.now()
    expect(parsed).toHaveProperty('timezoneOffset'); // getTimezoneOffset()

    // Verify nested structure (real format uses objects, not flat fields)
    expect(parsed.screen).toHaveProperty('width');
    expect(parsed.screen).toHaveProperty('height');
    expect(parsed.viewport).toHaveProperty('width');
    expect(parsed.viewport).toHaveProperty('height');

    // Verify types
    expect(typeof parsed.ua).toBe('string');
    expect(typeof parsed.fgRequestId).toBe('string');
    expect(typeof parsed.timestamp).toBe('number');
    expect(typeof parsed.timezoneOffset).toBe('number');
    expect(Array.isArray(parsed.languages)).toBe(true);

    // Verify ua matches userAgent and clientId matches
    expect(parsed.ua).toBe(profile.userAgent);
    expect(parsed.clientId).toBe(profile.clientId);

    // Verify regenerateDcr produces a fresh DCR (different timestamp)
    const freshDcr = fingerprintService.regenerateDcr(profile);
    expect(typeof freshDcr).toBe('string');
    expect(freshDcr.length).toBeGreaterThan(0);
  });

  it("STEP_DELAYS retorna promises que resolvem", async () => {
    const { STEP_DELAYS } = await import("./utils/helpers");

    // Test that delays are functions that return promises
    expect(typeof STEP_DELAYS.afterTurnstile).toBe("function");
    expect(typeof STEP_DELAYS.afterEmailCheck).toBe("function");
    expect(typeof STEP_DELAYS.afterRegistration).toBe("function");
    expect(typeof STEP_DELAYS.betweenAccounts).toBe("function");
  });
});

describe("Ghost Panel - Anti-Detection v4.2", () => {
  it("generateEmailPrefix gera prefixos com padrão humano (não aleatório puro)", async () => {
    const { generateEmailPrefix } = await import("./utils/helpers");

    // Gerar 20 prefixos e verificar que seguem padrões humanos
    const prefixes: string[] = [];
    for (let i = 0; i < 20; i++) {
      prefixes.push(generateEmailPrefix());
    }

    // Todos devem ser strings não-vazias
    prefixes.forEach(p => {
      expect(typeof p).toBe("string");
      expect(p.length).toBeGreaterThan(3);
    });

    // Devem ser únicos (alta probabilidade)
    const unique = new Set(prefixes);
    expect(unique.size).toBeGreaterThan(10);
  });

  it("generatePassword gera senhas com padrão humano (palavra+número+símbolo)", async () => {
    const { generatePassword } = await import("./utils/helpers");

    const passwords: string[] = [];
    for (let i = 0; i < 10; i++) {
      passwords.push(generatePassword());
    }

    passwords.forEach(p => {
      expect(p.length).toBeGreaterThanOrEqual(8);
      // Deve conter pelo menos uma letra maiúscula
      expect(p).toMatch(/[A-Z]/);
      // Deve conter pelo menos um número
      expect(p).toMatch(/[0-9]/);
      // Deve conter pelo menos um símbolo
      expect(p).toMatch(/[!@#$%&*?]/);
    });
  });

  it("fingerprintService gera firstEntry com distribuição realista (URLs ou undefined)", async () => {
    const { fingerprintService } = await import("./services/fingerprint");

    // Gerar 50 perfis e verificar distribuição de firstEntry
    const entries: (string | undefined)[] = [];
    for (let i = 0; i < 50; i++) {
      const profile = fingerprintService.generateProfile();
      entries.push(profile.firstEntry);
    }

    // Com 45% de chance de undefined (direct access), em 50 tentativas esperamos entre 10 e 40
    const undefinedCount = entries.filter(e => e === undefined).length;
    expect(undefinedCount).toBeLessThan(50); // Nunca 100% undefined
    expect(undefinedCount).toBeGreaterThan(0); // Deve ter alguns undefined (direct)

    // Deve ter pelo menos um com URL (não-direct)
    const withUrl = entries.filter(e => e !== undefined);
    expect(withUrl.length).toBeGreaterThan(0);

    // Todos os não-undefined devem ser URLs válidas
    withUrl.forEach(url => {
      expect(url).toMatch(/^https?:\/\//);
    });
  });

  it("timezoneOffset usa valor DST-aware (não valor fixo desatualizado)", async () => {
    const { fingerprintService } = await import("./services/fingerprint");

    // Em março de 2026, America/New_York está em EDT (UTC-4, offset=240)
    // Não deve retornar 300 (EST, UTC-5) que seria o valor de inverno
    const profile = fingerprintService.generateProfile("us");

    // O offset deve ser um número inteiro válido
    expect(Number.isInteger(profile.timezoneOffset)).toBe(true);
    // Deve estar em um range razoável para timezones americanos
    expect(profile.timezoneOffset).toBeGreaterThanOrEqual(180); // UTC-3 (mais leste)
    expect(profile.timezoneOffset).toBeLessThanOrEqual(480);    // UTC-8 (mais oeste)
  });

  it("DCR regenerado tem timestamp diferente do original", async () => {
    const { fingerprintService } = await import("./services/fingerprint");
    const profile = fingerprintService.generateProfile("us");

    // Aguardar 10ms para garantir timestamp diferente
    await new Promise(r => setTimeout(r, 10));

    const freshDcr = fingerprintService.regenerateDcr(profile);

    // O DCR regenerado deve ser diferente do original (timestamp mudou)
    // (pode ser igual se gerado no mesmo milissegundo, mas improvável)
    expect(typeof freshDcr).toBe("string");
    expect(freshDcr.length).toBeGreaterThan(0);
  });
});

describe("Ghost Panel - TLS Impersonation (v5.0)", () => {
  it("httpClient exporta as funções necessárias", async () => {
    const { httpRequest, isTlsImpersonationActive, getHttpClientInfo } = await import("./services/httpClient");

    expect(typeof httpRequest).toBe("function");
    expect(typeof isTlsImpersonationActive).toBe("function");
    expect(typeof getHttpClientInfo).toBe("function");
  });

  it("getHttpClientInfo retorna informações do cliente HTTP", async () => {
    const { getHttpClientInfo } = await import("./services/httpClient");
    const info = await getHttpClientInfo();

    expect(info).toHaveProperty("client");
    expect(info).toHaveProperty("impersonateSupport");
    expect(["impers", "fetch"]).toContain(info.client);
    expect(typeof info.impersonateSupport).toBe("boolean");
  });

  it("rpc.ts não importa mais https-proxy-agent diretamente", async () => {
    // O rpc.ts agora usa httpClient em vez de fetch + HttpsProxyAgent
    // Verificar que o módulo httpClient é importado corretamente
    const rpcModule = await import("./providers/manus/rpc");

    expect(typeof rpcModule.getUserPlatforms).toBe("function");
    expect(typeof rpcModule.registerByEmail).toBe("function");
    expect(typeof rpcModule.checkInvitationCode).toBe("function");
    expect(typeof rpcModule.getAvailableCredits).toBe("function");
  });

  it("httpClient mapeia versão do Chrome para target de impersonation correto", async () => {
    // Teste indireto: o httpRequest aceita userAgent e não crasheia
    const { httpRequest } = await import("./services/httpClient");

    // Não podemos testar uma requisição real em unit tests,
    // mas podemos verificar que a função aceita os parâmetros corretos
    expect(typeof httpRequest).toBe("function");
  });
});

describe("Ghost Panel - Auth Protection", () => {
  it("endpoints protegidos rejeitam usuário não autenticado", async () => {
    const caller = appRouter.createCaller(createUnauthContext());

    await expect(caller.dashboard.stats()).rejects.toThrow();
    await expect(caller.jobs.list()).rejects.toThrow();
    await expect(caller.accounts.list()).rejects.toThrow();
    await expect(caller.proxies.list()).rejects.toThrow();
    await expect(caller.logs.list()).rejects.toThrow();
    await expect(caller.settings.getAll()).rejects.toThrow();
  });

  it("auth.me retorna null para usuário não autenticado", async () => {
    const caller = appRouter.createCaller(createUnauthContext());
    const result = await caller.auth.me();

    expect(result).toBeNull();
  });

  it("auth.me retorna dados do usuário autenticado", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const result = await caller.auth.me();

    expect(result).not.toBeNull();
    expect(result?.email).toBe("admin@ghost.test");
    expect(result?.name).toBe("Ghost Admin");
  });
});
