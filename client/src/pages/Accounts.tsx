/**
 * Accounts Page - Lista de contas com filtros, exportação e ações
 */

import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { RefreshCw, Download, Copy, Trash2, Eye, EyeOff, Gift, X, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import StatusBadge from "@/components/StatusBadge";
import { trpc } from "@/lib/trpc";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { toast } from "sonner";

type AccountStatus = "active" | "banned" | "suspended" | "unverified" | "failed";

export default function Accounts() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [page, setPage] = useState(1);
  const [showPasswords, setShowPasswords] = useState(false);

  // Resgatar Contas — estado do modal
  const [redeemOpen, setRedeemOpen] = useState(false);
  const [redeemQty, setRedeemQty] = useState<string>("5");
  const [redeemResult, setRedeemResult] = useState<{ email: string; password: string }[] | null>(null);
  const [copied, setCopied] = useState(false);

  const queryInput = useMemo(() => ({
    page,
    limit: 50,
    ...(statusFilter !== "all" ? { status: statusFilter as AccountStatus } : {}),
  }), [page, statusFilter]);

  const { data, isLoading, refetch } = trpc.accounts.list.useQuery(queryInput);
  const { data: exportData, refetch: refetchExport } = trpc.accounts.exportAll.useQuery();

  const refetchAll = async () => {
    await Promise.all([refetch(), refetchExport()]);
  };

  const deleteMutation = trpc.accounts.delete.useMutation({
    onSuccess: () => { toast.success("Conta removida"); refetchAll(); },
    onError: (err) => toast.error("Erro ao deletar conta", { description: err.message }),
  });

  const redeemMutation = trpc.accounts.redeem.useMutation({
    onSuccess: (result) => {
      if (result.count === 0) {
        toast.info("Nenhuma conta ativa disponível para resgatar");
        return;
      }
      setRedeemResult(result.redeemed);
      setCopied(false);
      refetchAll();
    },
    onError: (err) => toast.error("Erro ao resgatar contas", { description: err.message }),
  });

  const accounts = data?.accounts ?? [];
  const count = data?.total ?? 0;
  const totalPages = Math.ceil(count / 50);

  const copyAll = async () => {
    if (exportData && exportData.length > 0) {
      const text = exportData.map((a) => `${a.email}:${a.password}`).join("\n");
      await navigator.clipboard.writeText(text);
      toast.success(`${exportData.length} contas copiadas!`);
    } else {
      toast.info("Nenhuma conta ativa para copiar");
    }
  };

  const exportAccounts = () => {
    if (exportData && exportData.length > 0) {
      const text = exportData.map((a) => `${a.email}:${a.password}`).join("\n");
      const blob = new Blob([text], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ghost_accounts_${new Date().toISOString().split("T")[0]}.txt`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`${exportData.length} contas exportadas!`);
    }
  };

  const copyOne = async (email: string, password: string) => {
    await navigator.clipboard.writeText(`${email}:${password}`);
    toast.success("Copiado!");
  };

  const handleRedeem = () => {
    const qty = parseInt(redeemQty, 10);
    if (!qty || qty < 1) { toast.error("Informe uma quantidade válida"); return; }
    setRedeemResult(null);
    redeemMutation.mutate({ quantity: qty });
  };

  const copyRedeemed = async () => {
    if (!redeemResult) return;
    const text = redeemResult.map(a => `${a.email}:${a.password}`).join("\n");
    await navigator.clipboard.writeText(text);
    setCopied(true);
    toast.success(`${redeemResult.length} conta${redeemResult.length !== 1 ? "s" : ""} copiada${redeemResult.length !== 1 ? "s" : ""}!`);
    setTimeout(() => setCopied(false), 2500);
  };

  const closeModal = () => {
    setRedeemOpen(false);
    setRedeemResult(null);
    setCopied(false);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Contas</h1>
          <p className="text-sm text-muted-foreground mt-1">{count} conta{count !== 1 ? "s" : ""} encontrada{count !== 1 ? "s" : ""}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowPasswords(!showPasswords)} className="gap-2">
            {showPasswords ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            {showPasswords ? "Ocultar" : "Mostrar"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { setRedeemOpen(true); setRedeemResult(null); setCopied(false); }}
            className="gap-2 border-ghost-accent/40 text-ghost-accent hover:bg-ghost-accent/10 hover:text-ghost-accent"
          >
            <Gift className="w-3.5 h-3.5" />
            Resgatar
          </Button>
          <Button variant="outline" size="sm" onClick={copyAll} className="gap-2">
            <Copy className="w-3.5 h-3.5" />
            Copiar Todas
          </Button>
          <Button variant="outline" size="sm" onClick={exportAccounts} className="gap-2">
            <Download className="w-3.5 h-3.5" />
            Exportar
          </Button>
          <Button variant="outline" size="sm" onClick={() => refetchAll()} className="gap-2">
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
          <SelectTrigger className="w-[180px] bg-ghost-surface-2 border-border">
            <SelectValue placeholder="Filtrar status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os status</SelectItem>
            <SelectItem value="active">Ativa</SelectItem>
            <SelectItem value="failed">Falhou</SelectItem>
            <SelectItem value="unverified">Não verificada</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="rounded-xl border border-border bg-card overflow-hidden"
      >
        <div className="overflow-x-auto">
        <table className="w-full min-w-[520px]">
          <thead>
            <tr className="border-b border-border bg-ghost-surface-1">
              <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Email</th>
              <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Senha</th>
              <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Status</th>
              <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Criado</th>
              <th className="text-right px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Ações</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {accounts.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-5 py-12 text-center text-sm text-muted-foreground">
                  {isLoading ? "Carregando..." : "Nenhuma conta encontrada"}
                </td>
              </tr>
            ) : (
              accounts.map((account, i) => (
                <motion.tr
                  key={account.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: i * 0.02 }}
                  className="hover:bg-ghost-surface-1/50 transition-colors group"
                >
                  <td className="px-5 py-3">
                    <span className="text-xs font-mono text-foreground">{account.email}</span>
                  </td>
                  <td className="px-5 py-3">
                    <span className="text-xs font-mono text-muted-foreground">
                      {showPasswords ? account.password : "••••••••"}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <StatusBadge status={account.status} />
                  </td>
                  <td className="px-5 py-3">
                    <span className="text-xs text-muted-foreground">
                      {account.createdAt ? formatDistanceToNow(new Date(account.createdAt), { addSuffix: true, locale: ptBR }) : "—"}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-foreground"
                        onClick={() => copyOne(account.email, account.password)}
                      >
                        <Copy className="w-3 h-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-ghost-error"
                        onClick={() => deleteMutation.mutate({ id: account.id })}
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  </td>
                </motion.tr>
              ))
            )}
          </tbody>
        </table>
        </div>
      </motion.div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">Página {page} de {totalPages}</p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Próxima</Button>
          </div>
        </div>
      )}

      {/* Modal — Resgatar Contas */}
      <AnimatePresence>
        {redeemOpen && (
          <motion.div
            key="redeem-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}
          >
            <motion.div
              key="redeem-modal"
              initial={{ opacity: 0, scale: 0.95, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 8 }}
              transition={{ duration: 0.18 }}
              className="relative w-full max-w-md mx-4 rounded-2xl border border-border bg-card shadow-2xl overflow-hidden"
            >
              {/* Modal Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-border">
                <div className="flex items-center gap-2">
                  <Gift className="w-4 h-4 text-ghost-accent" />
                  <h2 className="text-sm font-semibold text-foreground">Resgatar Contas</h2>
                </div>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" onClick={closeModal}>
                  <X className="w-3.5 h-3.5" />
                </Button>
              </div>

              <div className="px-6 py-5 space-y-5">
                {/* Resultado ainda não gerado — formulário */}
                {!redeemResult && (
                  <>
                    <p className="text-sm text-muted-foreground">
                      Define quantas contas <span className="text-ghost-success font-medium">ativas</span> deseja resgatar.
                      Elas serão copiadas e <span className="text-ghost-error font-medium">removidas permanentemente</span> da lista.
                    </p>
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        Quantidade de contas
                      </label>
                      <Input
                        type="number"
                        min={1}
                        max={10000}
                        value={redeemQty}
                        onChange={(e) => setRedeemQty(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleRedeem(); }}
                        className="bg-ghost-surface-2 border-border text-foreground"
                        placeholder="Ex: 5"
                        autoFocus
                      />
                    </div>
                    <Button
                      className="w-full gap-2 bg-ghost-accent hover:bg-ghost-accent/90 text-white"
                      onClick={handleRedeem}
                      disabled={redeemMutation.isPending}
                    >
                      {redeemMutation.isPending ? (
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Gift className="w-3.5 h-3.5" />
                      )}
                      {redeemMutation.isPending ? "Resgatando..." : "Resgatar e Copiar"}
                    </Button>
                  </>
                )}

                {/* Resultado — contas resgatadas */}
                {redeemResult && (
                  <>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-px bg-border" />
                      <span className="text-xs text-ghost-success font-medium">
                        {redeemResult.length} conta{redeemResult.length !== 1 ? "s" : ""} resgatada{redeemResult.length !== 1 ? "s" : ""}
                      </span>
                      <div className="flex-1 h-px bg-border" />
                    </div>

                    {/* Preview das contas */}
                    <div className="rounded-lg border border-border bg-ghost-surface-1 overflow-hidden">
                      <div className="max-h-56 overflow-y-auto divide-y divide-border">
                        {redeemResult.map((a, i) => (
                          <div key={i} className="px-3 py-2 flex items-center justify-between gap-3">
                            <span className="text-xs font-mono text-foreground truncate">{a.email}</span>
                            <span className="text-xs font-mono text-muted-foreground shrink-0">••••••••</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="flex gap-2">
                      <Button
                        className="flex-1 gap-2"
                        variant={copied ? "default" : "outline"}
                        onClick={copyRedeemed}
                      >
                        {copied ? <Check className="w-3.5 h-3.5 text-ghost-success" /> : <Copy className="w-3.5 h-3.5" />}
                        {copied ? "Copiado!" : "Copiar"}
                      </Button>
                      <Button
                        className="flex-1 gap-2 bg-ghost-accent hover:bg-ghost-accent/90 text-white"
                        onClick={() => { setRedeemResult(null); setCopied(false); }}
                      >
                        <Gift className="w-3.5 h-3.5" />
                        Novo Resgate
                      </Button>
                    </div>
                  </>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
