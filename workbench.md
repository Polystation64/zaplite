# ZapLite — Workbench do Núcleo Confiável

> ## 🏁 LOOP ENCERRADO PELO HUMANO — 2026-08-14, 20:45
>
> Estado final verificado: app rodando (PID 37852, binário de release), **CONNECTED às 20:44:55**, e às
> 20:45:13 o log registrou `"contador de tentativas zerado pelo Rust: 15s de CONNECTED sustentado"` —
> a lógica do M1 funcionando na reconexão real do usuário, sem instrumentação.
>
> **Entregue:** Fase 1 (aprovada por crítico) e Fase 2 (camada de conexão), com a correção de
> convergência da iteração 4 provada em produção mas **sem auditoria final** — o humano optou por
> encerrar, decisão registrada e legítima.
>
> **Não entregue (fora do que o humano decidiu fazer):** Fase 3 (performance), auditoria da Fase 4
> (notificações), extensão de B1 para 20 aberturas, e a passada final de coerência prevista no mandato.
>
> **Sem prova de campo:** M4 (rearme por sinal positivo) e M5 (fechamento seletivo de sockets) — ambos
> com teste unitário, nenhum exercitado numa conexão real.

> ## Terceiro deslogue — resolvido (2026-08-14, ~20:35)
>
> **Causa: testes do builder abriram janelas com QR ESCANEÁVEL em perfis descartáveis.** O QR foi
> escaneado duas vezes (19:29:20 e 20:34:25), vinculando dois aparelhos a perfis temporários. O WhatsApp
> limita a 4 aparelhos vinculados — explicação consistente para a sessão real ter caído. O perfil real
> ficou intocado (verificado por timestamp) e nenhum código do app recarregou a sessão.
>
> **AÇÃO DO USUÁRIO, nesta ordem:**
> 1. Escanear o QR na janela aberta (PID 37852) para reconectar.
> 2. No celular: **Configurações → Aparelhos conectados**, remover entradas estranhas. Os perfis de teste
>    foram apagados do disco pelo builder (inclusive os dois com sessão viva), mas o vínculo do lado do
>    WhatsApp só some se for removido pelo celular.
>
> **Guardrail que faltava e agora é regra:** nenhum teste pode abrir uma janela com QR escaneável. Um QR
> na tela é um convite a ser escaneado, e vincular aparelho tem custo real (o limite de 4 é global).
>
> Lição do projeto: dos 3 deslogues, 1 foi do usuário e **2 foram causados por testes** — rajada de
> eventos de rede e QR escaneável em perfil descartável.

> ## Deslogue anterior — por rajada de eventos sintéticos (2026-08-14, 15:40)
>
> **Desta vez a culpa foi do loop, não do usuário.** O builder T2.1d disparou **60 eventos
> `offline`/`online` sintéticos em 8 segundos** para testar o debounce (L3). O WhatsApp reage a esses
> eventos derrubando e reabrindo o socket, e a rajada de reconexões invalidou a sessão de aparelho
> vinculado. O builder reportou o erro por conta própria, na primeira linha do relatório.
>
> Cadeia de causa no log — **nenhuma linha de recuperação do ZapLite precede o BOOT**, ou seja quem
> navegou foi a própria página, não o app:
> ```
> 15:38:41  CONNECTED → STARTING   "interface pronta, socket reabrindo"   ← rajada de teste
> 15:40:18  BOOT      → STARTING   ← sem nível 2 nem watchdog antes
> 15:40:24  STARTING  → NEEDS_AUTH  QR real ("Scan this QR code to link a device!")
> ```
> Não é defeito do produto: 60 eventos em 8s não é carga que o app gere. É método de teste ruim.
>
> **Estado atual:** app rodando (PID 14812), parado num QR real esperando o celular do usuário.
> **Como retomar:** escanear o QR. Nenhum agente pode fazer isso.
>
> **Guardrail adicionado a todo contrato futuro:** proibido gerar rajadas de eventos `offline`/`online`
> sintéticos. Para exercitar queda, usar só o atalho de queda simulada, que é limitado e não gera loop
> de reconexão.

> ## ✅ Portão anterior resolvido — sessão religada (2026-08-14, 10:47)
>
> **Causa do deslogue esclarecida pelo usuário: ele deslogou sem querer pelo app do WhatsApp no celular.**
> Não foi consequência dos testes. A hipótese do orquestrador (instâncias concorrentes corrompendo o
> perfil) estava ERRADA e fica registrada como tal.
>
> Religado e validado no log real — e de quebra é a melhor validação possível do detector novo (J1),
> porque exercitou uma tela de QR verdadeira e a transição de volta:
> ```
> 10:46:34  STARTING   → NEEDS_AUTH  tela de login visível (QR/vincular aparelho)   ← QR real
> 10:46:53  NEEDS_AUTH → STARTING    carregando (tela do WhatsApp)                  ← usuário escaneou
> 10:47:01  STARTING   → CONNECTED   interface pronta, socket aberto e tráfego recente
> ```
> Login → CONNECTED em **8,8s**; o app do usuário (PID 18304) segue rodando e conectado.

> ## 🐞 ACHADO NOVO DO ORQUESTRADOR — segunda instância morre em silêncio
>
> Iniciei o exe às 10:51:02 com a instância do usuário já aberta: o processo **morreu em segundos, sem
> escrever uma linha no log**. Causa quase certa: `tauri-plugin-global-shortcut` registra `ctrl+shift+w`
> no `setup` (lib.rs) e falha com `HotKey already registered` quando já existe outra instância — o mesmo
> `PluginInitialization` que o builder do JS viu morrer durante os testes dele.
>
> Impacto direto no **critério 1** (20 de 20 aberturas prontas para usar): abrir o app com uma instância
> já aberta é uma falha silenciosa. O correto é uma das duas: `tauri-plugin-single-instance` focando a
> janela existente, ou degradar sem matar o app quando o atalho não puder ser registrado.
> Entra no próximo contrato de builder.

Superfície de acompanhamento do loop orquestrador. Uma linha por item.
Barra de aceite: (1) 20/20 aberturas conectam · (2) "recebe mas não envia" nunca persiste >10s · (3) chats <5s, conversa <2s · (4) RAM idle ≤2x WhatsApp Desktop oficial · build release limpo.

> Nota: os 4 critérios estão marcados [DERIVADO] no mandato. Adotados como barra de trabalho;
> confirmação humana ainda pendente — qualquer ajuste do humano entra aqui e o loop reprocessa.

## Estado das fases

