/**
 * Settings Page - Gerenciamento de configurações e API keys
 * 
 * Design: Obsidian Command — Dark Minimal Corporativa
 * Seções: API Keys + SMS Configuration (dinâmica via banco)
 */

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Save, Eye, EyeOff, Key, Mail, MessageSquare, Globe, Shield,
  RefreshCw, Zap, Clock, Hash, DollarSign, RotateCcw, Search, Info,
  Gift, Shuffle, Settings2, Activity, Ban, Trash2, CheckCircle, AlertTriangle, XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

/* ------------------------------------------------------------------ */
/*  Tipos                                                              */
/* ------------------------------------------------------------------ */

interface SettingField {
  key: string;
  label: string;
  sensitive: boolean;
  placeholder: string;
  description?: string;
}

interface SettingGroup {
  title: string;
  icon: any;
  description: string;
  keys: SettingField[];
}

interface SmsField {
  key: string;
  label: string;
  placeholder: string;
  description: string;
  type: "text" | "number" | "toggle";
  suffix?: string;
}

/* ------------------------------------------------------------------ */
/*  Configuração estática dos grupos de API Keys                       */
/* ------------------------------------------------------------------ */

const API_KEY_GROUPS: SettingGroup[] = [
  {
    title: "Captcha Solver",
    icon: Shield,
    description: "Resolução de CAPTCHA (Cloudflare Turnstile). Escolha CapSolver ou 2Captcha.",
    keys: [
      { key: "captcha_provider", label: "Provedor", sensitive: false, placeholder: "capsolver", description: "capsolver ou 2captcha" },
      { key: "capsolver_api_key", label: "CapSolver API Key", sensitive: true, placeholder: "CAP-..." },
      { key: "twocaptcha_api_key", label: "2Captcha API Key", sensitive: true, placeholder: "API key do 2Captcha" },
    ],
  },
  {
    title: "SMSBower",
    icon: MessageSquare,
    description: "Recebimento de códigos SMS",
    keys: [
      { key: "smsbower_api_key", label: "API Key", sensitive: true, placeholder: "API key do SMSBower" },
    ],
  },
  {
    title: "Webshare",
    icon: Globe,
    description: "Proxies datacenter",
    keys: [
      { key: "webshare_api_key", label: "API Key", sensitive: true, placeholder: "API key da Webshare" },
    ],
  },
  {
    title: "Zoho Mail",
    icon: Mail,
    description: "Leitura de emails de verificação",
    keys: [
      { key: "zoho_client_id", label: "Client ID", sensitive: false, placeholder: "1000.XXX" },
      { key: "zoho_client_secret", label: "Client Secret", sensitive: true, placeholder: "Client secret" },
      { key: "zoho_refresh_token", label: "Refresh Token", sensitive: true, placeholder: "1000.XXX" },
      { key: "zoho_account_id", label: "Account ID", sensitive: false, placeholder: "1410307000000008002" },
      { key: "email_domain", label: "Domínio(s) do Email", sensitive: false, placeholder: "dominio1.com, dominio2.com, dominio3.com", description: "Separe múltiplos domínios por vírgula. Cada conta usará um domínio aleatório — evita ban em lote por domínio compartilhado." },
    ],
  },
];

/* ------------------------------------------------------------------ */
/*  Configuração dos campos de SMS (dinâmicos via banco)               */
/* ------------------------------------------------------------------ */

const SMS_FIELDS: SmsField[] = [
  {
    key: "sms_country",
    label: "País",
    placeholder: "6",
    description: "Código do país no SMSBower. Ex: 6 = Indonesia, 0 = Rússia, 12 = Filipinas",
    type: "text",
  },
  {
    key: "sms_service",
    label: "Serviço",
    placeholder: "ot",
    description: "Código do serviço no SMSBower. 'ot' = Other (para serviços não listados como Manus)",
    type: "text",
  },
  {
    key: "sms_max_price",
    label: "Preço Máximo",
    placeholder: "0.01",
    description: "Preço máximo por número em USD. Ex: 0.01 = Gold $0.01, 0.007 = Gold $0.007",
    type: "text",
    suffix: "USD",
  },
  {
    key: "sms_provider_ids",
    label: "Provider IDs",
    placeholder: "2295,3291,2482,1507,3250,3027,2413",
    description: "IDs dos provedores separados por vírgula. Obtidos via getPricesV3. Deixe vazio para qualquer provedor dentro do maxPrice",
    type: "text",
  },
  {
    key: "sms_max_retries",
    label: "Máx. Retries",
    placeholder: "3",
    description: "Quantos números diferentes tentar antes de desistir. Cada retry aluga um novo número",
    type: "number",
    suffix: "tentativas",
  },
  {
    key: "sms_wait_time",
    label: "Tempo de Espera",
    placeholder: "120",
    description: "Quanto tempo esperar pelo SMS em cada tentativa antes de cancelar e tentar outro número",
    type: "number",
    suffix: "segundos",
  },
  {
    key: "sms_poll_interval",
    label: "Intervalo de Polling",
    placeholder: "5",
    description: "Intervalo entre verificações de status do SMS no SMSBower",
    type: "number",
    suffix: "segundos",
  },
  {
    key: "sms_cancel_wait",
    label: "Espera p/ Cancelar",
    placeholder: "125",
    description: "Tempo mínimo antes de cancelar um número (regra do SMSBower: mínimo 2 minutos)",
    type: "number",
    suffix: "segundos",
  },
  {
    key: "sms_retry_delay_min",
    label: "Delay Mín. entre Retries",
    placeholder: "3",
    description: "Delay mínimo entre tentativas para humanização",
    type: "number",
    suffix: "segundos",
  },
  {
    key: "sms_retry_delay_max",
    label: "Delay Máx. entre Retries",
    placeholder: "8",
    description: "Delay máximo entre tentativas para humanização",
    type: "number",
    suffix: "segundos",
  },
  {
    key: "sms_auto_discover",
    label: "Auto-Descobrir Provedores",
    placeholder: "",
    description: "Se ativo, busca automaticamente os providerIds mais baratos via getPricesV3 (ignora Provider IDs manuais)",
    type: "toggle",
  },
];

/* ------------------------------------------------------------------ */
/*  Componente: Campo com tooltip de ajuda                             */
/* ------------------------------------------------------------------ */

