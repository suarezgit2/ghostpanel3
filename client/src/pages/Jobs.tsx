/**
 * Jobs Page - Lista de todos os jobs com filtros e ações
 * Suporta visualização em pastas para jobs agrupados por cliente
 */

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, RefreshCw, Trash2, Eye, AlertTriangle, X, FolderOpen, FolderClosed, ChevronDown, ChevronRight, Layers } from "lucide-react";
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

/** Derives a combined status for a folder based on its jobs */
function getFolderStatus(folderJobs: { status: string }[]): string {
  if (folderJobs.length === 0) return "pending";
  const statuses = folderJobs.map(j => j.status);
  if (statuses.some(s => s === "running")) return "running";
  if (statuses.some(s => s === "paused")) return "paused";
  if (statuses.every(s => s === "completed")) return "completed";
  if (statuses.every(s => s === "partial")) return "partial";
  if (statuses.every(s => s === "failed")) return "failed";
  if (statuses.every(s => s === "cancelled")) return "cancelled";
  if (statuses.some(s => s === "partial")) return "partial";
  if (statuses.some(s => s === "completed")) return "completed";
  return "pending";
}

/** Inline job row used inside folders and standalone */
function JobRow({
  job,
  onCancel,
  onDelete,
  cancelPending,
  deletePending,
  indent = false,
}: {
  job: {
    id: number;
    status: string;
    totalAccounts: number;
    completedAccounts: number;
    failedAccounts: number;
    createdAt: Date | null;
    config?: unknown;
  };
  onCancel: (id: number) => void;
  onDelete: (id: number) => void;
  cancelPending: boolean;
  deletePending: boolean;
  indent?: boolean;
}) {
  const isDeletable = ["completed", "partial", "failed", "cancelled"].includes(job.status);
  const label = (job.config as any)?.label;

  return (
    <motion.tr
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="hover:bg-ghost-surface-1/50 transition-colors"
    >
      <td className="px-5 py-3.5">
        <div className={cn("flex flex-col", indent && "pl-5")}>
          <span className="text-sm font-medium text-foreground">Job #{job.id}</span>
          {label && (
            <span className="text-xs text-muted-foreground truncate max-w-[180px]" title={label}>{label}</span>
          )}
        </div>
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
              onClick={() => onCancel(job.id)}
              disabled={cancelPending}
            >
              <X className="w-3.5 h-3.5" />
            </Button>
          )}
          {isDeletable && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              onClick={() => onDelete(job.id)}
              disabled={deletePending}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
      </td>
    </motion.tr>
  );
}

