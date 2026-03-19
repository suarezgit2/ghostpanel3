/**
 * Jobs Page - Lista de todos os jobs com filtros e ações
 */

import { motion } from "framer-motion";
import { Plus, RefreshCw, Trash2, Eye } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import StatusBadge from "@/components/StatusBadge";
import { trpc } from "@/lib/trpc";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { toast } from "sonner";

export default function Jobs() {
  const { data: jobs, isLoading, refetch } = trpc.jobs.list.useQuery();
  const cancelMutation = trpc.jobs.cancel.useMutation({
    onSuccess: () => {
      toast.success("Job cancelado");
      refetch();
    },
    onError: (err) => toast.error("Erro ao cancelar job", { description: err.message }),
  });

  const count = jobs?.length ?? 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Jobs</h1>
          <p className="text-sm text-muted-foreground mt-1">{count} job{count !== 1 ? "s" : ""} encontrado{count !== 1 ? "s" : ""}</p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-2">
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
            Atualizar
          </Button>
          <Link href="/create">
            <Button size="sm" className="gap-2">
              <Plus className="w-3.5 h-3.5" />
              Novo Job
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
        <table className="w-full">
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
              jobs.map((job, i) => (
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
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </div>
                  </td>
                </motion.tr>
              ))
            )}
          </tbody>
        </table>
      </motion.div>
    </div>
  );
}
