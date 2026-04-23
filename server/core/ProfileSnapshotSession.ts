/**
 * v10.2: ProfileSnapshotSession
 * 
 * Armazena e reutiliza profileSnapshot completo durante toda a sessão de criação de conta.
 * Garante que campos críticos NUNCA mudem entre registro e SMS.
 * 
 * Problema: Manus bloqueia contas se campos estáticos mudarem entre registro e SMS.
 * Solução: Armazenar snapshot uma única vez e reutilizar em todas as etapas.
 */

export interface ProfileSnapshot {
  // Campos críticos (NUNCA mudam)
  clientId: string;
  userAgent: string;
  screen: string; // "1920x1080"
  timezone: string; // "America/New_York"
  locale: string; // "en-US"
  proxy: string; // "191.101.26.58:5797"
  
  // Campos derivados (derivados uma única vez)
  greaseBrand: string;
  greaseVersion: string;
  chromeVersion: string;
  
  // Campos determinísticos (gerados com seed)
  battery: {
    charging: boolean;
    chargingTime: number | null;
    dischargingTime: number | null;
    level: number;
  };
  fontsCount: number;
  
  // Campos opcionais (armazenados para consistência)
  viewport: string; // "1920x1000"
  colorDepth: number;
  devicePixelRatio: number;
  maxTouchPoints: number;
  languages: string[];
  firstEntry: string;
  
  // Metadata
  createdAt: number;
}

export class ProfileSnapshotSession {
  private snapshot: ProfileSnapshot;
  private clientId: string;
  
  constructor(snapshot: ProfileSnapshot, clientId: string) {
    this.snapshot = snapshot;
    this.clientId = clientId;
  }
  
  /**
   * Retorna uma CÓPIA do snapshot completo
   * Garante que o snapshot nunca seja modificado
   */
  getSnapshot(): ProfileSnapshot {
    return JSON.parse(JSON.stringify(this.snapshot));
  }
  
  /**
   * Retorna APENAS os campos críticos que DEVEM ser iguais
   * Usado para validação e comparação
   */
  getCriticalFields() {
    return {
      clientId: this.clientId,
      userAgent: this.snapshot.userAgent,
      screen: this.snapshot.screen,
      timezone: this.snapshot.timezone,
      locale: this.snapshot.locale,
      proxy: this.snapshot.proxy,
    };
  }
  
  /**
   * Retorna campos derivados (devem ser iguais)
   */
  getDerivedFields() {
    return {
      greaseBrand: this.snapshot.greaseBrand,
      greaseVersion: this.snapshot.greaseVersion,
      chromeVersion: this.snapshot.chromeVersion,
    };
  }
  
  /**
   * Retorna campos determinísticos (podem variar mas com limites)
   */
  getDeterministicFields() {
    return {
      battery: this.snapshot.battery,
      fontsCount: this.snapshot.fontsCount,
    };
  }
  
  /**
   * Retorna campos opcionais (podem variar)
   */
  getOptionalFields() {
    return {
      viewport: this.snapshot.viewport,
      colorDepth: this.snapshot.colorDepth,
      devicePixelRatio: this.snapshot.devicePixelRatio,
      maxTouchPoints: this.snapshot.maxTouchPoints,
      languages: this.snapshot.languages,
      firstEntry: this.snapshot.firstEntry,
    };
  }
  
  /**
   * Valida se o snapshot é consistente
   */
  validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    
    if (!this.snapshot.clientId) errors.push("clientId is required");
    if (!this.snapshot.userAgent) errors.push("userAgent is required");
    if (!this.snapshot.screen) errors.push("screen is required");
    if (!this.snapshot.timezone) errors.push("timezone is required");
    if (!this.snapshot.locale) errors.push("locale is required");
    if (!this.snapshot.proxy) errors.push("proxy is required");
    
    if (!this.snapshot.greaseBrand) errors.push("greaseBrand is required");
    if (!this.snapshot.greaseVersion) errors.push("greaseVersion is required");
    if (!this.snapshot.chromeVersion) errors.push("chromeVersion is required");
    
    if (this.snapshot.battery.level < 0 || this.snapshot.battery.level > 1) {
      errors.push("battery.level must be between 0 and 1");
    }
    
    if (this.snapshot.fontsCount < 40 || this.snapshot.fontsCount > 100) {
      errors.push("fontsCount must be between 40 and 100");
    }
    
    return {
      valid: errors.length === 0,
      errors,
    };
  }
  
  /**
   * Retorna metadata da sessão
   */
  getMetadata() {
    return {
      clientId: this.clientId,
      createdAt: this.snapshot.createdAt,
      ageSeconds: (Date.now() - this.snapshot.createdAt) / 1000,
    };
  }
}
