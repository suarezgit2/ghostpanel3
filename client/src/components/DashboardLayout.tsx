/**
 * DashboardLayout - Mobile-first Design
 * - Mobile: bottom navigation bar (fixed) + hamburger menu drawer
 * - Desktop: collapsible sidebar (same as before)
 */

import { Link, useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import {
  LayoutDashboard,
  Play,
  Zap,
  ListOrdered,
  Users,
  Globe,
  ScrollText,
  Settings,
  Ghost,
  ChevronLeft,
  ChevronRight,
  Key,
  BookOpen,
  Shield,
  LogOut,
  Menu,
  X,
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const NAV_ITEMS = [
  { path: "/", label: "Dashboard", icon: LayoutDashboard },
  { path: "/create", label: "Criar Job", icon: Play },
  { path: "/quick-job", label: "Job Rápido", icon: Zap },
  { path: "/jobs", label: "Jobs", icon: ListOrdered },
  { path: "/accounts", label: "Contas", icon: Users },
  { path: "/proxies", label: "Proxies", icon: Globe },
  { path: "/logs", label: "Logs", icon: ScrollText },
  { path: "/keys", label: "Keys", icon: Key },
  { path: "/settings", label: "Configurações", icon: Settings },
  { path: "/api-docs", label: "API / Docs", icon: BookOpen },
  { path: "/api-tokens", label: "API Tokens", icon: Shield },
];

// Items shown in the bottom nav bar on mobile (most used)
const BOTTOM_NAV_ITEMS = [
  { path: "/", label: "Home", icon: LayoutDashboard },
  { path: "/jobs", label: "Jobs", icon: ListOrdered },
  { path: "/quick-job", label: "Job Rápido", icon: Zap },
  { path: "/accounts", label: "Contas", icon: Users },
];

interface DashboardLayoutProps {
  children: React.ReactNode;
  onLogout?: () => void;
}

export default function DashboardLayout({ children, onLogout }: DashboardLayoutProps) {
  const [location] = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden bg-background">

      {/* ===== DESKTOP SIDEBAR (hidden on mobile) ===== */}
      <aside
        className={cn(
          "hidden md:flex flex-col border-r border-border bg-ghost-surface-1 transition-all duration-300 ease-in-out shrink-0",
          collapsed ? "w-[68px]" : "w-[240px]"
        )}
      >
        {/* Logo */}
        <div className="flex items-center gap-3 px-4 h-16 border-b border-border">
          <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/10 shrink-0">
            <Ghost className="w-5 h-5 text-primary" />
          </div>
          {!collapsed && (
            <motion.div
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              className="flex flex-col overflow-hidden"
            >
              <span className="text-sm font-bold tracking-tight text-foreground">Ghost</span>
              <span className="text-[10px] font-medium text-muted-foreground tracking-wider uppercase">Panel</span>
            </motion.div>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 py-4 px-3 space-y-1 overflow-y-auto">
          {NAV_ITEMS.map((item) => {
            const isActive = location === item.path || (item.path !== "/" && location.startsWith(item.path));
            const Icon = item.icon;

            const linkContent = (
              <Link
                key={item.path}
                href={item.path}
                className={cn(
                  "relative flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200",
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:text-foreground hover:bg-ghost-surface-2"
                )}
              >
                <Icon className={cn("w-[18px] h-[18px] shrink-0", isActive && "text-primary")} />
                {!collapsed && (
                  <motion.span
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.05 }}
                  >
                    {item.label}
                  </motion.span>
                )}
                {isActive && (
                  <motion.div
                    layoutId="activeNav"
                    className="absolute left-0 w-[3px] h-6 bg-primary rounded-r-full"
                    transition={{ type: "spring", stiffness: 500, damping: 30 }}
                  />
                )}
              </Link>
            );

            if (collapsed) {
              return (
                <Tooltip key={item.path} delayDuration={0}>
                  <TooltipTrigger asChild>{linkContent}</TooltipTrigger>
                  <TooltipContent side="right" className="font-medium">
                    {item.label}
                  </TooltipContent>
                </Tooltip>
              );
            }

            return linkContent;
          })}
        </nav>

        {/* Bottom: Logout + Collapse */}
        <div className="p-3 border-t border-border space-y-1">
          {onLogout && (
            collapsed ? (
              <Tooltip delayDuration={0}>
                <TooltipTrigger asChild>
                  <button
                    onClick={onLogout}
                    className="flex items-center justify-center w-full py-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                  >
                    <LogOut className="w-4 h-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">Sair</TooltipContent>
              </Tooltip>
            ) : (
              <button
                onClick={onLogout}
                className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
              >
                <LogOut className="w-[18px] h-[18px] shrink-0" />
                <span>Sair</span>
              </button>
            )
          )}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="flex items-center justify-center w-full py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-ghost-surface-2 transition-colors"
          >
            {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>
        </div>
      </aside>

      {/* ===== MOBILE DRAWER OVERLAY ===== */}
      <AnimatePresence>
        {mobileMenuOpen && (
          <>
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-40 bg-black/60 md:hidden"
              onClick={() => setMobileMenuOpen(false)}
            />
            {/* Drawer */}
            <motion.div
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", stiffness: 400, damping: 40 }}
              className="fixed left-0 top-0 bottom-0 z-50 w-72 flex flex-col bg-ghost-surface-1 border-r border-border md:hidden"
            >
              {/* Drawer header */}
              <div className="flex items-center justify-between px-4 h-16 border-b border-border">
                <div className="flex items-center gap-3">
                  <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/10">
                    <Ghost className="w-5 h-5 text-primary" />
                  </div>
                  <div className="flex flex-col">
                    <span className="text-sm font-bold tracking-tight text-foreground">Ghost</span>
                    <span className="text-[10px] font-medium text-muted-foreground tracking-wider uppercase">Panel</span>
                  </div>
                </div>
                <button
                  onClick={() => setMobileMenuOpen(false)}
                  className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-ghost-surface-2 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Drawer nav */}
              <nav className="flex-1 py-4 px-3 space-y-1 overflow-y-auto">
                {NAV_ITEMS.map((item) => {
                  const isActive = location === item.path || (item.path !== "/" && location.startsWith(item.path));
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.path}
                      href={item.path}
                      onClick={() => setMobileMenuOpen(false)}
                      className={cn(
                        "relative flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-medium transition-all duration-200",
                        isActive
                          ? "bg-primary/10 text-primary"
                          : "text-muted-foreground hover:text-foreground hover:bg-ghost-surface-2"
                      )}
                    >
                      <Icon className={cn("w-5 h-5 shrink-0", isActive && "text-primary")} />
                      <span>{item.label}</span>
                      {isActive && (
                        <div className="absolute left-0 w-[3px] h-6 bg-primary rounded-r-full" />
                      )}
                    </Link>
                  );
                })}
              </nav>

              {/* Drawer footer */}
              {onLogout && (
                <div className="p-3 border-t border-border">
                  <button
                    onClick={() => { onLogout(); setMobileMenuOpen(false); }}
                    className="flex items-center gap-3 w-full px-3 py-3 rounded-lg text-sm font-medium text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                  >
                    <LogOut className="w-5 h-5 shrink-0" />
                    <span>Sair</span>
                  </button>
                </div>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* ===== MAIN CONTENT ===== */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Mobile top bar */}
        <header className="md:hidden flex items-center justify-between px-4 h-14 border-b border-border bg-ghost-surface-1 shrink-0">
          <button
            onClick={() => setMobileMenuOpen(true)}
            className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-ghost-surface-2 transition-colors"
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2">
            <Ghost className="w-5 h-5 text-primary" />
            <span className="text-sm font-bold text-foreground">Ghost Panel</span>
          </div>
          <div className="w-9" /> {/* spacer */}
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto pb-20 md:pb-0">
          <AnimatePresence mode="wait">
            <motion.div
              key={location}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="p-4 md:p-6 lg:p-8"
            >
              {children}
            </motion.div>
          </AnimatePresence>
        </main>

        {/* ===== MOBILE BOTTOM NAV BAR ===== */}
        <nav className="md:hidden fixed bottom-0 left-0 right-0 z-30 flex items-center bg-ghost-surface-1 border-t border-border safe-area-bottom">
          {BOTTOM_NAV_ITEMS.map((item) => {
            const isActive = location === item.path || (item.path !== "/" && location.startsWith(item.path));
            const Icon = item.icon;
            return (
              <Link
                key={item.path}
                href={item.path}
                className={cn(
                  "flex-1 flex flex-col items-center justify-center py-2 gap-1 text-[10px] font-medium transition-colors",
                  isActive ? "text-primary" : "text-muted-foreground"
                )}
              >
                <Icon className={cn("w-5 h-5", isActive && "text-primary")} />
                <span>{item.label}</span>
              </Link>
            );
          })}
          {/* More button */}
          <button
            onClick={() => setMobileMenuOpen(true)}
            className="flex-1 flex flex-col items-center justify-center py-2 gap-1 text-[10px] font-medium text-muted-foreground"
          >
            <Menu className="w-5 h-5" />
            <span>Mais</span>
          </button>
        </nav>
      </div>
    </div>
  );
}