| Item | Status | Veredito crítico | Iterações | Achados em aberto |
|---|---|---|---|---|
| F1: wrapper base compila e abre WhatsApp Web | **CONCLUÍDO** | **PASS** (build reproduzido, app vivo 22s, TCP casando com IP de web.whatsapp.com) | 1 | nenhum |
| F2 — camada de conexão (Rust + JS) | **ENCERRADO pelo humano** na iteração 4 | it.1 FAIL · it.2 FAIL · it.3 FAIL · it.4 sem auditoria | 4 | M4 e M5 sem prova de campo; B3 reprovado (2/10 <5s) |
| F2 — indicador visual de status | entregue na it.3 (consome `zaplite://conn-state`) | sem auditoria dedicada | 1 | badge rotula eco de heartbeat como "decisão do app" |
| Vazamento da chave Anthropic à origem remota | tarefa separada, aguardando o usuário | — | 0 | chip criado; fora do escopo do loop |
| F2: detecção "recebe mas não envia" + reconexão automática | (fundido em T2.1) | — | — | — |
| F2: indicador visual de status | não iniciado | — | 0 | — |
| F3: performance de abertura | **entregue e verificado pelo orquestrador** | 8/10 <5s (média 4,84s a quente) | 1 | teto é do WhatsApp Web, não nosso |
| F4: notificações (módulo 31) | corrigido (P1..P8), provado ao vivo pelo builder | FAIL na it.1; **sem auditoria independente da correção** | 2 | P6 e fallback de seletor só em código |
| Auditoria adversarial da camada de conexão | feita 2x (it.2 e it.3) | FAIL nas duas; it.4 sem auditoria | 2 | encerrado por decisão do humano |
| Critério 4 (RAM ≤2x oficial) | **INALCANÇÁVEL — provado por experimento controlado** | FAIL honesto; decisão do humano | 2 | 2 vazamentos nossos fechados; ~96% do heap é do WhatsApp Web |
| 20 aberturas consecutivas (critério 1) | **20/20** em duas corridas independentes | PASS | 1 | — |
| Passada final de coerência | FAIL → **costuras fechadas (Y1..Y4)** | Y1 provado ao vivo; Y2/Y4 só em código | 2 | sem recrítica após a correção |

## Evidência coletada pelo orquestrador (2026-08-13, binário release 22:32)

Abertura a frio do exe, `connection.log` íntegro:

```
22:41:03.561  BOOT       → STARTING    script de conexão injetado
22:41:11.560  STARTING   → NEEDS_AUTH  tela de login/QR
22:41:39.557  NEEDS_AUTH → STARTING    aguardando interface
22:41:57.561  STARTING   → CONNECTED   interface carregada sem sinais de falha
```

Leitura do orquestrador (a confirmar/refutar pelos críticos):
1. A camada de conexão funciona de ponta a ponta: ACL, heartbeat, log e transições.
2. **Suspeita de defeito**: `NEEDS_AUTH` falso por 28s numa sessão logada. `qrScreen()` casa por
   `div[data-ref]` e por regex no texto do body — ambos podem bater durante o carregamento. Um
   indicador visual mostraria "precisa autenticar" em toda abertura.
3. **Suspeita de FAIL no critério 3**: 54s de abertura até `CONNECTED` (lista de conversas), contra
   a barra de <5s. Era partida a frio pós-rebuild; exige medição repetida a quente antes do veredito.
4. Watchdog não disparou recuperação espúria em ~100s de observação.

## COSTURAS FECHADAS (Y1..Y4) — verificado pelo orquestrador: 41/41 Rust + 4/4 JS, app CONNECTED

- **Y1 (a costura ALTO) — provado ao vivo nos níveis 2 E 3.** `fechar_toasts_por_recuperacao` no Rust,
  chamada **depois** do veredito (efeito, não decisão — `decidir_recuperacao` intocada). Evidência:
  enumeração de HWNDs mostra a janela `380x124 'ZapLite'` presente em t=6s e ausente em t=8s após o
  reload, sem voltar em 16s; log registra `[toasts fechados antes do reload: 1]` e `ToastState vazio`.
  Mérito de método: o bench rodou com **perfil WebView2 vazio e alvo `about:blank`**, deliberadamente
  longe da sessão do usuário, para que nenhuma tela de QR pudesse aparecer — a lição dos 4 deslogues
  virou prática.
- **Y3 — teste automatizado que cobre exatamente a regressão.** `throttleComCauda` substitui o `return`
  seco. Novo `bundle.test.js` (sem dependências) extrai a função REAL do bundle e testa o caso que
  quebrava: lote dentro da janela + **nada depois** ⇒ a cauda varre. 4/4 verde.
- **Y2 (clique perdido) — só em código.** O alvo agora é guardado no Rust (TTL 90s) e reentregue via
  `take_pending_chat`; o JS repete a busca por ~10s e avisa na tela se não conseguir abrir. Não testado
  ao vivo: exigiria clicar num toast de conversa real.
- **Y4 (varredura inicial) — só em código.**

Verificação independente do orquestrador: `cargo test --lib` **41/41**, `bundle.test.js` **4/4**,
app CONNECTED às 19:06:02.

## PASSADA FINAL DE COERÊNCIA — FAIL (o que motivou Y1..Y4). As costuras que ninguém tinha olhado juntas.

O crítico procurou COSTURAS, não peças. Duas quebraram, e as duas são degradação silenciosa no dia ruim:

- **X1 (ALTO) — toasts órfãos sobrevivem à recuperação.** Nada no Rust fecha toasts quando o nível 2
  (reload) ou 3 (renavegação) acontece: `close_all_toasts` só é chamado do `revert()` do módulo e do menu
  de diagnóstico, e a recuperação **não passa por `revert()`**. As janelas `toast-*` ficam órfãs,
  `always_on_top`, sobre um WhatsApp em branco, com o `ToastState` ainda segurando o estado delas.
  Ninguém cobriu esse caminho porque cada builder só olhou o próprio lado.
- **X1b (MÉDIO) — clique perdido.** `focus_chat` emite o evento e fecha o toast **incondicionalmente**;
  o `emit` do Tauri não tem buffer e o listener só existe ~0,4s após a navegação. Clique durante a janela
  de recuperação cai no vazio, o toast fecha, e o usuário não recebe nem um aviso.
- **X5 (MÉDIO, regressão funcional) — o anti-apagadas pode perder a mensagem apagada.** O piso de 500 ms
  é um `return` puro, sem timer de cauda (`bundle.js:1247-1249`): se a mutação do "mensagem foi apagada"
  chegar dentro da janela e não vier outro lote depois, a linha nunca é reexaminada. **O builder de
  memória trocou funcionalidade por GC sem perceber** — exatamente o risco de melhorar peças isoladas.
- **X5b (MÉDIO)** — não há varredura inicial: tudo que já estava renderizado quando o módulo sobe fica
  sem captura, e cada reload zera o `_store`.
- **X3 (MÉDIO, contido)** — a sonda pode emitir `CONNECTED` antes de `restauraContador()` resolver; o dano
  é contido porque `conn_transition` só grava `attempts_reported`. Sobra incoerência cosmética: `i.state`
  sai de FAILED no log/badge enquanto o breaker continua barrando. **E o ganho de 0,13s alegado não
  aparece na medição** — está dentro do ruído.

