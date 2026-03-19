/**
 * ApiDocs - Documentação da API REST do Ghost Panel
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { BookOpen, Copy, ChevronDown, ChevronRight, Terminal, Zap, Key, Globe, Shield, Info } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

const BASE_URL = window.location.origin;

interface Endpoint {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  description: string;
  auth: boolean;
  body?: Record<string, unknown>;
  response?: Record<string, unknown>;
  example?: string;
}

interface Section {
  title: string;
  icon: React.ElementType;
  color: string;
  endpoints: Endpoint[];
}

const SECTIONS: Section[] = [
  {
    title: "Autenticação",
    icon: Key,
    color: "text-yellow-400",
    endpoints: [
      {
        method: "POST",
        path: "/api/auth/login",
        description: "Autenticar com senha e obter cookie de sessão (uso via navegador)",
        auth: false,
        body: { password: "sua_senha" },
        response: { success: true },
      },
      {
        method: "GET",
        path: "/api/auth/status",
        description: "Verificar se a sessão está autenticada",
        auth: false,
        response: { authenticated: true },
      },
      {
        method: "POST",
        path: "/api/auth/logout",
        description: "Encerrar sessão atual",
        auth: true,
        response: { success: true },
      },
    ],
  },
  {
    title: "API Tokens",
    icon: Shield,
    color: "text-emerald-400",
    endpoints: [
      {
        method: "POST",
        path: "/api/trpc/apiTokens.generate",
        description: "Gerar um novo API Token para acesso programático",
        auth: true,
        body: { json: { name: "Meu Bot", permissions: "full", expiresInDays: 90 } },
        response: { result: { data: { json: { token: "gp_abc123...", prefix: "gp_abc123...", warning: "Copie agora" } } } },
        example: `curl -X POST ${BASE_URL}/api/trpc/apiTokens.generate \\
  -H "Authorization: Bearer gp_SEU_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"json":{"name":"Novo Token","permissions":"full","expiresInDays":90}}'`,
      },
      {
        method: "GET",
        path: "/api/trpc/apiTokens.list",
        description: "Listar todos os API Tokens (sem exibir o token raw)",
        auth: true,
        response: { result: { data: { json: [{ id: 1, name: "Meu Bot", tokenPrefix: "gp_abc1...", permissions: "full", revoked: false }] } } },
        example: `curl ${BASE_URL}/api/trpc/apiTokens.list \\
  -H "Authorization: Bearer gp_SEU_TOKEN"`,
      },
      {
        method: "POST",
        path: "/api/trpc/apiTokens.revoke",
        description: "Revogar um token (ele para de funcionar imediatamente)",
        auth: true,
        body: { json: { id: 1 } },
        response: { result: { data: { json: { success: true } } } },
      },
    ],
  },
  {
    title: "Jobs",
    icon: Zap,
    color: "text-blue-400",
    endpoints: [
      {
        method: "POST",
        path: "/api/trpc/jobs.create",
        description: "Criar um novo job de criação de contas",
        auth: true,
        body: {
          json: {
            provider: "manus",
            quantity: 5,
            inviteCode: "SEUCÓDIGO",
            label: "Meu job",
          },
        },
        response: { result: { data: { json: { jobId: 42 } } } },
        example: `curl -X POST ${BASE_URL}/api/trpc/jobs.create \\
  -H "Authorization: Bearer gp_SEU_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"json":{"provider":"manus","quantity":5,"inviteCode":"SEUCÓDIGO"}}'`,
      },
      {
        method: "POST",
        path: "/api/trpc/jobs.quickJob",
        description: "Criar múltiplos jobs de uma vez (Job Rápido)",
        auth: true,
        body: {
          json: {
            recipients: [
              { inviteCode: "CÓDIGO1", credits: 5000, label: "Usuário A" },
              { inviteCode: "CÓDIGO2", credits: 2500, label: "Usuário B" },
            ],
          },
        },
        response: { result: { data: { json: { jobIds: [43, 44], summary: "..." } } } },
        example: `curl -X POST ${BASE_URL}/api/trpc/jobs.quickJob \\
  -H "Authorization: Bearer gp_SEU_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"json":{"recipients":[{"inviteCode":"ABC123","credits":5000,"label":"Cliente 1"}]}}'`,
      },
      {
        method: "GET",
        path: "/api/trpc/jobs.list",
        description: "Listar todos os jobs",
        auth: true,
        response: { result: { data: { json: [{ id: 1, status: "completed", totalAccounts: 5 }] } } },
        example: `curl ${BASE_URL}/api/trpc/jobs.list \\
  -H "Authorization: Bearer gp_SEU_TOKEN"`,
      },
      {
        method: "GET",
        path: "/api/trpc/jobs.getById?input={\"json\":{\"id\":1}}",
        description: "Buscar detalhes de um job específico",
        auth: true,
        response: { result: { data: { json: { id: 1, status: "completed", accounts: [] } } } },
        example: `curl "${BASE_URL}/api/trpc/jobs.getById?input=%7B%22json%22%3A%7B%22id%22%3A1%7D%7D" \\
  -H "Authorization: Bearer gp_SEU_TOKEN"`,
      },
    ],
  },
  {
    title: "Keys",
    icon: Key,
    color: "text-purple-400",
    endpoints: [
      {
        method: "POST",
        path: "/api/trpc/keys.generate",
        description: "Gerar chaves de créditos",
        auth: true,
        body: { json: { credits: 5000, quantity: 3, label: "Promoção", expiresInDays: 30 } },
        response: { result: { data: { json: { codes: ["GHOST-XXXX-XXXX-XXXX"], count: 3 } } } },
        example: `curl -X POST ${BASE_URL}/api/trpc/keys.generate \\
  -H "Authorization: Bearer gp_SEU_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"json":{"credits":5000,"quantity":3,"label":"Promoção","expiresInDays":30}}'`,
      },
      {
        method: "GET",
        path: "/api/trpc/keys.check?input={\"json\":{\"code\":\"GHOST-XXXX-XXXX-XXXX\"}}",
        description: "Verificar se uma chave é válida (endpoint público)",
        auth: false,
        response: { result: { data: { json: { valid: true, credits: 5000 } } } },
        example: `curl "${BASE_URL}/api/trpc/keys.check?input=%7B%22json%22%3A%7B%22code%22%3A%22GHOST-XXXX-XXXX-XXXX%22%7D%7D"`,
      },
      {
        method: "POST",
        path: "/api/trpc/keys.redeem",
        description: "Resgatar uma chave (endpoint público)",
        auth: false,
        body: { json: { code: "GHOST-XXXX-XXXX-XXXX", inviteCode: "SEUCÓDIGO", name: "João" } },
        response: { result: { data: { json: { success: true, credits: 5000 } } } },
        example: `curl -X POST ${BASE_URL}/api/trpc/keys.redeem \\
  -H "Content-Type: application/json" \\
  -d '{"json":{"code":"GHOST-XXXX-XXXX-XXXX","inviteCode":"SEUCÓDIGO","name":"João"}}'`,
      },
    ],
  },
  {
    title: "Proxies",
    icon: Globe,
    color: "text-green-400",
    endpoints: [
      {
        method: "GET",
        path: "/api/trpc/proxies.list",
        description: "Listar todos os proxies",
        auth: true,
        response: { result: { data: { json: [{ id: 1, host: "1.2.3.4", port: 8080, enabled: true }] } } },
        example: `curl ${BASE_URL}/api/trpc/proxies.list \\
  -H "Authorization: Bearer gp_SEU_TOKEN"`,
      },
      {
        method: "POST",
        path: "/api/trpc/proxies.sync",
        description: "Sincronizar proxies da Webshare",
        auth: true,
        response: { result: { data: { json: { synced: 100 } } } },
        example: `curl -X POST ${BASE_URL}/api/trpc/proxies.sync \\
  -H "Authorization: Bearer gp_SEU_TOKEN"`,
      },
      {
        method: "POST",
        path: "/api/trpc/proxies.replaceAll",
        description: "Substituir todos os proxies via Webshare API",
        auth: true,
        response: { result: { data: { json: { replaced: 100 } } } },
        example: `curl -X POST ${BASE_URL}/api/trpc/proxies.replaceAll \\
  -H "Authorization: Bearer gp_SEU_TOKEN"`,
      },
    ],
  },
];

const METHOD_COLORS: Record<string, string> = {
  GET: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  POST: "bg-green-500/10 text-green-400 border-green-500/20",
  PUT: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  DELETE: "bg-red-500/10 text-red-400 border-red-500/20",
};

function EndpointCard({ endpoint }: { endpoint: Endpoint }) {
  const [open, setOpen] = useState(false);

  function copyExample() {
    const text = endpoint.example || `curl -X ${endpoint.method} ${BASE_URL}${endpoint.path}${endpoint.auth ? ' \\\n  -H "Authorization: Bearer gp_SEU_TOKEN"' : ""}${endpoint.body ? ` \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(endpoint.body)}'` : ""}`;
    navigator.clipboard.writeText(text);
    toast.success("Copiado!");
  }

  return (
    <div className="rounded-lg border border-border bg-ghost-surface-1 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-ghost-surface-2 transition-colors text-left"
      >
        <span className={cn(
          "inline-flex items-center px-2 py-0.5 rounded text-xs font-bold font-mono border shrink-0",
          METHOD_COLORS[endpoint.method]
        )}>
          {endpoint.method}
        </span>
        <code className="text-xs font-mono text-foreground flex-1 truncate">{endpoint.path}</code>
        {endpoint.auth && (
          <span className="text-xs text-muted-foreground shrink-0">🔒 Auth</span>
        )}
        {open ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 space-y-3 border-t border-border pt-3">
              <p className="text-sm text-muted-foreground">{endpoint.description}</p>

              {endpoint.body && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-1.5">Request Body</p>
                  <pre className="text-xs bg-background rounded-lg p-3 overflow-x-auto text-green-400 border border-border">
                    {JSON.stringify(endpoint.body, null, 2)}
                  </pre>
                </div>
              )}

              {endpoint.response && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-1.5">Response</p>
                  <pre className="text-xs bg-background rounded-lg p-3 overflow-x-auto text-blue-400 border border-border">
                    {JSON.stringify(endpoint.response, null, 2)}
                  </pre>
                </div>
              )}

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-xs font-semibold text-muted-foreground">Exemplo cURL</p>
                  <Button variant="ghost" size="sm" className="h-6 text-xs gap-1" onClick={copyExample}>
                    <Copy className="w-3 h-3" />
                    Copiar
                  </Button>
                </div>
                <pre className="text-xs bg-background rounded-lg p-3 overflow-x-auto text-yellow-400 border border-border whitespace-pre-wrap">
                  {endpoint.example || `curl -X ${endpoint.method} ${BASE_URL}${endpoint.path}${endpoint.auth ? ' \\\n  -H "Authorization: Bearer gp_SEU_TOKEN"' : ""}${endpoint.body ? ` \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(endpoint.body)}'` : ""}`}
                </pre>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function ApiDocs() {
  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
          <BookOpen className="w-6 h-6 text-primary" />
          API / Documentação
        </h1>
        <p className="text-muted-foreground mt-1">
          Referência completa da API REST do Ghost Panel
        </p>
      </div>

      {/* Base URL */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center gap-2 mb-2">
          <Terminal className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold">Base URL</span>
        </div>
        <div className="flex items-center gap-2">
          <code className="text-sm font-mono text-primary bg-primary/5 px-3 py-1.5 rounded-lg border border-primary/20 flex-1">
            {BASE_URL}
          </code>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => { navigator.clipboard.writeText(BASE_URL); toast.success("Copiado!"); }}
          >
            <Copy className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Auth info - Bearer Token */}
      <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-emerald-400" />
          <p className="text-sm font-bold text-emerald-400">Autenticação via API Token (recomendado)</p>
        </div>
        <p className="text-sm text-muted-foreground">
          Para acessar a API de forma programática (scripts, bots, automações), use um <strong className="text-foreground">API Token</strong> no header de todas as requisições. Endpoints marcados com <strong>🔒 Auth</strong> exigem autenticação.
        </p>

        <div className="space-y-3">
          <div>
            <p className="text-xs font-semibold text-muted-foreground mb-1.5">1. Gere um token</p>
            <p className="text-xs text-muted-foreground">
              Acesse <a href="/api-tokens" className="text-emerald-400 hover:underline font-medium">API Tokens</a> na sidebar e clique em <strong className="text-foreground">"Novo Token"</strong>. Copie o token gerado imediatamente — ele não será exibido novamente.
            </p>
          </div>

          <div>
            <p className="text-xs font-semibold text-muted-foreground mb-1.5">2. Inclua o token no header Authorization</p>
            <pre className="text-xs bg-background rounded-lg p-3 overflow-x-auto text-emerald-400 border border-border font-mono">
{`Authorization: Bearer gp_seu_token_aqui`}
            </pre>
          </div>

          <div>
            <p className="text-xs font-semibold text-muted-foreground mb-1.5">3. Exemplo completo</p>
            <pre className="text-xs bg-background rounded-lg p-3 overflow-x-auto text-yellow-400 border border-border font-mono whitespace-pre-wrap">
{`curl -H "Authorization: Bearer gp_seu_token" \\
  ${BASE_URL}/api/trpc/dashboard.stats`}
            </pre>
          </div>
        </div>

        <div className="flex items-start gap-2 bg-emerald-500/10 rounded-lg p-3">
          <Info className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
          <div className="text-xs text-muted-foreground space-y-1">
            <p><strong className="text-foreground">Permissões disponíveis:</strong></p>
            <p><code className="text-emerald-400 bg-background px-1 rounded">full</code> — Acesso completo (leitura + escrita em todos os endpoints)</p>
            <p><code className="text-blue-400 bg-background px-1 rounded">read</code> — Somente leitura (dashboard, listar jobs, contas, logs)</p>
            <p><code className="text-yellow-400 bg-background px-1 rounded">jobs_only</code> — Apenas criar e gerenciar jobs</p>
          </div>
        </div>
      </div>

      {/* Auth info - Cookie (alternativa) */}
      <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/5 p-4">
        <p className="text-sm font-semibold text-yellow-400 mb-1">🔒 Autenticação via Cookie (alternativa)</p>
        <p className="text-sm text-muted-foreground">
          Também é possível autenticar via cookie de sessão. Faça login via <code className="text-xs bg-background px-1 py-0.5 rounded">POST /api/auth/login</code> para obter o cookie <code className="text-xs bg-background px-1 py-0.5 rounded">ghost_session</code> e envie-o com <code className="text-xs bg-background px-1 py-0.5 rounded">-b "ghost_session=..."</code>. O método Bearer Token é preferível para automações.
        </p>
      </div>

      {/* Sections */}
      {SECTIONS.map((section) => {
        const Icon = section.icon;
        return (
          <div key={section.title} className="space-y-3">
            <div className="flex items-center gap-2">
              <Icon className={cn("w-4 h-4", section.color)} />
              <h2 className="text-base font-semibold text-foreground">{section.title}</h2>
              <div className="flex-1 h-px bg-border" />
            </div>
            <div className="space-y-2">
              {section.endpoints.map((ep) => (
                <EndpointCard key={`${ep.method}-${ep.path}`} endpoint={ep} />
              ))}
            </div>
          </div>
        );
      })}

      <div className="text-center text-xs text-muted-foreground pb-4">
        Ghost Panel API · Todos os endpoints usam JSON · Autenticação via Bearer Token ou Cookie
      </div>
    </div>
  );
}
