/**
 * Logs Page - Visualização de logs do sistema
 */

import { useState, useMemo } from "react";
import { motion } from "framer-motion";
import { RefreshCw, Filter, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type LogLevel = "info" | "warn" | "error" | "debug";

const LEVEL_COLORS: Record<string, string> = {
  info: "text-ghost-info",
  warn: "text-ghost-warning",
  error: "text-ghost-error",
  debug: "text-muted-foreground",
};

const LEVEL_BG: Record<string, string> = {
  info: "bg-ghost-info/10",
  warn: "bg-ghost-warning/10",
  error: "bg-ghost-error/10",
  debug: "bg-muted/50",
};

export default function Logs() {
  const [levelFilter, setLevelFilter] = useState<string>("all");
  const [page, setPage] = useState(1);

  const queryInput = useMemo(() => ({
    page,
    limit: 100,
    ...(levelFilter !== "all" ? { level: levelFilter as LogLevel } : {}),
  }), [page, levelFilter]);

  const { data, isLoading, refetch } = trpc.logs.list.useQuery(queryInput);
  const clearMutation = trpc.logs.clear.useMutation({
    onSuccess: () => { toast.success("Logs limpos"); refetch(); },
  });

  const logEntries = data?.logs ?? [];
  const count = data?.total ?? 0;
  const totalPages = Math.ceil(count / 100);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Logs</h1>
          <p className="text-sm text-muted-foreground mt-1">{count} entr{count !== 1 ? "adas" : "ada"}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => clearMutation.mutate()} className="gap-2 text-ghost-error">
            <Trash2 className="w-3.5 h-3.5" />
            Limpar
          </Button>
          <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-2">
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
            Atualizar
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <Filter className="w-4 h-4 text-muted-foreground" />
        <Select value={levelFilter} onValueChange={(v) => { setLevelFilter(v); setPage(1); }}>
          <SelectTrigger className="w-[160px] bg-ghost-surface-2 border-border">
            <SelectValue placeholder="Nível" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos</SelectItem>
            <SelectItem value="info">Info</SelectItem>
            <SelectItem value="warn">Warning</SelectItem>
            <SelectItem value="error">Error</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Log entries */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="rounded-xl border border-border bg-card overflow-hidden"
      >
        <div className="divide-y divide-border font-mono text-xs overflow-x-auto">
          {logEntries.length === 0 ? (
            <div className="px-5 py-12 text-center text-sm text-muted-foreground font-sans">
              {isLoading ? "Carregando..." : "Nenhum log encontrado"}
            </div>
          ) : (
            logEntries.map((log, i) => (
              <motion.div
                key={log.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: i * 0.01 }}
                className="flex items-start gap-2 px-4 py-2.5 hover:bg-ghost-surface-1/50 transition-colors min-w-0"
              >
                <span className="hidden sm:block text-muted-foreground shrink-0 w-[130px]">
                  {log.createdAt ? new Date(log.createdAt).toLocaleString("pt-BR", { hour12: false }) : "—"}
                </span>
                <span className={cn(
                  "shrink-0 w-[46px] px-1 py-0.5 rounded text-center font-semibold uppercase text-[10px]",
                  LEVEL_BG[log.level] || "bg-muted",
                  LEVEL_COLORS[log.level] || "text-muted-foreground"
                )}>
                  {log.level}
                </span>
                <span className="hidden md:block text-muted-foreground shrink-0 w-[120px] truncate">
                  {log.source || "—"}
                </span>
                <span className="text-foreground flex-1 break-all min-w-0">
                  {log.message}
                </span>
              </motion.div>
            ))
          )}
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
    </div>
  );
}