**PASSOU, e o crítico tentou quebrar por quatro ângulos:** X6 (o contador continua autoridade do Rust,
não é falsificável pela página, sobrevive ao reload, e trocar rótulo de cenário não compra orçamento) ·
X2 (o Painel não deadlocka mais nem contamina o watchdog) · X4 (os quatro caminhos do motor de regras
batem; horário prefere a origem e o código diz qual é qual) · X7 (varredura ASCII **e** UTF-16 do .exe:
zero gates de debug vazados).

**B3 não se sustenta.** A abertura medida deu 4,459s, mas os 4 boots anteriores do mesmo binário, medidos
de um ponto *posterior* ao `Start-Process`, já marcavam 5,4–5,9s — logo o wall-clock real deles foi ≥5,9s.
**4 de 5 aberturas recentes estouraram a barra**; o "8/10 abaixo de 5s" que medi antes não se reproduz.

**Nota de projeto (não é bug, mas o usuário precisa saber):** com "ocultar prévia" ligado, o **nome do
contato continua aparecendo** — o mascaramento cobre autor e corpo, por decisão explícita e testada.

## BUGS RELATADOS PELO USUÁRIO EM USO REAL (2026-08-15) — os 4 corrigidos

**U4 era muito pior que "janela em branco": clicar no Painel podia DERRUBAR A SESSÃO.**
Causa raiz medida por CDP: o alvo da janela do Painel era `about:blank`, `body` vazio, `__TAURI__`
undefined — a página nunca navegava, e não havia erro no console porque não havia documento.
`WebviewWindowBuilder::build()` **deadlocka no Windows quando chamado de um comando SÍNCRONO** — está
documentado na fonte do próprio Tauri 2.11.5 (`src/webview/webview_window.rs:115`). `open_settings` era
`fn`; `show_toast` sempre foi `async fn`, e é por isso que os toasts nunca sofreram disso.
Cadeia até a perda de sessão: 16:36 o `open_settings` trava o loop de eventos → sem heartbeat, o watchdog
renavega às 16:37:01, 16:37:34 e 16:38:10 → o `LOG.old` do IndexedDB do WhatsApp registra limpeza das
stores às **16:38:33**, no meio da rajada. Corrigido: `open_settings` virou `async`. Verificado no
binário final: `bodyLen=35922`, **32 cards de módulo**, 5 abas, `__TAURI__` presente, zero exceções, e o
app voltou a fechar limpo por `WM_CLOSE`.

**U1 (grupos silenciados) — corrigido.** Confirmado que não havia leitura nenhuma do silenciamento.
DOM real: das 69 conversas, **22 silenciadas**, com dois sinais coincidentes e zero divergência
(`data-testid="mute-notifications-refreshed"` e `aria-label="Conversa silenciada"`). Agora o silêncio do
WhatsApp vence a regra padrão; só uma regra explícita do usuário para aquele contato pode furá-lo.

**U2 (nome do contato) — a hipótese do orquestrador estava ERRADA, e o builder provou.** `nomeDaLinha`
casa em **69/69 linhas, 0 vazias**, e o Rust mascara só `author`/`body`, nunca `sender`. O que o usuário
viu era a janela de toast morta durante o deadlock do U4. Defeito real encontrado ao lado: em grupo o
autor sumia, porque o innerText vem em nó separado e o regex `^Fulano: texto$` nunca casava. Corrigido
com caminho guardado (só extrai quando o texto casa exatamente), validado por unidade — **não verificado
no DOM ao vivo**, a sessão caiu antes.

**U3 (data e hora) — implementado.** Era ausência de funcionalidade: a struct `Toast` nunca teve horário.
Capturado na origem (`cell-frame-primary-detail`, medido: `"16:35"`, `"07/08/2026"`), com queda para a
hora local do disparo se vier vazio. Verificado nos 4 estilos com janelas reais, batendo exatamente os
tamanhos de `size_for()`, sem overflow e sem colidir com o ✕.

`cargo test --lib` **41/41**. Ressalva declarada pelo builder: os payloads de toast foram sintéticos —
nenhuma notificação disparada por mensagem real chegou a ser testada, porque a sessão caiu antes.

## FASE 4 — NOTIFICAÇÕES (módulo 31): AUDITADO PELA PRIMEIRA VEZ, FAIL

**B1 (bloqueador). O ACL da janela do toast não permite os comandos que o próprio `toast.html` usa.**
`capabilities\toasts.json` só concede `core:*`. Ao vivo: `invoke("get_toast")` e `invoke("close_toast")`
→ *"not allowed by ACL"*. Resultado com 5 payloads sintéticos: 5 janelas abriram **em branco**
(`who="—"`, `msg=""`, sem estilo, sem som, sem contagem, sem clique) e **nenhuma fechou sozinha**.
É exatamente a armadilha que o README documenta — e ninguém aplicou à capability dos toasts.

**B2 (bloqueador). Instalação de fábrica = apagão total de notificação.** Sem `settings.json`,
`settings.notify` é undefined → `ruleFor()` devolve null → toda mensagem é descartada; e o
`window.Notification` nativo **já foi silenciado**. Ou seja: liga o módulo, perde toda notificação.

**S5 (ALTO, privacidade). O clique no toast pode abrir a conversa ERRADA.** `focus_chat` casa por
título com `#pane-side span[title]` + primeiro match. Medido na sessão real: 69 conversas mas **139**
`span[title]`, dos quais **70 não são nome de conversa** (são prévias) e **4 títulos já duplicados**.
Quem te manda mensagem controla esse texto: uma mensagem cujo corpo seja o nome de outro contato vira
match válido e sobe ao topo ⇒ o clique abre a conversa do remetente hostil.

**S4 (ALTO). Janelas e estado vazam.** Sem teto (11 janelas simultâneas, 54 processos WebView2), sem
handler de `Destroyed` para `toast-*`: fechar uma janela por fora deixou o payload retido para sempre
("FANTASMA RETIDO no estado Rust"). E `show_toast` insere no estado **antes** do `build()`, então toda
falha de criação vaza permanentemente.

**S1/S2 (MÉDIO).** "Ocultar prévia" mascara só o `body`; o `author` extraído por regex passa sem máscara
("Senha: 1234" vira author="Senha"). As regras de `notify` estão em `CHAVES_PUBLICAS`, então qualquer
script da página lê a lista de contatos. `index.html:428` interpola `r.accent` sem escape dentro de
`style="background:${...}"` — justamente na janela que enxerga a chave da API.

**S3.** N6 passa na identidade (o `Notification` volta o mesmo objeto), mas o que volta é um objeto com
`permission: "denied"` — desligar o módulo não devolve notificação funcionando.

Sem vazamento a disco: varredura de 1967 arquivos das árvores de dados não achou os marcadores dos
payloads; `connection.log` intacto.

### Correção das notificações (P1..P8) — entregue, provada ao vivo, sem auditoria independente