/** Folder row that expands to show its jobs */
function FolderRow({
  folder,
  onDeleteFolder,
  onCancelJob,
  onDeleteJob,
  cancelPending,
  deletePending,
  deleteFolderPending,
}: {
  folder: {
    id: number;
    clientName: string;
    inviteCode: string;
    totalJobs: number;
    createdAt: Date;
    jobs: {
      id: number;
      status: string;
      totalAccounts: number;
      completedAccounts: number;
      failedAccounts: number;
      createdAt: Date | null;
      config?: unknown;
    }[];
  };
  onDeleteFolder: (id: number) => void;
  onCancelJob: (id: number) => void;
  onDeleteJob: (id: number) => void;
  cancelPending: boolean;
  deletePending: boolean;
  deleteFolderPending: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const folderStatus = getFolderStatus(folder.jobs);
  const totalAccounts = folder.jobs.reduce((s, j) => s + j.totalAccounts, 0);
  const completedAccounts = folder.jobs.reduce((s, j) => s + j.completedAccounts, 0);
  const isDeletable = folder.jobs.every(j => ["completed", "partial", "failed", "cancelled"].includes(j.status));

  return (
    <>
      {/* Folder header row */}
      <tr
        className="bg-ghost-surface-1 hover:bg-ghost-surface-2 transition-colors cursor-pointer select-none"
        onClick={() => setExpanded(e => !e)}
      >
        <td className="px-5 py-3" colSpan={5}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">
                {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </span>
              {expanded
                ? <FolderOpen className="w-4 h-4 text-primary" />
                : <FolderClosed className="w-4 h-4 text-primary" />
              }
              <span className="text-sm font-semibold text-foreground">{folder.clientName}</span>
              <span className="text-xs text-muted-foreground bg-ghost-surface-3 rounded px-1.5 py-0.5 flex items-center gap-1">
                <Layers className="w-3 h-3" />
                {folder.jobs.length} job{folder.jobs.length !== 1 ? "s" : ""}
              </span>
              <StatusBadge status={folderStatus} />
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground font-mono">
                {completedAccounts}/{totalAccounts} contas
              </span>
              <span className="text-xs text-muted-foreground">
                {formatDistanceToNow(new Date(folder.createdAt), { addSuffix: true, locale: ptBR })}
              </span>
              {isDeletable && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  onClick={(e) => { e.stopPropagation(); onDeleteFolder(folder.id); }}
                  disabled={deleteFolderPending}
                  title="Deletar pasta e todos os jobs"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              )}
            </div>
          </div>
        </td>
      </tr>

      {/* Folder jobs (expanded) */}
      <AnimatePresence>
        {expanded && folder.jobs.map((job) => (
          <JobRow
            key={job.id}
            job={job}
            onCancel={onCancelJob}
            onDelete={onDeleteJob}
            cancelPending={cancelPending}
            deletePending={deletePending}
            indent={true}
          />
        ))}
      </AnimatePresence>
    </>
  );
}

export default function Jobs() {
  const { data: jobs, isLoading, refetch } = trpc.jobs.list.useQuery();
  const { data: folders, refetch: refetchFolders } = trpc.jobs.listFolders.useQuery();

  // Confirm dialog state
  const [confirmDelete, setConfirmDelete] = useState<
    | { type: "single"; id: number }
    | { type: "bulk"; statuses: string[] }
    | { type: "folder"; id: number; name: string }
    | null
  >(null);

  const cancelMutation = trpc.jobs.cancel.useMutation({
    onSuccess: () => { toast.success("Job cancelado"); refetch(); refetchFolders(); },
    onError: (err) => toast.error("Erro ao cancelar job", { description: err.message }),
  });

  const deleteMutation = trpc.jobs.delete.useMutation({
    onSuccess: () => { toast.success("Job deletado"); refetch(); refetchFolders(); setConfirmDelete(null); },
    onError: (err) => { toast.error("Erro ao deletar job", { description: err.message }); setConfirmDelete(null); },
  });

  const deleteCompletedMutation = trpc.jobs.deleteCompleted.useMutation({
    onSuccess: (data) => {
      toast.success(`${data.deleted} job(s) deletado(s)`);
      refetch();
      refetchFolders();
      setConfirmDelete(null);
    },
    onError: (err) => { toast.error("Erro ao deletar jobs", { description: err.message }); setConfirmDelete(null); },
  });

  const deleteFolderMutation = trpc.jobs.deleteFolder.useMutation({
    onSuccess: (data) => {
      toast.success(`Pasta deletada (${data.deletedJobs} job(s) removido(s))`);
      refetch();
      refetchFolders();
      setConfirmDelete(null);
    },
    onError: (err) => { toast.error("Erro ao deletar pasta", { description: err.message }); setConfirmDelete(null); },
  });

  // IDs of jobs that belong to a folder (to exclude from standalone list)
  const folderJobIds = new Set(
    (folders ?? []).flatMap(f => f.jobs.map(j => j.id))
  );

  // Standalone jobs = jobs not in any folder
  const standaloneJobs = (jobs ?? []).filter(j => !folderJobIds.has(j.id));

  const count = jobs?.length ?? 0;
  const deletableCount = jobs?.filter((j) => ["completed", "partial", "failed", "cancelled"].includes(j.status)).length ?? 0;
  const folderCount = folders?.length ?? 0;

  const handleConfirm = () => {
    if (!confirmDelete) return;
    if (confirmDelete.type === "single") {
      deleteMutation.mutate({ id: confirmDelete.id });
    } else if (confirmDelete.type === "folder") {
      deleteFolderMutation.mutate({ id: confirmDelete.id });
    } else {
      deleteCompletedMutation.mutate({ statuses: confirmDelete.statuses as any });
    }
  };

  const isConfirmLoading = deleteMutation.isPending || deleteCompletedMutation.isPending || deleteFolderMutation.isPending;

  return (
    <div className="space-y-6">
      {/* Confirm dialog */}
      <AnimatePresence>
        {confirmDelete && (
          <ConfirmDialog
            open={true}
            title={
              confirmDelete.type === "single" ? "Deletar job?" :
              confirmDelete.type === "folder" ? `Deletar pasta "${confirmDelete.name}"?` :
              "Deletar jobs?"
            }
            description={
              confirmDelete.type === "single"
                ? "Esta ação é irreversível. O job e todas as contas associadas serão removidos permanentemente."
                : confirmDelete.type === "folder"
                ? `Isso vai deletar a pasta "${confirmDelete.name}" e todos os jobs dentro dela, junto com suas contas. Esta ação é irreversível.`
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
            {folderCount > 0 && (
              <span className="ml-2 text-muted-foreground/60">· {folderCount} pasta{folderCount !== 1 ? "s" : ""}</span>
            )}
            {deletableCount > 0 && (
              <span className="ml-2 text-muted-foreground/60">· {deletableCount} finalizado{deletableCount !== 1 ? "s" : ""}</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={() => { refetch(); refetchFolders(); }} className="gap-2">
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
                  onClick={() => setConfirmDelete({ type: "bulk", statuses: ["completed", "partial", "failed", "cancelled"] })}
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
                  onClick={() => setConfirmDelete({ type: "bulk", statuses: ["partial"] })}
                >
                  Apenas parciais
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
                <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">ID / Nome</th>
                <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Progresso</th>
                <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Status</th>
                <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Criado</th>
                <th className="text-right px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading ? (
                <tr>
                  <td colSpan={5} className="px-5 py-12 text-center text-sm text-muted-foreground">
                    Carregando...
                  </td>
                </tr>
              ) : (
                <>
                  {/* Folder rows */}
                  {(folders ?? []).map((folder) => (
                    <FolderRow
                      key={`folder-${folder.id}`}
                      folder={folder}
                      onDeleteFolder={(id) => setConfirmDelete({ type: "folder", id, name: folder.clientName })}
                      onCancelJob={(id) => cancelMutation.mutate({ id })}
                      onDeleteJob={(id) => setConfirmDelete({ type: "single", id })}
                      cancelPending={cancelMutation.isPending}
                      deletePending={deleteMutation.isPending}
                      deleteFolderPending={deleteFolderMutation.isPending}
                    />
                  ))}

                  {/* Standalone jobs (not in any folder) */}
                  {standaloneJobs.map((job, i) => (
                    <JobRow
                      key={job.id}
                      job={job}
                      onCancel={(id) => cancelMutation.mutate({ id })}
                      onDelete={(id) => setConfirmDelete({ type: "single", id })}
                      cancelPending={cancelMutation.isPending}
                      deletePending={deleteMutation.isPending}
                    />
                  ))}

                  {/* Empty state */}
                  {(folders ?? []).length === 0 && standaloneJobs.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-5 py-12 text-center text-sm text-muted-foreground">
                        Nenhum job encontrado
                      </td>
                    </tr>
                  )}
                </>
              )}
            </tbody>
          </table>
        </div>
      </motion.div>
    </div>
  );
}
