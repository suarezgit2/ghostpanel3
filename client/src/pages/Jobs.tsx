/**
 * Jobs Page - Lista de todos os jobs com filtros e ações
 */

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, RefreshCw, Trash2, Eye, AlertTriangle, X } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import StatusBadge from "@/components/StatusBadge";
import { trpc } from "@/lib/trpc";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// Confirmation dialog component
function ConfirmDialog({
  open,
  title,
  description,
  onConfirm,
  onCancel,
  loading,
}: {
  open: boolean;
  title: string;
  description: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onCancel} />
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="relative z-10 w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-xl"
      >
        <div className="flex items-start gap-4">
          <div className="flex items-center justify-center w-10 h-10 rounded-full bg-destructive/10 shrink-0">
            <AlertTriangle className="w-5 h-5 text-destructive" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            <p className="text-sm text-muted-foreground mt-1">{description}</p>
          </div>
          <button onClick={onCancel} className="text-muted-foreground hover:text-foreground shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex gap-3 mt-5 justify-end">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={loading}>
            Cancelar
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm} disabled={loading}>
            {loading ? "Deletando..." : "Deletar"}
          </Button>
        </div>
      </motion.div>
    </div>
  );
}

export default function Jobs() {
  const { data: jobs, isLoading, refetch } = trpc.jobs.list.useQuery();

  // Confirm dialog state
  const [confirmDelete, setConfirmDelete] = useState<{ type: "single"; id: number } | { type: "bulk"; statuses: string[] } | null>(null);

  const cancelMutation = trpc.jobs.cancel.useMutation({
    onSuccess: () => { toast.success("Job cancelado"); refetch(); },
    onError: (err) => toast.error("Erro ao cancelar job", { description: err.message }),
  });

  const deleteMutation = trpc.jobs.delete.useMutation({
    onSuccess: () => { toast.success("Job deletado"); refetch(); setConfirmDelete(null); },
    onError: (err) => { toast.error("Erro ao deletar job", { description: err.message }); setConfirmDelete(null); },
  });

  const deleteCompletedMutation = trpc.jobs.deleteCompleted.useMutation({
    onSuccess: (data) => {
      toast.success(`${data.deleted} job(s) deletado(s)`);
      refetch();
      setConfirmDelete(null);
    },
    onError: (err) => { toast.error("Erro ao deletar jobs", { description: err.message }); setConfirmDelete(null); },
  });

  const count = jobs?.length ?? 0;
  const deletableCount = jobs?.filter((j) => ["completed", "failed", "cancelled"].includes(j.status)).length ?? 0;

  const handleConfirm = () => {
    if (!confirmDelete) return;
    if (confirmDelete.type === "single") {
      deleteMutation.mutate({ id: confirmDelete.id });
    } else {
      deleteCompletedMutation.mutate({ statuses: confirmDelete.statuses as any });
    }
  };

  const isConfirmLoading = deleteMutation.isPending || deleteCompletedMutation.isPending;

  return (
    <div className="space-y-6">
      {/* Confirm dialog */}
      <AnimatePresence>
        {confirmDelete && (
          <ConfirmDialog
            open={true}
            title={confirmDelete.type === "single" ? "Deletar job?" : "Deletar jobs?"}
            description={
              confirmDelete.type === "single"
                ? "Esta ação é irreversível. O job e todas as contas associadas serão removidos permanentemente."
                : `Isso vai deletar todos os jobs com status: ${confirmDelete.statuses.join(", ")}. Esta ação é irreversível.`
            }
            onConfirm={handleConfirm}
            onCancel={() => setConfirmDelete(null)}
            loading={isConfirmLoading}
          />
        )}
      </AnimatePresence>

      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Jobs</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {count} job{count !== 1 ? "s" : ""} encontrado{count !== 1 ? "s" : ""}
            {deletableCount > 0 && (
              <span className="ml-2 text-muted-foreground/60">· {deletableCount} finalizado{deletableCount !== 1 ? "s" : ""}</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-2">
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
            <span className="hidden sm:inline">Atualizar</span>
          </Button>

          {/* Bulk delete dropdown */}
          {deletableCount > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2 text-destructive border-destructive/30 hover:bg-destructive/10">
                  <Trash2 className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Limpar</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive focus:bg-destructive/10 gap-2"
                  onClick={() => setConfirmDelete({ type: "bulk", statuses: ["completed", "failed", "cancelled"] })}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Deletar todos finalizados
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="gap-2"
                  onClick={() => setConfirmDelete({ type: "bulk", statuses: ["completed"] })}
                >
                  Apenas concluídos
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="gap-2"
                  onClick={() => setConfirmDelete({ type: "bulk", statuses: ["failed"] })}
                >
                  Apenas com falha
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="gap-2"
                  onClick={() => setConfirmDelete({ type: "bulk", statuses: ["cancelled"] })}
                >
                  Apenas cancelados
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          <Link href="/create">
            <Button size="sm" className="gap-2">
              <Plus className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Novo Job</span>
            </Button>
          </Link>
        </div>
      </div>

      {/* Table */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="rounded-xl border border-border bg-card overflow-hidden"
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[500px]">
            <thead>
              <tr className="border-b border-border bg-ghost-surface-1">
                <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">ID</th>
                <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Progresso</th>
                <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Status</th>
                <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Criado</th>
                <th className="text-right px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {!jobs || jobs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-5 py-12 text-center text-sm text-muted-foreground">
                    {isLoading ? "Carregando..." : "Nenhum job encontrado"}
                  </td>
                </tr>
              ) : (
                jobs.map((job, i) => {
                  const isDeletable = ["completed", "failed", "cancelled"].includes(job.status);
                  return (
                    <motion.tr
                      key={job.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: i * 0.03 }}
                      className="hover:bg-ghost-surface-1/50 transition-colors"
                    >
                      <td className="px-5 py-3.5">
                        <span className="text-sm font-medium text-foreground">Job #{job.id}</span>
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-3">
                          <div className="flex-1 max-w-[120px] h-1.5 rounded-full bg-ghost-surface-3 overflow-hidden">
                            <div
                              className="h-full rounded-full bg-primary transition-all duration-500"
                              style={{ width: `${job.totalAccounts > 0 ? ((job.completedAccounts + job.failedAccounts) / job.totalAccounts * 100) : 0}%` }}
                            />
                          </div>
                          <span className="text-xs font-mono text-muted-foreground">
                            {job.completedAccounts}/{job.totalAccounts}
                            {job.failedAccounts > 0 && <span className="text-ghost-error ml-1">({job.failedAccounts} falhas)</span>}
                          </span>
                        </div>
                      </td>
                      <td className="px-5 py-3.5">
                        <StatusBadge status={job.status} />
                      </td>
                      <td className="px-5 py-3.5">
                        <span className="text-xs text-muted-foreground">
                          {job.createdAt ? formatDistanceToNow(new Date(job.createdAt), { addSuffix: true, locale: ptBR }) : "—"}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Link href={`/jobs/${job.id}`}>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground">
                              <Eye className="w-3.5 h-3.5" />
                            </Button>
                          </Link>
                          {job.status === "running" && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-ghost-error"
                              onClick={() => cancelMutation.mutate({ id: job.id })}
                              disabled={cancelMutation.isPending}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          )}
                          {isDeletable && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-destructive"
                              onClick={() => setConfirmDelete({ type: "single", id: job.id })}
                              disabled={deleteMutation.isPending}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </motion.tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </motion.div>
    </div>
  );
}
