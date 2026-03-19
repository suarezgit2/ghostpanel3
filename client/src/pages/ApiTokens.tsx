import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Key,
  Plus,
  Trash2,
  Ban,
  Copy,
  Check,
  AlertTriangle,
  Shield,
  Eye,
  EyeOff,
  RefreshCw,
} from "lucide-react";

export default function ApiTokens() {
  const tokens = trpc.apiTokens.list.useQuery();
  const generateToken = trpc.apiTokens.generate.useMutation({
    onSuccess: (data) => {
      setNewToken(data.token);
      setShowNewToken(true);
      tokens.refetch();
    },
  });
  const revokeToken = trpc.apiTokens.revoke.useMutation({
    onSuccess: () => tokens.refetch(),
  });
  const deleteToken = trpc.apiTokens.delete.useMutation({
    onSuccess: () => tokens.refetch(),
  });

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [permissions, setPermissions] = useState<"full" | "read" | "jobs_only">("full");
  const [expiresInDays, setExpiresInDays] = useState<number | undefined>(undefined);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [showNewToken, setShowNewToken] = useState(false);
  const [copied, setCopied] = useState(false);
  const [tokenVisible, setTokenVisible] = useState(false);

  const handleGenerate = () => {
    if (!name.trim()) return;
    generateToken.mutate({
      name: name.trim(),
      permissions,
      expiresInDays: expiresInDays || undefined,
    });
  };

  const handleCopy = () => {
    if (newToken) {
      navigator.clipboard.writeText(newToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleCloseNewToken = () => {
    setShowNewToken(false);
    setNewToken(null);
    setShowForm(false);
    setName("");
    setPermissions("full");
    setExpiresInDays(undefined);
    setTokenVisible(false);
  };

  const permissionLabels = {
    full: { label: "Acesso Total", color: "bg-red-500/20 text-red-400" },
    read: { label: "Somente Leitura", color: "bg-blue-500/20 text-blue-400" },
    jobs_only: { label: "Apenas Jobs", color: "bg-yellow-500/20 text-yellow-400" },
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">API Tokens</h1>
          <p className="text-zinc-400 mt-1">
            Gerencie tokens para acesso programático à API
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => tokens.refetch()}
            className="border-zinc-700 text-zinc-300 hover:bg-zinc-800"
          >
            <RefreshCw className="w-4 h-4 mr-1" />
            Atualizar
          </Button>
          <Button
            size="sm"
            onClick={() => setShowForm(true)}
            className="bg-emerald-600 hover:bg-emerald-700"
          >
            <Plus className="w-4 h-4 mr-1" />
            Novo Token
          </Button>
        </div>
      </div>

      {/* Modal de token recém-criado */}
      {showNewToken && newToken && (
        <Card className="bg-yellow-900/20 border-yellow-600/50">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-yellow-400 mt-0.5 flex-shrink-0" />
              <div className="flex-1 space-y-3">
                <div>
                  <h3 className="text-yellow-300 font-semibold">Token gerado com sucesso!</h3>
                  <p className="text-yellow-200/70 text-sm mt-1">
                    Copie este token agora. Por segurança, ele <strong>não será exibido novamente</strong>.
                  </p>
                </div>
                <div className="flex items-center gap-2 bg-black/30 rounded-lg p-3">
                  <code className="text-emerald-400 text-sm flex-1 break-all font-mono">
                    {tokenVisible ? newToken : newToken.slice(0, 12) + "•".repeat(40)}
                  </code>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setTokenVisible(!tokenVisible)}
                    className="text-zinc-400 hover:text-white"
                  >
                    {tokenVisible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleCopy}
                    className="text-zinc-400 hover:text-white"
                  >
                    {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  </Button>
                </div>
                <div className="bg-black/20 rounded-lg p-3">
                  <p className="text-zinc-400 text-xs mb-2">Exemplo de uso:</p>
                  <code className="text-zinc-300 text-xs font-mono break-all">
                    curl -H "Authorization: Bearer {tokenVisible ? newToken : "gp_..."}" https://ghost-panel-production.up.railway.app/api/trpc/dashboard.stats
                  </code>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCloseNewToken}
                  className="border-yellow-600/50 text-yellow-300 hover:bg-yellow-900/30"
                >
                  Entendi, já copiei o token
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Formulário de criação */}
      {showForm && !showNewToken && (
        <Card className="bg-zinc-900 border-zinc-800">
          <CardHeader>
            <CardTitle className="text-white text-lg">Gerar Novo Token</CardTitle>
            <CardDescription>
              Crie um token para acessar a API sem precisar de login
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-sm text-zinc-400 mb-1 block">Nome do token</label>
              <Input
                placeholder="Ex: Automação, Bot, Script..."
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="bg-zinc-800 border-zinc-700 text-white"
              />
            </div>
            <div>
              <label className="text-sm text-zinc-400 mb-1 block">Permissões</label>
              <div className="flex gap-2">
                {(["full", "read", "jobs_only"] as const).map((perm) => (
                  <Button
                    key={perm}
                    variant="outline"
                    size="sm"
                    onClick={() => setPermissions(perm)}
                    className={`border-zinc-700 ${
                      permissions === perm
                        ? "bg-emerald-600/20 border-emerald-600 text-emerald-400"
                        : "text-zinc-400 hover:bg-zinc-800"
                    }`}
                  >
                    {permissionLabels[perm].label}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-zinc-500 mt-1">
                {permissions === "full" && "Acesso completo a todos os endpoints da API"}
                {permissions === "read" && "Apenas leitura de dados (dashboard, jobs, contas, logs)"}
                {permissions === "jobs_only" && "Apenas criar e gerenciar jobs"}
              </p>
            </div>
            <div>
              <label className="text-sm text-zinc-400 mb-1 block">Expiração (opcional)</label>
              <div className="flex gap-2">
                {[
                  { label: "Nunca", value: undefined },
                  { label: "30 dias", value: 30 },
                  { label: "90 dias", value: 90 },
                  { label: "365 dias", value: 365 },
                ].map((opt) => (
                  <Button
                    key={opt.label}
                    variant="outline"
                    size="sm"
                    onClick={() => setExpiresInDays(opt.value)}
                    className={`border-zinc-700 ${
                      expiresInDays === opt.value
                        ? "bg-emerald-600/20 border-emerald-600 text-emerald-400"
                        : "text-zinc-400 hover:bg-zinc-800"
                    }`}
                  >
                    {opt.label}
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <Button
                onClick={handleGenerate}
                disabled={!name.trim() || generateToken.isPending}
                className="bg-emerald-600 hover:bg-emerald-700"
              >
                {generateToken.isPending ? "Gerando..." : "Gerar Token"}
              </Button>
              <Button
                variant="outline"
                onClick={() => setShowForm(false)}
                className="border-zinc-700 text-zinc-400"
              >
                Cancelar
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Lista de tokens */}
      <Card className="bg-zinc-900 border-zinc-800">
        <CardHeader>
          <CardTitle className="text-white flex items-center gap-2">
            <Shield className="w-5 h-5 text-emerald-400" />
            Tokens Ativos
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!tokens.data || tokens.data.length === 0 ? (
            <div className="text-center py-8 text-zinc-500">
              <Key className="w-10 h-10 mx-auto mb-3 opacity-50" />
              <p>Nenhum token criado</p>
              <p className="text-sm mt-1">Crie um token para acessar a API programaticamente</p>
            </div>
          ) : (
            <div className="space-y-3">
              {tokens.data.map((token) => (
                <div
                  key={token.id}
                  className={`flex items-center justify-between p-4 rounded-lg border ${
                    token.revoked
                      ? "bg-red-900/10 border-red-900/30 opacity-60"
                      : "bg-zinc-800/50 border-zinc-700/50"
                  }`}
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-white font-medium">{token.name}</span>
                      <Badge className={permissionLabels[token.permissions as keyof typeof permissionLabels]?.color || "bg-zinc-700 text-zinc-300"}>
                        {permissionLabels[token.permissions as keyof typeof permissionLabels]?.label || token.permissions}
                      </Badge>
                      {token.revoked && (
                        <Badge className="bg-red-500/20 text-red-400">Revogado</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-4 mt-1 text-xs text-zinc-500">
                      <span className="font-mono">{token.tokenPrefix}</span>
                      <span>Criado: {new Date(token.createdAt).toLocaleDateString("pt-BR")}</span>
                      {token.lastUsedAt && (
                        <span>Último uso: {new Date(token.lastUsedAt).toLocaleDateString("pt-BR")}</span>
                      )}
                      {token.expiresAt && (
                        <span>
                          Expira: {new Date(token.expiresAt).toLocaleDateString("pt-BR")}
                          {new Date(token.expiresAt) < new Date() && (
                            <span className="text-red-400 ml-1">(expirado)</span>
                          )}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    {!token.revoked && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          if (confirm("Revogar este token? Ele não poderá mais ser usado.")) {
                            revokeToken.mutate({ id: token.id });
                          }
                        }}
                        className="text-yellow-400 hover:text-yellow-300 hover:bg-yellow-900/20"
                        title="Revogar"
                      >
                        <Ban className="w-4 h-4" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (confirm("Excluir este token permanentemente?")) {
                          deleteToken.mutate({ id: token.id });
                        }
                      }}
                      className="text-red-400 hover:text-red-300 hover:bg-red-900/20"
                      title="Excluir"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Instruções de uso */}
      <Card className="bg-zinc-900 border-zinc-800">
        <CardHeader>
          <CardTitle className="text-white text-lg">Como usar</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-zinc-400">
          <p>
            Inclua o token no header <code className="text-emerald-400 bg-zinc-800 px-1 rounded">Authorization</code> de todas as requisições:
          </p>
          <div className="bg-black/30 rounded-lg p-3">
            <code className="text-zinc-300 text-xs font-mono">
              Authorization: Bearer gp_seu_token_aqui
            </code>
          </div>
          <p>
            <strong className="text-white">Exemplo com cURL:</strong>
          </p>
          <div className="bg-black/30 rounded-lg p-3">
            <code className="text-zinc-300 text-xs font-mono break-all">
              curl -H "Authorization: Bearer gp_..." \<br />
              &nbsp;&nbsp;https://ghost-panel-production.up.railway.app/api/trpc/dashboard.stats
            </code>
          </div>
          <div className="bg-black/30 rounded-lg p-3">
            <code className="text-zinc-300 text-xs font-mono break-all">
              curl -X POST -H "Authorization: Bearer gp_..." \<br />
              &nbsp;&nbsp;-H "Content-Type: application/json" \<br />
              &nbsp;&nbsp;-d '{"{"}\"provider\":\"manus\",\"quantity\":5{"}"}' \<br />
              &nbsp;&nbsp;https://ghost-panel-production.up.railway.app/api/trpc/jobs.create?batch=1
            </code>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
