/**
 * OutlookCallback — Página de callback do OAuth2 da Microsoft
 *
 * A Microsoft redireciona para /settings/outlook-callback?code=XXX após o usuário
 * autorizar o App. Esta página extrai o `code` da URL, chama o endpoint
 * exchangeOutlookCode no backend e fecha a janela.
 */

import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Ghost, CheckCircle, XCircle, RefreshCw } from "lucide-react";

export default function OutlookCallback() {
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [message, setMessage] = useState("Processando autorização...");
  const [email, setEmail] = useState<string | null>(null);

  const exchangeMutation = trpc.settings.exchangeOutlookCode.useMutation({
    onSuccess: (data) => {
      setEmail(data.email);
      setStatus("success");
      setMessage(`Conta ${data.email} autorizada com sucesso!`);
      // Notificar a janela pai para atualizar a lista
      if (window.opener) {
        window.opener.postMessage({ type: "OUTLOOK_ACCOUNT_ADDED", email: data.email }, "*");
      }
      // Fechar automaticamente após 2 segundos
      setTimeout(() => window.close(), 2000);
    },
    onError: (err) => {
      setStatus("error");
      setMessage(`Erro ao autorizar: ${err.message}`);
    },
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const error = params.get("error");
    const errorDescription = params.get("error_description");

    if (error) {
      setStatus("error");
      setMessage(`Autorização negada: ${errorDescription || error}`);
      return;
    }

    if (!code) {
      setStatus("error");
      setMessage("Código de autorização não encontrado na URL.");
      return;
    }

    const redirectUri = `${window.location.origin}/settings/outlook-callback`;
    exchangeMutation.mutate({ code, redirectUri });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4 p-8 text-center max-w-sm">
        {status === "loading" && (
          <>
            <RefreshCw className="w-10 h-10 text-primary animate-spin" />
            <p className="text-sm text-muted-foreground">{message}</p>
          </>
        )}
        {status === "success" && (
          <>
            <CheckCircle className="w-10 h-10 text-green-500" />
            <p className="text-sm font-semibold text-foreground">{message}</p>
            <p className="text-xs text-muted-foreground">
              Esta janela será fechada automaticamente...
            </p>
          </>
        )}
        {status === "error" && (
          <>
            <XCircle className="w-10 h-10 text-destructive" />
            <p className="text-sm font-semibold text-foreground">Erro na autorização</p>
            <p className="text-xs text-muted-foreground">{message}</p>
            <button
              onClick={() => window.close()}
              className="text-xs text-primary underline mt-2"
            >
              Fechar janela
            </button>
          </>
        )}
      </div>
    </div>
  );
}