function FieldWithHelp({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </Label>
        <Tooltip>
          <TooltipTrigger asChild>
            <Info className="w-3 h-3 text-muted-foreground/50 hover:text-muted-foreground cursor-help transition-colors" />
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs text-xs">
            {description}
          </TooltipContent>
        </Tooltip>
      </div>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Página Principal                                                   */
/* ------------------------------------------------------------------ */

export default function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [showSensitive, setShowSensitive] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<"keys" | "sms" | "proxy" | "general">("keys");

  const { data: allSettings, isLoading: loading, refetch: loadSettings } = trpc.settings.getAll.useQuery();
  const { data: healthData, refetch: refetchHealth } = trpc.settings.getSmsHealth.useQuery();
  const { data: blacklistData, refetch: refetchBlacklist } = trpc.settings.getSmsBlacklist.useQuery();
  const { data: countriesData, refetch: refetchCountries } = trpc.settings.getSmsCountries.useQuery();
  const { data: fpjsStatus, refetch: refetchFpjs } = trpc.settings.getFpjsStatus.useQuery(undefined, { refetchInterval: 15000 });

  // v9.7: SMSPool state
  const { data: smsPoolConfig, refetch: refetchSmsPoolConfig } = trpc.settings.getSmsPoolConfig.useQuery();
  const { data: smsPoolBalanceData, refetch: refetchSmsPoolBalance } = trpc.settings.getSmsPoolBalance.useQuery();
  const [smsPoolForm, setSmsPoolForm] = useState<{
    enabled?: boolean;
    apiKey?: string;
    serviceId?: string;
    countryId?: string;
    maxPrice?: string;
    pool?: string;
    priority?: "primary" | "secondary";
  }>({});
  const [smsPoolModified, setSmsPoolModified] = useState(false);
  const [showSmsPoolApiKey, setShowSmsPoolApiKey] = useState(false);

  // Multi-country state
  const [editingCountries, setEditingCountries] = useState<any[]>([]);
  const [countriesModified, setCountriesModified] = useState(false);
  const [showAddCountry, setShowAddCountry] = useState(false);
  const [newCountryCode, setNewCountryCode] = useState("");
  const [newCountryMaxPrice, setNewCountryMaxPrice] = useState("0.01");

  // Sync countries when loaded
  useEffect(() => {
    if (countriesData?.countries && !countriesModified) {
      setEditingCountries(countriesData.countries);
    }
  }, [countriesData, countriesModified]);

  // v9.7: SMSPool mutation
  const updateSmsPoolMutation = trpc.settings.updateSmsPoolConfig.useMutation({
    onSuccess: () => {
      toast.success("SMSPool atualizado!", { description: "Configuração salva com sucesso" });
      setSmsPoolModified(false);
      refetchSmsPoolConfig();
      refetchSmsPoolBalance();
    },
    onError: (err) => toast.error("Erro ao salvar SMSPool", { description: err.message }),
  });

  // Sync SMSPool form when config loads
  useEffect(() => {
    if (smsPoolConfig && !smsPoolModified) {
      setSmsPoolForm({
        enabled: smsPoolConfig.enabled,
        apiKey: smsPoolConfig.apiKey,
        serviceId: smsPoolConfig.serviceId,
        countryId: smsPoolConfig.countryId,
        maxPrice: smsPoolConfig.maxPrice,
        pool: smsPoolConfig.pool,
        priority: smsPoolConfig.priority,
      });
    }
  }, [smsPoolConfig, smsPoolModified]);

  const discoverMutation = trpc.settings.discoverAndUpdateSmsProviders.useMutation({
    onSuccess: (data) => {
      if (data.success) {
        toast.success("Provedores atualizados!", { description: data.message });
        loadSettings();
        refetchHealth();
      } else {
        toast.warning("Sem provedores", { description: data.message });
      }
    },
    onError: (err) => toast.error("Erro ao descobrir provedores", { description: err.message }),
  });

  const clearBlacklistMutation = trpc.settings.clearSmsBlacklist.useMutation({
    onSuccess: () => {
      toast.success("Blacklist limpa!", { description: "Health e blacklist dos provedores resetados" });
      refetchBlacklist();
      refetchHealth();
    },
    onError: (err) => toast.error("Erro ao limpar blacklist", { description: err.message }),
  });

  const resetHealthMutation = trpc.settings.resetSmsHealth.useMutation({
    onSuccess: () => {
      toast.success("Health resetado!");
      refetchHealth();
    },
    onError: (err) => toast.error("Erro ao resetar health", { description: err.message }),
  });

  const saveCountriesMutation = trpc.settings.saveSmsCountries.useMutation({
    onSuccess: (data) => {
      toast.success("Países salvos!", { description: data.message });
      setCountriesModified(false);
      refetchCountries();
    },
    onError: (err) => toast.error("Erro ao salvar países", { description: err.message }),
  });

  const discoverForCountryMutation = trpc.settings.discoverProvidersForCountry.useMutation({
    onSuccess: (data, vars) => {
      if (data.success) {
        toast.success(`Provedores descobertos!`, { description: data.message });
        // Atualiza os providerIds do país na lista local
        setEditingCountries(prev => prev.map(c =>
          c.countryCode === vars.countryCode
            ? { ...c, providerIds: data.providers }
            : c
        ));
        setCountriesModified(true);
      } else {
        toast.warning("Sem provedores", { description: data.message });
      }
    },
    onError: (err) => toast.error("Erro ao descobrir provedores", { description: err.message }),
  });

  // Sync settings when data loads
  useEffect(() => {
    if (allSettings) {
      setSettings(allSettings);
    }
  }, [allSettings]);

  const refillFpjsMutation = trpc.settings.refillFpjsPool.useMutation({
    onSuccess: (data) => {
      if (data.success) {
        toast.success("FPJS Direct OK!", { description: `requestId gerado: ${(data as any).requestId ?? "—"}` });
      } else {
        toast.warning("FPJS indisponível", { description: (data as any).message });
      }
      refetchFpjs();
    },
    onError: (err) => toast.error("Erro ao reabastecer pool FPJS", { description: err.message }),
  });

  const setBulkMutation = trpc.settings.setBulk.useMutation({
    onSuccess: () => {
      toast.success("Configurações salvas com sucesso!");
      loadSettings();
    },
    onError: (err) => {
      toast.error("Erro ao salvar", { description: err.message });
    },
  });

  // Chaves sensíveis que usam mascaramento (****xxxx)
  const SENSITIVE_KEYS = new Set([
    "capsolver_api_key",
    "twocaptcha_api_key",
    "smsbower_api_key",
    "smspool_api_key",
    "webshare_api_key",
    "zoho_client_id",
    "zoho_client_secret",
    "zoho_refresh_token",
    "admin_password_hash",
  ]);

  // v9.5.2: Chaves gerenciadas automaticamente por mutations específicas.
  // v9.8: Adicionadas chaves smspool_* — gerenciadas por updateSmsPoolConfig.
  // "Salvar Tudo" NÃO deve sobrescrever esses valores, pois são controlados
  // por clearBlacklist, saveSmsCountries, health tracker, updateSmsPoolConfig, etc.
  const MANAGED_KEYS = new Set([
    "sms_blacklisted_providers",
    "sms_provider_health",
    "sms_number_quality",
    "sms_countries",
    // v9.8: SMSPool settings gerenciadas por updateSmsPoolConfig mutation.
    // Sem isso, "Salvar Tudo" sobrescreve com valores stale/mascarados,
    // resetando a configuração do SMSPool.
    "smspool_enabled",
    "smspool_api_key",
    "smspool_service_id",
    "smspool_country_id",
    "smspool_max_price",
    "smspool_pool",
    "smspool_priority",
  ]);

  const saveSettings = async () => {
    setSaving(true);
    try {
      const entries = Object.entries(settings)
        .filter(([_, v]) => v !== undefined && v !== null)
        // PROTEÇÃO: nunca enviar valores mascarados (****xxxx) — eles não foram editados
        .filter(([key, value]) => !(SENSITIVE_KEYS.has(key) && value.startsWith("****")))
        // v9.5.2: nunca sobrescrever chaves gerenciadas por mutations específicas
        .filter(([key]) => !MANAGED_KEYS.has(key))
        .map(([key, value]) => ({ key, value }));
      await setBulkMutation.mutateAsync(entries);
    } finally {
      setSaving(false);
    }
  };

  const updateSetting = (key: string, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const toggleVisibility = (key: string) => {
    setShowSensitive((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Configurações</h1>
          <p className="text-sm text-muted-foreground mt-1">
            API keys, credenciais e parâmetros de SMS
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => loadSettings()} className="gap-1.5">
            <RefreshCw className="w-3.5 h-3.5" />
            Recarregar
          </Button>
          <Button onClick={saveSettings} disabled={saving} className="gap-1.5">
            <Save className="w-4 h-4" />
            {saving ? "Salvando..." : "Salvar Tudo"}
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 rounded-lg bg-ghost-surface-2 w-fit">
        <button
          onClick={() => setActiveTab("keys")}
          className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
            activeTab === "keys"
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <span className="flex items-center gap-2">
            <Key className="w-3.5 h-3.5" />
            API Keys
          </span>
        </button>
        <button
          onClick={() => setActiveTab("sms")}
          className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
            activeTab === "sms"
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <span className="flex items-center gap-2">
            <MessageSquare className="w-3.5 h-3.5" />
            SMS Config
          </span>
        </button>
        <button
          onClick={() => setActiveTab("general")}
          className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
            activeTab === "general"
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <span className="flex items-center gap-2">
            <Settings2 className="w-3.5 h-3.5" />
            Geral
          </span>
        </button>
      </div>

      {/* ============================================================ */}
      {/*  TAB: API Keys                                                */}
      {/* ============================================================ */}
      {activeTab === "keys" && (
        <div className="space-y-6">
          {API_KEY_GROUPS.map((group, gi) => (
            <motion.div
              key={group.title}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: gi * 0.06 }}
              className="rounded-xl border border-border bg-card"
            >
              <div className="flex items-center gap-3 px-6 py-4 border-b border-border">
                <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-ghost-surface-2">
                  <group.icon className="w-4 h-4 text-muted-foreground" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-foreground">{group.title}</h2>
                  <p className="text-xs text-muted-foreground">{group.description}</p>
                </div>
              </div>
              <div className="p-6 space-y-4">
                {group.keys.map((field) => (
                  <div key={field.key} className="space-y-1.5">
                    <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {field.label}
                    </Label>
                    <div className="relative">
                      <Input
                        type={field.sensitive && !showSensitive[field.key] ? "password" : "text"}
                        value={settings[field.key] || ""}
                        onChange={(e) => updateSetting(field.key, e.target.value)}
                        placeholder={field.placeholder}
                        className="bg-ghost-surface-2 border-border font-mono text-xs pr-10"
                      />
                      {field.sensitive && (
                        <button
                          type="button"
                          onClick={() => toggleVisibility(field.key)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {showSensitive[field.key] ? (
                            <EyeOff className="w-3.5 h-3.5" />
                          ) : (
                            <Eye className="w-3.5 h-3.5" />
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          ))}
        </div>
      )}

      {/* ============================================================ */}
      {/*  TAB: SMS Configuration                                       */}
      {/* ============================================================ */}
      {activeTab === "sms" && (
        <div className="space-y-6">
          {/* Info Banner */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4"
          >
            <div className="flex items-start gap-3">
              <Zap className="w-4 h-4 text-blue-400 mt-0.5 shrink-0" />
              <div className="text-xs text-blue-300/80 space-y-1">
                <p className="font-medium text-blue-300">Configuração dinâmica</p>
                <p>
                  Todas as alterações são aplicadas em tempo real. Para trocar de faixa de preço
                  (ex: Gold $0.01 → Gold $0.007), basta alterar o "Preço Máximo" e os "Provider IDs".
                  Nenhum código precisa ser alterado.
                </p>
              </div>
            </div>
          </motion.div>

          {/* Multi-Country Configuration */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.06 }}
            className="rounded-xl border border-border bg-card"
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-ghost-surface-2">
                  <Globe className="w-4 h-4 text-muted-foreground" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-foreground">Países de SMS</h2>
                  <p className="text-xs text-muted-foreground">
                    Configure múltiplos países. O sistema tenta em ordem e rotaciona quando um falha.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {countriesModified && (
                  <Button
                    size="sm"
                    onClick={() => saveCountriesMutation.mutate({ countries: editingCountries })}
                    disabled={saveCountriesMutation.isPending}
                    className="gap-1.5 text-xs bg-green-600 hover:bg-green-700"
                  >
                    <Save className="w-3 h-3" />
                    {saveCountriesMutation.isPending ? "Salvando..." : "Salvar Países"}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setShowAddCountry(!showAddCountry)}
                  className="gap-1.5 text-xs"
                >
                  <span className="text-base leading-none">+</span>
                  Adicionar País
                </Button>
              </div>
            </div>

            <div className="p-4 space-y-3">
              {/* Add Country Form */}
              {showAddCountry && (
                <div className="rounded-lg border border-border/50 bg-ghost-surface-2 p-4 space-y-3">
                  <p className="text-xs font-medium text-foreground">Adicionar novo país</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs text-muted-foreground mb-1 block">Código SMSBower</Label>
                      <div className="flex gap-2">
                        <select
                          value={newCountryCode}
                          onChange={(e) => setNewCountryCode(e.target.value)}
                          className="flex-1 h-8 rounded-md border border-border bg-ghost-surface-2 px-2 text-xs text-foreground"
                        >
                          <option value="">Selecionar país...</option>
                          {countriesData?.knownCountries && Object.entries(countriesData.knownCountries).map(([code, info]: [string, any]) => (
                            <option key={code} value={code}>{info.name} ({info.regionCode}) — código {code}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground mb-1 block">Preço Máximo ($)</Label>
                      <Input
                        type="text"
                        value={newCountryMaxPrice}
                        onChange={(e) => setNewCountryMaxPrice(e.target.value)}
                        placeholder="0.012"
                        className="h-8 bg-ghost-surface-2 border-border font-mono text-xs"
                      />
                    </div>
                  </div>
                  <div className="flex gap-2 justify-end">
                    <Button size="sm" variant="outline" onClick={() => setShowAddCountry(false)} className="text-xs">
                      Cancelar
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        if (!newCountryCode) return;
                        const known = countriesData?.knownCountries?.[newCountryCode] as any;
                        if (!known) return;
                        const already = editingCountries.find(c => c.countryCode === newCountryCode);
                        if (already) {
                          toast.warning("País já adicionado");
                          return;
                        }
                        setEditingCountries(prev => [...prev, {
                          countryCode: newCountryCode,
                          regionCode: known.regionCode,
                          name: known.name,
                          maxPrice: newCountryMaxPrice,
                          providerIds: [],
                          enabled: true,
                        }]);
                        setCountriesModified(true);
                        setShowAddCountry(false);
                        setNewCountryCode("");
                        setNewCountryMaxPrice("0.01");
                      }}
                      className="text-xs"
                    >
                      Adicionar
                    </Button>
                  </div>
                </div>
              )}

              {/* Country List */}
              {editingCountries.length === 0 ? (
                <div className="text-center py-6">
                  <p className="text-xs text-muted-foreground/60">
                    Nenhum país configurado. Clique em "Adicionar País" para começar.
                  </p>
                  <p className="text-xs text-muted-foreground/40 mt-1">
                    Enquanto não houver países configurados, o sistema usa as configurações legadas abaixo.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {editingCountries.map((country, idx) => (
                    <div
                      key={country.countryCode}
                      className={`rounded-lg border p-3 ${
                        country.enabled
                          ? "border-border/50 bg-ghost-surface-2"
                          : "border-border/20 bg-ghost-surface-2/30 opacity-60"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                          {/* Order badge */}
                          <span className="flex items-center justify-center w-5 h-5 rounded-full bg-border/50 text-[10px] font-mono font-bold text-muted-foreground shrink-0">
                            {idx + 1}
                          </span>
                          {/* Enable toggle */}
                          <Switch
                            checked={country.enabled}
                            onCheckedChange={(checked) => {
                              setEditingCountries(prev => prev.map((c, i) =>
                                i === idx ? { ...c, enabled: checked } : c
                              ));
                              setCountriesModified(true);
                            }}
                          />
                          {/* Country info */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-semibold text-foreground">{country.name}</span>
                              <span className="text-[10px] font-mono text-muted-foreground">{country.regionCode}</span>
                              <span className="text-[10px] font-mono text-green-400">${country.maxPrice}</span>
                              {country.providerIds.length > 0 && (
                                <span className="text-[10px] text-muted-foreground/60">
                                  {country.providerIds.length} provedor(es)
                                </span>
                              )}
                            </div>
                            {country.providerIds.length > 0 && (
                              <p className="text-[10px] font-mono text-muted-foreground/50 truncate mt-0.5">
                                [{country.providerIds.join(", ")}]
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {/* Max price edit */}
                          <Input
                            type="text"
                            value={country.maxPrice}
                            onChange={(e) => {
                              setEditingCountries(prev => prev.map((c, i) =>
                                i === idx ? { ...c, maxPrice: e.target.value } : c
                              ));
                              setCountriesModified(true);
                            }}
                            className="w-20 h-7 bg-ghost-surface-2 border-border font-mono text-xs text-center"
                            placeholder="0.01"
                          />
                          {/* Discover button */}
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => discoverForCountryMutation.mutate({
                              countryCode: country.countryCode,
                              maxPrice: country.maxPrice,
                            })}
                            disabled={discoverForCountryMutation.isPending}
                            className="h-7 px-2 text-[10px] gap-1"
                          >
                            <RefreshCw className={`w-3 h-3 ${
                              discoverForCountryMutation.isPending &&
                              (discoverForCountryMutation.variables as any)?.countryCode === country.countryCode
                                ? "animate-spin" : ""
                            }`} />
                            Buscar
                          </Button>
                          {/* Move up/down */}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              if (idx === 0) return;
                              const next = [...editingCountries];
                              [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
                              setEditingCountries(next);
                              setCountriesModified(true);
                            }}
                            disabled={idx === 0}
                            className="h-7 w-7 p-0 text-muted-foreground"
                          >
                            ↑
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              if (idx === editingCountries.length - 1) return;
                              const next = [...editingCountries];
                              [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
                              setEditingCountries(next);
                              setCountriesModified(true);
                            }}
                            disabled={idx === editingCountries.length - 1}
                            className="h-7 w-7 p-0 text-muted-foreground"
                          >
                            ↓
                          </Button>
                          {/* Remove */}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setEditingCountries(prev => prev.filter((_, i) => i !== idx));
                              setCountriesModified(true);
                            }}
                            className="h-7 w-7 p-0 text-red-400 hover:text-red-300 hover:bg-red-500/10"
                          >
                            <XCircle className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </motion.div>

          {/* Número & Serviço */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.12 }}
            className="rounded-xl border border-border bg-card"
          >
            <div className="flex items-center gap-3 px-6 py-4 border-b border-border">
              <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-ghost-surface-2">
                <Hash className="w-4 h-4 text-muted-foreground" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-foreground">Número & Serviço (Legado)</h2>
                <p className="text-xs text-muted-foreground">Usado quando nenhum país está configurado acima</p>
              </div>
            </div>
            <div className="p-6 space-y-4">
              {SMS_FIELDS.filter((f) =>
                ["sms_country", "sms_service", "sms_max_price", "sms_provider_ids"].includes(f.key)
              ).map((field) => (
                <FieldWithHelp key={field.key} label={field.label} description={field.description}>
                  <div className="relative">
                    <Input
                      type="text"
                      value={settings[field.key] || ""}
                      onChange={(e) => updateSetting(field.key, e.target.value)}
                      placeholder={field.placeholder}
                      className="bg-ghost-surface-2 border-border font-mono text-xs"
                    />
                    {field.suffix && (
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/50 font-mono uppercase">
                        {field.suffix}
                      </span>
                    )}
                  </div>
                </FieldWithHelp>
              ))}
            </div>
          </motion.div>

          {/* Retry & Timing */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.12 }}
            className="rounded-xl border border-border bg-card"
          >
            <div className="flex items-center gap-3 px-6 py-4 border-b border-border">
              <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-ghost-surface-2">
                <RotateCcw className="w-4 h-4 text-muted-foreground" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-foreground">Retry & Timing</h2>
                <p className="text-xs text-muted-foreground">Controle de tentativas, timeouts e delays de humanização</p>
              </div>
            </div>
            <div className="p-6 space-y-4">
              {SMS_FIELDS.filter((f) =>
                ["sms_max_retries", "sms_wait_time", "sms_poll_interval", "sms_cancel_wait", "sms_retry_delay_min", "sms_retry_delay_max"].includes(f.key)
              ).map((field) => (
                <FieldWithHelp key={field.key} label={field.label} description={field.description}>
                  <div className="relative">
                    <Input
                      type="number"
                      value={settings[field.key] || ""}
                      onChange={(e) => updateSetting(field.key, e.target.value)}
                      placeholder={field.placeholder}
                      className="bg-ghost-surface-2 border-border font-mono text-xs"
                    />
                    {field.suffix && (
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/50 font-mono uppercase">
                        {field.suffix}
                      </span>
                    )}
                  </div>
                </FieldWithHelp>
              ))}
            </div>
          </motion.div>

          {/* Auto-Discover */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.18 }}
            className="rounded-xl border border-border bg-card"
          >
            <div className="flex items-center gap-3 px-6 py-4 border-b border-border">
              <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-ghost-surface-2">
                <Search className="w-4 h-4 text-muted-foreground" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-foreground">Auto-Discover</h2>
                <p className="text-xs text-muted-foreground">Descoberta automática de provedores mais baratos</p>
              </div>
            </div>
            <div className="p-6">
              <FieldWithHelp
                label="Auto-Descobrir Provedores"
                description="Se ativo, busca automaticamente os providerIds mais baratos via getPricesV3 antes de cada aluguel. Ignora os Provider IDs manuais quando ativo."
              >
                <div className="flex items-center gap-3 mt-2">
                  <Switch
                    checked={settings["sms_auto_discover"] === "true"}
                    onCheckedChange={(checked) =>
                      updateSetting("sms_auto_discover", checked ? "true" : "false")
                    }
                  />
                  <span className="text-xs text-muted-foreground">
                    {settings["sms_auto_discover"] === "true" ? (
                      <span className="text-green-400">Ativo — provedores serão descobertos automaticamente</span>
                    ) : (
                      <span>Inativo — usando Provider IDs manuais</span>
                    )}
                  </span>
                </div>
              </FieldWithHelp>
            </div>
          </motion.div>

          {/* Provider Discovery */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.24 }}
            className="rounded-xl border border-border bg-card"
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-ghost-surface-2">
                  <Search className="w-4 h-4 text-muted-foreground" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-foreground">Descoberta de Provedores</h2>
                  <p className="text-xs text-muted-foreground">Busca provedores disponíveis via API e atualiza a lista manual</p>
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => discoverMutation.mutate()}
                disabled={discoverMutation.isPending}
                className="gap-1.5 text-xs"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${discoverMutation.isPending ? "animate-spin" : ""}`} />
                {discoverMutation.isPending ? "Buscando..." : "Descobrir Provedores Agora"}
              </Button>
            </div>
            <div className="p-4">
              <p className="text-xs text-muted-foreground">
                Clique para buscar os melhores provedores disponíveis dentro do preço máximo configurado.
                A lista de Provider IDs será atualizada automaticamente. Provedores na blacklist são excluídos.
              </p>
            </div>
          </motion.div>

          {/* Provider Health Panel */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.30 }}
            className="rounded-xl border border-border bg-card"
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-ghost-surface-2">
                  <Activity className="w-4 h-4 text-muted-foreground" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-foreground">Saúde dos Provedores</h2>
                  <p className="text-xs text-muted-foreground">
                    Score, taxa de sucesso, cooldowns e rejeições. Persiste entre restarts.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { refetchHealth(); refetchBlacklist(); }}
                  className="gap-1.5 text-xs"
                >
                  <RefreshCw className="w-3 h-3" />
                  Atualizar
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => resetHealthMutation.mutate()}
                  disabled={resetHealthMutation.isPending}
                  className="gap-1.5 text-xs text-amber-400 border-amber-500/30 hover:bg-amber-500/10"
                >
                  <RotateCcw className="w-3 h-3" />
                  Resetar Health
                </Button>
                {(blacklistData?.blacklist?.length ?? 0) > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => clearBlacklistMutation.mutate()}
                    disabled={clearBlacklistMutation.isPending}
                    className="gap-1.5 text-xs text-red-400 border-red-500/30 hover:bg-red-500/10"
                  >
                    <Trash2 className="w-3 h-3" />
                    Limpar Blacklist ({blacklistData?.blacklist?.length})
                  </Button>
                )}
              </div>
            </div>
            <div className="p-4">
              {/* Blacklist Banner */}
              {(blacklistData?.blacklist?.length ?? 0) > 0 && (
                <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
                  <Ban className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
                  <div className="text-xs text-red-300/80">
                    <span className="font-medium text-red-300">Blacklist ativa: </span>
                    {blacklistData?.blacklist?.length} provedor(es) banido(s) permanentemente por performance ruim: [{blacklistData?.blacklist?.join(", ")}]
                  </div>
                </div>
              )}

              {/* Health Table */}
              {healthData && healthData.length > 0 ? (
                <div className="overflow-hidden rounded-lg border border-border/50">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-ghost-surface-2">
                        <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Provedor</th>
                        <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Score</th>
                        <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Sucesso</th>
                        <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Falhas</th>
                        <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Rejeitados (alvo)</th>
                        <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Tempo Médio</th>
                        <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/30">
                      {healthData.map((h: any) => {
                        const isBlacklisted = blacklistData?.blacklist?.includes(h.providerId);
                        const inCooldown = h.inCooldown && !isBlacklisted;
                        return (
                          <tr key={h.providerId} className={isBlacklisted ? "opacity-50" : ""}>
                            <td className="px-3 py-2 font-mono font-medium">#{h.providerId}</td>
                            <td className="px-3 py-2">
                              <span className={`font-mono font-semibold ${
                                h.score >= 70 ? "text-green-400" :
                                h.score >= 40 ? "text-yellow-400" : "text-red-400"
                              }`}>{h.score}</span>
                            </td>
                            <td className="px-3 py-2 text-green-400 font-mono">{h.successRate}</td>
                            <td className="px-3 py-2">
                              <span className={h.consecutiveFailures >= 5 ? "text-red-400 font-semibold" : "text-muted-foreground"}>
                                {h.failures} ({h.consecutiveFailures} consec.)
                              </span>
                            </td>
                            <td className="px-3 py-2">
                              <span className={h.consecutiveTargetRejections >= 3 ? "text-amber-400 font-semibold" : "text-muted-foreground"}>
                                {h.targetRejections} ({h.consecutiveTargetRejections} consec.)
                              </span>
                            </td>
                            <td className="px-3 py-2 font-mono text-muted-foreground">
                              {h.avgResponseMs ? `${Math.round(h.avgResponseMs / 1000)}s` : "—"}
                            </td>
                            <td className="px-3 py-2">
                              {isBlacklisted ? (
                                <span className="flex items-center gap-1 text-red-400">
                                  <Ban className="w-3 h-3" /> Banido
                                </span>
                              ) : inCooldown ? (
                                <span className="flex items-center gap-1 text-amber-400">
                                  <AlertTriangle className="w-3 h-3" /> Cooldown {h.cooldownRemainingS}s
                                </span>
                              ) : (
                                <span className="flex items-center gap-1 text-green-400">
                                  <CheckCircle className="w-3 h-3" /> Ativo
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground/60 text-center py-6">
                  Nenhum dado de saúde ainda. Os provedores aparecerão aqui após as primeiras tentativas de SMS.
                </p>
              )}
            </div>
          </motion.div>

          {/* ============================================================ */}
          {/*  v9.7: SMSPool — Segunda API de SMS                           */}
          {/* ============================================================ */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.33 }}
            className="rounded-xl border border-border bg-card"
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-purple-500/10">
                  <Zap className="w-4 h-4 text-purple-400" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-foreground">SMSPool <span className="text-[10px] font-normal text-purple-400 ml-1">2ª API</span></h2>
                  <p className="text-xs text-muted-foreground">
                    Segunda API de SMS — soma à pool do SMSBower, não substitui
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {smsPoolBalanceData?.success && (
                  <span className="text-xs font-mono text-green-400">
                    Saldo: ${smsPoolBalanceData.balance.toFixed(2)}
                  </span>
                )}
                {smsPoolModified && (
                  <Button
                    size="sm"
                    onClick={() => updateSmsPoolMutation.mutate(smsPoolForm)}
                    disabled={updateSmsPoolMutation.isPending}
                    className="gap-1.5 text-xs bg-purple-600 hover:bg-purple-700"
                  >
                    <Save className="w-3 h-3" />
                    {updateSmsPoolMutation.isPending ? "Salvando..." : "Salvar SMSPool"}
                  </Button>
                )}
              </div>
            </div>

            <div className="p-6 space-y-4">
              {/* Enable/Disable Toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Status
                  </Label>
                  <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                    Habilita ou desabilita o SMSPool como segunda fonte de números SMS
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Switch
                    checked={smsPoolForm.enabled ?? false}
                    onCheckedChange={(checked) => {
                      setSmsPoolForm(prev => ({ ...prev, enabled: checked }));
                      setSmsPoolModified(true);
                    }}
                  />
                  <span className="text-xs">
                    {smsPoolForm.enabled ? (
                      <span className="text-green-400">Ativo</span>
                    ) : (
                      <span className="text-muted-foreground">Desativado</span>
                    )}
                  </span>
                </div>
              </div>

              <Separator className="border-border/30" />

              {/* API Key */}
              <FieldWithHelp
                label="API Key"
                description="Chave de API do SMSPool (smspool.net). Obtenha em: https://www.smspool.net/my/settings"
              >
                <div className="relative">
                  <Input
                    type={showSmsPoolApiKey ? "text" : "password"}
                    value={smsPoolForm.apiKey || ""}
                    onChange={(e) => {
                      setSmsPoolForm(prev => ({ ...prev, apiKey: e.target.value }));
                      setSmsPoolModified(true);
                    }}
                    placeholder="API key do SMSPool"
                    className="bg-ghost-surface-2 border-border font-mono text-xs pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSmsPoolApiKey(!showSmsPoolApiKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-ghost-surface-2 transition-colors"
                  >
                    {showSmsPoolApiKey ? (
                      <EyeOff className="w-3.5 h-3.5 text-muted-foreground" />
                    ) : (
                      <Eye className="w-3.5 h-3.5 text-muted-foreground" />
                    )}
                  </button>
                </div>
              </FieldWithHelp>

              {/* Priority */}
              <FieldWithHelp
                label="Prioridade"
                description="Primary: tenta SMSPool ANTES do SMSBower. Secondary: tenta SMSPool DEPOIS, como fallback quando o SMSBower falha."
              >
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setSmsPoolForm(prev => ({ ...prev, priority: "secondary" }));
                      setSmsPoolModified(true);
                    }}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                      smsPoolForm.priority === "secondary"
                        ? "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                        : "bg-ghost-surface-2 text-muted-foreground border border-border hover:text-foreground"
                    }`}
                  >
                    Secondary (Fallback)
                  </button>
                  <button
                    onClick={() => {
                      setSmsPoolForm(prev => ({ ...prev, priority: "primary" }));
                      setSmsPoolModified(true);
                    }}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                      smsPoolForm.priority === "primary"
                        ? "bg-purple-500/20 text-purple-400 border border-purple-500/30"
                        : "bg-ghost-surface-2 text-muted-foreground border border-border hover:text-foreground"
                    }`}
                  >
                    Primary (Tenta Primeiro)
                  </button>
                </div>
              </FieldWithHelp>

              {/* Max Price */}
              <FieldWithHelp
                label="Preço Máximo"
                description="Preço máximo por número SMS no SMSPool (em USD). Valores típicos: $0.10 a $1.00"
              >
                <div className="relative">
                  <Input
                    type="text"
                    value={smsPoolForm.maxPrice || ""}
                    onChange={(e) => {
                      setSmsPoolForm(prev => ({ ...prev, maxPrice: e.target.value }));
                      setSmsPoolModified(true);
                    }}
                    placeholder="0.50"
                    className="bg-ghost-surface-2 border-border font-mono text-xs"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/50 font-mono uppercase">
                    USD
                  </span>
                </div>
              </FieldWithHelp>

              {/* Service ID */}
              <FieldWithHelp
                label="Service ID"
                description="ID do serviço no SMSPool. Deixe vazio para mapeamento automático a partir do serviço SMSBower. Ex: 1=Other, 2=WhatsApp, 9=Google"
              >
                <Input
                  type="text"
                  value={smsPoolForm.serviceId || ""}
                  onChange={(e) => {
                    setSmsPoolForm(prev => ({ ...prev, serviceId: e.target.value }));
                    setSmsPoolModified(true);
                  }}
                  placeholder="Vazio = auto"
                  className="bg-ghost-surface-2 border-border font-mono text-xs"
                />
              </FieldWithHelp>

              {/* Country ID */}
              <FieldWithHelp
                label="Country ID"
                description="ID do país no SMSPool. Deixe vazio para mapeamento automático a partir do país SMSBower. Ex: 1=USA, 5=Indonesia, 36=Brazil"
              >
                <Input
                  type="text"
                  value={smsPoolForm.countryId || ""}
                  onChange={(e) => {
                    setSmsPoolForm(prev => ({ ...prev, countryId: e.target.value }));
                    setSmsPoolModified(true);
                  }}
                  placeholder="Vazio = auto"
                  className="bg-ghost-surface-2 border-border font-mono text-xs"
                />
              </FieldWithHelp>

              {/* Pool */}
              <FieldWithHelp
                label="Pool Preferida"
                description="ID da pool preferida no SMSPool. Deixe vazio para seleção automática. Ex: 1=Foxtrot"
              >
                <Input
                  type="text"
                  value={smsPoolForm.pool || ""}
                  onChange={(e) => {
                    setSmsPoolForm(prev => ({ ...prev, pool: e.target.value }));
                    setSmsPoolModified(true);
                  }}
                  placeholder="Vazio = auto"
                  className="bg-ghost-surface-2 border-border font-mono text-xs"
                />
              </FieldWithHelp>

              {/* Info Banner */}
              <div className="flex items-start gap-2 rounded-lg border border-purple-500/20 bg-purple-500/5 px-4 py-3 mt-2">
                <Info className="w-4 h-4 text-purple-400 mt-0.5 shrink-0" />
                <div className="text-xs text-purple-300/80 space-y-1">
                  <p className="font-medium text-purple-300">Como funciona</p>
                  <p>
                    O SMSPool é uma <strong>segunda fonte de números SMS</strong> que soma ao SMSBower.
                    No modo <strong>Secondary</strong> (recomendado), ele só é usado quando todos os países/provedores
                    do SMSBower falharem. No modo <strong>Primary</strong>, ele é tentado primeiro.
                    Desative a qualquer momento sem afetar o SMSBower.
                  </p>
                </div>
              </div>
            </div>
          </motion.div>

          {/* Quick Reference */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.36 }}
            className="rounded-xl border border-border/50 bg-card/50 p-5"
          >
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              Referência Rápida — Faixas de Preço (Indonesia, serviço "ot")
            </h3>
            <div className="overflow-hidden rounded-lg border border-border/50">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-ghost-surface-2">
                    <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Rank</th>
                    <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Custo</th>
                    <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Qtd. Aprox.</th>
                    <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Observação</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  <tr>
                    <td className="px-3 py-2"><span className="text-yellow-400 font-medium">Gold</span></td>
                    <td className="px-3 py-2 font-mono text-green-400">$0.007</td>
                    <td className="px-3 py-2 text-muted-foreground">~100</td>
                    <td className="px-3 py-2 text-muted-foreground">Mais barato, menos estoque</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2"><span className="text-yellow-400 font-medium">Gold</span></td>
                    <td className="px-3 py-2 font-mono text-green-400">$0.01</td>
                    <td className="px-3 py-2 text-muted-foreground">~6.400</td>
                    <td className="px-3 py-2 text-muted-foreground">Melhor custo-benefício (recomendado)</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2"><span className="text-yellow-400 font-medium">Gold</span></td>
                    <td className="px-3 py-2 font-mono">$0.02</td>
                    <td className="px-3 py-2 text-muted-foreground">~5.300</td>
                    <td className="px-3 py-2 text-muted-foreground">Bom estoque</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2"><span className="text-amber-600 font-medium">Bronze</span></td>
                    <td className="px-3 py-2 font-mono">$0.21</td>
                    <td className="px-3 py-2 text-muted-foreground">~13.000</td>
                    <td className="px-3 py-2 text-muted-foreground">Maior estoque, mais caro</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-[10px] text-muted-foreground/50 mt-2">
              Valores aproximados e sujeitos a variação. Use "Auto-Discover" para buscar preços atualizados automaticamente.
            </p>
          </motion.div>
        </div>
      )}

      {/* ============================================================ */}
      {/*  TAB: General Settings                                        */}
      {/* ============================================================ */}
      {activeTab === "general" && (
        <div className="space-y-6">
          {/* Invitation Code */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-xl border border-border bg-card"
          >
            <div className="flex items-center gap-3 px-6 py-4 border-b border-border">
              <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-ghost-surface-2">
                <Gift className="w-4 h-4 text-muted-foreground" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-foreground">Código de Convite</h2>
                <p className="text-xs text-muted-foreground">
                  Código de convite aplicado automaticamente após criação de cada conta (+500 créditos)
                </p>
              </div>
            </div>
            <div className="p-6 space-y-4">
              <FieldWithHelp
                label="Invitation Code"
                description="Se preenchido, cada conta criada irá automaticamente aceitar este código de convite após o registro. Isso dá +500 créditos para a conta nova e para o dono do código. Deixe vazio para desativar."
              >
                <Input
                  type="text"
                  value={settings["invite_code"] || ""}
                  onChange={(e) => {
                    const raw = e.target.value;
                    // Auto-extract code from invitation links
                    const pathMatch = raw.match(/\/invitation\/([A-Za-z0-9]+)/);
                    const queryMatch = raw.match(/[?&]code=([A-Za-z0-9]+)/);
                    const code = pathMatch ? pathMatch[1] : queryMatch ? queryMatch[1] : raw;
                    updateSetting("invite_code", code.toUpperCase());
                  }}
                  placeholder="Ex: ONEOBGLAEXNB ou cole o link de convite"
                  className="bg-ghost-surface-2 border-border font-mono text-xs uppercase tracking-wider"
                />
                <p className="text-[10px] text-muted-foreground/60 mt-1">
                  {settings["invite_code"]
                    ? `Link: https://manus.im/invitation?code=${settings["invite_code"]}&newUser=1`
                    : "Nenhum código configurado — etapa de convite será ignorada"}
                </p>
              </FieldWithHelp>
            </div>
          </motion.div>

          {/* Proxy Auto-Replace */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.06 }}
            className="rounded-xl border border-border bg-card"
          >
            <div className="flex items-center gap-3 px-6 py-4 border-b border-border">
              <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-ghost-surface-2">
                <Shuffle className="w-4 h-4 text-muted-foreground" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-foreground">Rotação Automática de Proxies</h2>
                <p className="text-xs text-muted-foreground">
                  Substitui todos os proxies via Webshare quando o pool atual for esgotado
                </p>
              </div>
            </div>
            <div className="p-6">
              <FieldWithHelp
                label="Auto-Replace Proxies"
                description="Quando ativo, após todos os proxies do pool serem usados pelo menos uma vez, o sistema automaticamente chama a API de replacement do Webshare para obter novos IPs. Isso garante que cada conta use um IP único."
              >
                <div className="flex items-center gap-3 mt-2">
                  <Switch
                    checked={settings["proxy_auto_replace"] === "true"}
                    onCheckedChange={(checked) =>
                      updateSetting("proxy_auto_replace", checked ? "true" : "false")
                    }
                  />
                  <span className="text-xs text-muted-foreground">
                    {settings["proxy_auto_replace"] === "true" ? (
                      <span className="text-green-400">Ativo — proxies serão substituídos automaticamente</span>
                    ) : (
                      <span>Inativo — proxies serão reutilizados quando esgotados</span>
                    )}
                  </span>
                </div>
              </FieldWithHelp>
            </div>
          </motion.div>

          {/* Proxy Blocked Countries */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.12 }}
            className="rounded-xl border border-border bg-card"
          >
            <div className="flex items-center gap-3 px-6 py-4 border-b border-border">
              <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-ghost-surface-2">
                <Ban className="w-4 h-4 text-muted-foreground" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-foreground">Países Bloqueados (Proxy)</h2>
                <p className="text-xs text-muted-foreground">
                  Proxies desses países serão automaticamente pulados
                </p>
              </div>
            </div>
            <div className="p-6 space-y-4">
              <FieldWithHelp
                label="Países Bloqueados"
                description="Lista de códigos de país (ex: ID,BR,US) cujos proxies serão ignorados. Use códigos de país ISO 2 letras. Separe múltiplos países por vírgula. Deixe vazio para desativar."
              >
                <Input
                  type="text"
                  value={settings["proxy_blocked_countries"] || ""}
                  onChange={(e) => updateSetting("proxy_blocked_countries", e.target.value.toUpperCase())}
                  placeholder="Ex: ID,BR,US,CN"
                  className="bg-ghost-surface-2 border-border font-mono text-xs uppercase tracking-wider"
                />
                <p className="text-[10px] text-muted-foreground/60 mt-1">
                  {settings["proxy_blocked_countries"]
                    ? `Bloqueado: ${settings["proxy_blocked_countries"]}`
                    : "Nenhum país bloqueado — todos os proxies serão usados"}
                </p>
              </FieldWithHelp>
            </div>
          </motion.div>

          {/* FPJS Pro Status */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.12 }}
            className="rounded-xl border border-border bg-card"
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-ghost-surface-2">
                  <Shield className="w-4 h-4 text-muted-foreground" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-foreground">FingerprintJS Pro</h2>
                  <p className="text-xs text-muted-foreground">
                    Pool de requestIds reais para o DCR — evita bans por ID sintético
                  </p>
                </div>
              </div>

            </div>
            <div className="p-6 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Status do serviço</span>
                {fpjsStatus?.available ? (
                  <span className="flex items-center gap-1.5 text-xs text-green-400">
                    <CheckCircle className="w-3.5 h-3.5" />
                    Ativo (Chromium encontrado)
                  </span>
                ) : fpjsStatus === undefined ? (
                  <span className="text-xs text-muted-foreground/60">Carregando...</span>
                ) : (
                  <span className="flex items-center gap-1.5 text-xs text-amber-400">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    Inativo — usando IDs sintéticos (fallback)
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Modo de geração</span>
                <span className="text-xs font-mono text-blue-400 font-semibold">
                  Sob demanda (sem pool)
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Concorrência máxima</span>
                <span className="text-xs font-mono text-muted-foreground">
                  3 gerações simultâneas
                </span>
              </div>
              {!fpjsStatus?.available && fpjsStatus !== undefined && (
                <p className="text-[10px] text-amber-300/60 mt-2">
                  Chromium não encontrado no servidor. Para ativar, o Docker precisa ter o
                  pacote <code className="font-mono">chromium</code> instalado. O Dockerfile já foi
                  atualizado — faça um novo deploy para ativar.
                </p>
              )}
            </div>
          </motion.div>

          {/* Info Banner */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.18 }}
            className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4"
          >
            <div className="flex items-start gap-3">
              <Info className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
              <div className="text-xs text-amber-300/80 space-y-1">
                <p className="font-medium text-amber-300">Sobre a rotação de proxies</p>
                <p>
                  O Webshare permite substituir proxies a cada 30 minutos. Se o pool de 20 proxies
                  for esgotado antes disso, o sistema aguardará automaticamente até a substituição
                  ser concluída. Cada conta criada usará um IP diferente para máxima segurança.
                </p>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
}