`cargo test --lib` 39 passed (eram 32). Destaques:
- **P1**: ACL corrigido + rede de segurança no `toast.html` (se `get_toast` for recusado, a janela se
  fecha sozinha). Toast sintético provou: conteúdo renderizado, acento aplicado, WebAudio rodando,
  contagem regressiva 83%→70%, e **fechou sozinho em 7,37s**.
- **P2**: decisão de regra migrou do JS para o Rust com `Regra::default()` semeada — sem `settings.json`
  o toast já sai com estilo, som e duração corretos.
- **P3 (o mais grave)**: identificador estável encontrado por investigação — a chave React `chat-<jid>`
  da linha da lista. Medido: **69 linhas → 69 ids, 0 duplicados**, contra 139 `span[title]` dos quais 69
  eram prévias. `focus_chat` agora exige `chatId` e o nome não trafega mais. Teste hostil: toast exibindo
  o nome de outra conversa mas com o id do atacante resolveu para o id, não para o nome. Os cliques foram
  interceptados por um gravador que **não encaminha**, então nenhuma conversa real foi aberta.
- **P4**: teto de 5 toasts, limpeza em `CloseRequested|Destroyed`, registro no estado só após o `build()`.
  11 disparos → 5 janelas; fechar por fora deixou `get_toast = null` (sem fantasma).
- **P5**: `notify` saiu de `CHAVES_PUBLICAS` — a página passa a receber só `skipWhenFocused`, sem nomes de
  contato. "Ocultar prévia" agora mascara autor **e** corpo no Rust.
- **P7**: `work_area()` em vez do tamanho do monitor; 5 posições distintas, nada sob a barra de tarefas.
- **P8**: `unlisten` guardado — após 3 ciclos liga/desliga, um evento produz 1 clique (antes, 4).

## CRITÉRIO 4 — RESOLVIDO POR EXPERIMENTO CONTROLADO: é inalcançável, e a culpa não é do wrapper

O builder isolou a variável com um interruptor de injeção só-em-debug: **a mesma página, no mesmo perfil
logado, com e sem uma linha nossa de código**. Três condições, 180s de repouso + 8 amostras de 30s:

| condição | total | maior renderer |
|---|---|---|
| **sem NENHUMA injeção** (WhatsApp Web puro) | 1550–2094 MB (média **1928**) | 972–1349 MB |
| injeção completa (bundle antigo) | 1918–2095 MB (média 2009) | 1143–1293 MB |

**Nossa camada inteira — conn core + 9 módulos + toasts — custa ~80 MB, 4% do total.** O WhatsApp Web
sozinho já ocupa ~1,9 GB nesta conta, e oscila 544 MB entre amostras **sem nosso código**: o padrão de
"coleta sobre heap grande" que motivou a investigação existe sem nós.

**Veredito: o limite de 2x (~812 MB) não é alcançável** enquanto o produto for o WhatsApp Web dentro de
uma WebView2. O oficial marca 406 MB porque é cliente nativo, não a aplicação web — a diferença é de
produto, não de wrapper. Única alavanca restante: limitar o V8 por fora (`--js-flags=--max-old-space-size`),
que derruba a página por OOM se errar a mão. O builder não recomenda sem ciclo de teste próprio.

Mesmo assim, dois vazamentos NOSSOS por construção foram fechados:
- `antiDelete._store` crescia sem teto **e** gravava sob `Math.random()` quando a linha não tinha
  `data-id` — chave que nunca seria consultada, ou seja retenção pura, uma entrada por linha renderizada.
  Agora: teto de 600 entradas em LRU, 4 KB por mensagem, e descarte de linha sem id.
- a varredura do `antiDelete` lia o `textContent` de **todas** as bolhas a cada lote de mutação (e o
  WhatsApp muta a árvore continuamente). Agora tem piso de 500 ms.
- poda de sockets `CLOSED` no mapa `live`.

Série depois: **1,44–1,51 GB em regime**. O builder foi honesto ao dizer que isso é *mais baixo que o
controle sem injeção*, logo não prova ganho de 400 MB nosso — prova que a variação do WhatsApp Web entre
execuções é maior que tudo o que controlamos. O que se afirma: sem regressão, com dois vazamentos fechados.

Descartados **com verificação**, não por presunção: avatares data URL, `ToastState` (o processo Rust
inteiro são 37 MB), `_seen` do smartNotify, `VecDeque`s do `connection.rs` e o log.

### Nota metodológica que vale guardar
O WebView2 **ignora `--remote-debugging-port`** nesta configuração: o argumento chega à linha de comando
do browser, mas nenhuma porta abre e nenhum `DevToolsActivePort` aparece. Por isso a atribuição foi feita
por interruptor de injeção, não por CDP.

## MEDIÇÃO INICIAL DE RAM (orquestrador, 4 amostras em 3 min) — o que motivou a investigação

```
             ZapLite                    WhatsApp oficial
21:31       1964 MB (maior: 1243)        406 MB (maior: 196)
21:32       1820 MB (maior: 1216)        408 MB
21:33       2872 MB (maior: 2150)        408 MB
21:34       2479 MB (maior: 1520)        408 MB
```
**4,5x a 7x**, contra o limite de 2x. Comparação justa: o oficial não está suspenso (responde, 42,6s de
CPU acumulada) e é rochosamente estável — varia 2 MB em 3 minutos. O nosso oscila 1,8–2,9 GB com um
renderer indo a 2,1 GB e voltando a 1,5 GB: assinatura de coleta de lixo sobre heap muito grande, ou
seja há retenção, não é só linha de base do WhatsApp Web. Investigação na fila.

## FASE 3 — PERFORMANCE DE ABERTURA (entregue, verificada por medição independente)

Repartição medida ANTES (a hipótese óbvia morreu com número): o `bundle.js` de 92 KB custa **2 ms** para
parsear e executar. **~80% do tempo é o boot da aplicação do WhatsApp Web** (3,9–4,0s), ~16% é
pré-documento (0,10s runtime Tauri + 0,38s criação da WebView2 + 0,34s navegação). A fatia nossa do gap
era **0,13s**: `evaluate()` rodava a 1 Hz, então a lista podia estar na tela por até 1s antes de o app
perceber. Conserto: sonda de `#pane-side` a 100 ms que se autodesliga na primeira prontidão.

O builder testou adiar dock/observadores/módulos até a lista existir, mediu ganho de ruído (4014→3980 ms)
e **reverteu** em vez de manter mudança de comportamento sem retorno.

Medição do builder: 4,83s média, 9/10 <5s.
**Medição independente do orquestrador** (script próprio, fechamento gracioso entre aberturas):
`6,72 | 5,08 | 4,79 | 4,94 | 4,75 | 4,80 | 4,77 | 4,78 | 4,80 | 4,85` — 10/10 conectaram, **8/10 <5s**,
média 5,03s (4,84s desconsiderando a primeira, que é partida a frio pós-build). Confirma o builder.

