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
  Gift, Shuffle, Settings2,
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
      { key: "email_domain", label: "Domínio do Email", sensitive: false, placeholder: "seudominio.com" },
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
  const [activeTab, setActiveTab] = useState<"keys" | "sms" | "general">("keys");

  const { data: allSettings, isLoading: loading, refetch: loadSettings } = trpc.settings.getAll.useQuery();

  // Sync settings when data loads
  useEffect(() => {
    if (allSettings) {
      setSettings(allSettings);
    }
  }, [allSettings]);

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
    "webshare_api_key",
    "zoho_client_id",
    "zoho_client_secret",
    "zoho_refresh_token",
    "admin_password_hash",
  ]);

  const saveSettings = async () => {
    setSaving(true);
    try {
      const entries = Object.entries(settings)
        .filter(([_, v]) => v !== undefined && v !== null)
        // PROTEÇÃO: nunca enviar valores mascarados (****xxxx) — eles não foram editados
        .filter(([key, value]) => !(SENSITIVE_KEYS.has(key) && value.startsWith("****")))
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

          {/* Número & Serviço */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.06 }}
            className="rounded-xl border border-border bg-card"
          >
            <div className="flex items-center gap-3 px-6 py-4 border-b border-border">
              <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-ghost-surface-2">
                <Hash className="w-4 h-4 text-muted-foreground" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-foreground">Número & Serviço</h2>
                <p className="text-xs text-muted-foreground">País, serviço e faixa de preço dos números SMS</p>
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

          {/* Quick Reference */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.24 }}
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
                  onChange={(e) => updateSetting("invite_code", e.target.value.toUpperCase())}
                  placeholder="Ex: ONEOBGLAEXNB"
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

          {/* Info Banner */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.12 }}
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
