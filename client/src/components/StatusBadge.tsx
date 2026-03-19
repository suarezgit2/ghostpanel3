import { cn } from "@/lib/utils";

const STATUS_CONFIG: Record<string, { color: string; bg: string; dot: string; label: string }> = {
  active: { color: "text-ghost-success", bg: "bg-ghost-success/10", dot: "bg-ghost-success", label: "Ativa" },
  running: { color: "text-ghost-info", bg: "bg-ghost-info/10", dot: "bg-ghost-info", label: "Executando" },
  completed: { color: "text-ghost-success", bg: "bg-ghost-success/10", dot: "bg-ghost-success", label: "Concluído" },
  failed: { color: "text-ghost-error", bg: "bg-ghost-error/10", dot: "bg-ghost-error", label: "Falhou" },
  pending: { color: "text-ghost-warning", bg: "bg-ghost-warning/10", dot: "bg-ghost-warning", label: "Pendente" },
  cancelled: { color: "text-muted-foreground", bg: "bg-muted/50", dot: "bg-muted-foreground", label: "Cancelado" },
  bad: { color: "text-ghost-error", bg: "bg-ghost-error/10", dot: "bg-ghost-error", label: "Ruim" },
};

interface StatusBadgeProps {
  status: string;
  className?: string;
  showDot?: boolean;
}

export default function StatusBadge({ status, className, showDot = true }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.pending;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold",
        config.bg,
        config.color,
        className
      )}
    >
      {showDot && (
        <span
          className={cn(
            "w-1.5 h-1.5 rounded-full",
            config.dot,
            status === "running" && "status-pulse"
          )}
        />
      )}
      {config.label}
    </span>
  );
}