**Piso realista: ~4,7s**, dos quais ~0,8s são intransponíveis sem mexer em WebView2/rede e ~3,9s são
boot da aplicação do WhatsApp, que roda antes de qualquer coisa nossa.

**Critério 1 (20 aberturas):** somando as 10 do crítico final e as 10 do orquestrador, **20/20
conectaram** em duas corridas independentes. Não é uma corrida única de 20, mas é evidência equivalente.

## ITERAÇÃO 4 (correção de convergência) — ENTREGUE, aguardando verificação final

Um builder só, com os três arquivos — decisão deliberada, porque o defeito da it.3 nasceu de dois
builders isolados produzindo composição sem freio. `cargo build --release` limpo; **32 testes** (eram 21);
`node --check` OK; RELATOR e ganchos de teste ausentes do binário de release.

- **M1 (causa raiz) — provado.** O contador passou a contar DISPARO de recuperação, observado pelo Rust,
  e vive no processo (reload não apaga). Convergência real atravessando reloads:
  `19:16:45 att=1 (1/3) → 19:17:17 att=2 (2/3) → 19:17:50 att=3 (3/3) → 19:18:24 NEGADA: convergiu,
  aguardando 300s → 19:25:29 NEGADA (2ª vez), descanso dobrou para 600s`. Antes: 8 recargas seguidas com
  `attempts=0`. Zeragem só por sucesso real (15s de CONNECTED sustentado).
- **M2 (sintoma oposto) — provado nas duas metades.** `19:19:55` o watchdog registrou descanso **91s após
  a página entrar em FAILED, com heartbeat CHEGANDO** — exatamente onde o código antigo fazia
  `if heartbeat_fresco { return; }`. E `19:23:24` o descanso terminou e o app voltou a tentar sozinho,
  sem reinício manual. O badge não manda mais "reabra o ZapLite".
- **M3 (o caso observado) — provado no binário de release, no app real, sem instrumentação.**
  `AUTH_MAX_MS` foi REMOVIDO (grep: 0 ocorrências): não existe mais timer capaz de recarregar uma tela de
  login legítima. Tela parada de 20:35:39 a 20:42:33 = **414s, 0 linhas de log, 0 recargas**, contra o
  teto antigo de 300s que gerava as 8 recargas.
- **M4 — implementado e testado, NÃO observado ao vivo.** Rearme por sinal positivo puxa os descansos
  para 20s; `DESCANSO_FAILED` caiu de 10min para 5min.
- **M5 — implementado, NÃO exercitado ponta a ponta.** O fallback `[...live.keys()]` não existe mais;
  sem socket claramente implicado, a ação passa a ser a mais branda (cutuca, não fecha nada).

Fora do escopo declarado dos 3 arquivos: 1 linha em `build.rs` e 1 na capability, obrigatórias para o
comando novo `conn_recovery` existir no ACL.

## AUDITORIA FINAL DA ITERAÇÃO 3 — FAIL. Um defeito só, e é o mesmo de sempre.

**O achado, provado com o log do próprio usuário, sem agente nenhum mexendo:** o app recarregou o
WhatsApp **8 vezes seguidas em 35 minutos** (16:03, 16:08, 16:13, 16:19, 16:24, 16:29, 16:34, 16:39),
uma a cada ~5 min, por cima da tela de QR, todas com `attempts=0`. Desassistido, seriam ~12 recargas
por hora, indefinidamente. O L1 não matou o buraco negro do NEEDS_AUTH — **converteu silêncio em laço**.

**Causa raiz (uma só, e explica os dois sintomas opostos):** o contador conta *estado do link*, não
*recuperação disparada*. O Rust congela o contador em STARTING/NEEDS_AUTH e durante carência; o nível 2
é um reload, e todo reload passa por STARTING; ao voltar, `restauraContador()` sobrescreve o contador do
JS com o 0 congelado. Cada camada está correta sozinha; a composição não tem breaker nenhum.
Regressão da iteração 3: no binário anterior o log mostrava `attempts` subindo 1→2→3→4; hoje, 0.

**Sintoma oposto, mesma raiz:** se a página travar viva (heartbeat chegando, link morto), `FAILED`
desliga a recuperação do JS (`bundle.js:839`) e o watchdog do Rust não substitui porque só age no
silêncio do heartbeat (`connection.rs:1417`). As duas camadas se calam para sempre e o próprio badge
admite: "não consegui reconectar — reabra o ZapLite".

**Conserto indicado pelo crítico, pequeno e único:** contar o que dispara recuperação (a recuperação em
si, observada pelo Rust, como `conta_recuperacao()` já faz no nível 3) em vez do estado do link; e dar
teto de tempo ao `FAILED`, como STARTING e NEEDS_AUTH já ganharam.

**Recomendação do crítico sobre uso diário: NÃO**, enquanto o laço existir.

### O que ficou provado como MORTO (com citação)
K1 (escrita direta do contador — a classe sobrevive em 114s, ver abaixo) · K2 (segunda instância e
atalho global) · K3 (bypass por foco) · K4 (corrupção de log: **3997 linhas, 0 corrupção** em 44 eventos
de fim de vida) · K10 (usuário não conseguia fechar) · K12 (detector por URL, com a melhor prova do
projeto) · L9 (QR expirado saindo da detecção, confirmado ao vivo: NEEDS_AUTH sustentado 41 min).

### A barra, medição final
- **B1: 10/10 aberturas prontas** ✅
- **B3: 2/10 abaixo de 5s** (min 4,91s · máx 6,61s · média 5,73s) — melhor medição da história do
  projeto (era 6,08–9,03s) e ainda assim reprova.
- **B2: conclusão negativa ACEITA pelo crítico** como honesta e bem fundamentada. Ressalva justa: os
  limiares de 50s/65s foram derivados de **uma** sessão diurna de 5,8 min (n=1), e o custo de errar é
  fechar todos os sockets.
- C8 PASS: detecção e primeira ação dentro dos 10s (queda em +3,95s, nível 1 em +7,95s). Mas uma queda
  de 15s virou **64s de indisponibilidade**, porque a cura recarrega a página.

### Achados menores que ficam registrados
`note_diag` foi silenciado com `#[allow(dead_code)]` em vez de gateado por `cfg` — a letra do critério
passa, o espírito foi contornado · "fecha só o socket implicado" é inoperante, cai no `[...live.keys()]`
e fecha todos · pior caso sem nenhuma recuperação: ~10 min, porque `hold_until`/`rust_failed_until` não
rearmam diante de sinal positivo · 406 linhas de eco do próprio heartbeat rotuladas como "decisão do app"
no badge.

## ⚠️ DECISÃO DO HUMANO PENDENTE — o critério 2 não fecha em 10s para um sub-caso

O builder mediu 349s de conexão saudável, 659 amostras a 2 Hz, e concluiu **negativamente com evidência**:

