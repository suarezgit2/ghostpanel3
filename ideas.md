# Ghost Panel - Brainstorm de Design

## Contexto
Painel de administração para automação de criação de contas. Público-alvo: operador técnico que precisa de eficiência, clareza de dados e controle total. O painel deve transmitir **poder**, **controle** e **sigilo**.

---

<response>
<text>

## Ideia 1: "Terminal Noir" — Estética Hacker/Cyberpunk

**Design Movement:** Cyberpunk Terminal UI — inspirado em interfaces de hacking de filmes, terminais de comando e dashboards de operações militares.

**Core Principles:**
1. Informação densa mas organizada — cada pixel conta
2. Feedback visual imediato — estados mudam em tempo real
3. Hierarquia por cor, não por tamanho — verde = sucesso, vermelho = falha, amarelo = processando
4. Sensação de "sala de controle"

**Color Philosophy:** Fundo quase preto (#0A0A0F) com acentos em verde neon (#00FF88) para sucesso e cyan (#00D4FF) para ações. Vermelho (#FF3366) para erros. A paleta transmite "operação noturna" — o operador trabalha nas sombras.

**Layout Paradigm:** Sidebar fixa estreita com ícones + tooltip. Conteúdo principal em grid de cards com bordas sutis de 1px. Tabelas densas com linhas alternadas semi-transparentes. Header mínimo com status badges em tempo real.

**Signature Elements:**
1. Glow effects sutis nos elementos ativos (box-shadow com cor neon)
2. Monospace font nos dados (emails, senhas, IDs) — como um terminal
3. Indicadores de status pulsantes (dots animados)

**Interaction Philosophy:** Cliques respondem com feedback visual instantâneo. Hover revela informações extras em tooltips escuros. Transições rápidas (150ms) — nada de animações lentas.

**Animation:** Fade-in rápido para novos dados. Pulse animation nos jobs em execução. Counter animation nos números do dashboard. Skeleton loading com gradiente sutil.

**Typography System:**
- Display: JetBrains Mono Bold — para títulos e métricas
- Body: Inter Medium — para texto corrido
- Data: JetBrains Mono Regular — para emails, senhas, IDs, logs

</text>
<probability>0.08</probability>
</response>

---

<response>
<text>

## Ideia 2: "Obsidian Command" — Estética Dark Minimal Corporativa

**Design Movement:** Dark Corporate Minimalism — inspirado em dashboards de fintech como Linear, Vercel e Stripe Dashboard. Profissional, limpo, sem excessos.

**Core Principles:**
1. Clareza acima de tudo — dados legíveis sem esforço
2. Hierarquia visual por peso tipográfico e espaçamento
3. Cores usadas com parcimônia — apenas para status e ações
4. Elegância silenciosa — parece caro sem ser chamativo

**Color Philosophy:** Fundo em cinza muito escuro (#09090B) com superfícies em camadas (#111113, #18181B, #27272A). Acento principal em azul elétrico (#3B82F6) para ações. Verde (#22C55E) para sucesso, âmbar (#F59E0B) para warning, vermelho (#EF4444) para erro. A paleta é contida — cor só aparece quando tem significado.

**Layout Paradigm:** Sidebar colapsável com navegação vertical. Cards com cantos arredondados médios (8px) e sombras suaves. Tabelas com headers sticky e sorting. Espaçamento generoso entre seções (32-48px). Grid responsivo 12 colunas.

**Signature Elements:**
1. Bordas sutis com gradiente (border-image com gradiente de transparente para cor)
2. Badges de status com dot colorido + texto — sempre visíveis
3. Micro-charts inline nas tabelas (sparklines)

**Interaction Philosophy:** Hover states com elevação sutil (shadow increase). Botões com estados claros (default, hover, active, disabled). Modais centrados com backdrop blur. Toasts no canto inferior direito.

**Animation:** Framer Motion para page transitions (slide + fade). Stagger animation nos cards do dashboard. Number counting animation nas métricas. Smooth scroll entre seções.

**Typography System:**
- Display: Geist Bold — para títulos e métricas grandes
- Body: Geist Regular — para texto e labels
- Data: Geist Mono — para dados técnicos (emails, tokens, IDs)

</text>
<probability>0.06</probability>
</response>

---

<response>
<text>

## Ideia 3: "Phantom Grid" — Estética Brutalista Dark

**Design Movement:** Dark Brutalism — inspirado em interfaces industriais, painéis de controle de fábricas e design brutalista web. Funcional, direto, sem decoração.

**Core Principles:**
1. Função define forma — zero elementos decorativos
2. Grid rígido e visível — linhas de grade como elemento visual
3. Tipografia como hierarquia principal — tamanhos extremos
4. Contraste máximo — preto e branco com uma cor de acento

**Color Philosophy:** Preto puro (#000000) com branco puro (#FFFFFF) para texto. Uma única cor de acento: laranja industrial (#FF6B00). Sem gradientes, sem sombras — apenas cor sólida. A paleta é brutal e direta — não há onde se esconder.

**Layout Paradigm:** Grid visível com linhas de 1px em cinza escuro. Blocos de conteúdo com bordas grossas (2px). Sem border-radius — tudo é retangular. Layout em colunas assimétricas. Sidebar larga com texto grande.

**Signature Elements:**
1. Números gigantes no dashboard (72px+) com labels pequenos abaixo
2. Bordas grossas (2px) em todos os containers
3. Texto em uppercase para labels e navegação

**Interaction Philosophy:** Hover inverte cores (fundo branco, texto preto). Cliques têm feedback tátil (scale 0.98). Sem transições suaves — mudanças instantâneas. Formulários com inputs de borda grossa.

**Animation:** Sem animações de entrada. Transições instantâneas. Loading states com texto "PROCESSING..." piscando. Progress bars com blocos discretos (não contínuos).

**Typography System:**
- Display: Space Grotesk Black — para números e títulos (72px+)
- Body: Space Grotesk Regular — para texto
- Data: Space Mono — para dados técnicos
- Labels: Space Grotesk Medium Uppercase — para navegação e labels

</text>
<probability>0.04</probability>
</response>
