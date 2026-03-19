/**
 * RedeemKey - Página pública para resgate de chaves de créditos
 */

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Ghost, Key, CheckCircle2, AlertCircle, Coins, Loader2, Clock, Info } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

type Step = "input" | "confirm" | "success" | "error";

function extractInviteCode(input: string): string {
  const trimmed = input.trim();
  const pathMatch = trimmed.match(/\/invitation\/([A-Za-z0-9]+)/);
  if (pathMatch) return pathMatch[1];
  const queryMatch = trimmed.match(/[?&]code=([A-Za-z0-9]+)/);
  if (queryMatch) return queryMatch[1];
  return trimmed;
}

export default function RedeemKey() {
  const [step, setStep] = useState<Step>("input");
  const [code, setCode] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [name, setName] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [successCredits, setSuccessCredits] = useState(0);

  const checkQuery = trpc.keys.check.useQuery(
    { code: code.toUpperCase() },
    { enabled: false }
  );

  const redeemMutation = trpc.keys.redeem.useMutation({
    onSuccess: (data) => {
      setSuccessCredits(data.credits);
      setStep("success");
    },
    onError: (err) => {
      setErrorMsg(err.message);
      setStep("error");
    },
  });

  async function handleCheckCode(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;

    const result = await checkQuery.refetch();
    const data = result.data;

    if (!data?.valid) {
      setErrorMsg(data?.error || "Chave inválida");
      setStep("error");
    } else {
      setStep("confirm");
    }
  }

  function handleRedeem(e: React.FormEvent) {
    e.preventDefault();
    redeemMutation.mutate({
      code: code.toUpperCase(),
      inviteCode: extractInviteCode(inviteCode),
      name: name.trim() || undefined,
    });
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md"
      >
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 mb-4">
            <Ghost className="w-8 h-8 text-primary" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">Resgatar Créditos</h1>
          <p className="text-sm text-muted-foreground mt-1">Insira sua chave para receber créditos</p>
        </div>

        <div className="bg-ghost-surface-1 border border-border rounded-xl p-6 shadow-lg">
          <AnimatePresence mode="wait">
            {/* Step 1: Enter code */}
            {step === "input" && (
              <motion.form
                key="input"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onSubmit={handleCheckCode}
                className="space-y-4"
              >
                <div className="space-y-2">
                  <Label htmlFor="code">Chave de acesso</Label>
                  <div className="relative">
                    <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      id="code"
                      value={code}
                      onChange={(e) => setCode(e.target.value.toUpperCase())}
                      placeholder="GHOST-XXXX-XXXX-XXXX"
                      className="pl-9 font-mono tracking-wider"
                      autoFocus
                      required
                    />
                  </div>
                </div>
                <Button type="submit" className="w-full" disabled={checkQuery.isFetching || !code}>
                  {checkQuery.isFetching ? (
                    <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Verificando...</>
                  ) : "Verificar Chave"}
                </Button>
              </motion.form>
            )}

            {/* Step 2: Confirm + invite code */}
            {step === "confirm" && checkQuery.data?.valid && (
              <motion.form
                key="confirm"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onSubmit={handleRedeem}
                className="space-y-4"
              >
                {/* Key info */}
                <div className="p-4 rounded-lg bg-primary/5 border border-primary/20">
                  <div className="flex items-center gap-3">
                    <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-primary/10">
                      <Coins className="w-5 h-5 text-primary" />
                    </div>
                    <div>
                      <p className="font-bold text-foreground text-lg">
                        {checkQuery.data.credits?.toLocaleString()} créditos
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {checkQuery.data.label || "Chave válida"}
                        {checkQuery.data.expiresAt && (
                          <> · Expira em {new Date(checkQuery.data.expiresAt).toLocaleDateString("pt-BR")}</>
                        )}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="name">Seu nome (opcional)</Label>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Ex: João Silva"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="inviteCode">Seu código de convite Manus *</Label>
                  <Input
                    id="inviteCode"
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)}
                    placeholder="Ex: ABCDEFGHIJ ou cole o link de convite"
                    className="font-mono"
                    required
                  />
                  <p className="text-xs text-muted-foreground">
                    Acesse manus.im → Configurações → Código de convite
                  </p>
                </div>

                <div className="flex gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1"
                    onClick={() => setStep("input")}
                  >
                    Voltar
                  </Button>
                  <Button
                    type="submit"
                    className="flex-1"
                    disabled={redeemMutation.isPending || !inviteCode}
                  >
                    {redeemMutation.isPending ? (
                      <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Resgatando...</>
                    ) : "Resgatar Créditos"}
                  </Button>
                </div>
              </motion.form>
            )}

            {/* Step 3: Success */}
            {step === "success" && (
              <motion.div
                key="success"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="text-center space-y-5"
              >
                {/* Icon */}
                <div className="flex items-center justify-center w-16 h-16 rounded-full bg-green-500/10 mx-auto">
                  <CheckCircle2 className="w-8 h-8 text-green-400" />
                </div>

                {/* Title */}
                <div>
                  <h2 className="text-xl font-bold text-foreground">Resgate confirmado!</h2>
                  <p className="text-sm text-muted-foreground mt-1">
                    Sua solicitação de <span className="font-semibold text-foreground">{successCredits.toLocaleString()} créditos</span> foi registrada com sucesso.
                  </p>
                </div>

                {/* Delivery info */}
                <div className="p-4 rounded-lg bg-ghost-surface-2 border border-border text-left space-y-3">
                  <div className="flex items-start gap-3">
                    <Clock className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-foreground">Prazo de entrega</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Os créditos serão enviados para o seu código de convite em até <span className="font-semibold text-foreground">30 minutos</span>. Aguarde e verifique sua conta Manus.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Info className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                    <p className="text-xs text-muted-foreground">
                      Não é necessário fazer nada. Os créditos chegam automaticamente na sua conta.
                    </p>
                  </div>
                </div>
              </motion.div>
            )}

            {/* Error */}
            {step === "error" && (
              <motion.div
                key="error"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="space-y-4"
              >
                <div className="flex items-start gap-3 p-4 rounded-lg bg-destructive/10 border border-destructive/20">
                  <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium text-destructive">Erro ao resgatar</p>
                    <p className="text-sm text-muted-foreground mt-0.5">{errorMsg}</p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => { setStep("input"); setErrorMsg(""); }}
                >
                  Tentar novamente
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <p className="text-center text-xs text-muted-foreground mt-4">
          Powered by Ghost Panel
        </p>
      </motion.div>
    </div>
  );
}
