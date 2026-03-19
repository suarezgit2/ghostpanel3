import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { Plus, Trash2, Zap, Calculator, CheckCircle2, ExternalLink, FolderOpen, Layers } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Link } from "wouter";

const CREDITS_PER_ACCOUNT = 500;

/** Extract invite code from a full invitation link or return as-is if already a code */
function extractInviteCode(input: string): string {
  const trimmed = input.trim();
  const pathMatch = trimmed.match(/\/invitation\/([A-Za-z0-9]+)/);
  if (pathMatch) return pathMatch[1];
  const queryMatch = trimmed.match(/[?&]code=([A-Za-z0-9]+)/);
  if (queryMatch) return queryMatch[1];
  return trimmed;
}

interface Recipient {
  id: string;
  inviteCode: string;
  credits: string;
  label: string;
  jobCount: string;
}

function calcAccounts(credits: string): number {
  const n = parseInt(credits);
  if (!n || n < CREDITS_PER_ACCOUNT) return 0;
  return Math.floor(n / CREDITS_PER_ACCOUNT);
}

export default function QuickJob() {
  const [recipients, setRecipients] = useState<Recipient[]>([
    { id: crypto.randomUUID(), inviteCode: "", credits: "", label: "", jobCount: "1" },
  ]);
  const [result, setResult] = useState<{ jobIds: number[]; folderIds: number[]; summary: string } | null>(null);

  const quickJobMutation = trpc.jobs.quickJob.useMutation({
    onSuccess: (data) => {
      setResult(data);
      const folderCount = data.folderIds?.length ?? 0;
      if (folderCount > 0) {
        toast.success(`${data.jobIds.length} job(s) criado(s) em ${folderCount} pasta(s)!`);
      } else {
        toast.success(`${data.jobIds.length} job(s) criado(s) com sucesso!`);
      }
    },
    onError: (err) => {
      toast.error(`Erro: ${err.message}`);
    },
  });

  function addRecipient() {
    setRecipients(prev => [...prev, { id: crypto.randomUUID(), inviteCode: "", credits: "", label: "", jobCount: "1" }]);
  }

  function removeRecipient(id: string) {
    setRecipients(prev => prev.filter(r => r.id !== id));
  }

  function updateRecipient(id: string, field: keyof Recipient, value: string) {
    setRecipients(prev => prev.map(r => r.id === id ? { ...r, [field]: value } : r));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const validRecipients = recipients.filter(r => r.inviteCode.trim() && parseInt(r.credits) >= CREDITS_PER_ACCOUNT);

    if (validRecipients.length === 0) {
      toast.error("Adicione pelo menos um destinatário válido com código e créditos ≥ 500");
      return;
    }

    setResult(null);
    quickJobMutation.mutate({
      recipients: validRecipients.map(r => ({
        inviteCode: extractInviteCode(r.inviteCode),
        credits: parseInt(r.credits),
        label: r.label.trim() || undefined,
        jobCount: parseInt(r.jobCount) || 1,
      })),
    });
  }

  const totalAccounts = recipients.reduce((sum, r) => {
    const accounts = calcAccounts(r.credits);
    const jobCount = parseInt(r.jobCount) || 1;
    return sum + accounts * jobCount;
  }, 0);
  const totalCredits = recipients.reduce((sum, r) => {
    const credits = parseInt(r.credits) || 0;
    const jobCount = parseInt(r.jobCount) || 1;
    return sum + credits * jobCount;
  }, 0);
  const estimatedCost = totalAccounts * 0.0138;
  const totalJobs = recipients.reduce((sum, r) => sum + (parseInt(r.jobCount) || 1), 0);
  const hasFolders = recipients.some(r => (parseInt(r.jobCount) || 1) > 1);

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
          <Zap className="w-6 h-6 text-primary" />
          Job Rápido
        </h1>
        <p className="text-muted-foreground mt-1">
          Envie créditos para múltiplos destinatários. Cada conta envia {CREDITS_PER_ACCOUNT} créditos.
          Se criar mais de 1 job por destinatário, uma pasta será criada automaticamente.
        </p>
      </div>

      {result ? (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <Card className="border-green-500/30 bg-green-500/5">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-green-400">
                <CheckCircle2 className="w-5 h-5" />
                Jobs criados com sucesso!
              </CardTitle>
              <CardDescription>
                {result.jobIds.length} job(s) iniciado(s)
                {result.folderIds?.length > 0 && ` em ${result.folderIds.length} pasta(s)`}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {result.folderIds?.length > 0 && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground bg-background/50 rounded-lg px-3 py-2">
                  <FolderOpen className="w-4 h-4 text-primary shrink-0" />
                  <span>
                    {result.folderIds.length} pasta{result.folderIds.length !== 1 ? "s" : ""} criada{result.folderIds.length !== 1 ? "s" : ""} com os jobs agrupados por cliente
                  </span>
                </div>
              )}
              <div className="bg-background/50 rounded-lg p-4 font-mono text-sm text-muted-foreground whitespace-pre-wrap">
                {result.summary}
              </div>
              <div className="flex gap-3">
                <Link href="/jobs">
                  <Button variant="outline" className="gap-2">
                    <ExternalLink className="w-4 h-4" />
                    Ver Jobs
                  </Button>
                </Link>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setResult(null);
                    setRecipients([{ id: crypto.randomUUID(), inviteCode: "", credits: "", label: "", jobCount: "1" }]);
                  }}
                >
                  Novo Job Rápido
                </Button>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Destinatários</CardTitle>
              <CardDescription>
                Informe o código de convite, a quantidade de créditos e o número de jobs por destinatário.
                Se "Nº de Jobs" for maior que 1, uma pasta será criada com o nome do cliente.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <AnimatePresence>
                {recipients.map((recipient, index) => {
                  const jobCount = parseInt(recipient.jobCount) || 1;
                  const isMultiJob = jobCount > 1;
                  return (
                    <motion.div
                      key={recipient.id}
                      initial={{ opacity: 0, y: -8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, x: -20 }}
                      transition={{ duration: 0.15 }}
                      className={`p-3 rounded-lg border transition-colors ${isMultiJob ? "bg-primary/5 border-primary/30" : "bg-ghost-surface-2 border-border"}`}
                    >
                      {/* Row 1: Label, Invite Code, Credits, Remove */}
                      <div className="grid grid-cols-12 gap-3 items-end">
                        {/* Label */}
                        <div className="col-span-3">
                          {index === 0 && <Label className="text-xs mb-1.5 block text-muted-foreground">Nome do cliente</Label>}
                          <Input
                            placeholder="Ex: Joãozinho"
                            value={recipient.label}
                            onChange={(e) => updateRecipient(recipient.id, "label", e.target.value)}
                            className="h-9 text-sm"
                          />
                        </div>

                        {/* Invite Code */}
                        <div className="col-span-4">
                          {index === 0 && <Label className="text-xs mb-1.5 block text-muted-foreground">Código de convite *</Label>}
                          <Input
                            placeholder="Código ou link"
                            value={recipient.inviteCode}
                            onChange={(e) => updateRecipient(recipient.id, "inviteCode", e.target.value)}
                            className="h-9 text-sm font-mono"
                            required
                          />
                        </div>

                        {/* Credits */}
                        <div className="col-span-2">
                          {index === 0 && <Label className="text-xs mb-1.5 block text-muted-foreground">Créditos *</Label>}
                          <div className="relative">
                            <Input
                              type="number"
                              placeholder="5000"
                              min={500}
                              step={500}
                              value={recipient.credits}
                              onChange={(e) => updateRecipient(recipient.id, "credits", e.target.value)}
                              className="h-9 text-sm pr-10"
                              required
                            />
                            {calcAccounts(recipient.credits) > 0 && (
                              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-primary font-medium">
                                {calcAccounts(recipient.credits)}x
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Job Count */}
                        <div className="col-span-2">
                          {index === 0 && (
                            <Label className="text-xs mb-1.5 flex items-center gap-1 text-muted-foreground">
                              <Layers className="w-3 h-3" />
                              Nº de Jobs
                            </Label>
                          )}
                          <div className="relative">
                            <Input
                              type="number"
                              placeholder="1"
                              min={1}
                              max={20}
                              value={recipient.jobCount}
                              onChange={(e) => updateRecipient(recipient.id, "jobCount", e.target.value)}
                              className={`h-9 text-sm ${isMultiJob ? "border-primary/50 bg-primary/5 font-semibold text-primary" : ""}`}
                            />
                          </div>
                        </div>

                        {/* Remove */}
                        <div className="col-span-1 flex justify-end">
                          {recipients.length > 1 && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => removeRecipient(recipient.id)}
                              className="h-9 w-9 p-0 text-muted-foreground hover:text-destructive"
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          )}
                        </div>
                      </div>

                      {/* Multi-job indicator */}
                      {isMultiJob && (
                        <div className="mt-2 flex items-center gap-1.5 text-xs text-primary">
                          <FolderOpen className="w-3.5 h-3.5" />
                          <span>
                            Será criada uma pasta "{recipient.label || "Cliente"}" com {jobCount} jobs de {calcAccounts(recipient.credits)} conta{calcAccounts(recipient.credits) !== 1 ? "s" : ""} cada
                            {calcAccounts(recipient.credits) > 0 && ` (${jobCount * calcAccounts(recipient.credits)} contas no total)`}
                          </span>
                        </div>
                      )}
                    </motion.div>
                  );
                })}
              </AnimatePresence>

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addRecipient}
                className="gap-2 w-full border-dashed"
              >
                <Plus className="w-4 h-4" />
                Adicionar destinatário
              </Button>
            </CardContent>
          </Card>

          {/* Summary */}
          {totalAccounts > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <Card className="border-primary/20 bg-primary/5">
                <CardContent className="pt-4">
                  <div className="flex items-center gap-2 mb-3">
                    <Calculator className="w-4 h-4 text-primary" />
                    <span className="text-sm font-medium text-primary">Estimativa</span>
                  </div>
                  <div className="grid grid-cols-4 gap-2 text-center">
                    <div>
                      <p className="text-2xl font-bold text-foreground">{recipients.filter(r => r.inviteCode.trim()).length}</p>
                      <p className="text-xs text-muted-foreground">Destinatários</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-foreground">{totalJobs}</p>
                      <p className="text-xs text-muted-foreground">Jobs totais</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-foreground">{totalAccounts}</p>
                      <p className="text-xs text-muted-foreground">Contas a criar</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-foreground">${estimatedCost.toFixed(2)}</p>
                      <p className="text-xs text-muted-foreground">Custo estimado</p>
                    </div>
                  </div>
                  {hasFolders && (
                    <div className="mt-3 pt-3 border-t border-border flex items-center justify-center gap-1.5 text-xs text-primary">
                      <FolderOpen className="w-3.5 h-3.5" />
                      <span>Pastas serão criadas para destinatários com mais de 1 job</span>
                    </div>
                  )}
                  <div className="mt-2 pt-2 border-t border-border">
                    <p className="text-xs text-muted-foreground text-center">
                      {totalCredits.toLocaleString()} créditos totais · {totalAccounts} contas × $0.0138/conta
                    </p>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          )}

          <Button
            type="submit"
            className="w-full gap-2"
            size="lg"
            disabled={quickJobMutation.isPending || totalAccounts === 0}
          >
            {quickJobMutation.isPending ? (
              <>
                <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                Criando jobs...
              </>
            ) : (
              <>
                <Zap className="w-4 h-4" />
                Iniciar {totalJobs > 0 ? `${totalJobs} Job${totalJobs !== 1 ? "s" : ""}` : "Job Rápido"}
                {totalAccounts > 0 && ` (${totalAccounts} conta${totalAccounts !== 1 ? "s" : ""})`}
              </>
            )}
          </Button>
        </form>
      )}
    </div>
  );
}
