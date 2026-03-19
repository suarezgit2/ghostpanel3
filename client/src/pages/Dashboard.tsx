/**
 * Dashboard Page - Obsidian Command Design
 * Visão geral com métricas, jobs recentes e contas recentes
 */

import { Users, CheckCircle2, XCircle, Loader2, ListOrdered, Globe, TrendingUp, DollarSign, RefreshCw } from "lucide-react";
import MetricCard from "@/components/MetricCard";
import StatusBadge from "@/components/StatusBadge";
import { trpc } from "@/lib/trpc";
import { motion } from "framer-motion";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { useState } from "react";

export default function Dashboard() {
  const { data: stats, isLoading: statsLoading, refetch: refetchStats } = trpc.dashboard.stats.useQuery();
  const { data: recentJobs, refetch: refetchJobs } = trpc.dashboard.recentJobs.useQuery();
  const { data: recentAccounts, refetch: refetchAccounts } = trpc.accounts.list.useQuery({ page: 1, limit: 8 });
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await Promise.all([refetchStats(), refetchJobs(), refetchAccounts()]);
    setIsRefreshing(false);
  };

  const totalAccounts = stats?.totalAccounts ?? 0;
  const activeAccounts = stats?.activeAccounts ?? 0;
  const failedAccounts = stats?.failedAccounts ?? 0;
  const total = activeAccounts + failedAccounts;
  const successRate = total > 0 ? ((activeAccounts / total) * 100).toFixed(1) : null;
  const estimatedCost = (activeAccounts * 0.0138).toFixed(4);

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">Visão geral do sistema de automação</p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={isRefreshing}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-ghost-surface-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-ghost-surface-3 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${isRefreshing || statsLoading ? "animate-spin" : ""}`} />
          Atualizar
        </button>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          title="Total de Contas"
          value={totalAccounts}
          subtitle="criadas"
          icon={Users}
          color="blue"
          delay={0}
        />
        <MetricCard
          title="Contas Ativas"
          value={activeAccounts}
          subtitle="verificadas"
          icon={CheckCircle2}
          color="green"
          delay={0.05}
        />
        <MetricCard
          title="Taxa de Sucesso"
          value={successRate ? `${successRate}%` : "—"}
          icon={TrendingUp}
          color="amber"
          delay={0.1}
        />
        <MetricCard
          title="Custo Total"
          value={`$${estimatedCost}`}
          subtitle="estimado"
          icon={DollarSign}
          color="default"
          delay={0.15}
        />
      </div>

      {/* Secondary Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <MetricCard
          title="Jobs Executando"
          value={stats?.runningJobs ?? 0}
          subtitle={`de ${stats?.totalJobs ?? 0} total`}
          icon={ListOrdered}
          color="blue"
          delay={0.2}
        />
        <MetricCard
          title="Contas Falhas"
          value={failedAccounts}
          icon={XCircle}
          color="red"
          delay={0.25}
        />
        <MetricCard
          title="Proxies Ativos"
          value={stats?.availableProxies ?? 0}
          icon={Globe}
          color="green"
          delay={0.3}
        />
      </div>

      {/* Tables Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Jobs */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35 }}
          className="rounded-xl border border-border bg-card"
        >
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground">Jobs Recentes</h2>
            <a href="/jobs" className="text-xs font-medium text-primary hover:text-primary/80 transition-colors">
              Ver todos
            </a>
          </div>
          <div className="divide-y divide-border">
            {!recentJobs || recentJobs.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-muted-foreground">
                Nenhum job encontrado
              </div>
            ) : (
              recentJobs.map((job) => (
                <div key={job.id} className="flex items-center justify-between px-5 py-3 hover:bg-ghost-surface-1/50 transition-colors">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium text-foreground">
                      Job #{job.id}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {job.completedAccounts}/{job.totalAccounts} contas
                      {job.createdAt && ` · ${formatDistanceToNow(new Date(job.createdAt), { addSuffix: true, locale: ptBR })}`}
                    </span>
                  </div>
                  <StatusBadge status={job.status} />
                </div>
              ))
            )}
          </div>
        </motion.div>

        {/* Recent Accounts */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="rounded-xl border border-border bg-card"
        >
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground">Contas Recentes</h2>
            <a href="/accounts" className="text-xs font-medium text-primary hover:text-primary/80 transition-colors">
              Ver todas
            </a>
          </div>
          <div className="divide-y divide-border">
            {!recentAccounts?.accounts || recentAccounts.accounts.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-muted-foreground">
                Nenhuma conta encontrada
              </div>
            ) : (
              recentAccounts.accounts.map((account) => (
                <div key={account.id} className="flex items-center justify-between px-5 py-3 hover:bg-ghost-surface-1/50 transition-colors">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs font-mono text-foreground">{account.email}</span>
                    <span className="text-xs text-muted-foreground">
                      {account.createdAt && formatDistanceToNow(new Date(account.createdAt), { addSuffix: true, locale: ptBR })}
                    </span>
                  </div>
                  <StatusBadge status={account.status} />
                </div>
              ))
            )}
          </div>
        </motion.div>
      </div>
    </div>
  );
}