| grandeza medida | valor |
|---|---|
| maior intervalo entre frames do servidor | **33,6s** (p90 24,7 · mediana 6,9) |
| maior intervalo entre envios espontâneos da página | 28,0s |
| maior `txSemResposta` saudável | 18,9s (medição anterior: 21,8s) |
| amostras com `bufferedAmount > 0` | **0 de 659** |

A medição de hoje é PIOR que a anterior (33,6s contra 25,3s) e **obriga a subir** o limiar de
"envio sem resposta" de 45s para 50s, não a descer. Qualquer limiar abaixo de 33,6s não detecta nada —
só gera falso positivo, cuja consequência é fechar socket são.

Sonda ativa foi avaliada e **recusada com evidência**: `WebSocket.prototype` nesta WebView2 expõe
exatamente `["close","send"]` — não existe ping/pong de protocolo acessível ao JS. A única forma de pôr
bytes naquele socket é `send()`, ou seja injetar quadro no stream Noise do WhatsApp, com risco de
invalidar a sessão. Sonda por conexão nova não serve, porque "meio-aberto" é propriedade daquela
conexão TCP específica.

**O que cabe nos 10s**: fila de envio sem progresso (~2,75s) e bolha com relógio (~6s) — ou seja,
**sempre que o usuário está de fato tentando enviar, a detecção fica em ≤6s**.
**Residual que não cabe**: socket meio-aberto **com o usuário parado e nada na fila** só é pego pelos
relógios lentos (50s/65s). Enquanto isso dura, nada do usuário está sendo perdido; no instante em que
ele envia, a detecção volta a ≤6s.

**Pergunta ao humano**: aceitar esse residual (recomendado, é limite físico do protocolo) ou insistir
nos 10s literais para todos os casos, que exigiria injetar tráfego no socket do WhatsApp — risco de
deslogar, exatamente o que o mandato proíbe?

## T2.1c ENTREGUE (iteração 3, lado Rust) — alegações do builder, AINDA NÃO AUDITADAS

`cargo build --release` exit 0; `cargo test --lib` **21 passed, 0 failed** (eram 10).

- **K1 (autoridade do contador)**: `Inner.attempts` deixou de existir. O contador passa a ser derivado de
  eventos que o Rust observa com o próprio relógio; o valor da página vira `attempts_reported` e nunca
  realimenta. Ataque executado: 30x `attempts=10` e 30x `attempts=0` — o contador **não se moveu**.
- **K2 (segunda instância)**: `tauri-plugin-single-instance` como primeiro plugin; 3 tentativas com uma
  instância aberta, todas focaram a janela viva e saíram com **exit code 0** em ~0,1s, dono vivo, 1
  processo total. O `.expect()` que abortava virou `match` com registro de falha de boot no log. O
  atalho global deixou de poder derrubar o app.
- **K3 (bypass por foco)**: carência agora exige transição real invisível→visível, com teto de 60s.
  **20 cliques com a carência zerada mantiveram `graceMs=0`** (antes, cada clique somava 30s).
- **K4 (corrupção de log)**: caminho de escrita único sob mutex, uma linha = um `write_all`; rotação via
  `write` em `.tmp` + `rename`. No mesmo teste em que o crítico viu 3 corrupções em 12 fechamentos:
  **3810 linhas, 0 ocorrências de `}{`, 0 linhas vazias, 0 JSON inválido**. Martelo com 8 threads
  concorrentes também limpo.
- **K5 (DoS na observabilidade)**: canal limitado a 512 com descarte contado, dedup de 1,5s e teto de
  30 transições/60s por origem remota. Histórico protegido: cada linha marca `src:"app"|"page"` e a
  rotação **preserva todas as linhas do app**.
- **K6 (as duas máquinas mentindo)**: separação `page_state` × `state` efetivo, com autoridade definida
  (a página manda no estado do link, o Rust no veredito de falha) e `check()` finalmente lendo `i.state`.
- **K7 (backoff inerte)**: carência de recuperação separada da de boot; espaçamentos voltaram a variar
  (32s, 34s, 38s, 46s em vez de 60s fixos) e o pior caso encadeado caiu de ~135s para 60s.
- **K12**: verificado empiricamente que no WebView2 o `Source` continua sendo a URL tentada após falha de
  navegação — `chrome-error:` nunca aparece, confirmando que o detector antigo jamais dispararia no
  Windows. Sinal novo: `NavigationCompleted` dispara também na falha.
- K8, K9, K10, K11 resolvidos (comandos fora da thread da UI; teto de 64 chars no `ts` testado com string
  de 4 MB; saída pedida pelo usuário não é mais revertida; notas gravam o `attempts` real).

## AUDITORIA FUNCIONAL DA ITERAÇÃO 2 — FAIL, com a barra medida pela primeira vez

**B1 (aberturas consecutivas): 10/10 conectaram** — 0 NEEDS_AUTH, 0 about:blank, todas vivas. É o
critério nº1 do projeto praticamente atingido (falta estender para 20).

**B3 (lista de chats <5s): 0/10. FAIL medido, não presumido.** 10 aberturas a frio, do `Start-Process`
até a lista renderizada: **6,08s a 9,03s**, mediana 6,42s. Mesmo pela métrica benevolente do builder
(a partir da linha BOOT, descartando ~0,95s de start), 0/9 ficam abaixo de 5s. A alegação de "5,45s"
era BOOT→CONNECTED, não abertura→pronto, e não se reproduz em N aberturas.

**B2 ("recebe mas não envia" ≤10s): FAIL por construção.** Dos três sinais, só `BUFFER_STUCK_MS=5000`
cabe no orçamento; `UNANSWERED_MS=45000` e `SILENCE_MS=75000` dão 46s e 76s — 4,6x e 7,6x acima. O caso
canônico (socket meio-aberto, página sem enviar nada) cai justamente nos caminhos de 45s/75s.

**C5 FAIL: corrupção de log reproduzida 3 em 12 fechamentos** — dois JSON grudados sem `\n` mais linha
em branco. Causa: `WindowEvent::Destroyed` dispara a thread escritora e o `note_sync` (segundo handle
append) quase simultaneamente. Taxa de 25% no desligamento normal.

Confirmado por medição: nível 3 renavega e o app sobrevive (mesmo PID); about:blank em 13,91s; falso
NEEDS_AUTH eliminado (0 em 10 aberturas); backoff/contador sobrevivem a 3 reloads; backdoor fechado
(evento forjado ignorado); ACL correto (`load_settings` NEGADO à origem remota, como deve ser);
rotação de 1 MB funciona sem linha inválida; `zaplite://conn-state` emite 5 eventos batendo com o log;
build limpo e 10 testes passando.

Custo que ninguém tinha medido: **o retorno a CONNECTED após uma queda leva 87s**, e o app fica
inutilizável nesse intervalo. Detecção é rápida (5,9s), recuperação é lenta.

