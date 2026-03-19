/**
 * Job Detail Page - Detalhes de um job específico com contas e logs
 */

import { useParams, Link } from "wouter";
import { motion } from "framer-motion";
import { ArrowLeft, RefreshCw, Copy, StopCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import StatusBadge from "@/components/StatusBadge";
import { trpc } from "@/lib/trpc";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { toast } from "sonner";

export default function JobDetail() {
  const { id } = useParams<{ id: string }>();
  const jobId = parseInt(id || "0");

  const { data: job, isLoading, refetch: refetchJob } = trpc.jobs.getById.useQuery({ id: jobId }, { enabled: jobId > 0 });
  const { data: jobAccounts, refetch: refetchAccounts } = trpc.accounts.list.useQuery({ page: 1, limit: 100, jobId }, { enabled: jobId > 0 });
  const { data: jobLogs, refetch: refetchLogs } = trpc.logs.list.useQuery({ page: 1, limit: 50, jobId }, { enabled: jobId > 0 });

  const refetchAll = async () => {
    await Promise.all([refetchJob(), refetchAccounts(), refetchLogs()]);
  };

  const cancelMutation = trpc.jobs.cancel.useMutation({
    onSuccess: () => { toast.success("Job cancelado"); refetchAll(); },
  });

  const accounts = jobAccounts?.accounts ?? [];
  const logs = jobLogs?.logs ?? [];

  const copyAccounts = async () => {
    const active = accounts.filter((a) => a.status === "active");
    if (active.length === 0) {
      toast.info("Nenhuma conta ativa neste job");
      return;
    }
    const text = active.map((a) => `${a.email}:${a.password}`).join("\n");
    await navigator.clipboard.writeText(text);
    toast.success(`${active.length} contas copiadas!`);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  if (!job) {
    return (
      <div className="text-center py-16">
        <p className="text-muted-foreground">Job não encontrado</p>
        <Link href="/jobs">
          <Button variant="outline" className="mt-4">Voltar</Button>
        </Link>
      </div>
    );
  }

  const progress = job.totalAccounts > 0 ? ((job.completedAccounts + job.failedAccounts) / job.totalAccounts * 100) : 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href="/jobs">
          <Button variant="ghost" size="icon" className="h-9 w-9">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              Job #{job.id}
            </h1>
            <StatusBadge status={job.status} />
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {job.createdAt ? formatDistanceToNow(new Date(job.createdAt), { addSuffix: true, locale: ptBR }) : "—"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => refetchAll()} className="gap-2">
            <RefreshCw className="w-3.5 h-3.5" />
            Atualizar
          </Button>
          <Button variant="outline" size="sm" onClick={copyAccounts} className="gap-2">
            <Copy className="w-3.5 h-3.5" />
            Copiar Contas
          </Button>
          {job.status === "running" && (
            <Button variant="destructive" size="sm" onClick={() => cancelMutation.mutate({ id: job.id })} className="gap-2">
              <StopCircle className="w-3.5 h-3.5" />
              Cancelar
            </Button>
          )}
        </div>
      </div>

      {/* Progress */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-xl border border-border bg-card p-6"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-foreground">Progresso</h2>
          <span className="text-sm font-mono text-muted-foreground">{progress.toFixed(0)}%</span>
        </div>
        <div className="h-2 rounded-full bg-ghost-surface-3 overflow-hidden mb-4">
          <div
            className="h-full rounded-full bg-primary transition-all duration-700 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="grid grid-cols-4 gap-4">
          <div>
            <p className="text-xs text-muted-foreground">Quantidade</p>
            <p className="text-lg font-bold font-mono text-foreground">{job.totalAccounts}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Concluídas</p>
            <p className="text-lg font-bold font-mono text-ghost-success">{job.completedAccounts}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Falhas</p>
            <p className="text-lg font-bold font-mono text-ghost-error">{job.failedAccounts}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Custo</p>
            <p className="text-lg font-bold font-mono text-foreground">${(job.completedAccounts * 0.0138).toFixed(4)}</p>
          </div>
        </div>
      </motion.div>

      {/* Accounts & Logs */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Accounts */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="rounded-xl border border-border bg-card"
        >
          <div className="px-5 py-4 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground">Contas ({accounts.length})</h2>
          </div>
          <div className="divide-y divide-border max-h-[400px] overflow-y-auto">
            {accounts.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-muted-foreground">
                Nenhuma conta criada ainda
              </div>
            ) : (
              accounts.map((account) => (
                <div key={account.id} className="flex items-center justify-between px-5 py-2.5 hover:bg-ghost-surface-1/50 transition-colors">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs font-mono text-foreground">{account.email}</span>
                    <span className="text-[10px] font-mono text-muted-foreground">{account.password}</span>
                  </div>
                  <StatusBadge status={account.status} />
                </div>
              ))
            )}
          </div>
        </motion.div>

        {/* Logs */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="rounded-xl border border-border bg-card"
        >
          <div className="px-5 py-4 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground">Logs ({logs.length})</h2>
          </div>
          <div className="divide-y divide-border max-h-[400px] overflow-y-auto font-mono text-xs">
            {logs.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-muted-foreground font-sans">
                Nenhum log registrado
              </div>
            ) : (
              logs.map((log) => (
                <div key={log.id} className="px-4 py-2 hover:bg-ghost-surface-1/50 transition-colors">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className={`text-[10px] font-semibold uppercase ${
                      log.level === "error" ? "text-ghost-error" :
                      log.level === "warn" ? "text-ghost-warning" : "text-ghost-info"
                    }`}>
                      {log.level}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {log.source || "—"}
                    </span>
                  </div>
                  <p className="text-muted-foreground">{log.message}</p>
                </div>
              ))
            )}
          </div>
        </motion.div>
      </div>
    </div>
  );
}
