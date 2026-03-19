/**
 * Proxies Page - Gerenciamento de proxies Webshare
 * Updated: single-use proxy policy with auto-replacement
 */

import { useState, useMemo } from "react";
import { motion } from "framer-motion";
import {
  RefreshCw, Download, Globe, CheckCircle2, XCircle,
  RotateCcw, Search, Filter, Activity, ArrowUpDown,
  ShieldAlert, ShieldCheck, Zap
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type FilterType = "all" | "available" | "used";
type SortType = "id" | "failCount" | "lastUsed";

export default function Proxies() {
  const [filter, setFilter] = useState<FilterType>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortType>("id");
  const [sortAsc, setSortAsc] = useState(true);

  const { data: proxies, isLoading, refetch } = trpc.proxies.list.useQuery(undefined, {
    refetchInterval: 10000,
  });
  const { data: stats, refetch: refetchStats } = trpc.proxies.stats.useQuery(undefined, {
    refetchInterval: 10000,
  });

  const syncMutation = trpc.proxies.sync.useMutation({
    onSuccess: (data) => {
      toast.success(`${data.synced} proxies sincronizados!`);
      refetch();
      refetchStats();
    },
    onError: (err) => toast.error("Erro ao sincronizar", { description: err.message }),
  });

  const toggleMutation = trpc.proxies.toggle.useMutation({
    onSuccess: () => { refetch(); refetchStats(); },
    onError: (err) => toast.error("Erro ao alterar proxy", { description: err.message }),
  });

  const resetMutation = trpc.proxies.resetFails.useMutation({
    onSuccess: () => {
      toast.success("Todos os proxies foram resetados e estão disponíveis novamente");
      refetch();
      refetchStats();
    },
    onError: (err) => toast.error("Erro ao resetar", { description: err.message }),
  });

  const replaceMutation = trpc.proxies.replaceAll.useMutation({
    onSuccess: (data) => {
      toast.success(`${data.replaced} proxies substituídos via Webshare!`);
      refetch();
      refetchStats();
    },
    onError: (err) => toast.error("Erro ao substituir proxies", { description: err.message }),
  });

  // Filter + search + sort
  const filteredProxies = useMemo(() => {
    if (!proxies) return [];

    let result = [...proxies];

    // Filter by status
    if (filter === "available") result = result.filter(p => p.enabled && !p.lastUsedAt);
    else if (filter === "used") result = result.filter(p => !p.enabled || p.lastUsedAt);

    // Search by host
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(p => p.host.toLowerCase().includes(q) || String(p.port).includes(q));
    }

    // Sort
    result.sort((a, b) => {
      let diff = 0;
      if (sort === "id") diff = a.id - b.id;
      else if (sort === "failCount") diff = a.failCount - b.failCount;
      else if (sort === "lastUsed") {
        const aTime = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
        const bTime = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
        diff = aTime - bTime;
      }
      return sortAsc ? diff : -diff;
    });

    return result;
  }, [proxies, filter, search, sort, sortAsc]);

  function toggleSort(newSort: SortType) {
    if (sort === newSort) setSortAsc(!sortAsc);
    else { setSort(newSort); setSortAsc(true); }
  }

  const available = stats?.available ?? 0;
  const used = stats?.used ?? 0;
  const total = stats?.total ?? 0;
  const isReplacing = stats?.isReplacing ?? false;
  const queueLength = stats?.queueLength ?? 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Proxies</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Cada proxy é usado apenas 1 vez e substituído automaticamente
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (confirm("Resetar todos os proxies? Isso marca todos como disponíveis novamente (útil para testes).")) {
                resetMutation.mutate();
              }
            }}
            disabled={resetMutation.isPending}
            className="gap-2"
          >
            <RotateCcw className={cn("w-3.5 h-3.5", resetMutation.isPending && "animate-spin")} />
            Resetar
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { refetch(); refetchStats(); }}
            className="gap-2"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", isLoading && "animate-spin")} />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (confirm("Substituir TODOS os proxies via Webshare? Isso pode levar alguns minutos.")) {
                replaceMutation.mutate();
              }
            }}
            disabled={replaceMutation.isPending || isReplacing}
            className="gap-2"
          >
            <ShieldAlert className={cn("w-3.5 h-3.5", (replaceMutation.isPending || isReplacing) && "animate-pulse text-yellow-400")} />
            {isReplacing ? "Substituindo..." : "Replace Todos"}
          </Button>
          <Button
            size="sm"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
            className="gap-2"
          >
            <Download className={cn("w-3.5 h-3.5", syncMutation.isPending && "animate-spin")} />
            Sincronizar
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-4 gap-4">
        <div className="rounded-xl border border-border bg-card p-4 flex items-center gap-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-blue-500/10">
            <Globe className="w-4 h-4 text-blue-400" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Total</p>
            <p className="text-lg font-bold font-mono text-foreground">{total}</p>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 flex items-center gap-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-green-500/10">
            <CheckCircle2 className="w-4 h-4 text-green-400" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Disponíveis</p>
            <p className="text-lg font-bold font-mono text-foreground">{available}</p>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 flex items-center gap-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-orange-500/10">
            <XCircle className="w-4 h-4 text-orange-400" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Usados</p>
            <p className="text-lg font-bold font-mono text-foreground">{used}</p>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 flex items-center gap-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-purple-500/10">
            <Zap className="w-4 h-4 text-purple-400" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Fila de replace</p>
            <div className="flex items-center gap-2">
              <p className="text-lg font-bold font-mono text-foreground">{queueLength}</p>
              {isReplacing && (
                <Badge variant="outline" className="text-[10px] text-yellow-400 border-yellow-400/30 animate-pulse">
                  Substituindo
                </Badge>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Pool status bar */}
      {total > 0 && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-muted-foreground">Pool de proxies — uso único</span>
            <span className="text-xs font-mono text-foreground">
              {available} disponíveis / {used} usados / {total} total
            </span>
          </div>
          <div className="h-2 bg-ghost-surface-2 rounded-full overflow-hidden flex">
            <motion.div
              className="h-full bg-green-500 rounded-l-full"
              initial={{ width: 0 }}
              animate={{ width: total > 0 ? `${(available / total) * 100}%` : "0%" }}
              transition={{ duration: 0.5 }}
            />
            <motion.div
              className="h-full bg-orange-500"
              initial={{ width: 0 }}
              animate={{ width: total > 0 ? `${(used / total) * 100}%` : "0%" }}
              transition={{ duration: 0.5 }}
            />
          </div>
          <div className="flex items-center gap-4 mt-2">
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-green-500" />
              <span className="text-xs text-muted-foreground">Disponível</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-orange-500" />
              <span className="text-xs text-muted-foreground">Usado (aguardando replace)</span>
            </div>
          </div>
          {isReplacing && (
            <p className="text-xs text-yellow-400 mt-2 flex items-center gap-1">
              <Activity className="w-3 h-3 animate-pulse" />
              Substituição automática em andamento...
            </p>
          )}
        </div>
      )}

      {/* Filters + Search */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por host ou porta..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9 text-sm"
          />
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-border bg-ghost-surface-1 p-1">
          {(["all", "available", "used"] as FilterType[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "px-3 py-1 rounded-md text-xs font-medium transition-colors",
                filter === f
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {f === "all" ? "Todos" : f === "available" ? "Disponíveis" : "Usados"}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Filter className="w-3.5 h-3.5" />
          <span>{filteredProxies.length} de {proxies?.length ?? 0}</span>
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
              <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Host</th>
              <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Porta</th>
              <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">País</th>
              <th
                className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground cursor-pointer hover:text-foreground"
                onClick={() => toggleSort("failCount")}
              >
                <span className="flex items-center gap-1">
                  Falhas
                  <ArrowUpDown className="w-3 h-3" />
                </span>
              </th>
              <th
                className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground cursor-pointer hover:text-foreground"
                onClick={() => toggleSort("lastUsed")}
              >
                <span className="flex items-center gap-1">
                  Usado em
                  <ArrowUpDown className="w-3 h-3" />
                </span>
              </th>
              <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Status</th>
              <th className="text-right px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Ação</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {!filteredProxies || filteredProxies.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-5 py-12 text-center text-sm text-muted-foreground">
                  {isLoading ? "Carregando..." : search ? "Nenhum proxy encontrado para esta busca" : "Nenhum proxy. Clique em \"Sincronizar\" para importar."}
                </td>
              </tr>
            ) : (
              filteredProxies.map((proxy, i) => {
                const isUsed = !proxy.enabled || !!proxy.lastUsedAt;
                return (
                  <motion.tr
                    key={proxy.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: Math.min(i * 0.01, 0.3) }}
                    className={cn(
                      "hover:bg-ghost-surface-1/50 transition-colors group",
                      isUsed && "opacity-50"
                    )}
                  >
                    <td className="px-5 py-3">
                      <span className="text-xs font-mono text-foreground">{proxy.host}</span>
                    </td>
                    <td className="px-5 py-3">
                      <span className="text-xs font-mono text-muted-foreground">{proxy.port}</span>
                    </td>
                    <td className="px-5 py-3">
                      <span className="text-xs text-muted-foreground">{proxy.country || "—"}</span>
                    </td>
                    <td className="px-5 py-3">
                      <span className={cn(
                        "text-xs font-mono",
                        proxy.failCount >= 5 ? "text-red-400" : proxy.failCount >= 2 ? "text-yellow-400" : "text-muted-foreground"
                      )}>
                        {proxy.failCount}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <span className="text-xs text-muted-foreground">
                        {proxy.lastUsedAt
                          ? new Date(proxy.lastUsedAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
                          : "—"}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      {isUsed ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-orange-500/10 text-orange-400">
                          <XCircle className="w-3 h-3" /> Usado
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-green-500/10 text-green-400">
                          <ShieldCheck className="w-3 h-3" /> Disponível
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => toggleMutation.mutate({ id: proxy.id, enabled: !proxy.enabled })}
                        disabled={toggleMutation.isPending}
                      >
                        {proxy.enabled ? "Desativar" : "Reativar"}
                      </Button>
                    </td>
                  </motion.tr>
                );
              })
            )}
          </tbody>
        </table>
      </motion.div>
    </div>
  );
}