Nota: o próprio crítico declarou ter destruído a maior parte do histórico do `connection.log` ao testar
a rotação, e deixou 4,28 GB de árvore de build no scratchpad (removidos pelo orquestrador).

## AUDITORIA ADVERSARIAL DA ITERAÇÃO 2 — FAIL (4 CRÍTICOS, 4 ALTOS, 9 MÉDIOS)

Confirmado como REALMENTE corrigido (com citação):
- ✅ **Nível 3 não destrói mais nada** — `w.navigate()`, zero `destroy()` no repo; log de produção mostra
  renavegação e processo sobrevivendo até CONNECTED. O pior crítico da it.1 morreu.
- ✅ **"Recebe mas não envia" virou detecção de nível de socket**, independente do DOM (`bufferPreso()`,
  `txSemResposta` via hook em `ws.send`) — não depende mais de conversa aberta.
- 🟡 Carências: mecanismo correto e testado, mas o USO gerou dois achados novos.
- 🟡 Breaker: zeragem corrigida; persistência existe mas é falsificável (ver C2).

CRÍTICOS EM ABERTO:
- **C1. `NEEDS_AUTH` continua buraco negro — o crítico nº4 da it.1 NÃO foi corrigido.** `bundle.js:454`
  posiciona NEEDS_AUTH ANTES do teto de STARTING (`:455-472`), e o ramo `!ruim` sai sem recuperar.
  Provado no log de produção durante queda real: **2min07s de silêncio total**, e o `attempts:0` no BOOT
  seguinte prova que quem recuperou foi um processo NOVO (reinício manual), não o app.
- **C2. O contador `attempts` do Rust é eco puro do valor que a página manda.** Os únicos escritores são
  `conn_heartbeat` e `conn_transition`, ambos expostos à origem remota. A alegação de que o contador
  "saiu do alcance da página" (J10) é FALSA: um script pode mandar `attempts:10` e desligar toda a
  recuperação, ou `attempts:0` em laço e garantir reload eterno — o mesmo crítico da it.1, agora pela
  ponte nativa em vez do sessionStorage.
- **C3. Segunda instância aborta o app em silêncio.** `panic=abort` + `.expect()` em `lib.rs:411`; a
  falha do plugin de atalho global acontece antes de existir janela ou log. Confirma o achado do
  orquestrador com citação de código.
- **C4. Foco de janela adia o watchdog indefinidamente.** `Focused(true)` empurra a carência +30s a cada
  ganho de foco. O reflexo humano diante de um app travado é clicar nele — cada clique suprime o nível 3.
  Bypass permanente da última linha de recuperação.

ALTOS: escrita concorrente corrompe o log (**observada** no arquivo de produção: dois JSON na mesma
linha, justamente na telemetria de fim de vida); sem debounce, medidas **3,8 transições por segundo** por
mais de um minuto, com canal ilimitado e rotação que pode apagar todo o histórico de diagnóstico; as duas
máquinas de estado nunca se reconciliam (`conn_heartbeat` sobrescreve o FAILED do Rust sem logar, e
`check()` nunca lê `i.state`); **o evento `zaplite://conn-state` não tem UM ouvinte sequer no repositório**
— a decisão do Rust nunca chega ao usuário; carências encadeadas somam ~135s sem recuperação (13x o
orçamento de 10s), e a carência de 60s domina o backoff, tornando-o inerte.

A4 (perda de sessão) passou limpo de novo: nenhum caminho apaga perfil, cookies ou storage; renavegar
opera na mesma webview, UA e perfil intocados; IndexedDB é transacional, rollback atômico.

## T2.1a entregue (iteração 2) — alegações do builder, AINDA NÃO AUDITADAS

Decisão de projeto central: o nível 3 **não destrói mais nada**. Em vez de `destroy()` + recriar (que
não podia funcionar), **renavega a webview existente**, preservando a janela. As outras duas opções
foram rejeitadas com justificativa: rotacionar o label quebraria o ACL (`windows:["main"]` nas
capabilities) e destruir-e-esperar deixa uma janela de tempo com zero janelas, que mata o processo.

Evidência apresentada (reproduzida 3x, método validado de `delete window.__TAURI__` via CDP):
```
23:50:48.073  RECONNECTING  watchdog: >15s sem heartbeat; renavegando (nível 3, tentativa 1)
23:50:48.323  BOOT → STARTING  script de conexão injetado   ← bundle voltou a rodar
              ponte restaurada, PROCESSO VIVO
```
- R9 (about:blank): detecção em **14,1s** contra 209s/nunca. Detector de primeira classe, roda antes
  da carência de boot, com breaker próprio.
- R2: escondido por fora com `ShowWindow(SW_HIDE)` + ponte morta = 24s sem heartbeat, **0 recuperações**
  (o código antigo agiria aos 15s); carência de 30s ao reexibir atrasa, não desliga.
- R3: `NtSuspendProcess` por 60s ⇒ 0 recuperações espúrias. Confirmado empiricamente que no Windows
  `Instant` inclui o tempo suspenso (61s monotônico / 61s de parede).
- R4: detecção em 15,9s e 14,1s contra 35,5s e 209s do auditor.
- R7: breaker agora em janela deslizante; provado que 70s de heartbeats não zeram mais o contador.
- R10: verificado que os ganchos de teste estão ausentes do `.exe` de release.
- `cargo test --lib`: 10 passed, 0 failed (8 testes novos). `cargo build --release` limpo.
- Extra: telemetria de fim de vida, para que sumiço de processo nunca mais fique sem explicação.

## T2.1b entregue (iteração 2) — alegações do builder, AINDA NÃO AUDITADAS

- **J1 (o principal)**: duas aberturas a frio na sessão logada **sem nenhuma linha NEEDS_AUTH**, e
  CONNECTED em **5,45s** e **5,38s** — contra 20-54s/nunca da iteração 1. Detector agora é positivo,
  exige elemento visível, roda depois de `appReady()`. Medição que explica o bug antigo:
  `body.textContent` = 550.708 chars, dos quais **545.514 são texto de `<script>`**.
- **J8 (injeção)**: ataque reproduzido com `<span aria-label="pagamento pendente">` — seletor antigo
  casa, seletor novo não; estado permaneceu CONNECTED.
- **J5**: detecção de degradação em ~5s (era 10s+), mais três sinais que não dependem de o usuário
  enviar nada: fila que não drena (5s), envio sem resposta (45s), silêncio total (75s).
- **J9**: backdoor `simulateDrop` fechado — evento forjado pela página é recusado (`isTrusted=false`).
  ⚠️ Efeito colateral: o gancho `ZAPLITE_TESTE_QUEDA` em `lib.rs` usa `w.eval`, que é main-world, e
  agora só recebe a recusa. Método de simulação válido passa a ser tecla real ou CDP `Input.dispatchKeyEvent`.
