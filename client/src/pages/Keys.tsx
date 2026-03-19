/**
 * Keys Page - Geração e gerenciamento de chaves de créditos
 */

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import {
  Key, Plus, Copy, Trash2, Ban, RefreshCw,
  CheckCircle2, XCircle, Clock, Coins, ExternalLink
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

type KeyStatus = "active" | "redeemed" | "expired" | "cancelled";

const STATUS_CONFIG: Record<KeyStatus, { label: string; color: string; icon: React.ElementType }> = {
  active: { label: "Ativa", color: "text-green-400 bg-green-400/10", icon: CheckCircle2 },
  redeemed: { label: "Resgatada", color: "text-blue-400 bg-blue-400/10", icon: CheckCircle2 },
  expired: { label: "Expirada", color: "text-yellow-400 bg-yellow-400/10", icon: Clock },
  cancelled: { label: "Cancelada", color: "text-red-400 bg-red-400/10", icon: XCircle },
};

export default function Keys() {
  const [genCredits, setGenCredits] = useState("5000");
  const [genQuantity, setGenQuantity] = useState("1");
  const [genLabel, setGenLabel] = useState("");
  const [genExpiry, setGenExpiry] = useState("");
  const [generatedCodes, setGeneratedCodes] = useState<string[]>([]);
  const [filterStatus, setFilterStatus] = useState<KeyStatus | "all">("all");

  const { data: keysList, isLoading, refetch } = trpc.keys.list.useQuery();
  const { data: stats, refetch: refetchStats } = trpc.keys.stats.useQuery();

  const generateMutation = trpc.keys.generate.useMutation({
    onSuccess: (data) => {
      setGeneratedCodes(data.codes);
      toast.success(`${data.count} chave(s) gerada(s) com sucesso!`);
      refetch();
      refetchStats();
    },
    onError: (err) => toast.error(`Erro: ${err.message}`),
  });

  const revokeMutation = trpc.keys.revoke.useMutation({
    onSuccess: () => { toast.success("Chave cancelada"); refetch(); refetchStats(); },
    onError: (err) => toast.error(`Erro: ${err.message}`),
  });

  const deleteMutation = trpc.keys.delete.useMutation({
    onSuccess: () => { toast.success("Chave excluída"); refetch(); refetchStats(); },
    onError: (err) => toast.error(`Erro: ${err.message}`),
  });

  function copyCode(code: string) {
    navigator.clipboard.writeText(code);
    toast.success("Código copiado!");
  }

  function copyAllCodes() {
    navigator.clipboard.writeText(generatedCodes.join("\n"));
    toast.success(`${generatedCodes.length} código(s) copiado(s)!`);
  }

  function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    generateMutation.mutate({
      credits: parseInt(genCredits),
      quantity: parseInt(genQuantity),
      label: genLabel || undefined,
      expiresInDays: genExpiry ? parseInt(genExpiry) : undefined,
    });
  }

  const filteredKeys = keysList?.filter(k =>
    filterStatus === "all" ? true : k.status === filterStatus
  ) ?? [];

  const redeemUrl = `${window.location.origin}/redeem`;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <Key className="w-6 h-6 text-primary" />
            Keys
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Gere chaves para distribuir créditos a usuários
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => { copyCode(redeemUrl); }}
            className="gap-2"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Copiar link de resgate
          </Button>
          <Button variant="outline" size="sm" onClick={() => { refetch(); refetchStats(); }} className="gap-2">
            <RefreshCw className={cn("w-3.5 h-3.5", isLoading && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: "Total", value: stats?.total ?? 0, color: "text-blue-400 bg-blue-400/10", icon: Key },
          { label: "Ativas", value: stats?.active ?? 0, color: "text-green-400 bg-green-400/10", icon: CheckCircle2 },
          { label: "Resgatadas", value: stats?.redeemed ?? 0, color: "text-purple-400 bg-purple-400/10", icon: Coins },
          { label: "Canceladas/Expiradas", value: (stats?.expired ?? 0) + (0), color: "text-red-400 bg-red-400/10", icon: XCircle },
        ].map((stat) => (
          <div key={stat.label} className="rounded-xl border border-border bg-card p-4 flex items-center gap-3">
            <div className={cn("flex items-center justify-center w-9 h-9 rounded-lg", stat.color.split(" ")[1])}>
              <stat.icon className={cn("w-4 h-4", stat.color.split(" ")[0])} />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{stat.label}</p>
              <p className="text-lg font-bold font-mono text-foreground">{stat.value}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Generate Form */}
        <div className="col-span-1">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Plus className="w-4 h-4" />
                Gerar Chaves
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleGenerate} className="space-y-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">Créditos por chave</Label>
                  <Input
                    type="number"
                    min={500}
                    step={500}
                    value={genCredits}
                    onChange={(e) => setGenCredits(e.target.value)}
                    className="h-9"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Quantidade de chaves</Label>
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    value={genQuantity}
                    onChange={(e) => setGenQuantity(e.target.value)}
                    className="h-9"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Label (opcional)</Label>
                  <Input
                    placeholder="Ex: Promoção Julho"
                    value={genLabel}
                    onChange={(e) => setGenLabel(e.target.value)}
                    className="h-9"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Expira em (dias, opcional)</Label>
                  <Input
                    type="number"
                    min={1}
                    max={365}
                    placeholder="Ex: 30"
                    value={genExpiry}
                    onChange={(e) => setGenExpiry(e.target.value)}
                    className="h-9"
                  />
                </div>

                <Button
                  type="submit"
                  className="w-full gap-2"
                  disabled={generateMutation.isPending}
                >
                  {generateMutation.isPending ? (
                    <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <Key className="w-4 h-4" />
                  )}
                  Gerar {parseInt(genQuantity) > 1 ? `${genQuantity} Chaves` : "Chave"}
                </Button>
              </form>

              {/* Generated codes */}
              <AnimatePresence>
                {generatedCodes.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mt-4 space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium text-muted-foreground">Chaves geradas</p>
                      {generatedCodes.length > 1 && (
                        <Button variant="ghost" size="sm" className="h-6 text-xs gap-1" onClick={copyAllCodes}>
                          <Copy className="w-3 h-3" />
                          Copiar todas
                        </Button>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      {generatedCodes.map((code) => (
                        <div
                          key={code}
                          className="flex items-center justify-between gap-2 p-2 rounded-lg bg-ghost-surface-2 border border-border"
                        >
                          <code className="text-xs font-mono text-primary">{code}</code>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 shrink-0"
                            onClick={() => copyCode(code)}
                          >
                            <Copy className="w-3 h-3" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </CardContent>
          </Card>
        </div>

        {/* Keys List */}
        <div className="col-span-2">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Chaves ({filteredKeys.length})</CardTitle>
                <div className="flex items-center gap-1 rounded-lg border border-border bg-ghost-surface-1 p-1">
                  {(["all", "active", "redeemed", "expired", "cancelled"] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => setFilterStatus(s)}
                      className={cn(
                        "px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
                        filterStatus === s
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {s === "all" ? "Todas" : STATUS_CONFIG[s]?.label ?? s}
                    </button>
                  ))}
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-border max-h-[500px] overflow-y-auto">
                {isLoading ? (
                  <div className="py-12 text-center text-sm text-muted-foreground">Carregando...</div>
                ) : filteredKeys.length === 0 ? (
                  <div className="py-12 text-center text-sm text-muted-foreground">
                    Nenhuma chave encontrada. Gere sua primeira chave!
                  </div>
                ) : (
                  filteredKeys.map((key, i) => {
                    const statusCfg = STATUS_CONFIG[key.status as KeyStatus] ?? STATUS_CONFIG.active;
                    const StatusIcon = statusCfg.icon;

                    return (
                      <motion.div
                        key={key.id}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: Math.min(i * 0.02, 0.3) }}
                        className="flex items-center gap-3 px-4 py-3 hover:bg-ghost-surface-1/50 transition-colors group"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <code className="text-xs font-mono text-foreground">{key.code}</code>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                              onClick={() => copyCode(key.code)}
                            >
                              <Copy className="w-3 h-3" />
                            </Button>
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-xs text-muted-foreground font-mono">{key.credits.toLocaleString()} créditos</span>
                            {key.label && <span className="text-xs text-muted-foreground">· {key.label}</span>}
                            {key.redeemedBy && <span className="text-xs text-muted-foreground">· {key.redeemedBy}</span>}
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <span className={cn(
                            "inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full",
                            statusCfg.color
                          )}>
                            <StatusIcon className="w-3 h-3" />
                            {statusCfg.label}
                          </span>

                          {key.status === "active" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                              onClick={() => revokeMutation.mutate({ id: key.id })}
                              title="Cancelar chave"
                            >
                              <Ban className="w-3.5 h-3.5" />
                            </Button>
                          )}

                          {key.status !== "active" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                              onClick={() => deleteMutation.mutate({ id: key.id })}
                              title="Excluir chave"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          )}
                        </div>
                      </motion.div>
                    );
                  })
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
