/**
 * Create Job Page - Formulário para criar novos jobs de criação de contas
 */

import { useState } from "react";
import { useLocation } from "wouter";
import { motion } from "framer-motion";
import { Play, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

export default function CreateJob() {
  const [, navigate] = useLocation();
  const [form, setForm] = useState({
    provider: "manus",
    quantity: 1,
    password: "auto",
    customPassword: "",
    region: "default",
  });

  const { data: providers } = trpc.settings.listProviders.useQuery();
  const createJobMutation = trpc.jobs.create.useMutation({
    onSuccess: (data) => {
      toast.success("Job criado com sucesso!", {
        description: `${form.quantity} conta(s) via ${form.provider} — Job #${data.jobId}`,
      });
      navigate("/jobs");
    },
    onError: (err) => {
      toast.error("Erro ao criar job", { description: err.message });
    },
  });

  const estimatedCost = (form.quantity * 0.0138).toFixed(4);
  const estimatedTime = Math.ceil(form.quantity * 1.5);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const password = form.password === "custom" ? form.customPassword : undefined;
    createJobMutation.mutate({
      provider: form.provider,
      quantity: form.quantity,
      password,
      region: form.region,
    });
  };

  return (
    <div className="max-w-2xl space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Criar Job</h1>
        <p className="text-sm text-muted-foreground mt-1">Configure e inicie a criação de contas</p>
      </div>

      {/* Form */}
      <motion.form
        onSubmit={handleSubmit}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="space-y-6"
      >
        {/* Provider */}
        <div className="rounded-xl border border-border bg-card p-6 space-y-5">
          <h2 className="text-sm font-semibold text-foreground">Configuração do Job</h2>

          <div className="space-y-2">
            <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Provider</Label>
            <Select value={form.provider} onValueChange={(v) => setForm({ ...form, provider: v })}>
              <SelectTrigger className="bg-ghost-surface-2 border-border">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providers && providers.length > 0 ? (
                  providers.map((p) => (
                    <SelectItem key={p.slug} value={p.slug}>
                      {p.name}
                    </SelectItem>
                  ))
                ) : (
                  <SelectItem value="manus">Manus.im</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Quantidade de Contas</Label>
            <Input
              type="number"
              min={1}
              max={1000}
              value={form.quantity}
              onChange={(e) => setForm({ ...form, quantity: parseInt(e.target.value) || 1 })}
              className="bg-ghost-surface-2 border-border font-mono"
            />
            <p className="text-xs text-muted-foreground">Máximo: 1000 contas por job</p>
          </div>

          <div className="space-y-2">
            <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Senha</Label>
            <Select value={form.password} onValueChange={(v) => setForm({ ...form, password: v })}>
              <SelectTrigger className="bg-ghost-surface-2 border-border">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Gerar automaticamente</SelectItem>
                <SelectItem value="custom">Senha personalizada</SelectItem>
              </SelectContent>
            </Select>
            {form.password === "custom" && (
              <Input
                type="text"
                placeholder="Digite a senha..."
                value={form.customPassword}
                onChange={(e) => setForm({ ...form, customPassword: e.target.value })}
                className="bg-ghost-surface-2 border-border font-mono mt-2"
              />
            )}
          </div>

          <div className="space-y-2">
            <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Região do Fingerprint</Label>
            <Select value={form.region} onValueChange={(v) => setForm({ ...form, region: v })}>
              <SelectTrigger className="bg-ghost-surface-2 border-border">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Misto (padrão)</SelectItem>
                <SelectItem value="us">Estados Unidos</SelectItem>
                <SelectItem value="br">Brasil</SelectItem>
                <SelectItem value="eu">Europa</SelectItem>
                <SelectItem value="asia">Ásia</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Estimation */}
        <div className="rounded-xl border border-border bg-card p-6">
          <div className="flex items-center gap-2 mb-4">
            <Info className="w-4 h-4 text-ghost-info" />
            <h2 className="text-sm font-semibold text-foreground">Estimativa</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <p className="text-xs text-muted-foreground mb-1">Custo estimado</p>
              <p className="text-lg font-bold font-mono text-foreground">${estimatedCost}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Tempo estimado</p>
              <p className="text-lg font-bold font-mono text-foreground">{estimatedTime} min</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Custo/conta</p>
              <p className="text-lg font-bold font-mono text-foreground">$0.0138</p>
            </div>
          </div>
        </div>

        {/* Submit */}
        <Button
          type="submit"
          disabled={createJobMutation.isPending || form.quantity < 1}
          className="w-full h-12 text-sm font-semibold"
        >
          {createJobMutation.isPending ? (
            <span className="flex items-center gap-2">
              <span className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
              Criando job...
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <Play className="w-4 h-4" />
              Iniciar Criação de {form.quantity} Conta{form.quantity > 1 ? "s" : ""}
            </span>
          )}
        </Button>
      </motion.form>
    </div>
  );
}
