import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { type LucideIcon } from "lucide-react";

interface MetricCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: LucideIcon;
  trend?: { value: number; label: string };
  color?: "blue" | "green" | "amber" | "red" | "default";
  delay?: number;
}

const COLOR_MAP = {
  blue: { icon: "text-ghost-info bg-ghost-info/10", ring: "ring-ghost-info/20" },
  green: { icon: "text-ghost-success bg-ghost-success/10", ring: "ring-ghost-success/20" },
  amber: { icon: "text-ghost-warning bg-ghost-warning/10", ring: "ring-ghost-warning/20" },
  red: { icon: "text-ghost-error bg-ghost-error/10", ring: "ring-ghost-error/20" },
  default: { icon: "text-muted-foreground bg-muted", ring: "ring-border" },
};

export default function MetricCard({ title, value, subtitle, icon: Icon, trend, color = "default", delay = 0 }: MetricCardProps) {
  const colors = COLOR_MAP[color];

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay, ease: "easeOut" }}
      className={cn(
        "relative overflow-hidden rounded-xl border border-border bg-card p-5",
        "hover:border-border/80 transition-colors duration-200"
      )}
    >
      <div className="flex items-start justify-between">
        <div className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
          <div className="flex items-baseline gap-2">
            <motion.span
              className="text-3xl font-extrabold tracking-tight text-foreground font-mono"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: delay + 0.15 }}
            >
              {value}
            </motion.span>
            {subtitle && (
              <span className="text-sm text-muted-foreground">{subtitle}</span>
            )}
          </div>
          {trend && (
            <div className="flex items-center gap-1.5">
              <span className={cn(
                "text-xs font-semibold",
                trend.value >= 0 ? "text-ghost-success" : "text-ghost-error"
              )}>
                {trend.value >= 0 ? "+" : ""}{trend.value}%
              </span>
              <span className="text-xs text-muted-foreground">{trend.label}</span>
            </div>
          )}
        </div>
        <div className={cn("flex items-center justify-center w-10 h-10 rounded-lg", colors.icon)}>
          <Icon className="w-5 h-5" />
        </div>
      </div>
    </motion.div>
  );
}