- **J10**: contador saiu do `sessionStorage`; adulteração testada e sem efeito.
- **J12**: 33 de 36 linhas do flush carregam `ts` real anterior à restauração da ponte (a mais antiga,
  2,5 min antes) — prova de que o timestamp deixou de mentir.
- **J11 é a exceção honesta**: teto de 40 garantido por código, não por observação; a fila estabilizou
  em 34 e drenou a 0. Fica como achado em aberto para o crítico.
- Três bugs achados pela própria verificação empírica e corrigidos: limiar de 6s para "envio sem
  resposta" era falso positivo (cadência real de frames do servidor chega a 25,3s); BOOT zerava o
  contador recém-lido do Rust; OFFLINE espúrio no boot.

Riscos residuais declarados: script da página ainda pode falsificar `attempts` chamando `conn_heartbeat`
direto (mitigação é validação no lado Rust); e uma morte por `HotKey already registered` quando duas
instâncias coexistiram — mais um argumento para o single-instance.

## Achados do crítico funcional cego de T2.1 (FAIL, iteração 1) — evidência empírica

- **Nível 3 reproduzido 3×, matando o app todas as vezes**: `"falha ao recriar a janela: a webview with
  label 'main' already exists"` seguido de morte do processo. Confirma o achado C-1 do adversarial por
  execução real, não só por leitura.
- **2 de 4 aberturas travaram em `about:blank`** com ZERO linhas de log — o bundle nunca roda, nenhuma
  telemetria chega, e o desfecho foi o watchdog matar o app. Achado novo, não previsto por ninguém.
- **Tempo até lista de conversas**: 54s / nunca / 20,2s / nunca. Melhor caso 20,2s contra a barra de <5s.
  Critério 3 falha, e metade das aberturas nem entrega a lista (critério 1 também falha).
- **Watchdog lento e travável**: 35,5s para agir (esperado 15s) e 209s no caso about:blank (esperado 60s),
  consistente com `is_visible()` bloqueante na task tokio.
- **`STARTING` é buraco negro**: medidos 167s parado, sem escalada, sem sinal ao usuário.
- **C8 atendido na letra**: detecção em 5,43s e primeira ação em 5,44s (≤10s). Mas o retorno a CONNECTED
  levou 181s, com 167s de app inutilizável.
- PASS: C6 (ACL provado ponta a ponta), C7 (build limpo), C2(c) (interceptação de WebSocket funciona).
- Rigor metodológico registrado: o crítico descartou a própria primeira tentativa de simulação por ser
  inválida (`__TAURI__.core` congelado) e refez o teste.

## Achados da auditoria adversarial de T2.1 (FAIL, iteração 1)

CRÍTICOS (qualquer um sozinho reprova):
- **C-1. O nível 3 do watchdog só sabe matar o app.** `connection.rs:264-268`: `w.destroy()` é assíncrono
  (enfileira no event loop), mas `create_main_window` roda inline; o label "main" ainda está no mapa,
  então `build()` retorna `WindowLabelAlreadyExists` sempre. Janela destruída, nunca recriada, sem tray
  icon e sem Ctrl+Shift+W (ambos dependem de `get_webview_window("main")`). Perda total do app, 100%.
- **C-2. Gatilho cotidiano para C-1.** `connection.rs:210` não tem carência após a janela voltar a ficar
  visível. Esconder com Ctrl+Shift+W (o app oferece o atalho) faz o Chromium estrangular timers; ao
  reexibir, >15s sem heartbeat dispara o nível 3. Idêntico ao voltar de suspensão do Windows (`Instant`
  no Windows conta o tempo suspenso).
- **C-3. Circuit breaker zerado pelo próprio falso positivo ⇒ reload eterno.** `bundle.js:142-146` zera
  `attempts` após 10s estável em NEEDS_AUTH, e o log real prova 28s nesse estado a cada carregamento.
  `nextAttemptAt` não é persistido, então entre reloads o backoff é zero.
- **C-4. Falso NEEDS_AUTH congela a recuperação numa queda real.** `bundle.js:204` testa `qrScreen()`
  antes de `appReady()`, e NEEDS_AUTH é isento de reconexão por design: falha silenciosa total.
- **C-5. O detector de "recebe mas não envia" cobre só o caso feliz.** `pendingOutgoing()` exige a bolha
  no DOM; sem conversa aberta o seletor nunca casa. Além disso 8s de PENDING + tick de 2s já consomem
  o orçamento de 10s antes de qualquer ação. O objetivo central do produto não é cumprido.

ALTOS: `lastTraffic` coletado e nunca usado (socket zumbi indetectável); CONNECTED por ausência de sinal;
`aria-label*="endente"` sem escopo permite que texto de terceiro dispare DEGRADED e derrube a conexão;
`recovering` pode travar em `true` para sempre (erro de `run_on_main_thread` descartado); `is_visible()`
bloqueante a cada 3s trava o watchdog justamente no travamento que ele deveria detectar; contador de
segurança em `sessionStorage` da página monitorada (gravável por script da página); breaker do nível 3
zerado por heartbeat; janela recriada recebe 15s de carência contra 54s de carregamento medido.

Fora do escopo do loop, mas achado de segurança real: `load_settings` devolve o objeto inteiro à origem
remota, expondo `anthropicKey` em claro a qualquer script de web.whatsapp.com. Registrado como tarefa
separada.

A3 (perda de sessão) passou: nenhum caminho apaga perfil, cookies ou storage; o UA é mantido na recriação.

## Estado herdado (levantamento inicial, 2026-08-13)

- Projeto Tauri 2 já existente e maduro: janela principal carrega web.whatsapp.com com `bundle.js` injetado; painel próprio; 13 dos 32 módulos implementados (fora de escopo deste loop, exceto o 31).
- **Camada de conexão não existe**: nenhum código monitora estado da conexão, detecta degradação ou reconecta. É o coração do escopo.
- Notificações (módulo 31 + `notify.rs` + `toast.html`) já implementam janela por contato, persistência e som por regra — mas sem auditoria.
- Riscos conhecidos do repo (README): ACL remoto do Tauri 2 exige registrar cada comando em `build.rs` + `capabilities/remote-whatsapp.json`; seletores DOM do WhatsApp mudam.

## Portões humanos pendentes

- Confirmação dos 4 critérios [DERIVADO].
- ~~Máquina sem sessão logada~~ — **retratado**. A sessão ESTÁ logada: o estado alcança `CONNECTED`
  por `appReady()` = presença de `#pane-side` (lista de conversas, só existe autenticado).
  O `NEEDS_AUTH` inicial era falso positivo transitório. Critérios 1/3/4 são mensuráveis.
  Consequência de segurança: os testes rodam contra a conta real do usuário — nenhum agente pode
  interagir com conversas, e o portão de "enviar mensagem real" continua fechado.
- Qualquer teste que envie mensagem real pela conta do usuário (Fase 2, teste de envio): PARADO até aprovação humana explícita. Testes de conexão/leitura rodam livres.
