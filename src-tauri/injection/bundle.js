/* ============================================================================
   ZapLite — bundle injetado no WhatsApp Web
   Roda como initialization_script, antes do app carregar. Cada módulo é
   ativado/desativado pelas configurações salvas em settings.json.
   Nada aqui fala com servidor do WhatsApp fora do fluxo normal da página.
   ============================================================================ */
(function () {
  "use strict";
  if (window.__ZAPLITE__) return;
  window.__ZAPLITE__ = true;

  // Propaga o erro de verdade. A versão antiga rejeitava em silêncio e
  // fazia qualquer falha de permissão parecer "o botão não faz nada".
  async function invoke(cmd, args) {
    if (!window.__TAURI__ || !window.__TAURI__.core) {
      throw new Error("ponte nativa indisponível (window.__TAURI__ ausente)");
    }
    try {
      return await window.__TAURI__.core.invoke(cmd, args);
    } catch (e) {
      const msg =
        typeof e === "string" ? e : (e && (e.message || e.toString())) || "erro desconhecido";
      const err = new Error(cmd + " → " + msg);
      console.error("[ZapLite]", err.message);
      throw err;
    }
  }

  // Envolve um handler para que qualquer falha apareça na tela.
  const guarded = (fn, titulo) => async (...a) => {
    try {
      await fn(...a);
    } catch (e) {
      showPanel(titulo || "Erro", (e && e.message) || String(e));
    }
  };

  const notify = (title, body) => {
    try {
      window.__TAURI__.notification.sendNotification({ title, body });
    } catch (_) {}
  };

  /* ========================================================================
     BOLHAS DE MENSAGEM — UM lugar só (V1)
     ------------------------------------------------------------------------
     O seletor `div.message-in, div.message-out` estava COPIADO em 8 pontos
     (anti-apagadas x3, transcrição, collectVisibleMessages x2, velocidade de
     áudio, menu do botão direito, camada de conexão). Medido no DOM real da
     sessão logada em 16/08/2026, com conversa aberta e cheia:

         div.message-in   = 0        .message-in       = 0
         div.message-out  = 0        [class*=message-] = 0

     Ou seja: a classe SUMIU do WhatsApp Web, e por isso "Resumir esta
     conversa" respondia "Abra uma conversa primeiro" com a conversa aberta.
     O que existe hoje (mesma medição, 8 a 25 bolhas por conversa em 16
     conversas diferentes):

         #main div[role="row"] > div[data-id][data-testid^="conv-msg-"]
         ├─ [data-testid="msg-container"]   ← a bolha desenhada
         ├─ [data-pre-plain-text]           ← "[13:38, 15/08/2026] Fulano: "
         ├─ span.selectable-text / [data-testid="selectable-text"]
         └─ [data-icon="tail-in"] | [data-icon="tail-out"]  (só na 1a do grupo)

     As classes CSS de hoje são atômicas e ofuscadas (`x1n2onr6 xscbp6u`),
     idênticas para entrada e saída: não dá para tirar direção delas. Direção
     medida por três sinais independentes, nesta ordem de confiança:

       1. `tail-in` / `tail-out` (só na primeira bolha de cada bloco);
       2. GEOMETRIA — medido: bolha de entrada encosta na esquerda do painel
          (folga 62 px, constante) e a de saída na direita (folga 67 px,
          constante). É o sinal que nenhum remetente consegue forjar;
       3. `aria-label="Você:"` e os rótulos de status (" Entregue ", " Lida ")
          que só existem em bolha de saída.

     Cada função abaixo degrada sozinha: some um sinal, os outros seguram. */
  const BOLHA_SEL = [
    "div.message-in",
    "div.message-out",
    '[data-testid^="conv-msg-"]',
    '#main div[role="row"] [data-id]',
  ].join(",");
  const BOLHA_MIOLO = '[data-testid="msg-container"]';
  const TAIL_SEL = '[data-icon^="tail-"],[data-testid^="tail-"]';
  // ORDEM importa: `querySelector` com vírgula devolve o primeiro nó na ordem
  // do DOCUMENTO, não o primeiro seletor da lista — e `.copyable-text` é o
  // ENVOLTÓRIO do texto (traz o horário e o status junto). Por isso a busca é
  // seletor a seletor, do mais específico para o mais frouxo.
  const TEXTO_SELS = ["span.selectable-text", '[data-testid="selectable-text"]', ".copyable-text"];
  const META_SEL = '[data-testid="msg-meta"],[data-testid="msg-status"]';

  function painelDasBolhas() {
    return (
      document.querySelector('[data-testid="conversation-panel-messages"]') ||
      document.querySelector("#main") ||
      null
    );
  }
  /** É mesmo uma bolha, e não um pedaço de uma? */
  function ehBolha(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      if (el.classList.contains("message-in") || el.classList.contains("message-out")) return true;
      const tid = el.getAttribute("data-testid") || "";
      if (tid.indexOf("conv-msg-") === 0) return true;
      // `[data-id]` seco só vale dentro de uma linha do painel de mensagens
      if (!el.hasAttribute("data-id")) return false;
      return !!el.closest('#main div[role="row"], [data-testid="conversation-panel-messages"]');
    } catch (_) {
      return false;
    }
  }
  /** Bolhas renderizadas dentro de `raiz` (documento inteiro por padrão).
      Dedupe e sem aninhadas: uma citação dentro de outra bolha não vira bolha. */
  function bolhasEm(raiz) {
    const r = raiz || document;
    let achadas = [];
    try {
      if (r.nodeType === 1 && ehBolha(r)) achadas.push(r);
      if (r.querySelectorAll) achadas = achadas.concat([...r.querySelectorAll(BOLHA_SEL)]);
    } catch (_) {
      return [];
    }
    const out = [];
    for (const el of achadas) {
      if (!ehBolha(el)) continue;
      if (out.indexOf(el) >= 0) continue;
      // se já temos um ancestral dela na lista, ela é parte de uma bolha
      if (out.some((j) => j !== el && j.contains(el))) continue;
      for (let i = out.length - 1; i >= 0; i--) if (el.contains(out[i])) out.splice(i, 1);
      out.push(el);
    }
    return out;
  }
  /** Todas as bolhas da conversa aberta, na ordem em que estão na tela. */
  function bolhasVisiveis() {
    const p = painelDasBolhas();
    const dentro = p ? bolhasEm(p) : [];
    // Fallback: se o painel mudar de nome, ainda achamos as bolhas soltas.
    return dentro.length ? dentro : bolhasEm(document);
  }
  /** A bolha que contém `el` (para `closest`, nos módulos de áudio e menu). */
  function bolhaDe(el) {
    if (!el || !el.closest) return null;
    let cand;
    try {
      cand = el.closest(BOLHA_SEL);
    } catch (_) {
      return null;
    }
    while (cand && !ehBolha(cand)) cand = cand.parentElement && cand.parentElement.closest(BOLHA_SEL);
    return cand || null;
  }
  /** Mensagem enviada por MIM? Três sinais, o mais confiável primeiro. */
  function ehDeSaida(bolha) {
    if (!bolha) return false;
    try {
      if (bolha.classList.contains("message-out")) return true;
      if (bolha.classList.contains("message-in")) return false;
      const tail = bolha.querySelector(TAIL_SEL);
      if (tail) {
        const v = tail.getAttribute("data-icon") || tail.getAttribute("data-testid") || "";
        if (v.indexOf("tail-out") === 0) return true;
        if (v.indexOf("tail-in") === 0) return false;
      }
      // Geometria: de que lado do painel a bolha está desenhada.
      const p = painelDasBolhas();
      const miolo = bolha.querySelector(BOLHA_MIOLO) || bolha;
      if (p) {
        const rb = miolo.getBoundingClientRect();
        const rp = p.getBoundingClientRect();
        if (rb.width > 8 && rp.width > 8) {
          const esq = rb.left - rp.left;
          const dir = rp.right - rb.right;
          if (Math.abs(esq - dir) > 24) return dir < esq;
        }
      }
      // Último recurso: rótulos que só existem em bolha de saída.
      const al = bolha.querySelector(
        '[aria-label^="Você:"],[aria-label^="Voce:"],[aria-label^="You:"],[data-icon^="status-"],[data-icon^="msg-"]'
      );
      return !!al;
    } catch (_) {
      return false;
    }
  }
  /** O texto da mensagem — nunca o `textContent` da bolha inteira, que traz
      hora, nome do autor e o <title> dos ícones decorativos. */
  function textoDaBolha(bolha) {
    if (!bolha) return "";
    try {
      for (const sel of TEXTO_SELS) {
        const el = bolha.querySelector(sel);
        if (!el || !el.textContent) continue;
        if (sel !== ".copyable-text") return el.textContent;
        // Envoltório: sai o bloco de hora/status antes de ler o texto.
        try {
          const c = el.cloneNode(true);
          c.querySelectorAll(META_SEL).forEach((x) => x.remove());
          return c.textContent || "";
        } catch (_) {
          return el.textContent;
        }
      }
      return "";
    } catch (_) {
      return "";
    }
  }
  /** Identificador estável da mensagem (chave do anti-apagadas). */
  function idDaBolha(bolha) {
    if (!bolha) return "";
    try {
      const id = bolha.getAttribute("data-id");
      if (id) return id;
      const tid = bolha.getAttribute("data-testid") || "";
      return tid.indexOf("conv-msg-") === 0 ? tid.slice(9) : "";
    } catch (_) {
      return "";
    }
  }

  /* ========================================================================
     A2 — LINKS DE MENSAGEM
     ------------------------------------------------------------------------
     MEDIDO em 20/08/2026 (build de depuração, perfil descartável, página local
     com três links, clique de mouse REAL via SendInput):

       <a href>                       → NavigationStarting  → handler do Rust
       window.open("…")               → NewWindowRequested  → handler do Rust
       <a target="_blank">            → NADA. Nem navegação, nem novo pedido
       <a target="_blank" rel=…>      → NADA.

     Ou seja: o WebView2 simplesmente descarta o clique num link com
     `target="_blank"` — que é exatamente a forma que o WhatsApp usa nos links
     das mensagens. Nenhum handler NOSSO estava engolindo nada (o menu de
     contexto só escuta `contextmenu`); o pedido nunca chegava ao Rust.

     Por isso a correção tem duas metades, e as duas são necessárias:
     · Rust  — `on_new_window` + `on_navigation` (cobre window.open e link sem
       target, e impede a janela de sair do WhatsApp);
     · aqui  — o clique no `<a>` é interceptado na fase de captura e mandado
       para `open_external`, que abre no navegador do sistema.

     Cuidados: só botão esquerdo sem modificador; só esquema de link; link do
     próprio WhatsApp continua sendo da página (é assim que uma conversa abre);
     e o `stopPropagation` existe para o WhatsApp não abrir o MESMO link de
     novo pelo caminho dele. Nada disto toca clique fora de `<a>`, então lista
     de conversas e menu do botão direito seguem intactos. */
  const LINK_ESQUEMA = /^(https?:|mailto:|tel:)/i;
  function ehLinkDoWhatsApp(url) {
    try {
      const h = new URL(url, location.href).hostname.toLowerCase();
      return h === "web.whatsapp.com" || h.endsWith(".whatsapp.com") || h.endsWith(".whatsapp.net");
    } catch (_) {
      return false;
    }
  }
  /* ==========================================================================
     P2/P3/P4 — abrir a conversa que um link pediu.

     Duas entradas, um caminho só:
       · `whatsapp://send?phone=…` clicado no Windows → o Rust interpreta,
         guarda o alvo e avisa (evento `zaplite://deep-link`);
       · `wa.me/…` clicado DENTRO do ZapLite → interpretado aqui mesmo.

     POR QUE NAVEGAR em vez de procurar a linha na lista (como o clique no
     toast faz): o toast sabe o `chat-<jid>` exato da conversa que chegou. Um
     link traz um TELEFONE, e telefone não casa com id de linha — medido na
     lista real, os ids são `…@lid` e `…@g.us`, que não são o número. Quem sabe
     resolver telefone → conversa é o próprio WhatsApp, pela rota `/send`.
     É a mesma rota que o `wa.me` usa num navegador.

     REGRA DURA: o `text=` PREENCHE a caixa e NUNCA envia. Por isso o rascunho
     não viaja na URL (onde seria o WhatsApp quem o coloca na caixa) — ele fica
     no `sessionStorage`, atravessa a navegação (mesma origem) e é escrito aqui
     com `insertText`. Nenhuma linha deste bloco produz `Enter`, clica em botão
     de enviar ou chama `send`.
     ====================================================================== */

  // O rascunho tem que sobreviver ao recarregamento que a rota `/send` causa.
  const RASCUNHO_CHAVE = "zaplite:rascunho-de-link";
  // Rascunho velho não cola em conversa nenhuma: se a navegação não terminou
  // em poucos minutos, o usuário já está fazendo outra coisa.
  const RASCUNHO_TTL = 3 * 60 * 1000;

  // Mesmas regras do `sanear_telefone` do Rust (src/protocol.rs): só dígitos, e
  // fora da faixa E.164 não é telefone — é `null`, e `null` não abre nada.
  function telefoneValido(bruto) {
    const d = String(bruto || "").replace(/\D+/g, "");
    return d.length >= 8 && d.length <= 15 ? d : null;
  }
  function codigoValido(bruto) {
    const c = String(bruto || "").trim();
    return c && c.length <= 64 && /^[A-Za-z0-9_-]+$/.test(c) ? c : null;
  }
  function textoDeLink(bruto) {
    // O texto vem de FORA: fora os controles (menos quebra de linha e
    // tabulação) e teto de tamanho, igual ao `sanear_texto` do Rust.
    // Escrito com códigos em vez de classe de regex de propósito: um caractere
    // de controle literal dentro do fonte é invisível na revisão, e este é
    // justamente o código que existe para tirar caracteres invisíveis.
    const entrada = String(bruto || "");
    let saida = "";
    for (let i = 0; i < entrada.length && saida.length < 4096; i++) {
      const c = entrada.charCodeAt(i);
      const quebra = c === 10 || c === 9; // LF e TAB são texto de mensagem
      if ((c < 32 && !quebra) || c === 127 || c === 65279) continue; // 127=DEL, 65279=BOM
      saida += entrada[i];
    }
    return saida;
  }

  /** P4 — um link https vira alvo de conversa? Só as formas que o WhatsApp
      publica. Qualquer outra coisa devolve `null` e segue o caminho antigo
      (navegador, ou a própria página). */
  function alvoDeLinkWeb(href) {
    let u;
    try {
      u = new URL(href, location.href);
    } catch (_) {
      return null;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const host = u.hostname.toLowerCase();
    const texto = textoDeLink(u.searchParams.get("text") || "");

    // wa.me/5511999998888  (e wa.me/message/XXXX, que é um link CURTO: só o
    // servidor do WhatsApp sabe resolvê-lo, então esse continua indo embora)
    if (host === "wa.me" || host === "www.wa.me") {
      const p = telefoneValido(u.pathname.replace(/^\/+/, "").split("/")[0]);
      return p ? { phone: p, code: "", text: texto } : null;
    }
    // api.whatsapp.com/send?phone= … e web.whatsapp.com/send?phone= …
    if (host === "api.whatsapp.com" || host === "web.whatsapp.com") {
      if (!/^\/send\/?$/.test(u.pathname)) return null;
      const p = telefoneValido(u.searchParams.get("phone") || "");
      return p ? { phone: p, code: "", text: texto } : null;
    }
    // chat.whatsapp.com/<codigo> — convite de grupo
    if (host === "chat.whatsapp.com") {
      const c = codigoValido(u.pathname.replace(/^\/+/, "").split("/")[0]);
      return c ? { phone: "", code: c, text: texto } : null;
    }
    return null;
  }

  /** Leva a janela até a conversa. O destino é SEMPRE dentro de
      `web.whatsapp.com` — o `on_navigation` do Rust recusaria qualquer outra
      coisa, e é bom que recuse: essa trava é o que impede um link de tirar a
      sessão da tela. Aqui ela não é enfraquecida, é respeitada. */
  function abrirAlvoWhatsapp(alvo) {
    if (!alvo) return;
    const phone = telefoneValido(alvo.phone);
    const code = codigoValido(alvo.code);
    if (!phone && !code) return; // link sem destino não navega
    const texto = textoDeLink(alvo.text);

    // Já estamos exatamente onde o link pede? Recarregar seria jogar fora a
    // página por nada (e um link repetido viraria um laço de reload).
    const jaEstamos =
      phone && /^\/send\/?$/.test(location.pathname) &&
      telefoneValido(new URLSearchParams(location.search).get("phone")) === phone;

    if (texto) {
      try {
        sessionStorage.setItem(
          RASCUNHO_CHAVE,
          JSON.stringify({ texto: texto, ts: Date.now() })
        );
      } catch (_) {}
    }
    if (jaEstamos) return preencherRascunhoPendente();

    const destino = phone
      ? "https://web.whatsapp.com/send?phone=" + encodeURIComponent(phone)
      : "https://web.whatsapp.com/accept?code=" + encodeURIComponent(code);
    console.log("[ZapLite] abrindo conversa pedida por link:", phone || "convite " + code);
    location.assign(destino);
  }

  /** Escreve o rascunho na caixa de mensagem. NUNCA envia — é `insertText` e
      mais nada. Três travas, e as três existem por um motivo:
        · a caixa é procurada dentro de `#main` (a conversa aberta), nunca no
          documento inteiro: `div[contenteditable][data-tab]` também casa com a
          caixa de BUSCA, e escrever lá pesquisaria em vez de rascunhar;
        · o rascunho é consumido do `sessionStorage` ANTES de qualquer espera,
          para que um texto velho não reapareça numa conversa qualquer depois;
        · caixa já com conteúdo não é tocada — o que o usuário digitou vale
          mais que o texto que veio no link. */
  async function preencherRascunhoPendente() {
    let pend = null;
    try {
      const bruto = sessionStorage.getItem(RASCUNHO_CHAVE);
      if (!bruto) return;
      sessionStorage.removeItem(RASCUNHO_CHAVE);
      pend = JSON.parse(bruto);
    } catch (_) {
      return;
    }
    if (!pend || !pend.texto || Date.now() - (pend.ts || 0) > RASCUNHO_TTL) return;

    // A conversa pode levar um tempo para abrir (a rota `/send` recarrega o
    // WhatsApp inteiro). Sem caixa, o rascunho simplesmente não acontece.
    const box = await until(
      () => {
        const main = document.getElementById("main");
        return main && main.querySelector('div[contenteditable="true"][data-tab]');
      },
      60000
    );
    if (!box) {
      console.warn("[ZapLite] a conversa do link não abriu; o rascunho não foi escrito");
      return;
    }
    if ((box.innerText || box.textContent || "").trim()) return; // não atropela o usuário
    try {
      box.focus();
      document.execCommand("insertText", false, textoDeLink(pend.texto));
      console.log("[ZapLite] rascunho do link escrito na caixa (NÃO enviado)");
    } catch (e) {
      console.warn("[ZapLite] não consegui escrever o rascunho do link:", e);
    }
  }

  /** P2 — a ponte com o Rust. Duas metades, pelo mesmo motivo do Y2:
        · o evento, para o link clicado com o app já aberto e a página viva;
        · a pergunta ao subir, para o link que ABRIU o app (o processo nasceu
          com a URL no argv e a página nem existia) e para o link que caiu no
          meio de uma recuperação, quando não há listener para o `emit`. */
  function instalarLinksProfundos() {
    if (!window.__TAURI__ || !window.__TAURI__.event) return;
    window.__TAURI__.event
      .listen("zaplite://deep-link", (ev) => {
        const p = ev && ev.payload;
        if (p && typeof p === "object") abrirAlvoWhatsapp(p);
      })
      .catch(() => {});
    invoke("take_pending_deeplink")
      .then((alvo) => {
        if (alvo) abrirAlvoWhatsapp(alvo);
      })
      .catch(() => {});
  }

  function instalarAberturaDeLinks() {
    document.addEventListener(
      "click",
      (e) => {
        if (e.defaultPrevented || e.button !== 0) return;
        if (e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
        const a = e.target && e.target.closest && e.target.closest("a[href]");
        if (!a) return;
        const bruto = a.getAttribute("href") || "";
        if (!LINK_ESQUEMA.test(bruto)) return; // "#", "javascript:", relativo…
        const url = a.href;
        // P4 — `wa.me/5511…` e `api.whatsapp.com/send?phone=…` são o caso mais
        // comum do dia a dia: alguém MANDA um link de conversa dentro do
        // WhatsApp. Antes isto ia para o navegador, o navegador disparava
        // `whatsapp://` e o Windows entregava ao aplicativo oficial — três
        // saltos para chegar num app que não é o que o usuário está usando.
        // Aqui o link é interpretado e a conversa abre AQUI mesmo. Nada de
        // registrar handler de http/https: isto vale só para clique DENTRO do
        // ZapLite, que é o único lugar onde temos o direito de decidir.
        const alvoLocal = alvoDeLinkWeb(url);
        if (alvoLocal) {
          e.preventDefault();
          e.stopPropagation();
          abrirAlvoWhatsapp(alvoLocal);
          return;
        }
        if (ehLinkDoWhatsApp(url)) return; // conversa/mídia da própria página
        e.preventDefault();
        e.stopPropagation();
        invoke("open_external", { url }).catch(() => {
          // Retaguarda: sem a ponte nativa (ACL recusou, bundle rodando em
          // outra origem), `window.open` ainda cai no `on_new_window` do Rust,
          // que abre no navegador e nega a janela. Pior caso, nada acontece —
          // nunca uma navegação que tire o WhatsApp da tela.
          try {
            window.open(url, "_blank", "noopener");
          } catch (_) {}
        });
      },
      true
    );
  }

  /** A6 — a bolha está marcada como apagada? UM lugar só: o módulo
      anti-apagadas e o menu do botão direito faziam (fariam) a mesma pergunta,
      e seletor/regex duplicado é como um cisma do WhatsApp quebra os dois de
      uma vez (ver V1/V2 acima). */
  const APAGADA_RE = /apagada|apagou esta mensagem|deleted|se eliminó|this message was deleted/i;
  function ehApagada(bolha) {
    if (!bolha) return false;
    try {
      const c = bolha.cloneNode(true);
      c.querySelectorAll(".zl-recovered").forEach((x) => x.remove());
      return APAGADA_RE.test(c.textContent || "");
    } catch (_) {
      return APAGADA_RE.test((bolha.textContent || ""));
    }
  }

  /* ========================================================================
     CAMADA DE CONEXÃO (T2.1) — núcleo, sempre ativa, independente de settings
     Estados: STARTING, NEEDS_AUTH, CONNECTED, OFFLINE, DEGRADED,
              RECONNECTING, FAILED.

     Princípios que este arquivo respeita (auditorias J1..J12, L1..L10):
     · Todo texto da página é HOSTIL. Nenhum sinal nasce de varredura de texto
       do documento: `body.textContent` inclui o conteúdo dos <script> inline
       do WhatsApp (medido: 545 KB de 550 KB) e qualquer prévia de mensagem é
       controlável por terceiros. Sinais vêm de ELEMENTOS VISÍVEIS e escopados.
       Isso vale para TODOS eles, inclusive o aviso de conexão (L5).
     · CONNECTED é AFIRMAÇÃO, não ausência de problema: interface pronta E
       socket aberto E tráfego recente.
     · O que é usado para decidir recuperação (contador de tentativas e
       backoff) mora no lado Rust, fora do alcance de script da página.
     · Nenhum estado é "buraco negro": STARTING e NEEDS_AUTH têm teto de tempo
       (L1 — NEEDS_AUTH ficou 2min07s sem nada acontecer em produção).
     · Nada de flapping: toda troca de estado passa por histerese, e nenhuma
       transição idêntica é emitida em sequência (L3).
     · O indicador visual reflete AS DUAS CAMADAS: o estado desta máquina e o
       que o Rust decidiu sozinho, via evento `zaplite://conn-state` (L4).
     Detecção passiva: NUNCA envia mensagem de teste, e nunca injeta bytes no
     socket do WhatsApp (ver o orçamento de detecção, adiante).

     Recuperação: nível 1 (cutucar a reconexão interna) → nível 2 (reload da
     página; a sessão persiste no perfil). O nível 3 (recriar a webview) é do
     watchdog no Rust, via heartbeat. Nunca desloga, nunca toca no perfil.
     ======================================================================== */
  (function connCore() {
    let isTop = true;
    try { isTop = window.top === window; } catch (_) { isTop = false; }
    if (!isTop) return; // só o frame principal monitora

    const TICK_MS = 1000;         // avaliação dos sinais
    const FAST_TICK_MS = 250;     // amostragem do buffer de envio (ver B2)
    const HEARTBEAT_MS = 3000;    // heartbeat p/ o watchdog do Rust
    const PENDING_MS = 4000;      // relógio contínuo na bolha ⇒ DEGRADED

    /* ---- ORÇAMENTO DE "RECEBE MAS NÃO ENVIA" (B2: nunca >10s) -------------
       Medição desta sessão real, 349 s CONNECTED ininterruptos, amostragem a
       2 Hz (659 amostras) — números de hoje, não estimativas:
       · maior intervalo entre frames vindos do SERVIDOR .... 33,6 s
         (p90 24,7 s · mediana 6,9 s)
       · maior intervalo entre ENVIOS espontâneos da página . 28,0 s
         (p90 19,0 s · mediana 7,3 s)
       · maior `txSemResposta` com a conexão SAUDÁVEL ....... 18,9 s
         (a medição anterior desta mesma métrica deu 21,8 s; fica valendo o
         PIOR dos dois. L8: o comentário antigo justificava UNANSWERED_MS
         citando "5,9 s", número que nunca foi medido — a margem real de 45 s
         era 2,06x sobre 21,8 s, não os 7,6x que o texto sugeria.)
       · `bufferedAmount` > 0 em ......................... 0 de 659 amostras

       O que isso força, e por quê 10 s não fecha para o caso canônico:
       Com o usuário parado, os únicos relógios passivos são o silêncio do
       servidor e o envio-sem-resposta — e AMBOS são limitados pela mesma
       grandeza física, a cadência do servidor, medida hoje em 33,6 s. Um
       limiar abaixo disso não detecta nada: ele SÓ produz falso positivo, e
       falso positivo aqui fecha socket são. A medição de hoje, aliás, é pior
       que a anterior (33,6 s contra os 25,3 s registrados antes): ela obriga
       a SUBIR o UNANSWERED_MS de 45 s para 50 s, não a descê-lo.

       Sonda ativa foi avaliada e recusada, com evidência:
       `Object.getOwnPropertyNames(WebSocket.prototype)` nesta WebView2 devolve
       exatamente ["close","send"] — não existe ping/pong de protocolo
       acessível ao JS da página. Logo, a única forma de pôr bytes NAQUELE
       socket é `send()`, ou seja, injetar quadro no stream Noise do WhatsApp:
       risco de o servidor derrubar ou invalidar a sessão. Recusada. Sonda por
       conexão NOVA (HTTP ou WS separado) não serve: meio-aberto é uma
       propriedade daquela conexão TCP, e uma conexão nova pode subir
       perfeitamente enquanto a antiga segue morta.

       O que efetivamente cabe no orçamento, e está implementado:
       · fila de envio sem PROGRESSO (L6), amostrada a 4 Hz ⇒ ~2,75 s;
       · bolha de saída com relógio (usuário afetado de fato) ⇒ 4 s;
       somados à histerese de 2 s, dão 4,75 s e 6 s — dentro dos 10 s. E o
       falso positivo custa menos: o nível 1 agora fecha só o socket
       implicado, não todos.
       Residual assumido e reportado: socket meio-aberto COM o usuário parado
       e nada na fila de envio só é pego pelos relógios lentos (50 s / 65 s).
       Enquanto isso dura, nada do usuário está sendo perdido — no instante em
       que ele envia, a detecção volta a ser ≤6 s.                          */
    const BUFFER_STUCK_MS = 2500; // fila de envio sem PROGRESSO ⇒ meio-aberto
    const UNANSWERED_MS = 50000;  // 1,49x o pior silêncio saudável medido
    const SILENCE_MS = 65000;     // 1,93x — socket "aberto" e mudo ⇒ zumbi

    const SOCKET_GRACE_MS = 5000; // tolerância p/ o retry nativo reabrir
    const STARTING_MAX_MS = 30000;  // teto sem NENHUMA tela de carregamento
    const LOADING_MAX_MS = 120000;  // teto com a tela de carregamento do WA

    /* ---- TETO DO NEEDS_AUTH (L1) ------------------------------------------
       NEEDS_AUTH era o único estado sem teto: em produção ficou 2min07s sem
       uma linha sequer, e quem "recuperou" foi um processo NOVO (o BOOT
       seguinte veio com attempts:0 — reinício manual). Dois tetos, porque os
       dois erros possíveis têm custos bem diferentes:

       · Recarregar por cima de um QR legítimo custa ao usuário um QR novo —
         e o WhatsApp já regenera o QR sozinho a cada ~20-60 s, então depois
         de alguns minutos parado não existe QR "prestes a ser escaneado".
       · NÃO recarregar uma tela de login falsa custa o app inteiro parado por
         tempo indefinido, que é exatamente o defeito relatado.

       Logo: teto LONGO quando a tela de login tem cara de legítima, teto
       CURTO quando ela aparece logo depois de sinais de queda. O que NÃO
       entra na suspeita, de propósito: "já esteve pronto antes". O log de
       10:46:34 mostra um QR REAL logo depois de uma sessão saudável (o
       usuário deslogou pelo celular) e o scan veio em 19 s — punir esse caso
       seria recarregar em cima de um QR de verdade. A suspeita vem de sinais
       de FALHA, não de histórico de sucesso.

       M3 — E O TETO LONGO FOI EMBORA. O texto acima raciocina sobre QUANDO
       recarregar uma tela de login; a produção respondeu se ADIANTA: em
       14/08, das 16:03:49 às 16:39:26, o app recarregou o WhatsApp do usuário
       8 vezes seguidas por cima de uma tela de QR, uma a cada ~5 min, todas
       com "tentativa 1" — e o QR seguiu lá, sem ninguém para escanear.
       Recarregar NÃO conserta uma tela de login: só troca o QR debaixo de
       quem estava prestes a lê-lo. O remédio ali é humano.
       Fica valendo só o tier CURTO, e só para o caso em que a suspeita é de
       falha e não de espera: login que apareceu logo depois de SINAIS DE
       QUEDA (sessão possivelmente derrubada pela rede). E até esse tem fim —
       o breaker do Rust converge depois de MAX_DISPAROS_CENARIO tentativas no
       mesmo cenário e manda o app aguardar.                                */
    const AUTH_SUSPEITO_MS = 45000;  // login após sinais de queda: 45 s
    const QUEDA_RECENTE_MS = 180000; // janela que define "após sinais de queda"
    const LOGIN_TICKS_MIN = 3;       // ticks seguidos vendo login (QR real
                                     // medido durou 19 s: sobra folga)
    /* M2 — descanso do FAILED. `if (state === "FAILED") return;` sem teto era
       metade do silêncio eterno: a página parava de tentar PARA SEMPRE e o
       badge mandava "reabra o ZapLite" — reinício manual, exatamente o defeito
       que este projeto existe para eliminar. */
    const FAILED_REST_MS = 300000;   // 5 min de descanso, e volta a tentar

    const CONFIRMA_MS = 2000;     // histerese: quanto um alvo precisa durar
    const DEBOUNCE_MS = 300;      // coalescência dos eventos online/offline
    const REEMISSAO_MIN_MS = 5000;// não repetir transição idêntica
    const PEDIDO_COMPROVADO_MIN_MS = 5000; // W2: piso entre re-pedidos por falha real
    const STABLE_OK_MS = 15000;   // CONNECTED estável ⇒ zera o contador
    const MAX_ATTEMPTS = 10;      // circuit breaker
    const BACKOFF_BASE_MS = 2000;
    const BACKOFF_CAP_MS = 60000;
    const FILA_MAX = 12;          // teto da fila de transições não entregues
    const SIM_DROP_MS = 15000;    // duração FIXA da queda simulada
    const SIM_CHORD = "Ctrl+Alt+Shift+D";

    /* --- interceptação transparente do WebSocket -----------------------
       Além de contar sockets, marcamos o tráfego nos DOIS sentidos, POR
       SOCKET. É o que permite (a) enxergar o socket meio-aberto (readyState
       continua OPEN por minutos) e (b) fechar no nível 1 só o socket
       implicado, em vez de derrubar todos os sãos junto. */
    const NativeWS = window.WebSocket;
    const live = new Map();  // ws -> { env, dren, drenTs, rx, tx }
    let hadSocket = false;
    let lastRx = 0;        // último frame recebido (ou open)
    let lastTx = 0;        // último frame enviado pela página
    let txSemResposta = 0; // instante do envio mais antigo ainda sem resposta
    let blockUntil = 0;    // queda simulada: derruba conexões novas também

    function marcaRx() { lastRx = Date.now(); txSemResposta = 0; }
    function marcaTx() { const t = Date.now(); lastTx = t; if (!txSemResposta) txSemResposta = t; }

    const enc = typeof TextEncoder === "function" ? new TextEncoder() : null;
    function tamanho(d) {
      try {
        if (d == null) return 0;
        if (typeof d === "string") return enc ? enc.encode(d).length : d.length;
        if (typeof d.byteLength === "number") return d.byteLength;
        if (typeof d.size === "number") return d.size;
      } catch (_) {}
      return 0;
    }

    function ZLWebSocket(url, protocols) {
      const ws = protocols !== undefined ? new NativeWS(url, protocols) : new NativeWS(url);
      const agora = Date.now();
      const r = { env: 0, dren: 0, drenTs: agora, rx: agora, tx: 0 };
      hadSocket = true;
      live.set(ws, r);
      ws.addEventListener("open", () => { r.rx = Date.now(); marcaRx(); });
      ws.addEventListener("message", () => { r.rx = Date.now(); marcaRx(); });
      ws.addEventListener("close", () => { live.delete(ws); });
      // instrumenta o envio: sem isto não dá para distinguir "ninguém fala"
      // de "eu falo e ninguém responde", nem medir o que já drenou.
      try {
        const envioNativo = ws.send.bind(ws);
        Object.defineProperty(ws, "send", {
          value: function (dados) {
            marcaTx();
            r.tx = Date.now();
            r.env += tamanho(dados);
            return envioNativo(dados);
          },
          writable: true,
          configurable: true,
        });
      } catch (_) {}
      if (Date.now() < blockUntil) {
        // durante a queda simulada, toda conexão nova cai na hora
        setTimeout(() => { try { ws.close(); } catch (_) {} }, 50);
      }
      return ws;
    }
    ZLWebSocket.prototype = NativeWS.prototype;
    ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach((k) => { ZLWebSocket[k] = NativeWS[k]; });
    try {
      Object.defineProperty(window, "WebSocket", { value: ZLWebSocket, writable: true, configurable: true });
    } catch (_) {}

    const openSockets = () => {
      let n = 0;
      live.forEach((_r, w) => { if (w.readyState === NativeWS.OPEN) n++; });
      return n;
    };
    const bufferPreso = () => {
      let m = 0;
      live.forEach((_r, w) => {
        try { if (w.readyState === NativeWS.OPEN && w.bufferedAmount > m) m = w.bufferedAmount; } catch (_) {}
      });
      return m;
    };

    /* L6 — progresso, não igualdade a zero. `bufferedAmount === 0` amostrado
       a 1 Hz podia NUNCA pegar o zero num upload sustentado, e o DEGRADED
       falso resultante fechava todos os sockets sãos, inclusive o que estava
       carregando o upload. O que medimos agora é quanto JÁ DRENOU
       (`enviado − bufferedAmount`), que é monotônico num socket saudável —
       mesmo com a fila sempre cheia — e CONGELA num socket meio-aberto.
       Amostrado a 4 Hz para caber no orçamento de detecção. */
    function amostraBuffers() {
      const now = Date.now();
      live.forEach((r, w) => {
        let b;
        try {
          // Rede de segurança da retenção: o `live` é forte e só era limpo pelo
          // evento `close`. Socket que morre sem despachar `close` (renavegação,
          // erro de rede no meio do handshake) ficava no Map para sempre, com o
          // objeto e o listener juntos. Todo LEITOR já ignora quem não está
          // OPEN, então descartar o CLOSED aqui não muda decisão nenhuma.
          if (w.readyState === NativeWS.CLOSED) { live.delete(w); return; }
          if (w.readyState !== NativeWS.OPEN) return;
          b = w.bufferedAmount || 0;
        } catch (_) { return; }
        const drenado = r.env - b;
        if (b === 0 || drenado > r.dren) { r.dren = drenado; r.drenTs = now; }
      });
    }
    // Sockets cuja fila de envio não progride há tempo demais.
    function socketsPresos(now) {
      const out = [];
      live.forEach((r, w) => {
        try {
          if (w.readyState !== NativeWS.OPEN) return;
          const b = w.bufferedAmount || 0;
          if (b > 0 && now - r.drenTs > BUFFER_STUCK_MS) out.push({ ws: w, bytes: b, ms: now - r.drenTs });
        } catch (_) {}
      });
      return out;
    }

    /* --- máquina de estados -------------------------------------------- */
    let state = "STARTING";
    let since = Date.now();
    let reason = "boot";
    let attempts = 0;
    let nextAttemptAt = 0;
    let restaurado = false;    // o contador do Rust já chegou?
    let semPonte = false;      // ponte nativa indisponível agora
    let pendingSince = null;   // desde quando há mensagem de saída presa
    let semUiDesde = Date.now(); // desde quando estamos sem interface pronta
    let naoProntoTicks = 0;    // ticks seguidos sem interface (anti-piscada)
    let lastOpenTs = Date.now(); // última vez com socket aberto (ou boot)
    let stableTimer = null;
    let evaluating = false;
    let loginTicks = 0;        // ticks seguidos vendo tela de login
    let authDesde = null;      // desde quando a tela de login está na tela
    let ultimaQueda = 0;       // último sinal de queda (p/ o teto do NEEDS_AUTH)
    let cand = null;           // alvo candidato (histerese)
    let candDesde = 0;
    let failedDesde = 0;       // desde quando estamos em FAILED (M2: tem teto)
    let pedindo = false;       // pedido de recuperação em voo (um de cada vez)
    let ultimoPedidoComprovado = 0; // W2: piso local dos re-pedidos por falha real
    let aguardandoAte = 0;     // o Rust mandou aguardar até este instante
    let aguardandoMotivo = ""; // e por quê (texto do Rust, só para o badge)
    let agendado = 0;          // timer do debounce
    let flushando = false;     // guarda de reentrância do flush (L7)
    const fila = [];           // transições não entregues (ponte ausente)

    const backoffDe = (n) =>
      Math.min(BACKOFF_BASE_MS * Math.pow(2, Math.max(0, n - 1)), BACKOFF_CAP_MS);

    /* O contador de tentativas e o backoff NÃO moram na página.
       sessionStorage é da origem web.whatsapp.com: qualquer script de lá
       escreve "9" e desliga a recuperação, ou "0" em laço e garante reload
       eterno — e ainda por cima morre junto com a webview no nível 3.
       O lado Rust é o dono: ele conta o DISPARO de cada recuperação e decide
       o backoff. Aqui só restauramos a foto — e ela inclui o descanso, não só
       o número. (Antes o backoff era RECALCULADO a partir de `since`; agora
       vem pronto do Rust, que é quem sabe se já convergiu.) */
    async function restauraContador() {
      try {
        const s = await invoke("get_connection_state");
        const a = parseInt((s && s.attempts) || 0, 10);
        attempts = isFinite(a) && a > 0 ? Math.min(a, MAX_ATTEMPTS) : 0;
        // M1 — o que atravessa o reload não é só o número: é o DESCANSO. Se o
        // Rust já convergiu, a página que acabou de nascer não pode recomeçar
        // do zero como se nada tivesse acontecido — era assim que 8 recargas
        // seguidas apareciam todas como "tentativa 1".
        const descanso = parseInt((s && s.descansoMs) || 0, 10) || 0;
        const hold = parseInt((s && s.holdMs) || 0, 10) || 0;
        const espera = Math.max(descanso, hold);
        if (espera > 0) {
          aguardandoAte = Date.now() + Math.min(espera, BACKOFF_CAP_MS * 30);
          nextAttemptAt = aguardandoAte;
          aguardandoMotivo = descanso > 0
            ? "o app já tentou o bastante neste cenário e está aguardando"
            : "backoff em curso";
        }
        semPonte = false;
        console.log("[ZapLite/conn] contador restaurado do Rust:", attempts, "| aguardando", Math.max(0, nextAttemptAt - Date.now()), "ms | cenário", (s && s.cenario) || "—");
      } catch (e) {
        semPonte = true;
        console.warn("[ZapLite/conn] sem ponte nativa: sem contador confiável, recuperação limitada ao nível 1");
      }
      restaurado = true;
    }

    /* L10 — a fila existe para a ponte MOMENTANEAMENTE indisponível, e o teto
       é só um limite de memória. Ele é estruturalmente inalcançável: sem
       ponte não há heartbeat, e o watchdog do Rust renavega a webview ~16 s
       depois do último heartbeat; com a histerese de 2 s isso dá no máximo
       ~8 transições. Por isso NÃO existe mais contador de descarte nem aviso
       diferido: era código que nunca rodava. Descarta o mais antigo e pronto. */
    function entrega(t) {
      return invoke("conn_transition", t).catch((e) => {
        while (fila.length >= FILA_MAX) fila.shift();
        fila.push(t);
        throw e;
      });
    }
    /* Assinaturas das transições que NÓS mandamos, para separar o eco do Rust
       de uma decisão dele. Precisa ser um anel, não um slot único: quando duas
       transições saem coladas (OFFLINE e, no mesmo tick, RECONNECTING), o eco
       da primeira chega depois de a segunda já ter sobrescrito o slot — e a
       primeira era rotulada como "decisão do app" sem ser. Medido no teste do
       teto de NEEDS_AUTH. */
    const enviadas = [];
    function marcaEnviada(sig) {
      enviadas.push({ sig, ts: Date.now() });
      while (enviadas.length > 8) enviadas.shift();
    }
    function foiNossa(sig) {
      const lim = Date.now() - 15000;
      for (let i = enviadas.length - 1; i >= 0; i--) {
        if (enviadas[i].ts >= lim && enviadas[i].sig === sig) return true;
      }
      return false;
    }
    let ultimaEmissao = { chave: "", ts: 0 };
    function sendTransition(prev, st, rs, quando) {
      // L3 — nunca emitir a mesma transição repetidamente. O flapping medido
      // (OFFLINE⇄STARTING a 3,8/s por mais de um minuto) gerava um invoke,
      // uma linha de log e um emit por troca, ajudando a estourar a rotação
      // de 1 MB e apagar o histórico de diagnóstico.
      const chave = prev + ">" + st + "|" + rs;
      const agora = Date.now();
      if (chave === ultimaEmissao.chave && agora - ultimaEmissao.ts < REEMISSAO_MIN_MS) {
        return Promise.resolve();
      }
      ultimaEmissao = { chave, ts: agora };
      // `ts` é o instante REAL da transição (campo opcional do contrato):
      // uma transição enfileirada não pode ser carimbada com a hora do flush.
      const t = {
        prev,
        state: st,
        reason: rs,
        attempts,
        ts: new Date(quando || agora).toISOString(),
      };
      // o Rust ecoa toda transição de volta no evento `zaplite://conn-state`;
      // guardar a assinatura é o que separa o eco da decisão dele (L4).
      marcaEnviada(st + "|" + rs);
      return entrega(t).catch(() => {});
    }
    async function flushFila() {
      if (flushando) return; // L7: dois flushes liam fila[0] e ambos davam
      flushando = true;      // shift() — uma linha duplicada e uma perdida.
      try {
        let guarda = FILA_MAX + 1; // nunca bloqueia o laço
        while (fila.length && guarda-- > 0) {
          const t = fila[0];
          try { await invoke("conn_transition", t); } catch (_) { return; }
          if (fila[0] === t) fila.shift();
        }
      } finally {
        flushando = false;
      }
    }

    function setState(st, rs) {
      if (st === state) return;
      const prev = state;
      const agora = Date.now();
      state = st;
      reason = rs;
      since = agora;
      if (st === "FAILED") failedDesde = agora; // M2: o descanso começa aqui
      console.log("[ZapLite/conn]", prev, "→", st, "|", rs);
      sendTransition(prev, st, rs, agora);
      sinaliza();
      clearTimeout(stableTimer);
      // SÓ sucesso real e sustentado zera o contador. NEEDS_AUTH não é
      // sucesso: se zerasse, qualquer falso positivo dribla o circuit breaker
      // (era exatamente o que acontecia — 28s de NEEDS_AUTH por carregamento).
      if (st === "CONNECTED") {
        stableTimer = setTimeout(() => {
          if (state === "CONNECTED") { attempts = 0; nextAttemptAt = 0; }
        }, STABLE_OK_MS);
      }
    }

    /* --- sinais: elementos visíveis, nunca texto do documento ----------- */
    function visivel(el) {
      if (!el) return false;
      try {
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) return false;
        const s = getComputedStyle(el);
        return s.visibility !== "hidden" && s.display !== "none" && parseFloat(s.opacity || "1") > 0.05;
      } catch (_) { return false; }
    }
    function algumVisivel(sel, raiz) {
      let els;
      try { els = (raiz || document).querySelectorAll(sel); } catch (_) { return false; }
      for (const e of els) if (visivel(e)) return true;
      return false;
    }

    // Interface pronta = lista de conversas realmente na tela. Vários
    // seletores porque os do WhatsApp mudam; qualquer um serve.
    const PRONTO_SEL = '#pane-side, [data-testid="wa-web-main-screen"], [data-testid="chat-list"]';
    function appReady() { return algumVisivel(PRONTO_SEL); }

    // Tela de carregamento do PRÓPRIO WhatsApp ("suas mensagens estão sendo
    // baixadas"). Enquanto ela existe, socket indo e voltando é normal —
    // cutucar a conexão aqui só atrasa o carregamento.
    const CARREGANDO_SEL = '[data-testid="wa-web-loading-screen"], [data-testid="startup-progress"]';
    function loadingScreen() {
      if (algumVisivel(CARREGANDO_SEL)) return true;
      return !appReady() && algumVisivel('progress, [role="progressbar"]');
    }

    /* Tela de login: afirmação POSITIVA, com elemento visível. Nunca por
       varredura de texto (o body carrega centenas de KB de <script> e casa
       com qualquer string de UI do bundle do WhatsApp).

       L9 — saiu daqui `[data-testid="intro-md-beta-logo-dark"]`: é o logo da
       tela de INTRO/carregamento, não de login, e era uma das duas fontes do
       NEEDS_AUTH falso que virou buraco negro. */
    const LOGIN_SEL = [
      'canvas[aria-label*="QR" i]',
      'canvas[aria-label*="scan" i]',
      'canvas[aria-label*="escane" i]',
      'div[data-ref] canvas',
      '[data-testid="qrcode"]',
      '[data-animate-qr-code]',
      // Contêiner da tela de vincular aparelho. Medido no DOM de uma tela de
      // login REAL (14/08 15:40): data-testid `link-device-qr-code`,
      // `link-device-qrcode-alt-linking-help`, `link-device-qrcode-alt-linking-hint`.
      // Nenhum `link-device-*` aparece na página logada (medição da sessão
      // conectada: 107 testids, nenhum deles). Precisa estar aqui porque o QR
      // EXPIRA: o WhatsApp troca o canvas pelo estado "recarregar código" e,
      // sem este seletor, a tela de login deixava de ser reconhecida, caía no
      // ramo de STARTING e era recarregada pelo teto de carregamento —
      // medido em 15:54:17, em cima de um QR real que o usuário precisava ler.
      '[data-testid^="link-device"]',
    ].join(",");
    /* Degradação graciosa: se os atributos mudarem de nome, o QR ainda é um
       canvas grande numa página sem lista de conversas. Mas o fallback antigo
       aceitava QUALQUER canvas ≥120x120 visível — a segunda fonte do L1.
       Agora exige a geometria de um QR de verdade: quadrado (±12%), entre 160
       e 600 px, visível e no miolo horizontal da tela. Medição de hoje na
       sessão logada: a página inteira tem 0 canvas, então não há motivo
       nenhum para este caminho ser frouxo. */
    function qrPlausivel() {
      let cs;
      try { cs = document.querySelectorAll("canvas"); } catch (_) { return false; }
      for (const c of cs) {
        const r = c.getBoundingClientRect();
        if (r.width < 160 || r.width > 600) continue;
        if (Math.abs(r.width - r.height) > r.width * 0.12) continue;
        if (!visivel(c)) continue;
        const cx = r.left + r.width / 2;
        if (cx < innerWidth * 0.15 || cx > innerWidth * 0.85) continue;
        if (r.top > innerHeight || r.bottom < 0) continue;
        return true;
      }
      return false;
    }
    function loginScreen() {
      if (appReady() || loadingScreen()) return false;
      if (algumVisivel(LOGIN_SEL)) return true;
      return qrPlausivel();
    }

    /* L5 — o aviso de conexão do PRÓPRIO WhatsApp. Era um `querySelector`
       seco, sem checagem de visibilidade nenhuma, contrariando a doutrina que
       vale para todos os outros sinais — e nunca foi visto disparar em log
       nenhum. Medido no DOM real de hoje: a faixa de avisos é
       `<span data-testid="chat-butterbar">` dentro de `#side`, e quando está
       VAZIA ela mede 511x0 px. Ou seja: um ícone ali dentro casaria com o
       seletor antigo mesmo sem nada aparecer na tela.
       Agora: escopado em `#app`, ícone precisa estar visível E dentro de uma
       faixa com altura real. */
    const BANNER_ICONE = [
      '[data-icon="alert-phone"]',
      '[data-icon="alert-computer"]',
      '[data-icon="offline"]',
      '[data-icon="alert-phone-refreshed"]',
      '[data-icon="alert-computer-refreshed"]',
      '[data-icon="alert-connection"]',
    ].join(",");
    function offlineBanner() {
      const app = document.getElementById("app");
      if (!app) return null;
      let els;
      try { els = app.querySelectorAll(BANNER_ICONE); } catch (_) { return null; }
      for (const e of els) {
        if (!visivel(e)) continue;
        const faixa = e.closest('[data-testid="chat-butterbar"]') || e.parentElement;
        try {
          if (faixa && faixa.getBoundingClientRect().height < 8) continue;
        } catch (_) { continue; }
        return "aviso de conexão do WhatsApp visível";
      }
      return null;
    }

    // Bolha de saída presa com relógio. ESCOPADO na bolha de saída: o
    // seletor antigo aceitava qualquer span com aria-label contendo
    // "pendente"/"pending" — texto de terceiro (ex.: um contato chamado
    // "pagamento pendente") virava DEGRADED e derrubava a conexão de
    // verdade no nível 1. Nada de casar texto aqui.
    //
    // V1: o escopo era a classe `div.message-out`, que não existe mais no
    // WhatsApp Web (medido: 0 ocorrências no DOM da sessão logada). Agora o
    // escopo é `ehDeSaida()`, que decide por tail/geometria/rótulo. A
    // SEMÂNTICA é a mesma de antes: ícone de relógio VISÍVEL dentro de uma
    // bolha que EU enviei; nenhum sinal novo, nenhuma varredura de texto.
    //
    /* V2 — E O SELETOR DO ÍCONE TAMBÉM TINHA MORRIDO. Consertar o escopo da
       bolha (V1) não bastava: o nome do ícone mudou junto com a família
       `message-in/out`. Medido no DOM real da sessão logada em 16/08/2026,
       numa bolha de saída de verdade (id AC302DA43CD73EAA4965248FAC8A7B90):

         <span aria-hidden="false" aria-label=" Lida " class="x1rv0e52">
           <svg viewBox="0 0 24 24" width="16" ...><title>wds-ic-read</title>…

       Três fatos que derrubam os CINCO seletores antigos de uma vez:
       · o nó de status NÃO tem `data-icon` nenhum (censo do documento inteiro:
         `[data-icon]` devolve 6 a 10 nós, todos de chrome — `lock-outline`,
         `new-chat-outline`, `tail-out`… — e NENHUM de status de mensagem);
       · o nome do ícone virou a família `wds-ic-*` e mora no TEXTO de
         `<svg><title>`, não em atributo (`WDS-ATTR total=0`: nenhum atributo
         do documento contém "wds-ic-");
       · o estado legível fica em `aria-label`, com espaços em volta (" Lida ").

       Logo `[data-icon="msg-time"]` e seus quatro irmãos casavam ZERO nós, e
       `pendingOutgoing()` era uma função que só sabia devolver `false` — o
       único sinal capaz de enxergar "recebe mas não envia" com o usuário
       recebendo normalmente (ver o orçamento de detecção acima).

       O que este código passa a fazer, e por que resiste ao próximo rename:
       NÃO procura um nome específico de ícone. Procura o NÓ DE STATUS — que é
       reconhecível pela FORMA (um elemento com `aria-label` cujo svg carrega
       um `<title>` da família de ícones do WhatsApp) — e só então pergunta se
       aquele status é "pendente", por DOIS caminhos independentes: o nome do
       ícone e o rótulo acessível. Basta um deles.

       O que continua proibido, e continua valendo: casar texto solto da
       página. O rótulo só é lido DENTRO de um nó de status verificado, dentro
       de uma bolha que `ehDeSaida()` confirmou — um contato chamado "pagamento
       pendente" não tem como pôr `aria-label` num svg de status meu. */
    // Legado: builds antigas do WhatsApp Web ainda usavam `data-icon`.
    const PENDENTE_SEL = [
      '[data-icon="msg-time"]',
      '[data-icon="msg-time-full"]',
      '[data-icon="msg-time-refreshed"]',
      '[data-testid="msg-time"]',
      '[data-icon="status-time"]',
    ].join(",");
    // Onde o nome do ícone pode estar hoje: título de svg, ou os atributos de
    // sempre. Um nó só é NÓ DE STATUS se tiver nome de ícone conhecido.
    const NOME_ICONE_FAM = /^(wds-ic-|msg-|status-|ic-)/;
    const PENDENTE_NOME = /(clock|time|pend|sched|hourglass|wait|sending)/i;
    // Rótulos de "ainda não saiu" — pt-BR e en. Só lidos dentro do nó de
    // status; nunca varridos no documento.
    const PENDENTE_ROTULO = /(pendente|enviando|aguardando|pending|sending|clock)/i;
    // Rótulos de status JÁ RESOLVIDO: servem de canário. Se a conversa tem
    // status resolvido e nenhum deles é reconhecido, a marcação mudou de novo.
    const RESOLVIDO = /(lida|lido|entregue|enviad|read|deliver|sent|check)/i;
    let ultimoIconePendente = "";   // p/ o `why` da transição (forense)
    let statusDesconhecidos = [];   // canário: nomes de status que não sabemos ler

    /** Nome do ícone de um nó, onde quer que o WhatsApp o esteja guardando. */
    function nomeDoIcone(el) {
      try {
        const a = el.getAttribute("data-icon") || el.getAttribute("data-testid") || "";
        if (a && NOME_ICONE_FAM.test(a)) return a;
        const t = el.querySelector("svg title, title");
        const v = t && t.textContent ? t.textContent.trim() : "";
        if (v && NOME_ICONE_FAM.test(v)) return v;
        if (a) return a;
        return v;
      } catch (_) { return ""; }
    }
    /** Os nós de STATUS de uma bolha: rótulo acessível + ícone da família. */
    function nosDeStatus(bolha) {
      const out = [];
      try {
        for (const e of bolha.querySelectorAll("[aria-label]")) {
          const nome = nomeDoIcone(e);
          if (!nome || !NOME_ICONE_FAM.test(nome)) continue;
          out.push({ el: e, nome, rotulo: e.getAttribute("aria-label") || "" });
        }
      } catch (_) {}
      return out;
    }
    function pendingOutgoing() {
      // Ordem invertida de propósito: o ícone é raro e a checagem é barata; a
      // direção (que mede geometria) só roda para quem já tem o relógio.
      let achou = false;
      for (const b of bolhasVisiveis()) {
        // (a) caminho legado — `data-icon` de builds antigas.
        if (algumVisivel(PENDENTE_SEL, b)) {
          if (ehDeSaida(b)) { ultimoIconePendente = "legado:data-icon"; achou = true; break; }
          continue;
        }
        // (b) caminho de hoje — nó de status verificado dentro da bolha.
        const nos = nosDeStatus(b);
        if (!nos.length) continue;
        let saida = null; // só calcula a direção (geometria) se precisar
        for (const n of nos) {
          if (!visivel(n.el)) continue;
          const pendente = PENDENTE_NOME.test(n.nome) || PENDENTE_ROTULO.test(n.rotulo);
          if (!pendente) {
            // canário: status que não é pendente E não é reconhecidamente
            // resolvido = a marcação mudou de novo e este sinal vai cegar.
            if (!RESOLVIDO.test(n.nome) && !RESOLVIDO.test(n.rotulo) &&
                statusDesconhecidos.indexOf(n.nome) < 0 && statusDesconhecidos.length < 8) {
              statusDesconhecidos.push(n.nome);
              console.warn("[ZapLite/conn] status de mensagem desconhecido:", n.nome, n.rotulo);
            }
            continue;
          }
          if (saida == null) saida = ehDeSaida(b);
          if (!saida) break;
          ultimoIconePendente = n.nome + " / '" + n.rotulo.trim() + "'";
          achou = true;
          break;
        }
        if (achou) break;
      }
      return achou;
    }

    /* --- L4: o que o RUST decidiu (evento `zaplite://conn-state`) --------
       Este evento é emitido pelo Rust a cada transição — inclusive as que ele
       decide SOZINHO: o FAILED do circuit breaker do watchdog e as
       renavegações de nível 3. Até aqui NÃO existia um único ouvinte no
       repositório, então a decisão da camada nativa nunca chegava ao usuário:
       o indicador mostrava só o estado do JS.

       O payload é tratado como NÃO CONFIÁVEL: `core:default` permite que
       qualquer script da página chame `event.emit()` e forje este evento. Por
       isso o ouvinte só ALIMENTA O INDICADOR — nunca chama setState, nunca
       decide recuperação, e nunca renderiza string vinda do payload (o rótulo
       exibido é sempre texto nosso, escolhido por um nome de estado que
       precisa estar na lista abaixo). O pior que um forjador consegue é um
       rótulo errado no badge. */
    const ESTADOS = {
      STARTING: 1, NEEDS_AUTH: 1, CONNECTED: 1, OFFLINE: 1,
      DEGRADED: 1, RECONNECTING: 1, FAILED: 1,
    };
    let rust = null;         // { state, reason, attempts, ts }
    let rustSozinho = false; // a última notícia do Rust não é eco da nossa
    let ouvindoRust = false;

    function ouveRust() {
      if (ouvindoRust) return true;
      try {
        if (!window.__TAURI__ || !window.__TAURI__.event || !window.__TAURI__.event.listen) return false;
        const p = window.__TAURI__.event.listen("zaplite://conn-state", (ev) => {
          const d = (ev && ev.payload) || {};
          const st = typeof d.state === "string" && ESTADOS[d.state] ? d.state : null;
          if (!st) return;
          const rs = typeof d.reason === "string" ? d.reason.slice(0, 160) : "";
          const at = parseInt(d.attempts, 10);
          // Decisão do Rust é o que NÃO é eco da transição que acabamos de
          // mandar. O watchdog carimba os motivos dele com "watchdog:".
          rustSozinho = /^watchdog:/.test(rs) || !foiNossa(st + "|" + rs);
          rust = { state: st, reason: rs, attempts: isFinite(at) ? at : 0, ts: Date.now() };
          console.log("[ZapLite/conn] rust:", st, "|", rs, rustSozinho ? "(decisão do app)" : "(eco)");
          sinaliza();
        });
        if (p && typeof p.catch === "function") p.catch(() => { ouvindoRust = false; });
        ouvindoRust = true;
        return true;
      } catch (_) { return false; }
    }

    /* --- indicador visual: a verdade das DUAS camadas -------------------- */
    const ROTULO = {
      CONNECTED: "conectado",
      STARTING: "carregando…",
      // M3: a tela de login não está "falhando" — está esperando um humano.
      NEEDS_AUTH: "escaneie o QR no celular",
      OFFLINE: "sem conexão — recuperando",
      DEGRADED: "conexão degradada — recuperando",
      RECONNECTING: "reconectando",
      // M2: o rótulo antigo ("reabra o ZapLite") pedia ao usuário exatamente o
      // que este app existe para evitar. FAILED agora é descanso com prazo.
      FAILED: "sem conexão — descansando antes de tentar de novo",
    };
    const GRAVIDADE = {
      CONNECTED: 0, STARTING: 1, NEEDS_AUTH: 2,
      DEGRADED: 3, OFFLINE: 3, RECONNECTING: 3, FAILED: 4,
    };
    const COR = ["#22d3aa", "#f5c451", "#f5c451", "#f5c451", "#ef6461"];
    const BASE_BADGE =
      "position:fixed;left:10px;bottom:10px;z-index:2147483003;pointer-events:none;" +
      "border-radius:999px;box-sizing:border-box;font:600 11.5px system-ui,-apple-system,sans-serif;";

    function sinaliza() {
      try {
        if (!document.body) return;
        const rEst = rust && rust.state;
        const gJs = GRAVIDADE[state] || 0;
        const gRs = rEst ? GRAVIDADE[rEst] || 0 : -1;
        // vence a camada mais grave: se o Rust já está em FAILED ou
        // renavegando, é isso que o usuário precisa ver, mesmo com o JS
        // achando que está tudo bem.
        const doRust = gRs > gJs;
        const efetivo = doRust ? rEst : state;
        const grav = gRs > gJs ? gRs : gJs;

        let el = document.getElementById("zl-conn-badge");
        if (!el) {
          el = document.createElement("div");
          el.id = "zl-conn-badge";
          el.setAttribute("aria-live", "polite");
          document.body.appendChild(el);
        }
        el.title = "ZapLite — página: " + state + " · app: " + (rEst || "—");
        if (grav === 0) {
          // Tudo certo nas duas camadas: ponto discreto, sem texto e sem
          // roubar espaço do WhatsApp. É o indicador de status permanente.
          el.style.cssText = BASE_BADGE + "width:7px;height:7px;padding:0;opacity:.3;background:" + COR[0] + ";";
          el.textContent = "";
          return;
        }
        el.style.cssText = BASE_BADGE +
          "padding:5px 10px;max-width:52vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" +
          "color:#04120e;opacity:.96;box-shadow:0 4px 16px rgba(0,0,0,.32);background:" +
          (COR[grav] || COR[3]) + ";";
        const seg = Math.round((Date.now() - (doRust ? rust.ts : since)) / 1000);
        const tent = doRust ? rust.attempts : attempts;
        // M3 — o indicador tem que dizer a VERDADE, inclusive a verdade
        // "parei de tentar de propósito e volto em Ns". Um badge que promete
        // recuperação enquanto o app espera é tão ruim quanto recarregar.
        const espera = Math.round((aguardandoAte - Date.now()) / 1000);
        // só texto NOSSO, nunca string vinda da página nem do payload
        el.textContent =
          "ZapLite • " + (ROTULO[efetivo] || efetivo) +
          (doRust && rustSozinho ? " · o app está agindo" : "") +
          (tent ? " · tentativa " + tent : "") +
          (espera > 1 ? " · aguardando " + espera + "s" : "") +
          (seg > 4 ? " · " + seg + "s" : "");
      } catch (_) {}
    }

    /* --- M5: nível 1 de fato SELETIVO -----------------------------------
       O nível 1 alegava "fecha só o socket implicado", mas caía em
       `[...live.keys()]` sempre que `presos.length === 0` — e a medição do
       próprio projeto diz `bufferedAmount > 0` em 0 de 659 amostras. Ou seja:
       na prática ele fechava TODOS os sockets, todas as vezes. Isso não é
       detalhe estético. Carga de reconexão foi o que invalidou a sessão do
       usuário duas vezes neste projeto: derrubar sockets sãos é justamente o
       gesto caro.
       Agora "implicado" tem três evidências, todas POR SOCKET, e nenhuma
       delas é "não sei qual é":
         · fila de envio daquele socket sem progresso (L6);
         · aquele socket mudo há mais que SILENCE_MS;
         · aquele socket falou depois de ouvir e ficou sem resposta.
       Sem nenhuma evidência, a ação é a mais BRANDA: cutuca a reconexão
       interna e não fecha nada. */
    function socketsImplicados(now) {
      const alvos = new Set();
      socketsPresos(now).forEach((p) => alvos.add(p.ws));
      live.forEach((r, w) => {
        try {
          if (w.readyState !== NativeWS.OPEN) return;
          if (now - r.rx > SILENCE_MS) { alvos.add(w); return; }
          if (r.tx && r.tx > r.rx && now - r.tx > UNANSWERED_MS) alvos.add(w);
        } catch (_) {}
      });
      return [...alvos];
    }
    // Cutucão da reconexão interna da página. Um par de eventos por
    // recuperação autorizada — e o Rust limita quantas recuperações existem,
    // então isto não vira rajada.
    function cutucaReconexao() {
      try {
        window.dispatchEvent(new Event("offline"));
        window.dispatchEvent(new Event("online"));
      } catch (_) {}
    }
    function nivel1() {
      const agora = Date.now();
      const alvos = socketsImplicados(agora);
      cutucaReconexao();
      if (!alvos.length) {
        console.log("[ZapLite/conn] nível 1 brando: nenhum socket implicado, nada foi fechado");
        return "brando (nenhum socket implicado)";
      }
      alvos.forEach((w) => { try { w.close(); } catch (_) {} });
      return alvos.length + " de " + live.size + " sockets fechados (implicados)";
    }

    /* --- M1: quem conta a recuperação é o RUST ---------------------------
       O contador não pode morar aqui. O nível 2 É um `location.reload()`:
       tudo que esta closure sabe morre junto com o documento, e ao voltar ela
       lia do Rust um contador que o Rust congelava em STARTING/NEEDS_AUTH.
       As duas camadas estavam certas isoladamente e a composição não tinha
       breaker nenhum — 8 recargas em 35 min, todas "tentativa 1".
       Agora: pedimos autorização ANTES de agir. Quem conta o disparo, aplica
       backoff e decide convergir é o processo que sobrevive ao reload. */
    /* W2 — SILÊNCIO SUSPEITO x FALHA COMPROVADA.
       A carência pós-suspensão (e as outras) existe porque, logo depois de um
       salto de relógio, tudo PARECE quebrado: socket ainda reabrindo, árvore
       ainda montando. Sinal que nasce de AUSÊNCIA não sabe distinguir "morto"
       de "ainda subindo" e por isso espera a carência.
       Sinal que nasce de um FATO OBSERVADO, não. Em 16/08 22:19:42, cinco
       segundos depois do retorno de suspensão, esta camada reportou "websocket
       fechado sem retomada" e o Rust respondeu "NEGADA: backoff em curso:
       faltam 39s" — quatro minutos de mensagem presa vieram daí.
       Marcamos aqui, e só aqui, o que é fato observado. O Rust decide o resto;
       o furo vale só para o nível 1 e tem orçamento próprio lá. */
    function ehFalhaComprovada(target, cenario, why) {
      if (target !== "OFFLINE" && target !== "DEGRADED") return false;
      // fatos: socket fechado sem retomada / fila que não drena / bolha presa
      if (cenario === "envio-preso") return true;
      return (
        why === "websocket fechado sem retomada" ||
        why.indexOf("fila de envio sem progresso") === 0
      );
    }
    function pedeRecuperacao(nivel, cenario, why, comprovada) {
      pedindo = true;
      invoke("conn_recovery", {
        nivel: nivel, cenario: cenario, reason: why, comprovada: !!comprovada,
      })
        .then((v) => {
          semPonte = false;
          const a = parseInt((v && v.attempts) || 0, 10);
          if (isFinite(a) && a >= 0) attempts = Math.min(a, MAX_ATTEMPTS);
          const ms = parseInt((v && v.esperaMs) || 0, 10);
          const espera = isFinite(ms) && ms > 0 ? Math.min(ms, 30 * 60000) : 0;
          nextAttemptAt = Date.now() + espera;
          if (!v || !v.permitido) {
            // NEGADO é uma decisão, não um erro: insistir não conserta este
            // cenário. O app para de recarregar e passa a aguardar — e volta
            // sozinho quando o descanso acabar (ou antes, com sinal positivo).
            aguardandoAte = nextAttemptAt;
            aguardandoMotivo = (v && typeof v.motivo === "string") ? v.motivo.slice(0, 160) : "recuperação negada";
            if (v && v.convergiu && state !== "FAILED") {
              setState("FAILED", "convergiu — " + aguardandoMotivo);
            }
            sinaliza();
            return;
          }
          aguardandoAte = 0;
          aguardandoMotivo = "";
          const motivo = "nível " + nivel + ", tentativa " + attempts +
            " (contada pelo Rust) — " + why;
          if (state !== "RECONNECTING") {
            setState("RECONNECTING", motivo);
          } else {
            reason = motivo;
            since = Date.now();
            sendTransition("RECONNECTING", "RECONNECTING", motivo, since);
            sinaliza();
          }
          if (nivel === 1) nivel1();
          else { try { location.reload(); } catch (_) {} }
        })
        .catch(() => {
          // Sem ponte não há contador confiável nem supervisor: recarregar às
          // cegas viraria laço infinito. Nível 1 brando e backoff local.
          semPonte = true;
          attempts = Math.min(attempts + 1, MAX_ATTEMPTS);
          nextAttemptAt = Date.now() + backoffDe(attempts);
          nivel1();
        })
        .finally(() => { pedindo = false; });
    }

    /* --- avaliação + recuperação escalonada ----------------------------- */
    function evaluate() {
      if (evaluating) return;
      evaluating = true;
      try { evaluateInner(); } catch (e) { console.warn("[ZapLite/conn] avaliação falhou", e); }
      evaluating = false;
    }
    // L3 — os eventos online/offline do sistema chegam em rajada (medido:
    // 3,8 trocas por segundo por mais de um minuto). Coalescê-los antes de
    // avaliar é a primeira metade do amortecimento; a histerese, adiante, é
    // a segunda.
    function agenda() {
      if (agendado) return;
      agendado = setTimeout(() => { agendado = 0; evaluate(); }, DEBOUNCE_MS);
    }

    function evaluateInner() {
      const now = Date.now();
      const abertos = openSockets();
      if (abertos > 0) lastOpenTs = now;

      // Debounce só para PERDER a prontidão: o SPA recria a árvore e o
      // #pane-side some por um tick — não é motivo para sair de CONNECTED.
      // Ganhar prontidão continua imediato.
      const prontoAgora = appReady();
      if (prontoAgora) naoProntoTicks = 0;
      else if (state === "CONNECTED" || state === "DEGRADED") naoProntoTicks++;
      else naoProntoTicks = 99;
      const pronto = prontoAgora || naoProntoTicks <= 2;

      const carregando = loadingScreen();

      const loginAgora = loginScreen();
      if (loginAgora) {
        loginTicks++;
        if (authDesde == null) authDesde = now;
      } else {
        loginTicks = 0;
        authDesde = null;
      }

      /* A tela de login É interface: o relógio do teto de CARREGAMENTO não
         pode correr por baixo dela. Sem isto, `semUiDesde` acumulava durante
         todo o NEEDS_AUTH e bastava UM tick em que o QR piscasse (o WhatsApp
         troca o canvas a cada regeneração) para o fluxo cair no ramo de
         STARTING já com o teto estourado e recarregar na hora. Medido em
         14/08 15:47:52, em cima de um QR REAL: "sem interface há 164s — teto
         de carregamento estourado", 157s depois de entrar em NEEDS_AUTH.
         Quem governa a tela de login é o teto do NEEDS_AUTH, e só ele. */
      if (pronto || loginAgora) semUiDesde = null;
      else if (semUiDesde == null) semUiDesde = now;

      const presos = socketsPresos(now);

      if (pendingOutgoing()) { if (pendingSince == null) pendingSince = now; }
      else pendingSince = null;

      const socketDown = hadSocket && abertos === 0 && now - lastOpenTs > SOCKET_GRACE_MS;
      const banner = offlineBanner();
      const rxIdade = lastRx ? now - lastRx : Infinity;
      const semResposta = txSemResposta ? now - txSemResposta : 0;
      if (!navigator.onLine || socketDown || banner || presos.length) ultimaQueda = now;
      let porCarregamento = false;
      // M3 — rótulo do cenário. É por cenário que o Rust converge: N
      // tentativas do MESMO tipo sem progresso e ele manda parar de insistir.
      let cenario = "socket";

      let target, why;
      if (!navigator.onLine) { target = "OFFLINE"; why = "navigator.onLine=false"; }
      else if (banner) { target = "OFFLINE"; why = banner; }
      // Socket caído só vira OFFLINE com a interface JÁ pronta. Durante o
      // carregamento (e na tela de login) o WhatsApp abre e fecha socket como
      // parte do fluxo normal: tratar isso como queda gerava tentativa e
      // fechamento de sockets logo no boot (visto no log de 10:07:08). Se a
      // interface nunca ficar pronta, quem cobra é o teto de STARTING.
      else if (socketDown && pronto && !carregando) { target = "OFFLINE"; why = "websocket fechado sem retomada"; }
      // Degradação que NÃO depende de o usuário estar enviando nada — o
      // próprio WhatsApp fala com o servidor sozinho. Do mais rápido e
      // específico ao mais lento:
      // 1) a fila de envio do socket não PROGRIDE (TCP meio-aberto);
      else if (pronto && presos.length) {
        target = "DEGRADED";
        why = "fila de envio sem progresso há " + (presos[0].ms / 1000).toFixed(1) +
          "s, " + presos[0].bytes + " bytes presos (recebe mas não envia)";
      }
      // 2) falamos e ninguém respondeu por muito mais que a cadência normal;
      else if (pronto && abertos > 0 && txSemResposta && semResposta > UNANSWERED_MS) {
        target = "DEGRADED";
        why = "socket aberto sem resposta há " + Math.round(semResposta / 1000) + "s (recebe mas não envia)";
      }
      // 3) silêncio total no socket "aberto".
      else if (pronto && abertos > 0 && rxIdade > SILENCE_MS) {
        target = "DEGRADED";
        why = "socket aberto e mudo há " + Math.round(rxIdade / 1000) + "s (socket zumbi)";
      }
      else if (pendingSince != null && now - pendingSince > PENDING_MS) {
        target = "DEGRADED";
        // O NOME do ícone medido vai no log de propósito: foi exatamente a
        // troca silenciosa desse nome que cegou a detecção por meses.
        why = "mensagem de saída presa com relógio >" + PENDING_MS / 1000 + "s" +
          (ultimoIconePendente ? " [status: " + ultimoIconePendente + "]" : "");
        cenario = "envio-preso";
      }
      // CONNECTED é afirmação: interface + socket + tráfego recente.
      else if (pronto && abertos > 0 && rxIdade <= SILENCE_MS) {
        target = "CONNECTED"; why = "interface pronta, socket aberto e tráfego recente";
      }
      else if (loginTicks >= LOGIN_TICKS_MIN) {
        /* M3 — DUAS coisas muito diferentes usam a mesma tela:
           (a) "o usuário ainda não escaneou" — não é falha, e recarregar só
               troca o QR debaixo dele. Remédio humano: esperar. Este ramo
               NUNCA dispara recuperação, por mais que demore. Foi ele que
               produziu as 8 recargas de 16:03 a 16:39.
           (b) "o login apareceu logo depois de sinais de queda" — pode ser
               sessão derrubada pela rede, e aí vale tentar. Continua com o
               tier de 45 s, mas agora TEM FIM: o breaker do Rust converge
               depois de MAX_DISPAROS_CENARIO tentativas no cenário
               'login-apos-queda' e manda aguardar.
           O que NÃO entra na suspeita, de propósito: `attempts > 0`. Com o
           contador consertado (M1), ele fica alto por minutos depois de
           qualquer recuperação — mantê-lo aqui marcaria como suspeita QUALQUER
           tela de login posterior a uma queda já resolvida, que é o carimbo
           errado no caso (a). Suspeita vem de sinal ATUAL, não de histórico. */
        const idade = now - (authDesde || now);
        const vivo = abertos > 0 && rxIdade < SILENCE_MS;
        // Um QR servido pelo MARKUP PRÓPRIO do WhatsApp (aria-label "Scan this
        // QR code…", canvas dentro de div[data-ref], data-testid
        // link-device-qr-code) e por cima de um socket vivo é evidência forte
        // de tela de login LEGÍTIMA — o servidor está ali, do outro lado,
        // gerando o código. Medido: em 14/08 15:40 uma sessão caiu e voltou
        // como QR real, com socket aberto — tratar aquilo como falha seria
        // recarregar no exato momento em que o usuário ia escanear.
        const forte = algumVisivel(LOGIN_SEL);
        const suspeito =
          !vivo ||
          (!forte && ultimaQueda > 0 && now - ultimaQueda < QUEDA_RECENTE_MS);
        if (suspeito && idade > AUTH_SUSPEITO_MS) {
          // fechar socket não cura tela de login: se for tentar, é reload
          porCarregamento = true;
          cenario = "login-apos-queda";
          target = "DEGRADED";
          why = "tela de login há " + Math.round(idade / 1000) +
            "s logo após sinais de queda (possível sessão derrubada)";
        } else {
          target = "NEEDS_AUTH";
          why = suspeito
            ? "tela de login visível após sinais de queda (aguardando " +
              Math.round((AUTH_SUSPEITO_MS - idade) / 1000) + "s antes de tentar)"
            : "tela de login visível (QR/vincular aparelho) — esperando você escanear, sem recarregar";
        }
      }
      else {
        // STARTING com teto: nenhum estado pode ser buraco negro.
        const teto = carregando ? LOADING_MAX_MS : STARTING_MAX_MS;
        const idade = now - (semUiDesde || now);
        if (idade > teto) {
          porCarregamento = true;
          cenario = "carregamento";
          target = "DEGRADED";
          why = "sem interface há " + Math.round(idade / 1000) + "s" +
            (carregando ? " (tela de carregamento travada)" : "") + " — teto de carregamento estourado";
        } else {
          target = "STARTING";
          why = carregando
            ? "carregando (tela do WhatsApp)"
            : pronto
            ? "interface pronta, socket reabrindo"
            : "aguardando interface";
        }
      }

      const ruim = target === "OFFLINE" || target === "DEGRADED";
      if (ruim) ultimaQueda = now;

      /* L3 — HISTERESE. Um alvo diferente do estado atual precisa se sustentar
         por CONFIRMA_MS antes de virar transição (e antes de disparar
         recuperação). Exceção deliberada: CONNECTED entra na hora, porque já
         é uma afirmação tripla (interface + socket + tráfego), nunca esteve
         no flapping medido, e atrasá-lo só atrasaria o boot. */
      if (target !== cand) { cand = target; candDesde = now; }
      const maduro = target === "CONNECTED" || target === state || now - candDesde >= CONFIRMA_MS;

      sinaliza();

      if (!ruim) {
        if (state !== target && maduro && !(state === "RECONNECTING" && target === "STARTING")) {
          setState(target, why);
        }
        return;
      }

      /* M2 — FAILED com TETO. Era `if (state === "FAILED") return;` e ponto
         final: o JS desligava a recuperação para sempre, o watchdog do Rust
         não substituía (ele só age no SILÊNCIO do heartbeat, e aqui o
         heartbeat continua chegando) e o badge admitia a derrota mandando o
         usuário reabrir o app. Reinício manual é o defeito que este projeto
         existe para eliminar. Agora FAILED é descanso, e descanso acaba. */
      if (state === "FAILED") {
        if (now - failedDesde < FAILED_REST_MS) return;
        setState(target, "descanso de " + Math.round(FAILED_REST_MS / 1000) +
          "s terminou — o app volta a tentar sozinho");
      }
      if (!maduro) return;            // ainda não é queda confirmada
      if (state !== target && state !== "RECONNECTING") setState(target, why);

      // Sem o contador restaurado do Rust não se escala nada: agir sem saber
      // quantas tentativas já houve é o mesmo que não ter circuit breaker.
      if (!restaurado) return;

      if (attempts >= MAX_ATTEMPTS) {
        setState("FAILED", "circuit breaker: " + attempts + " tentativas seguidas sem sucesso");
        return;
      }
      if (pedindo) return;             // já há um pedido em voo
      const comprovada = ehFalhaComprovada(target, cenario, why);
      /* W2 — o backoff LOCAL também barrava a falha comprovada. Depois de uma
         recusa, `nextAttemptAt` guarda o instante que o Rust mandou esperar, e
         a página nem chegava a perguntar de novo: o furo do lado Rust nunca
         seria exercido. Quem decide o furo é o Rust (é ele que tem o
         orçamento); a página só volta a PERGUNTAR — e não a 1 Hz. */
      if (now < nextAttemptAt) {
        if (!comprovada) return;
        if (now - ultimoPedidoComprovado < PEDIDO_COMPROVADO_MIN_MS) return;
      }
      if (comprovada) ultimoPedidoComprovado = now;

      // Carregamento travado (e tela de login suspeita) não se cura fechando
      // socket: vai direto ao reload.
      let nivel = porCarregamento ? 2 : attempts <= 2 ? 1 : 2;
      // Sem ponte nativa não há contador confiável nem supervisor: recarregar
      // às cegas viraria laço infinito. Fica no nível 1.
      if (semPonte && nivel === 2) nivel = 1;

      // M1: NÃO incrementamos nada aqui. Quem conta o disparo — e quem decide
      // se ele pode acontecer — é o Rust, que sobrevive ao reload.
      pedeRecuperacao(nivel, cenario, why, comprovada);
    }

    /* --- laços ---------------------------------------------------------- */
    // A transição de BOOT só sai DEPOIS de restaurar o contador: como o Rust
    // guarda `attempts` do que a gente manda, um BOOT com attempts=0 zeraria
    // no Rust justamente o contador que acabamos de ler dele — e o reload do
    // nível 2 voltaria a ser gratuito. O instante real do boot vai no `ts`.
    const tBoot = Date.now();
    ouveRust();
    restauraContador().then(() => {
      ouveRust();
      sendTransition("BOOT", "STARTING", "script de conexão injetado", tBoot);
    });
    /* --- E2: pausa de JS declarada pela PRÓPRIA página --------------------
       Um `setInterval` não "atrasa um pouco" quando o heap é grande: numa
       coleta maior ele PARA. O heap desta conta foi medido em 1,2–1,3 GB
       (~181 conversas), e o `connection.log` de 17/08 mostra o efeito — o
       renderizador ficou mudo por 2min12s (09:45:16→09:47:28) e por 3min49s
       (09:52:28→09:56:17) com a página perfeitamente viva nas duas vezes.

       Do lado do Rust, silêncio de heartbeat é ambíguo: cabe "webview morreu"
       e cabe "JS congelou". Quem consegue desempatar é só quem estava dentro
       da pausa. Este tique mede o salto entre suas próprias execuções: se ele
       voltou 130 s depois de rodar, o JS esteve parado 130 s, e isso vai no
       heartbeat seguinte. Um atraso EXPLICADO não é zumbi.

       Note que durante a pausa nada disto roda — e é exatamente esse o sinal.
       O relato é retroativo, por construção; o Rust usa esse recorde para
       calibrar quanto silêncio ainda é plausível NESTA máquina. */
    const PULSO_MS = 1000;
    const PAUSA_MIN_MS = 2000;
    let ultimoPulso = Date.now();
    let pausaMaxMs = 0;
    setInterval(() => {
      const agora = Date.now();
      const salto = agora - ultimoPulso - PULSO_MS;
      ultimoPulso = agora;
      // Relógio de parede também anda na suspensão do Windows; o Rust já trata
      // salto de relógio à parte, e mandar a pausa a mais é conservador na
      // direção certa (esperar em vez de destruir).
      if (salto > PAUSA_MIN_MS) pausaMaxMs = Math.max(pausaMaxMs, salto);
    }, PULSO_MS);

    /* --- E3: existe texto não enviado no campo de mensagem? ---------------
       SÓ LÊ. Nada aqui escreve, foca ou dispara evento no campo — o custo de
       um erro aqui seria mandar mensagem sozinho. O seletor é o mesmo já usado
       pelo recurso de rascunho da IA (`div[contenteditable][data-tab]`),
       restrito ao painel da conversa aberta (`#main`) para não confundir a
       caixa de busca com a de mensagem. */
    function temRascunho() {
      try {
        const main = document.getElementById("main");
        if (!main) return false;
        const box = main.querySelector('div[contenteditable="true"][data-tab]');
        if (!box) return false;
        return ((box.innerText || box.textContent || "").trim().length > 0);
      } catch (_) {
        return false;
      }
    }

    setInterval(evaluate, TICK_MS);
    setInterval(amostraBuffers, FAST_TICK_MS);
    /* Abertura do app: a lista de conversas é o sinal mais caro de ESPERAR.
       Com só o tique de 1 s, o app podia levar até 1 s para PERCEBER que a
       lista já estava na tela — tempo nosso, não do WhatsApp (medido: 0,13 s
       em média, 1 s no pior caso). Uma sonda barata (`getElementById`, tabela
       de hash) só até a primeira prontidão adianta o `evaluate` para ≤100 ms.
       Não muda regra nenhuma de decisão — só o INSTANTE em que a avaliação
       roda; quem decide continua sendo `evaluateInner`, com a mesma
       histerese, os mesmos tetos e o mesmo contador do Rust. */
    let sondaPronto = setInterval(() => {
      if (!document.getElementById("pane-side")) return;
      clearInterval(sondaPronto);
      sondaPronto = 0;
      evaluate();
    }, 100);
    window.addEventListener("online", agenda);
    window.addEventListener("offline", agenda);
    document.addEventListener("visibilitychange", agenda);
    setInterval(() => {
      flushFila();
      if (!ouvindoRust) ouveRust();
      // E2/E3 — o heartbeat leva agora duas informações que só a página tem:
      // quanto tempo o JS ficou congelado desde o último batimento, e se há
      // texto não enviado na tela. O Rust trata as duas como SINAL com teto
      // (nenhuma consegue desligar o watchdog), nunca como veredito.
      const pausaMs = Math.round(pausaMaxMs);
      invoke("conn_heartbeat", {
        state,
        attempts,
        pausedMs: pausaMs,
        draft: temRascunho(),
      })
        .then(() => { semPonte = false; pausaMaxMs = Math.max(0, pausaMaxMs - pausaMs); })
        .catch(() => { semPonte = true; });
    }, HEARTBEAT_MS);

    /* --- simulação de queda: exige evento CONFIÁVEL ---------------------
       `simulateDrop(ms)` exposto no objeto global era um backdoor: qualquer
       script da página chamava simulateDrop(999999999) e todo WebSocket novo
       passava a morrer 50ms após nascer, por ~11 dias. Agora o gatilho é uma
       tecla com `isTrusted === true`, que script de página não consegue
       forjar (KeyboardEvent despachado por JS vem com isTrusted=false), e a
       duração é fixa. Quem testa: o usuário pelo teclado, ou o CDP via
       Input.dispatchKeyEvent (que gera evento confiável). */
    function simulaQueda(origem) {
      blockUntil = Date.now() + SIM_DROP_MS;
      if (live.size === 0) { hadSocket = true; lastOpenTs = Date.now() - SOCKET_GRACE_MS; }
      live.forEach((_r, w) => { try { w.close(); } catch (_) {} });
      console.log("[ZapLite/conn] queda simulada por " + SIM_DROP_MS + "ms (" + origem + ")");
    }
    window.addEventListener(
      "keydown",
      (e) => {
        if (!e.isTrusted) return;
        if (e.ctrlKey && e.altKey && e.shiftKey && (e.key === "D" || e.key === "d")) {
          e.preventDefault();
          simulaQueda("atalho " + SIM_CHORD);
        }
      },
      true
    );

    /* --- exposto só p/ diagnóstico (nada acionável pela página) --------- */
    window.__ZAPLITE_CONN__ = {
      get info() {
        const now = Date.now();
        return {
          state, since, attempts, reason,
          socketsAbertos: openSockets(),
          lastRx, lastTx, txSemResposta,
          bufferPreso: bufferPreso(),
          presos: socketsPresos(now).map((p) => ({ bytes: p.bytes, ms: p.ms })),
          proximaTentativaEm: Math.max(0, nextAttemptAt - now),
          aguardandoEm: Math.max(0, aguardandoAte - now), aguardandoMotivo,
          implicados: socketsImplicados(now).length, sockets: live.size,
          failedHaMs: failedDesde ? now - failedDesde : 0,
          restaurado, semPonte, pedindo, fila: fila.length,
          // sinais crus, p/ auditoria — leitura, nunca ação
          login: loginScreen(), banner: offlineBanner(), pronto: appReady(),
          authIdadeMs: authDesde ? now - authDesde : 0,
          quedaHaMs: ultimaQueda ? now - ultimaQueda : -1,
          candidato: cand, candidatoHaMs: cand ? now - candDesde : 0,
          rust, rustSozinho, ouvindoRust,
        };
      },
      simulateDrop() {
        console.warn(
          "[ZapLite/conn] simulateDrop() desativado no bundle de produção: era negação de serviço acionável por qualquer script da página. Use " +
            SIM_CHORD + " (evento confiável: teclado do usuário ou CDP Input.dispatchKeyEvent)."
        );
        return "desativado: use " + SIM_CHORD + " com evento confiável";
      },
    };

  })();


  let settings = {};
  const on = (id) => settings.modules && settings.modules[id] === true;

  /* --- utilidades de DOM / espera ------------------------------------------ */
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(fn, timeout = 20000, step = 300) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const v = fn();
      if (v) return v;
      await wait(step);
    }
    return null;
  }
  // Fila de estilos pedidos antes da página existir. O initialization_script
  // roda antes do documento, então documentElement pode ser null aqui.
  const cssQueue = [];
  const css = (text, key) => {
    const root = document.head || document.documentElement;
    if (!root) {
      cssQueue.push([text, key]);
      return;
    }
    let el = document.getElementById(key);
    if (!el) {
      el = document.createElement("style");
      el.id = key;
      root.appendChild(el);
    }
    el.textContent = text;
  };
  const flushCss = () => {
    while (cssQueue.length) {
      const [t, k] = cssQueue.shift();
      css(t, k);
    }
  };
  const dropCss = (key) => {
    const el = document.getElementById(key);
    if (el) el.remove();
  };

  /* ========================================================================
     REGISTRO DE MÓDULOS
     Cada módulo: { id, label, apply(), revert() }
     apply() é idempotente. revert() desfaz efeitos visuais quando desligado.
     ======================================================================== */
  const modules = [];
  const reg = (m) => modules.push(m);
  /** Um módulo consultando outro (A6: o menu do botão direito pergunta ao
      anti-apagadas o que ele guardou). Sem isto seria uma segunda cópia do
      `_store` — e duas cópias divergem. */
  const moduloPorId = (id) => modules.filter((m) => m.id === id)[0] || null;

  /* 1. Enviar para número não salvo -------------------------------------- */
  reg({
    id: "unsavedSend",
    apply() {
      addAct(ensureDock(), "zl-unsaved", "☎", "Enviar p/ número não salvo", "", () => {
        const raw = prompt("Número com DDI e DDD (só dígitos). Ex: 5511999998888");
        if (!raw) return;
        const num = raw.replace(/\D/g, "");
        if (num.length < 10) return alert("Número inválido.");
        location.href = "https://web.whatsapp.com/send?phone=" + num;
      });
    },
    revert() {
      dropAct("zl-unsaved");
    },
  });

  /* 4. Anti-apagadas ------------------------------------------------------ */
  // Tetos do histórico capturado. Sem eles o `_store` era um vazamento por
  // construção: uma entrada por linha de mensagem que passasse pela tela, texto
  // inteiro, para sempre. Medido no perfil real, é a única estrutura NOSSA que
  // cresce sem parar. 600 mensagens cobrem folgadamente a rolagem que o
  // WhatsApp mantém viva; o que cair fora dela não estava mais na tela.
  const AD_MAX_ENTRADAS = 600;
  const AD_MAX_TEXTO = 4096;   // por mensagem (uma colagem enorme não fica retida)
  const AD_VARREDURA_MS = 500; // piso entre varreduras do documento inteiro
  const AD_INICIAL_TENTATIVAS = 12;  // Y4: ~7s esperando a lista renderizar
  const AD_INICIAL_INTERVALO = 600;

  /* Y3 — throttle COM BORDA DE SAÍDA.
     O piso puro (`if (agora - ultima < MS) return;`) descarta o último lote da
     janela. Isso perdia exatamente o caso que o módulo existe para cobrir: a
     mutação do "Esta mensagem foi apagada" chegando dentro dos 500 ms e NENHUM
     lote depois — a linha nunca mais era reexaminada e a marcação nunca
     aparecia. Aqui o piso continua valendo (é ele que segura o custo da
     varredura do documento inteiro, que era a maior fonte de lixo do nosso
     lado); o que muda é que o lote de dentro da janela fica AGENDADO para o
     fim dela em vez de jogado fora. No máximo uma execução extra por janela:
     enquanto houver cauda pendente, novos pedidos não somam timer nenhum.
     Fora do bundle isto é testado por `bundle.test.js`. */
  function throttleComCauda(fn, ms) {
    let ultima = 0;
    let cauda = null;
    const rodar = () => {
      cauda = null;
      ultima = Date.now();
      fn();
    };
    const pedir = () => {
      const falta = ms - (Date.now() - ultima);
      if (falta <= 0) {
        rodar();
        return;
      }
      if (cauda) return; // já existe borda de saída agendada
      cauda = setTimeout(rodar, falta);
    };
    pedir.cancelar = () => {
      if (cauda) {
        clearTimeout(cauda);
        cauda = null;
      }
    };
    return pedir;
  }

  reg({
    id: "antiDelete",
    _store: new Map(),
    /** A6 — consulta pública do que foi guardado. O `_store` existia mas não
        havia como perguntar nada a ele: o texto só aparecia se a varredura
        conseguisse pendurar a tarja na hora certa. Agora o menu do botão
        direito pergunta aqui. Devolve string ou "". */
    textoGuardado(bolha) {
      const id = idDaBolha(bolha);
      return (id && this._store.get(id)) || "";
    },
    /** Pendura a tarja "(recuperada)" nesta bolha, se ainda não estiver lá. */
    revelarNaBolha(bolha, texto) {
      if (!bolha || !texto || bolha.querySelector(".zl-recovered")) return false;
      const tag = document.createElement("div");
      tag.className = "zl-recovered";
      tag.textContent = "🕵️ (recuperada) " + texto;
      bolha.appendChild(tag);
      return true;
    },
    apply() {
      if (this._hooked) return;
      this._hooked = true;
      const store = this._store;
      // Guarda com teto e ordem LRU (Map itera na ordem de inserção).
      const guarda = (id, texto) => {
        // Sem `data-id` não há como casar a recuperação depois: a versão antiga
        // gravava sob `Math.random()`, uma chave que NUNCA seria consultada —
        // retenção pura, uma entrada por linha renderizada.
        if (!id) return;
        if (store.has(id)) store.delete(id);
        store.set(id, texto.length > AD_MAX_TEXTO ? texto.slice(0, AD_MAX_TEXTO) : texto);
        while (store.size > AD_MAX_ENTRADAS) {
          store.delete(store.keys().next().value);
        }
      };
      // Captura o texto de uma linha já renderizada (usada tanto pelo
      // observer quanto pela varredura inicial do Y4). Passa pelo MESMO
      // `guarda`, então os tetos (LRU de 600, 4 KB por mensagem) valem igual.
      const capturar = (row) => {
        const txt = textoDaBolha(row);
        if (txt) guarda(idDaBolha(row), txt);
      };
      // Detecta o texto "Esta mensagem foi apagada". A varredura é do
      // DOCUMENTO INTEIRO e lê o `textContent` de cada bolha: rodá-la a cada
      // lote de mutação (o WhatsApp muta a árvore continuamente) era a maior
      // fonte de lixo do nosso lado — daí o piso de meio segundo, agora com
      // borda de saída (Y3), que preserva o objetivo de memória sem perder o
      // último lote da janela.
      const marcarApagadas = () => {
        bolhasVisiveis()
          .forEach((row) => {
            if (row.querySelector(".zl-recovered")) return;
            if (!ehApagada(row)) return;
            const id = idDaBolha(row);
            const original = id && store.get(id);
            if (original) {
              const tag = document.createElement("div");
              tag.className = "zl-recovered";
              tag.textContent = "🕵️ (recuperada) " + original;
              row.appendChild(tag);
            }
          });
      };
      const pedirVarredura = throttleComCauda(marcarApagadas, AD_VARREDURA_MS);
      this._pedirVarredura = pedirVarredura;

      // Observa nós de mensagem; ao detectar remoção do texto original,
      // reinsere a versão capturada com marcação.
      const obs = new MutationObserver((muts) => {
        for (const m of muts) {
          for (const node of m.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;
            bolhasEm(node).forEach(capturar);
          }
        }
        pedirVarredura();
      });
      obs.observe(document.body, { childList: true, subtree: true });
      this._obs = obs;

      // Y4 — varredura INICIAL. O observer só vê `addedNodes`: tudo que já
      // estava na tela quando o módulo subiu ficava sem captura. E como cada
      // reload (nível 2) e cada renavegação (nível 3) nasce com `_store`
      // vazio, sem isto o módulo ficava cego justamente depois de uma
      // recuperação, até novas mensagens renderizarem. Repete algumas vezes
      // porque o `apply()` roda assim que existe `document.body` — o SPA ainda
      // não desenhou a conversa — e para assim que encontra a primeira linha.
      let tentativa = 0;
      const varreduraInicial = () => {
        const rows = bolhasVisiveis();
        rows.forEach(capturar);
        pedirVarredura();
        if (rows.length === 0 && ++tentativa < AD_INICIAL_TENTATIVAS) {
          this._inicial = setTimeout(varreduraInicial, AD_INICIAL_INTERVALO);
        } else {
          this._inicial = null;
        }
      };
      varreduraInicial();
    },
    revert() {
      /* mantém captura ativa; só remove marcações visuais */
      document.querySelectorAll(".zl-recovered").forEach((e) => e.remove());
    },
  });

  /* ========================================================================
     ÁUDIO DE UMA MENSAGEM — UM lugar só (V2)
     ------------------------------------------------------------------------
     O padrão `bolha.querySelector("audio")` + `fetch(audio.src)` estava
     COPIADO em dois pontos (botão na bolha e menu do botão direito) e os dois
     quebraram juntos — é a mesma família do cisma das classes `message-in`.
     MEDIDO no DOM real da sessão logada em 17/08/2026, conversa aberta com 6
     mensagens de voz na tela:

         #main audio          = 0     document audio   = 0   (ANTES do play)
         #main audio          = 0     document audio   = 0   (DEPOIS do play)

     Ou seja: NÃO existe elemento `<audio>` nenhum — nem antes, nem depois de
     reproduzir. O `querySelector("audio")` devolvia null e o código lançava
     "Áudio não encontrado no player.", que é exatamente o que o usuário viu.
     O que a bolha de voz tem hoje (mesma medição):

         div[role="row"] > [data-testid^="conv-msg-"]
         ├─ [data-testid="msg-container"]
         ├─ button[data-testid="audio-player-frame-spinner"]  ← o controle
         ├─ [data-testid="loading-spinner"]  (enquanto baixa)
         ├─ span[data-icon="ptt-status"]
         └─ <canvas>                          ← a onda desenhada, sem bytes

     De onde vêm os bytes, então: a página decifra a mídia e cria um Blob.
     Medido no mesmo experimento, `URL.createObjectURL` recebeu 6 Blobs
     `audio/mp4` e, ao reproduzir, 3 Blobs `audio/ogg; codecs=opus` de 4966,
     15160 e 34617 bytes. É o ÚNICO ponto do processo em que os bytes do áudio
     passam por uma API pública — por isso a captura é aqui.

     Os dois ganchos são `Proxy` sobre a função nativa, não funções novas:
     `Reflect.apply` mantém o comportamento idêntico e o `toString()` continua
     devolvendo "[native code]" (um wrapper comum apareceria como código
     nosso para qualquer verificação da página).

     EFEITO COLATERAL, assumido de propósito: para obter os bytes é preciso
     mandar a página reproduzir a mensagem, e reproduzir uma mensagem de voz
     manda o recibo de "ouvida" para quem enviou. É o mesmo que o usuário
     faria à mão para saber o conteúdo; o player é silenciado e pausado no
     instante em que os bytes aparecem. */
  const AUD_MIME = /^audio\//i;
  const AUD_MAX_BLOBS = 24;      // teto: um Blob retido é memória retida
  const AUD_ESPERA_MS = 20000;   // baixar+decifrar um áudio longo demora
  const AUD = { blobs: new Map(), ordem: [], play: null, capturando: false };

  function lembrarBlob(url, blob) {
    AUD.blobs.set(url, { blob, ts: Date.now() });
    AUD.ordem.push(url);
    while (AUD.ordem.length > AUD_MAX_BLOBS) {
      const velho = AUD.ordem.shift();
      if (velho !== url) AUD.blobs.delete(velho);
    }
  }
  try {
    URL.createObjectURL = new Proxy(URL.createObjectURL, {
      apply(alvo, self, args) {
        const url = Reflect.apply(alvo, self, args);
        try {
          const o = args[0];
          if (o && typeof o.arrayBuffer === "function" && AUD_MIME.test(String(o.type || ""))) {
            lembrarBlob(url, o);
          }
        } catch (_) {}
        return url;
      },
    });
    // Quem toca é um elemento que NÃO está no documento (por isso
    // `querySelectorAll("audio")` não acha nada). O gancho no `play` é o que
    // liga "cliquei no play desta bolha" ao elemento e ao src de verdade.
    HTMLMediaElement.prototype.play = new Proxy(HTMLMediaElement.prototype.play, {
      apply(alvo, self, args) {
        try {
          if (AUD.capturando) self.muted = true;
          AUD.play = { el: self, ts: Date.now() };
        } catch (_) {}
        return Reflect.apply(alvo, self, args);
      },
    });
  } catch (e) {
    console.error("[ZapLite] não consegui instalar a captura de áudio:", e);
  }

  /** Sequência de eventos que um mouse de verdade produz. Ver Z1 (a lista de
      conversas abre no `mousedown`, e `element.click()` sozinho não abre). */
  function cliqueReal(alvo) {
    if (!alvo) return;
    const r = alvo.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const passos = [
      ["pointerover", 0], ["pointerdown", 1], ["mousedown", 1],
      ["pointerup", 0], ["mouseup", 0], ["click", 0],
    ];
    for (const [tipo, botoes] of passos) {
      const Ctor = tipo.indexOf("pointer") === 0 && window.PointerEvent ? PointerEvent : MouseEvent;
      try {
        alvo.dispatchEvent(
          new Ctor(tipo, {
            bubbles: true, cancelable: true, composed: true, view: window,
            clientX: x, clientY: y, button: 0, buttons: botoes,
            pointerId: 1, isPrimary: true,
          })
        );
      } catch (_) {}
    }
  }

  // RECONHECER que a bolha é de voz e SABER onde clicar são duas perguntas
  // diferentes, e misturá-las foi o primeiro erro desta correção: o
  // `[data-testid="ptt-status"]` (o ícone de status, um `span`) reconhece a
  // bolha mas NÃO reage a clique — clicar nele não fazia nada e a captura
  // estourava o tempo. Medido em 17/08/2026, bolha carregada:
  //     <button aria-label="Reproduzir mensagem de voz"> ← é este
  //   e, enquanto toca, o mesmo botão vira "Pausar mensagem de voz".
  const AUD_SINAL_SELS = [
    "audio",
    '[data-testid="ptt-status"]',
    '[data-icon="ptt-status"]',
    '[data-testid="audio-player-frame-spinner"]',
    '[data-testid^="audio-player"]',
    'button[aria-label*="eproduzir mensagem de voz"]',
    'button[aria-label*="ausar mensagem de voz"]',
    'button[aria-label*="lay voice"]',
  ];
  const AUD_CTRL_SELS = [
    'button[aria-label*="eproduzir"]',              // pt-BR (medido)
    'button[aria-label*="lay voice"]',              // en
    'button[aria-label*="lay audio"]',
    '[data-icon="audio-play"]',
    '[data-icon="play"]',
    '[data-testid="audio-player-frame-spinner"]',   // enquanto ainda baixa
  ];
  const AUD_PAUSA_SELS = ['button[aria-label*="ausar"]', 'button[aria-label*="ause"]'];

  function primeiro(bolha, sels) {
    if (!bolha) return null;
    for (const s of sels) {
      const el = bolha.querySelector(s);
      if (el) return el.closest("button") || el;
    }
    return null;
  }
  const controleDeAudio = (bolha) => primeiro(bolha, AUD_CTRL_SELS);
  /** A bolha é de áudio? (usado pelo botão e pelo menu do botão direito) */
  const ehBolhaDeAudio = (bolha) => !!primeiro(bolha, AUD_SINAL_SELS);

  function esperarBytes(marca, ms) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const olhar = () => {
        // 1) o elemento que começou a tocar depois do nosso clique
        if (AUD.play && AUD.play.ts >= marca) {
          const el = AUD.play.el;
          const src = (el && (el.src || el.currentSrc)) || "";
          const g = AUD.blobs.get(src);
          if (g || src) return resolve({ el, src, blob: g && g.blob });
        }
        // 2) ou um Blob de áudio novo, se a página tocar sem passar por play()
        for (let i = AUD.ordem.length - 1; i >= 0; i--) {
          const g = AUD.blobs.get(AUD.ordem[i]);
          if (g && g.ts >= marca) return resolve({ el: AUD.play && AUD.play.el, src: AUD.ordem[i], blob: g.blob });
        }
        if (Date.now() - t0 >= ms) return resolve({});
        setTimeout(olhar, 100);
      };
      olhar();
    });
  }

  /** Bytes do áudio de UMA bolha. Único caminho — os dois pontos de chamada
      passam por aqui de propósito. */
  async function blobDoAudio(bolha) {
    // Caminho A: o `<audio>` clássico. Não existe hoje, fica como retaguarda
    // para o dia em que o WhatsApp voltar a expor um player no documento.
    const el = bolha && bolha.querySelector("audio,video");
    const src0 = el && (el.src || el.currentSrc);
    if (src0) {
      const g = AUD.blobs.get(src0);
      if (g) return g.blob;
      return await (await fetch(src0)).blob();
    }

    // Caminho B (o de hoje): mandar a bolha reproduzir e pegar os bytes.
    // MEDIDO: o clique em "Reproduzir mensagem de voz" faz a página criar um
    // `new Audio()` FORA do documento, apontar o `src` para o blob: do áudio e
    // chamar `play()` — é aí que os dois ganchos se encontram e a associação
    // "esta bolha ↔ estes bytes" fica exata (nada de adivinhar pelo Blob mais
    // recente: ao abrir a conversa a página já cria um blob por mensagem).
    const ctrl = controleDeAudio(bolha);
    if (!ctrl) {
      // já está tocando ESTA bolha (o botão virou "Pausar"): o elemento em
      // reprodução é o desta mensagem, não há o que clicar.
      const tocando = primeiro(bolha, AUD_PAUSA_SELS) && AUD.play && AUD.play.el;
      const src = tocando && (AUD.play.el.src || AUD.play.el.currentSrc);
      if (src) {
        const g = AUD.blobs.get(src);
        return g ? g.blob : await (await fetch(src)).blob();
      }
      throw new Error("esta mensagem não tem player de áudio (nenhum controle encontrado na bolha).");
    }
    const marca = Date.now();
    AUD.capturando = true;
    let achado = {};
    try {
      cliqueReal(ctrl);
      achado = await esperarBytes(marca, AUD_ESPERA_MS);
    } finally {
      AUD.capturando = false;
      // devolve o player ao estado em que estava: pausado, do começo, sem mudo
      try {
        const p = achado.el || (AUD.play && AUD.play.el);
        if (p) { p.pause(); p.currentTime = 0; p.muted = false; }
      } catch (_) {}
    }
    if (achado.blob) return achado.blob;
    if (achado.src) return await (await fetch(achado.src)).blob();
    throw new Error(
      "pedi para reproduzir e os bytes do áudio não apareceram em " +
        Math.round(AUD_ESPERA_MS / 1000) + "s."
    );
  }

  /** base64 sem estourar a pilha. `String.fromCharCode(...array)` — o que
      estava aqui — quebra com RangeError acima de ~100 mil bytes, e um WAV de
      16 kHz de um minuto tem 1,9 MB. */
  function paraBase64(bytes) {
    let s = "";
    const PEDACO = 0x8000;
    for (let i = 0; i < bytes.length; i += PEDACO) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + PEDACO));
    }
    return btoa(s);
  }

  /* ========================================================================
     A3 — SALVAR ARQUIVO: perguntar onde, mostrar progresso, confirmar
     ------------------------------------------------------------------------
     Antes: `save_media` gravava calado em `Downloads\ZapLite`. No Windows esse
     caminho casa, sem diferenciar maiúsculas, com `Downloads\zaplite` — a
     pasta do PROJETO do usuário. A mídia dele caía dentro da árvore de código
     (ver o comentário do lado Rust, com a medição). Agora quem escolhe o
     destino é o diálogo nativo, e o fim do caminho é um aviso com botão para
     abrir o arquivo e para abrir a pasta.
     ======================================================================== */

  function formatarTamanho(n) {
    if (!n) return "";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }

  function mostrarProgresso(titulo, texto, pct) {
    const p = showPanel(titulo, texto);
    const corpo = p.querySelector(".zl-panel-body");
    const bar = document.createElement("div");
    bar.className = "zl-bar";
    const i = document.createElement("i");
    i.style.width = Math.max(0, Math.min(100, Math.round(pct || 0))) + "%";
    bar.appendChild(i);
    corpo.appendChild(bar);
    return p;
  }

  function fecharPainel() {
    const p = document.getElementById("zl-panel");
    if (p) p.remove();
  }

  function avisarSalvo(caminho, bytes) {
    const tam = bytes ? "\n" + formatarTamanho(bytes) : "";
    showPanel("Arquivo salvo", caminho + tam, [
      [
        "Abrir arquivo",
        () => invoke("abrir_arquivo", { caminho }).catch((e) => showPanel("Erro", e.message)),
      ],
      [
        "Abrir a pasta",
        () => invoke("revelar_arquivo", { caminho }).catch((e) => showPanel("Erro", e.message)),
      ],
    ]);
  }

  /* Downloads que a PÁGINA inicia (o botão de baixar do próprio WhatsApp)
     agora passam pelo Rust: ele desce o arquivo para uma área temporária,
     pergunta onde fica e avisa por este evento. Sem isto o WebView2 gravava
     por conta própria e o app nem ficava sabendo. */
  let _ouvindoGravacao = false;
  function ouvirEventosDeGravacao() {
    if (_ouvindoGravacao) return;
    if (!window.__TAURI__ || !window.__TAURI__.event) return;
    _ouvindoGravacao = true;
    const ev = window.__TAURI__.event;
    ev.listen("zaplite://save-progress", (e) => {
      const p = (e && e.payload) || {};
      if (typeof p.pct === "number") mostrarProgresso("Salvando arquivo", "Gravando no disco…", p.pct);
    }).catch(() => {});
    ev.listen("zaplite://midia-salva", (e) => {
      const p = (e && e.payload) || {};
      if (p.erro) return showPanel("Não deu para salvar", p.erro);
      if (p.cancelado) {
        return showPanel(
          "Download descartado",
          "Você fechou a janela sem escolher onde salvar “" + (p.nome || "arquivo") +
            "”. O arquivo temporário foi apagado — nada ficou no disco."
        );
      }
      avisarSalvo(p.path, p.bytes);
    }).catch(() => {});
  }

  /** Lê o blob em pedaços para dar progresso de verdade em arquivo grande. */
  async function bytesComProgresso(blob, titulo) {
    const total = blob.size || 0;
    if (!blob.stream || total < 4 * 1024 * 1024) {
      return new Uint8Array(await blob.arrayBuffer());
    }
    const leitor = blob.stream().getReader();
    const partes = [];
    let lido = 0;
    for (;;) {
      const passo = await leitor.read();
      if (passo.done) break;
      partes.push(passo.value);
      lido += passo.value.length;
      mostrarProgresso(titulo, "Preparando o arquivo…", (lido * 100) / total);
    }
    const out = new Uint8Array(lido);
    let off = 0;
    for (const p of partes) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }

  /** base64 devolvendo o controle ao navegador de tempos em tempos: um vídeo
      de 60 MB numa volta só congela a interface do WhatsApp inteira. */
  async function paraBase64Async(bytes, titulo) {
    let s = "";
    const PEDACO = 0x8000;
    let desde = Date.now();
    for (let i = 0; i < bytes.length; i += PEDACO) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + PEDACO));
      if (Date.now() - desde > 16) {
        mostrarProgresso(titulo, "Preparando o arquivo…", (i * 100) / bytes.length);
        await new Promise((r) => setTimeout(r, 0));
        desde = Date.now();
      }
    }
    return btoa(s);
  }

  const EXT_POR_MIME = {
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
    "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "application/pdf": "pdf",
  };
  function nomeSugerido(blob, prefixo) {
    const mime = String((blob && blob.type) || "").split(";")[0].trim().toLowerCase();
    const ext = EXT_POR_MIME[mime] || (mime.split("/")[1] || "bin").replace(/[^a-z0-9]/g, "");
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const carimbo =
      d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    return (prefixo || "zaplite") + "-" + carimbo + "." + ext;
  }

  /** Único caminho de "salvar um blob em disco". Devolve o caminho final, ou
      null se o usuário cancelou o diálogo. */
  async function salvarArquivo(blob, prefixo) {
    ouvirEventosDeGravacao();
    const titulo = "Salvando arquivo";
    mostrarProgresso(titulo, "Preparando o arquivo…", 0);
    const bytes = await bytesComProgresso(blob, titulo);
    const b64 = await paraBase64Async(bytes, titulo);
    mostrarProgresso(titulo, "Escolha onde salvar na janela do Windows…", 100);
    const r = await invoke("save_media", { dataB64: b64, filename: nomeSugerido(blob, prefixo) });
    if (!r || r.cancelado) {
      fecharPainel();
      return null;
    }
    avisarSalvo(r.path, r.bytes);
    return r.path;
  }

  /** OGG/Opus (ou mp4/aac) → WAV PCM 16 bits, 16 kHz, mono — o formato que o
      whisper.cpp quer. Feito AQUI porque a WebView2 já traz os decodificadores
      (é a mesma engine do Chrome): sem isto o app dependeria do ffmpeg
      instalado à parte, em toda máquina que receber o instalador. */
  async function wav16kMono(blob) {
    const buf = await blob.arrayBuffer();
    const Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Off) throw new Error("sem OfflineAudioContext nesta webview");
    // decodificar num contexto de 16 kHz já entrega o áudio reamostrado
    let dados = await new Off(1, 1, 16000).decodeAudioData(buf.slice(0));
    if (dados.sampleRate !== 16000) {
      const off = new Off(1, Math.max(1, Math.ceil(dados.duration * 16000)), 16000);
      const fonte = off.createBufferSource();
      fonte.buffer = dados;
      fonte.connect(off.destination);
      fonte.start();
      dados = await off.startRendering();
    }
    const n = dados.length;
    const canais = dados.numberOfChannels;
    const wav = new Uint8Array(44 + n * 2);
    const dv = new DataView(wav.buffer);
    const txt = (p, s) => { for (let i = 0; i < s.length; i++) wav[p + i] = s.charCodeAt(i); };
    txt(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); txt(8, "WAVE");
    txt(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
    dv.setUint16(22, 1, true); dv.setUint32(24, 16000, true);
    dv.setUint32(28, 16000 * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    txt(36, "data"); dv.setUint32(40, n * 2, true);
    const c0 = dados.getChannelData(0);
    const c1 = canais > 1 ? dados.getChannelData(1) : null;
    for (let i = 0; i < n; i++) {
      let v = c1 ? (c0[i] + c1[i]) / 2 : c0[i];
      v = v < -1 ? -1 : v > 1 ? 1 : v;
      dv.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
    return wav;
  }

  /** Bolha → texto. Os DOIS pontos de chamada usam esta função. */
  /* Vocabulário da conversa para o prompt inicial do Whisper.
     Nomes próprios e jargão são justamente onde ele erra; dar o contexto
     antes melhora bastante o acerto. Só texto que já está na tela. */
  function contextoDaConversa() {
    const partes = [];
    const titulo = document.querySelector('#main header span[title]');
    if (titulo) partes.push(titulo.getAttribute("title") || titulo.textContent || "");
    try {
      const bolhas = bolhasVisiveis().slice(-25);
      for (const b of bolhas) {
        const t = (textoDaBolha(b) || "").trim();
        if (t && t.length < 220) partes.push(t);
      }
    } catch (_) {}
    let ctx = partes.filter(Boolean).join(". ").replace(/\s+/g, " ").trim();
    if (ctx.length > 800) ctx = ctx.slice(ctx.length - 800);
    return ctx;
  }

  /** Segundos de áudio de uma bolha, lidos do rótulo que a página já desenha
      ("0:37"). Serve ao A5 para DESCARTAR um áudio longo ANTES de mandar a
      página reproduzi-lo — reproduzir manda o recibo de "ouvida", então
      descobrir a duração só depois seria tarde. Devolve 0 se não achar. */
  function segundosDaBolha(bolha) {
    try {
      const m = /(?:^|\s)(\d{1,2}):([0-5]\d)(?::([0-5]\d))?(?:\s|$)/.exec(bolha.textContent || "");
      if (!m) return 0;
      return m[3]
        ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
        : Number(m[1]) * 60 + Number(m[2]);
    } catch (_) {
      return 0;
    }
  }

  /** Bolha → texto transcrito. `maxSeg` (opcional) aborta antes de gastar CPU
      com whisper se o áudio decodificado passar do limite. */
  async function transcreverBolha(bolha, maxSeg) {
    const blob = await blobDoAudio(bolha);
    let b64;
    try {
      const wav = await wav16kMono(blob);
      if (maxSeg && (wav.length - 44) / 2 / 16000 > maxSeg) {
        const err = new Error("áudio mais longo que o limite de " + maxSeg + "s");
        err.zlLongoDemais = true;
        throw err;
      }
      b64 = paraBase64(wav);
    } catch (e) {
      if (e && e.zlLongoDemais) throw e;
      // decodificação falhou (formato exótico): manda o original e deixa o
      // Rust tentar o ffmpeg, que diz com todas as letras se não estiver lá.
      console.warn("[ZapLite] decodificação na página falhou:", e);
      b64 = paraBase64(new Uint8Array(await blob.arrayBuffer()));
    }
    return await invoke("transcribe_audio", { audioB64: b64, prompt: contextoDaConversa() });
  }

  /** Pendura o texto transcrito NA BOLHA. UM lugar só: o botão "Transcrever"
      e o A5 (transcrição automática) mostram exatamente a mesma coisa, e é
      também o que o A5 usa para saber que esta bolha já foi feita. */
  function mostrarTranscricaoNaBolha(bolha, texto, marca) {
    if (!bolha || bolha.querySelector(".zl-tr-txt")) return null;
    const out = document.createElement("div");
    out.className = "zl-recovered zl-tr-out";
    const txt = document.createElement("span");
    txt.className = "zl-tr-txt";
    txt.textContent = (marca || "📝 ") + texto;
    out.appendChild(txt);
    const cp = document.createElement("button");
    cp.className = "zl-tr-copy";
    cp.textContent = "Copiar";
    cp.title = "Copiar a transcrição";
    cp.onclick = async (ev) => {
      ev.stopPropagation();
      try {
        await navigator.clipboard.writeText(texto);
      } catch (_) {
        const r = document.createRange();
        r.selectNodeContents(txt);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      }
      cp.textContent = "Copiado!";
      setTimeout(() => {
        cp.textContent = "Copiar";
      }, 1400);
    };
    out.appendChild(cp);
    bolha.appendChild(out);
    return out;
  }

  /* 11. Transcrição de áudio (local, Whisper) ---------------------------- */
  reg({
    id: "transcribe",
    apply() {
      if (this._timer) return;
      const inject = () => {
        bolhasVisiveis().forEach((bubble) => {
          if (bubble.querySelector(".zl-tr-btn") || !ehBolhaDeAudio(bubble)) return;
          const b = document.createElement("button");
          b.className = "zl-tr-btn";
          b.textContent = "📝 Transcrever";
          b.onclick = async () => {
            b.textContent = "⏳ ...";
            try {
              mostrarTranscricaoNaBolha(bubble, await transcreverBolha(bubble));
              b.remove();
            } catch (e) {
              b.textContent = "📝 Transcrever";
              // A7: "ainda não instalado" não é erro, é um passo que falta.
              if (ehFaltaDeInstalacao(e)) avisarInstalacaoDaTranscricao(e);
              else showPanel("Transcrição", (e && e.message) || String(e));
            }
          };
          (bubble.querySelector(BOLHA_MIOLO) || bubble).appendChild(b);
        });
      };
      this._timer = setInterval(inject, 1500);
    },
    revert() {
      clearInterval(this._timer);
      this._timer = null;
      document.querySelectorAll(".zl-tr-btn").forEach((e) => e.remove());
    },
  });

  /* IA genérica: resumo / tradução / rascunho / detector de golpe -------- */
  async function ai(system, prompt, extra) {
    return invoke("ai_complete", {
      system,
      prompt,
      imageB64: (extra && extra.image) || null,
      mediaType: (extra && extra.mediaType) || null,
    });
  }
  function collectVisibleMessages(limit = 200) {
    const rows = bolhasVisiveis().slice(-limit);
    return rows
      .map((r) => {
        const t = textoDaBolha(r);
        return t ? `${ehDeSaida(r) ? "Você" : "Contato"}: ${t}` : null;
      })
      .filter(Boolean)
      .join("\n");
  }

  /* 12. Resumo de conversa ----------------------------------------------- */
  reg({
    id: "summarize",
    apply() {
      addAct(ensureDock(), "zl-sum", "∑", "Resumir esta conversa", "", async (b) => {
        const conv = collectVisibleMessages();
        if (!conv) return alert("Abra uma conversa primeiro.");
        showPanel("Resumo da conversa", "Resumindo…");
        try {
          const r = await ai(
            "Você resume conversas de WhatsApp em português do Brasil, de forma objetiva, em tópicos curtos. Destaque decisões, pendências e perguntas em aberto.",
            "Resuma:\n\n" + conv
          );
          showPanel("Resumo da conversa", r);
        } catch (e) {
          showPanel("Resumo da conversa", "Falhou: " + (e.message || e));
        }
      });
    },
    revert() {
      dropAct("zl-sum");
    },
  });

  /* 14. Rascunho de resposta com seu tom --------------------------------- */
  reg({
    id: "draftReply",
    apply() {
      addAct(ensureDock(), "zl-draft", "✍", "Sugerir uma resposta", "", async () => {
        const conv = collectVisibleMessages(30);
        if (!conv) return alert("Abra uma conversa primeiro.");
        showPanel("Rascunho", "Escrevendo…");
        try {
          const tone = settings.aiTone || "direto, amigável e claro";
          const r = await ai(
            `Você sugere UMA resposta curta de WhatsApp em português do Brasil, no tom ${tone}. Responda apenas com o texto da mensagem, sem aspas.`,
            "Contexto:\n" + conv + "\n\nSugira minha próxima resposta."
          );
          const box = document.querySelector('div[contenteditable="true"][data-tab]');
          if (box) {
            box.focus();
            document.execCommand("insertText", false, r.trim());
            const p = document.getElementById("zl-panel");
            if (p) p.remove();
          } else {
            showPanel("Rascunho", r);
          }
        } catch (e) {
          showPanel("Rascunho", "Falhou: " + (e.message || e));
        }
      });
    },
    revert() {
      dropAct("zl-draft");
    },
  });

  /* 21. Velocidade extra de áudio ---------------------------------------- */
  reg({
    id: "audioSpeed",
    apply() {
      if (this._timer) return;
      const speeds = [1, 1.5, 2, 2.5, 3];
      this._timer = setInterval(() => {
        document.querySelectorAll("audio").forEach((a) => {
          if (a.dataset.zlSpeed) return;
          a.dataset.zlSpeed = "1";
          const b = document.createElement("button");
          b.className = "zl-tr-btn";
          b.textContent = "1x";
          b.onclick = () => {
            let i = speeds.indexOf(parseFloat(a.dataset.zlSpeed));
            i = (i + 1) % speeds.length;
            a.playbackRate = speeds[i];
            a.dataset.zlSpeed = String(speeds[i]);
            b.textContent = speeds[i] + "x";
          };
          const host = bolhaDe(a);
          if (host) host.appendChild(b);
        });
      }, 1500);
    },
    revert() {
      clearInterval(this._timer);
      this._timer = null;
    },
  });

  /* 24. Sempre no topo ---------------------------------------------------- */
  reg({
    id: "alwaysOnTop",
    apply() {
      invoke("set_always_on_top", { value: true });
    },
    revert() {
      invoke("set_always_on_top", { value: false });
    },
  });

  /* 25. Tema / dark reforçado + acento personalizável -------------------- */
  reg({
    id: "theme",
    apply() {
      const accent = (settings.theme && settings.theme.accent) || "#7c3aed";
      const radius = (settings.theme && settings.theme.radius) || "14px";
      css(
        `:root{--zl-accent:${accent};--zl-radius:${radius}}
         [data-icon="status-refreshed"] , span[data-icon="status-outline"]{filter:hue-rotate(0)}
         .zl-fab{background:var(--zl-accent)!important}
         header ._ak8i, .app-wrapper-web{--wa-accent:var(--zl-accent)}`,
        "zl-theme"
      );
    },
    revert() {
      dropCss("zl-theme");
    },
  });

  /* 26. Esconder Status / Canais / Comunidades --------------------------- */
  reg({
    id: "declutter",
    apply() {
      const hide = [];
      if (settings.hide?.status) hide.push('[aria-label*="Status"]', '[data-icon="status-refreshed"]');
      if (settings.hide?.channels) hide.push('[aria-label*="Canais"]', '[aria-label*="Channels"]');
      if (settings.hide?.communities) hide.push('[aria-label*="Comunidades"]', '[aria-label*="Communities"]');
      css(hide.length ? hide.join(",") + "{display:none!important}" : "", "zl-declutter");
    },
    revert() {
      dropCss("zl-declutter");
    },
  });

  /* 29. Blur ao perder o foco (privacidade) ------------------------------ */
  reg({
    id: "privacyBlur",
    apply() {
      if (this._hooked) return;
      this._hooked = true;
      css("body.zl-blur #app{filter:blur(14px);transition:filter .15s}", "zl-blur-style");
      this._blur = () => document.body.classList.add("zl-blur");
      this._focus = () => document.body.classList.remove("zl-blur");
      window.addEventListener("blur", this._blur);
      window.addEventListener("focus", this._focus);
    },
    revert() {
      dropCss("zl-blur-style");
      document.body.classList.remove("zl-blur");
      window.removeEventListener("blur", this._blur);
      window.removeEventListener("focus", this._focus);
      this._hooked = false;
    },
  });

  /* 33. Modo NSFW — toda mídia entra borrada -----------------------------
     Regras que este módulo respeita:
     · borra CONTEÚDO, nunca a interface. Os alvos saem do helper de bolhas
       (V1) e de `img`/`video` — os ícones do WhatsApp são <svg>/[data-icon] e
       por construção nunca recebem a classe;
     · pega o que chega DEPOIS: o WhatsApp renderiza mídia sob demanda, então
       além da varredura periódica há um MutationObserver;
     · revelar é por item: passar o mouse mostra enquanto o ponteiro estiver
       ali, clicar libera aquele item até a próxima renderização. O clique NÃO
       é cancelado, senão abrir a foto pararia de funcionar (ver A2). */
  const NSFW_MIN_PX = 40;   // abaixo disso é ícone/figurinha de texto
  const NSFW_VARREDURA_MS = 400;
  reg({
    id: "nsfwBlur",
    apply() {
      if (this._on) return;
      this._on = true;
      const self = this;

      const marcar = (el) => {
        if (!el || el.classList.contains("zl-nsfw-alvo")) return;
        try {
          if (el.closest("#zl-dock,#zl-panel,#zl-ctx,.zl-recovered")) return;
        } catch (_) {}
        const r = el.getBoundingClientRect();
        // Sem tamanho ainda (não renderizou): marca mesmo assim. O custo de
        // marcar cedo é uma classe; o de marcar tarde é a imagem aparecer nua.
        if (r.width && r.height && (r.width < NSFW_MIN_PX || r.height < NSFW_MIN_PX)) return;
        el.classList.add("zl-nsfw-alvo");
      };
      const midiasDe = (raiz) => {
        if (!raiz || !raiz.querySelectorAll) return [];
        try {
          return [].slice.call(raiz.querySelectorAll("img,video"));
        } catch (_) {
          return [];
        }
      };

      const varrer = () => {
        // 1) conteúdo de mensagem
        bolhasVisiveis().forEach((b) => midiasDe(b).forEach(marcar));
        // 2) prévia na lista de conversas (desligável em settings.nsfw.lista)
        if (!(settings.nsfw && settings.nsfw.lista === false)) {
          midiasDe(document.querySelector("#pane-side")).forEach(marcar);
        }
        // 3) visualizador em tela cheia — abrir a foto não pode desfazer o modo
        midiasDe(document.querySelector('[data-testid="media-viewer"]')).forEach(marcar);
        const modal = document.querySelector("[data-animate-modal-body]");
        if (modal) midiasDe(modal).forEach(marcar);
      };
      const pedir = throttleComCauda(varrer, NSFW_VARREDURA_MS);
      self._pedir = pedir;

      self._obs = new MutationObserver(pedir);
      self._obs.observe(document.body, { childList: true, subtree: true });
      // Rede de segurança para o que muda sem inserir nó (troca de `src`).
      self._timer = setInterval(varrer, 1500);

      self._clique = (e) => {
        const alvo = e.target && e.target.closest && e.target.closest(".zl-nsfw-alvo");
        if (alvo) alvo.classList.add("zl-nsfw-livre"); // sem preventDefault
      };
      document.addEventListener("click", self._clique, true);

      varrer();
    },
    revert() {
      if (this._obs) this._obs.disconnect();
      this._obs = null;
      if (this._pedir && this._pedir.cancelar) this._pedir.cancelar();
      clearInterval(this._timer);
      this._timer = null;
      if (this._clique) document.removeEventListener("click", this._clique, true);
      document.querySelectorAll(".zl-nsfw-alvo").forEach((e) => {
        e.classList.remove("zl-nsfw-alvo");
        e.classList.remove("zl-nsfw-livre");
      });
      this._on = false;
    },
  });

  /* 34. Transcrever automaticamente o áudio que chegar -------------------
     O que é fácil errar aqui, e como cada coisa está resolvida:
     · CPU: whisper é um processo por vez. Fila de um, nunca em paralelo.
     · Repetição: cada mensagem só é transcrita uma vez (id estável da bolha)
       e a presença da tarja também conta como "já feito".
     · Áudio longo: descartado ANTES de mandar a página reproduzir, pelo
       rótulo de duração que ela já desenha (`settings.transcricao.autoMaxSeg`).
     · Travar a interface: nada de laço síncrono — varredura a cada 2,5s e uma
       transcrição de cada vez, tudo em `await`.
     · Whisper ausente: o módulo se desliga na PRIMEIRA falha de instalação e
       avisa uma vez, com botão para o instalador (A7). Nunca fica em laço.
     · Histórico: ao abrir/trocar de conversa, o que JÁ estava na tela é
       marcado como visto sem transcrever. Obter os bytes exige mandar a página
       reproduzir, e reproduzir manda o recibo de "ouvida" — varrer um
       histórico inteiro marcaria dezenas de mensagens antigas como ouvidas.
       Só vale para o que chegar com a conversa aberta. */
  const AT_VARREDURA_MS = 2500;
  const AT_MAX_SEG_PADRAO = 180;
  reg({
    id: "autoTranscribe",
    _feitos: new Set(),
    apply() {
      if (this._timer) return;
      const self = this;
      self._fila = [];
      self._ocupado = false;
      self._desligado = false;
      self._conversa = null;

      const limite = () => {
        const v = Number((settings.transcricao && settings.transcricao.autoMaxSeg) || 0);
        return v > 0 ? v : AT_MAX_SEG_PADRAO;
      };
      const chaveDaConversa = () => {
        const t = document.querySelector("#main header span[title]");
        return (t && (t.getAttribute("title") || t.textContent)) || "";
      };
      const marcarFeito = (b) => {
        const id = idDaBolha(b);
        if (id) self._feitos.add(id);
      };
      const jaFeito = (b) => {
        const id = idDaBolha(b);
        if (id && self._feitos.has(id)) return true;
        return !!b.querySelector(".zl-tr-txt");
      };

      const varrer = () => {
        if (self._desligado) return;
        const chave = chaveDaConversa();
        if (!chave) return;
        const audios = bolhasVisiveis().filter((b) => ehBolhaDeAudio(b) && !ehDeSaida(b));
        if (chave !== self._conversa) {
          // Primeira vez nesta conversa: tudo que já está na tela é histórico.
          self._conversa = chave;
          audios.forEach(marcarFeito);
          return;
        }
        audios.forEach((b) => {
          if (jaFeito(b)) return;
          if (self._fila.indexOf(b) >= 0) return;
          const seg = segundosDaBolha(b);
          if (seg && seg > limite()) {
            marcarFeito(b);
            console.log("[ZapLite] áudio de " + seg + "s acima do limite: transcrição automática pulada.");
            return;
          }
          self._fila.push(b);
        });
        bombear();
      };

      const bombear = async () => {
        if (self._ocupado || self._desligado) return;
        const bolha = self._fila.shift();
        if (!bolha) return;
        if (!document.body.contains(bolha) || jaFeito(bolha)) {
          setTimeout(bombear, 0);
          return;
        }
        self._ocupado = true;
        marcarFeito(bolha);
        const espera = document.createElement("div");
        espera.className = "zl-recovered zl-tr-espera";
        espera.textContent = "⏳ transcrevendo…";
        (bolha.querySelector(BOLHA_MIOLO) || bolha).appendChild(espera);
        try {
          const texto = await transcreverBolha(bolha, limite());
          espera.remove();
          mostrarTranscricaoNaBolha(bolha, texto);
          const botao = bolha.querySelector(".zl-tr-btn");
          if (botao) botao.remove();
        } catch (e) {
          espera.remove();
          if (ehFaltaDeInstalacao(e)) {
            // Uma vez só. Ficar tentando em laço numa máquina sem whisper é
            // gastar CPU para repetir o mesmo aviso. O timer é ZERADO (e não
            // só marcado) para que, terminada a instalação pelo Painel, o
            // `applyAll()` que o `save_settings` dispara volte a armar o
            // módulo — senão ele ficaria morto até reiniciar o app.
            self._desligado = true;
            self._fila.length = 0;
            clearInterval(self._timer);
            self._timer = null;
            avisarInstalacaoDaTranscricao(e);
          } else if (!(e && e.zlLongoDemais)) {
            console.warn("[ZapLite] transcrição automática falhou:", (e && e.message) || e);
          }
        } finally {
          self._ocupado = false;
        }
        if (!self._desligado) setTimeout(bombear, 250);
      };

      self._timer = setInterval(varrer, AT_VARREDURA_MS);
      varrer();
    },
    revert() {
      clearInterval(this._timer);
      this._timer = null;
      this._desligado = true;
      if (this._fila) this._fila.length = 0;
      document.querySelectorAll(".zl-tr-espera").forEach((e) => e.remove());
    },
  });

  /* 31. Notificações próprias com regras por contato --------------------- */
  reg({
    id: "smartNotify",
    _seen: new Map(), // id ESTÁVEL da conversa -> última prévia notificada
    _primed: false, // ignora a primeira varredura (senão notifica tudo ao abrir)
    _desde: 0, // V2: instante em que este módulo começou a observar
    _conhecidas: new Set(), // V2: conversas que já apareceram numa varredura anterior
    // U1(b): id da conversa -> silenciada no WhatsApp, do jeito que a última
    // observação CONFIÁVEL viu. Um sumiço momentâneo do sino (menção pendente,
    // linha ainda renderizando) não pode desfazer isto. Ver `mudoResistente`.
    _mudos: new Map(),
    _unlisten: null, // devolvido pelo listen(); sem guardar, cada ciclo somava um listener
    _reabrir: null, // Y2: timer da nova tentativa de abrir a conversa clicada
    _conferir: null, // Z1: timer da conferência "a conversa abriu mesmo?"
    _rolagemOriginal: null, // Z1: onde o usuário deixou a lista antes da varredura
    _ultimoAlvo: "", // Y2: dedupe entre o evento vivo e o pedido pendente
    _ultimoAlvoTs: 0,

    apply() {
      if (this._started) return;
      this._started = true;
      const self = this;
      // V2: marco zero da observação. Tudo que a linha datar ANTES disto é
      // não lida antiga — estava lá quando o app subiu, não chegou agora.
      this._desde = Date.now();

      // 1) Cala a notificação nativa do WhatsApp Web para não duplicar.
      try {
        const Native = window.Notification;
        function Silent() {
          return { close() {}, onclick: null, onclose: null };
        }
        Silent.permission = "granted";
        Silent.requestPermission = () => Promise.resolve("granted");
        Object.defineProperty(window, "Notification", {
          value: Silent,
          writable: true,
          configurable: true,
        });
        self._native = Native;
      } catch (e) {
        console.warn("[ZapLite] não consegui silenciar a notificação nativa", e);
      }

      // 2) Converte o avatar (blob: da página) em data: para a janela do toast conseguir exibir.
      async function avatarAsData(img) {
        try {
          if (!img || !img.src) return "";
          const r = await fetch(img.src);
          const b = await r.blob();
          if (b.size > 300000) return "";
          return await new Promise((res) => {
            const fr = new FileReader();
            fr.onload = () => res(fr.result);
            fr.onerror = () => res("");
            fr.readAsDataURL(b);
          });
        } catch (_) {
          return "";
        }
      }

      // 3) Identificador ESTÁVEL da conversa.
      // O WhatsApp Web não põe o jid em atributo nenhum da lista, mas o item da
      // lista virtualizada tem chave de React `chat-<jid>` (ex.: `chat-1276...@lid`,
      // `chat-5521...@g.us`). Medido na lista real: 69 linhas, 69 ids, 0 duplicados.
      // É isso que o clique usa — casar por NOME é indefensável, porque o nome de
      // uma conversa pode ser reproduzido no CORPO de uma mensagem por qualquer
      // remetente (medido: 139 `span[title]` para 69 conversas, 70 deles prévias).
      function chatIdDaLinha(row) {
        try {
          const k = Object.keys(row).find((x) => x.startsWith("__reactFiber$"));
          if (!k) return "";
          let f = row[k];
          for (let i = 0; i < 8 && f; i++) {
            if (typeof f.key === "string" && f.key.startsWith("chat-")) return f.key.slice(5);
            f = f.return;
          }
        } catch (_) {}
        return "";
      }

      // Nome da conversa: só do bloco de TÍTULO da linha, nunca da prévia.
      function nomeDaLinha(row) {
        const t =
          row.querySelector('[data-testid="cell-frame-title"] span[title]') ||
          row.querySelector('[role="gridcell"][aria-colindex="2"] span[title]');
        return t ? (t.getAttribute("title") || t.textContent || "").trim() : "";
      }

      // U1: a conversa está SILENCIADA no próprio WhatsApp?
      // Medido na lista real do usuário (69 linhas, 22 silenciadas): o sino
      // cortado aparece como `data-testid="mute-notifications-refreshed"` E
      // como `aria-label="Conversa silenciada"` na MESMA linha — os dois sinais
      // bateram nas mesmas 22 linhas, zero divergência. Os seletores do
      // WhatsApp mudam sozinhos (o "-refreshed" no nome do testid é a prova de
      // que já mudou), então aqui vai uma lista de sinais e basta UM bater.
      //
      // U1(20/08/2026) — REMEDIÇÃO no DOM real (69 linhas, 22 silenciadas). Dois
      // fatos novos, e os dois quebravam o silenciamento:
      //
      //  (1) O sino NÃO é um enfeite ao lado do contador: ele ocupa um SLOT.
      //      Caminho medido do sino, numa linha silenciada com não lidas:
      //        div[data-testid="mute-notifications-refreshed"]  (filho 0 de 2)
      //          └ span (filho 0 de 3) └ div.xhslqc4…x193iq5w (filho 1 de 2)
      //            └ div[data-testid="cell-frame-secondary"]
      //      Caminho medido do marcador de MENÇÃO, na linha que tinha menção
      //      pendente:
      //        div[data-testid="icon-mentions"][aria-label="Menção"] (filho 0 de 2)
      //          └ span (filho 0 de 3) └ div.xhslqc4…x193iq5w (filho 1 de 2)
      //            └ div[data-testid="cell-frame-secondary"]
      //      MESMO pai, MESMAS classes, MESMO índice, e o irmão nos dois casos é
      //      o `icon-unread-count`. Ou seja: menção pendente e sino disputam o
      //      mesmo lugar. Quem só procura o sino perde o silenciamento
      //      exatamente enquanto a menção estiver pendente — que é o relato
      //      "fui citado e passei a receber TUDO daquele grupo". Daí a memória
      //      por conversa em `mudoResistente()`.
      //
      //  (2) `[title*="ilenciad"]` era um buraco: `title` na linha é ATRIBUTO DE
      //      TEXTO — o nome da conversa e a PRÉVIA da mensagem moram em
      //      `span[title]`. Bastava alguém escrever "silenciada" para a linha
      //      passar por silenciada e a notificação sumir. Sinal de estado agora
      //      só conta se for ÍCONE (elemento com <svg> dentro ou sem texto
      //      próprio) — ver `sinalDeEstado()`.
      //
      // Sinais medidos do silenciado, na mesma linha e sempre juntos:
      //   data-testid="mute-notifications-refreshed"
      //   aria-label="Conversa silenciada"
      //   <svg><title>ic-notifications-off</title>
      const SINAIS_MUDO = [
        '[data-testid*="mute" i]',
        '[data-icon*="mute" i]',
        '[data-icon*="notifications-off" i]',
        '[aria-label*="ilenciad" i]', // pt/es: "Conversa silenciada" / "silenciado"
        '[aria-label*="mute" i]', // en: "muted"
      ].join(",");
      // Ícone (família `wds-ic-*`/`ic-*`) só se identifica pelo <title> do SVG,
      // que NENHUM seletor de atributo alcança. Medido: `ic-notifications-off`
      // em 22 linhas — as mesmas 22 do `mute-notifications-refreshed`.
      const RE_ICONE_MUDO = /(^|[-_])(notifications?-off|muted?|silenc)/i;

      // Um marcador de ESTADO é um ícone: ou tem <svg> dentro, ou não tem texto
      // próprio. Texto na linha é escrito por terceiro (nome e prévia vêm em
      // `span[title]`) e não pode virar sinal de estado.
      function sinalDeEstado(el) {
        try {
          if (!el) return false;
          if (el.querySelector("svg") || el.tagName.toLowerCase() === "svg") return true;
          return (el.textContent || "").trim() === "";
        } catch (_) {
          return false;
        }
      }

      function algumSinal(row, seletor, reIcone) {
        try {
          for (const el of row.querySelectorAll(seletor)) {
            if (sinalDeEstado(el)) return true;
          }
          if (reIcone) {
            for (const t of row.querySelectorAll("svg > title")) {
              if (reIcone.test((t.textContent || "").trim())) return true;
            }
          }
        } catch (_) {}
        return false;
      }

      // Estado CRU da linha: o sino está visível AGORA?
      function mudoDaLinha(row) {
        return algumSinal(row, SINAIS_MUDO, RE_ICONE_MUDO);
      }

      // A linha terminou de renderizar? A lista é virtualizada: uma linha pela
      // metade não pode ser lida como "não tem sino, logo não é silenciada".
      function linhaLegivel(row) {
        try {
          return !!(
            row.querySelector('[data-testid="cell-frame-title"]') &&
            row.querySelector('[data-testid="cell-frame-secondary"], [data-testid="cell-frame-container"]')
          );
        } catch (_) {
          return false;
        }
      }

      // U1(b) — MEMÓRIA do silenciamento, por conversa.
      // O sumiço do sino NÃO é prova de que o grupo deixou de ser silenciado:
      // menção pendente o esconde (medido acima), e a linha pode estar pela
      // metade. Então:
      //   · sino visível            → silenciada, e fica lembrado;
      //   · sem sino, linha legível E sem menção pendente → OBSERVAÇÃO POSITIVA
      //     de "não silenciada": só aqui a memória é apagada;
      //   · qualquer outro caso     → vale o que já se sabia da conversa.
      // Teto de MUDO_MEM_MAX conversas, descartando as mais antigas (o Map do
      // JS preserva ordem de inserção, então reinserir é um LRU de graça).
      const MUDO_MEM_MAX = 2000;
      function lembrarMudo(id, valor) {
        const m = self._mudos;
        if (m.has(id)) m.delete(id);
        m.set(id, valor);
        while (m.size > MUDO_MEM_MAX) m.delete(m.keys().next().value);
      }
      function mudoResistente(row, chatId) {
        const agora = mudoDaLinha(row);
        if (!chatId) return agora; // sem id não há memória possível
        if (agora) {
          lembrarMudo(chatId, true);
          return true;
        }
        if (linhaLegivel(row) && !mencaoDaLinha(row)) {
          lembrarMudo(chatId, false);
          return false;
        }
        return self._mudos.get(chatId) === true;
      }

      // U3: horário QUE O WHATSAPP MOSTRA NA LINHA — é o horário da mensagem,
      // não o do disparo da notificação. Medido: "16:35" para hoje, "07/08/2026"
      // para conversa antiga. Se não vier, o Rust cai na hora do disparo.
      function horaDaLinha(row) {
        const el =
          row.querySelector('[data-testid="cell-frame-primary-detail"]') ||
          row.querySelector('[role="gridcell"][aria-colindex="2"] [data-testid*="detail"]');
        const t = el ? (el.textContent || "").trim() : "";
        return t.length <= 24 ? t : "";
      }

      // V3 — RELÓGIO da linha, quando ele existir em algum lugar ESTRUTURAL.
      // O rótulo do dia ("quarta-feira", "Ontem") não traz hora, e o Rust não
      // pode inventar uma. Aqui se procura uma hora de verdade em atributos
      // (title/aria-label/datetime) do próprio bloco de data — NUNCA no texto
      // da prévia, que é escrito por terceiro (medido: uma prévia de jornal
      // trazia "🌐 Notícias ... 08:00" e viraria "hora da mensagem").
      // Medição de 16/08/2026, 69 linhas: NENHUMA linha com rótulo de dia da
      // semana tem hora em atributo nenhum. Ou seja, hoje isto devolve ""
      // e o rótulo continua saindo como está — que é o comportamento certo.
      function relogioDaLinha(row) {
        try {
          const el =
            row.querySelector('[data-testid="cell-frame-primary-detail"]') ||
            row.querySelector('[role="gridcell"][aria-colindex="2"] [data-testid*="detail"]');
          if (!el) return "";
          const fontes = [el, el.parentElement].filter(Boolean);
          for (const f of fontes) {
            for (const attr of ["title", "aria-label", "datetime"]) {
              const v = f.getAttribute && f.getAttribute(attr);
              const m = v && String(v).match(/\b(\d{1,2}):(\d{2})\b/);
              if (m && +m[1] <= 23 && +m[2] <= 59) return m[1] + ":" + m[2];
            }
          }
        } catch (_) {}
        return "";
      }

      // V2 — o rótulo da linha diz que a última mensagem é DE AGORA?
      //   true  → relógio de hoje, a partir do instante em que passamos a olhar
      //   false → "Ontem", "quarta-feira", "07/08/2026", ou hora anterior ao
      //           início: é conversa não lida ANTIGA, não notifica
      //   null  → não deu para afirmar (sem rótulo / formato desconhecido)
      // Fora do bundle isto é testado por `bundle.test.js`.
      function rotuloIndicaNovo(rotulo, desde, agora) {
        const t = String(rotulo || "").trim();
        if (!t) return null;
        const m = t.match(/^(\d{1,2}):(\d{2})\s*([apAP])\.?\s*[mM]?\.?$|^(\d{1,2}):(\d{2})$/);
        if (!m) return false; // rótulo que é DATA (dia da semana, "Ontem", dd/mm)
        const h0 = m[1] !== undefined ? +m[1] : +m[4];
        const min = m[2] !== undefined ? +m[2] : +m[5];
        if (!(h0 >= 0 && h0 <= 23 && min >= 0 && min <= 59)) return null;
        let h = h0;
        const suf = (m[3] || "").toLowerCase();
        if (suf === "p" && h < 12) h += 12;
        if (suf === "a" && h === 12) h = 0;
        const dDesde = new Date(desde);
        const dAgora = new Date(agora);
        // Virou o dia desde que começamos a olhar: um relógio só pode ser de
        // hoje, então é novo. Melhor notificar do que perder mensagem.
        if (dDesde.toDateString() !== dAgora.toDateString()) return true;
        const alvo = new Date(agora);
        alvo.setHours(h, min, 0, 0);
        // 90s de folga: o rótulo tem resolução de minuto e a varredura corre
        // junto com a subida do app.
        return alvo.getTime() >= desde - 90000;
      }

      // Marcas de direção de texto (U+200e/f, U+202a-e, U+2066-9) que o
      // WhatsApp embrulha em volta da prévia. São invisíveis, mas quebram
      // qualquer comparação de string — e era numa comparação dessas que a
      // extração do autor morria.
      function limparTexto(s) {
        return (s || "")
          .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
          .replace(/\s+/g, " ")
          .trim();
      }

      // Prévia da última mensagem (o texto que o remetente controla).
      function previaDaLinha(row) {
        const sec = row.querySelector('[data-testid="cell-frame-secondary"]');
        const alvo = (sec && (sec.querySelector("span[title]") || sec.querySelector("span"))) || null;
        if (alvo) return limparTexto(alvo.getAttribute("title") || alvo.textContent);
        const spans = [...row.querySelectorAll("span")];
        return spans.length > 1 ? limparTexto(spans[spans.length - 1].textContent) : "";
      }

      // W3 — QUEM FALOU no grupo, lido da ESTRUTURA da linha, não de texto.
      //
      // Medido no DOM real da sessão logada (16/08, 69 linhas, 32 grupos):
      // dentro de `[data-testid="cell-frame-secondary"]` existe
      // `span[data-testid="last-msg-status"]`, e em GRUPO seus filhos DIRETOS
      // são, nesta ordem:
      //   [0] <div>…<span dir="auto">Marcelo</span></div>   ← o autor
      //   [1] <span>":&nbsp;"</span>                         ← o separador
      //   [2] <span dir="ltr|auto">texto da mensagem</span>
      // Em conversa 1:1 o filho [0] JÁ É o texto (medido: nenhum separador de
      // topo), então esta função devolve "" e nenhum autor é inventado.
      //
      // Por que a tentativa anterior falhava SEMPRE, apesar de "passar" em
      // teste sintético: ela casava `sec.innerText` contra a prévia, e o
      // CONTADOR de não lidas (`span[data-testid="icon-unread-count"]`) também
      // mora dentro de `cell-frame-secondary`. Medido: innerText
      // "Pai : Figurinha 1" contra prévia "Figurinha" — a guarda reprovava e o
      // autor era descartado. Exatamente as linhas COM mensagem nova, que são
      // as únicas que notificam.
      // O `textContent` de um nó inclui o <title> dos SVGs decorativos que o
      // WhatsApp põe na linha. Medido em produção: o ícone de "entregue" fez o
      // autor sair como `"wds-ic-deliveredVocê"`. Ícone não é texto — some.
      function textoSemIcone(n) {
        if (!n) return "";
        if (n.nodeType !== 1) return n.textContent || "";
        try {
          const c = n.cloneNode(true);
          c.querySelectorAll('svg, [aria-hidden="true"], [data-testid="chat-msg-symbol"]').forEach(
            (x) => x.remove()
          );
          return c.textContent || "";
        } catch (_) {
          return n.textContent || "";
        }
      }

      function autorDaLinha(row) {
        try {
          const sec = row.querySelector('[data-testid="cell-frame-secondary"]');
          if (!sec) return "";
          const host = sec.querySelector('[data-testid="last-msg-status"]');
          if (!host) return "";
          const kids = [...host.childNodes];
          let sep = -1;
          for (let i = 0; i < kids.length && i < 5; i++) {
            const t = textoSemIcone(kids[i]).replace(/[\s\u00a0]/g, "");
            if (t === ":") {
              sep = i;
              break;
            }
            // bloco longo antes de qualquer ":" é a mensagem, não um autor
            if (t.length > 48) break;
          }
          // sep === 0 significa que a própria mensagem começa com ":": não há
          // bloco de autor antes dela.
          if (sep < 1) return "";
          return limparTexto(kids.slice(0, sep).map(textoSemIcone).join(""))
            .replace(/:$/, "")
            .trim()
            .slice(0, 60);
        } catch (_) {
          return "";
        }
      }

      // W4 — MARCADOR de menção na linha. Como o silenciamento (U1), vai uma
      // lista de sinais e basta um bater: os atributos do WhatsApp mudam
      // sozinhos. AVISO HONESTO: ao contrário do sino de silenciado — que foi
      // medido em 22 linhas reais — nenhuma conversa da lista tinha menção
      // pendente no momento da medição, então estes seletores NÃO foram
      // confirmados no DOM ao vivo. Por isso a menção não depende só deles: o
      // Rust também casa os apelidos do usuário contra o texto da prévia.
      //
      // MEDIDO EM 20/08/2026 — o aviso acima deixou de valer: a lista real
      // tinha UMA linha de grupo com menção pendente, e ela traz
      //   <div data-testid="icon-mentions" aria-label="Menção">
      //     <svg><title>ic-alternate-email</title>…</svg>
      //   <span data-testid="icon-unread-count" aria-label="1 mensagem não lida">
      // Note o nome do ícone: `ic-alternate-email`, que não tem "mention"
      // nenhum no meio — por isso ele entra na lista explicitamente.
      // `[title*="mencion"]` saiu pelo mesmo motivo que saiu do silenciamento:
      // `title` na linha é a prévia da mensagem, texto de terceiro.
      const SINAIS_MENCAO = [
        '[data-icon*="mention" i]',
        '[data-testid*="mention" i]',
        '[data-icon*="alternate-email" i]',
        '[aria-label*="mencion" i]', // pt: "Você foi mencionado"
        '[aria-label*="menç" i]',
        '[aria-label*="mention" i]',
      ].join(",");
      const RE_ICONE_MENCAO = /(^|[-_])(mention|alternate-email)/i;
      function mencaoDaLinha(row) {
        return algumSinal(row, SINAIS_MENCAO, RE_ICONE_MENCAO);
      }

      // 4) Varre a lista de conversas atrás de badge de não lida.
      async function scan() {
        const pane = document.querySelector("#pane-side");
        if (!pane) return;
        const rows = pane.querySelectorAll('[role="listitem"], [role="row"]');

        for (const row of rows) {
          const sender = nomeDaLinha(row);
          if (!sender) continue;
          const chatId = chatIdDaLinha(row);

          // U1(b): a memória do silenciamento é alimentada em TODA linha de
          // TODA varredura, ANTES de qualquer `continue`. Se só rodasse no
          // caminho do toast, um grupo silenciado sem não lidas nunca entraria
          // na memória — e a primeira menção nele cairia de novo no bug, que é
          // justamente quando a memória precisa existir.
          const mudo = mudoResistente(row, chatId);

          // badge de não lidas (o WhatsApp usa aria-label com "não lida"/"unread")
          const badge = row.querySelector(
            '[aria-label*="ão lida"], [aria-label*="unread"], [aria-label*="no leído"]'
          );
          const key = chatId || sender;
          // V2: a conversa passou a ser CONHECIDA no momento em que a linha
          // dela apareceu — com ou sem badge. É esta marca que separa "estava
          // aqui quando chegamos" de "mudou enquanto olhávamos".
          const jaConhecida = self._conhecidas.has(key);
          if (!jaConhecida) {
            if (self._conhecidas.size > 5000) self._conhecidas.clear();
            self._conhecidas.add(key);
          }
          if (!badge) {
            self._seen.delete(key);
            continue;
          }

          const preview = previaDaLinha(row);
          if (!preview) continue;

          if (self._seen.get(key) === preview) continue; // já notificado
          self._seen.set(key, preview);
          if (!self._primed) continue; // primeira passada: só popula o estado

          // V2 — NOTIFICAR SÓ O QUE É NOVO DESDE QUE O APP ESTÁ OLHANDO.
          //
          // Antes: bastava "tem badge de não lida" + "a prévia mudou desde a
          // última vez que vi esta linha". Parece razoável, mas a lista do
          // WhatsApp NÃO nasce pronta: `#pane-side` existe antes das linhas
          // renderizarem, a primeira varredura roda com a lista vazia e já
          // marca `_primed = true`. Toda conversa com não lidas ANTIGAS que
          // renderizasse depois disso era "prévia nova" e virava toast — foi
          // o que o usuário viu, dois avisos de mensagens de "quarta-feira"
          // aparecendo agora. O mesmo acontecia a cada rolagem da lista
          // virtualizada e a cada renavegação (nível 3), que recomeça do zero.
          //
          // Agora a decisão precisa de uma AFIRMAÇÃO de novidade:
          //   · o rótulo da linha é um relógio de hoje posterior ao início da
          //     observação (mensagem que chegou com o app rodando); ou
          //   · não há rótulo legível, mas a conversa já era conhecida numa
          //     varredura anterior — então a prévia mudou na nossa frente.
          // Rótulo de DATA ("Ontem", "quarta-feira", "07/08/2026") é prova de
          // que a mensagem é velha: nunca notifica.
          const hora = horaDaLinha(row);
          const novo = rotuloIndicaNovo(hora, self._desde, Date.now());
          if (novo === false) continue;
          if (novo === null && !jaConhecida) continue;

          // Não notificar a conversa já aberta e em foco. A marca vem da própria
          // linha (`aria-selected`), não de comparar títulos: comparação por nome
          // deixaria um remetente calar o aviso escolhendo o texto certo.
          const isOpen = !!row.querySelector('[aria-selected="true"]');
          const skipFocused =
            settings.notify && settings.notify.skipWhenFocused !== false;
          if (skipFocused && document.hasFocus() && isOpen) continue;

          // W3 — quem falou no grupo. Primeiro pela ESTRUTURA da linha (é o
          // formato de hoje, medido no DOM real da sessão logada); só se ela
          // não devolver nada é que se tenta o formato antigo, em que a prévia
          // inteira vinha "Fulano: texto". A tentativa anterior fazia o
          // contrário e morria numa guarda que comparava `sec.innerText` com a
          // prévia — ver o comentário de `autorDaLinha`.
          let author = autorDaLinha(row);
          let body = preview;
          if (!author) {
            const m = preview.match(/^([^:]{1,28}):\s(.+)$/);
            if (m) {
              author = m[1];
              body = m[2];
            }
          }

          // Lido ANTES do await: a lista é virtualizada e a linha pode ser
          // reciclada enquanto o avatar é convertido.
          const relogio = relogioDaLinha(row); // V3: "" quando a linha não tem hora
          const grupo = /@g\.us$/.test(chatId);
          const mencao = mencaoDaLinha(row);

          const avatar = await avatarAsData(row.querySelector("img"));

          // Só fato bruto: quem aplica a regra (estilo, som, máscara de prévia,
          // silenciar) é o Rust, que lê o settings.json. Assim a lista de regras
          // — que é a lista de contatos do usuário — nunca chega à página.
          invoke("show_toast", {
            toast: {
              id: String(Date.now()) + Math.random().toString(36).slice(2, 7),
              sender,
              author,
              body,
              avatar,
              chat_id: chatId,
              muted: mudo,
              time: hora,
              clock: relogio,
              is_group: grupo,
              mention_mark: mencao,
            },
          }).catch((e) => console.warn("[ZapLite] toast", e));
        }

        if (!self._primed) self._primed = true;

        // W1(b): a lista de conversas vai para o Rust para o PAINEL poder
        // oferecer caixinhas de "silenciar" em vez de obrigar o usuário a
        // escrever uma regra por grupo. É insumo de UI: nenhuma decisão de
        // notificação depende disto (a decisão usa o `chat_id` do toast).
        // A varredura roda a cada 1,2s; reportar a lista a cada 15s basta.
        if (Date.now() - (self._ultimoReport || 0) > 15000) {
          self._ultimoReport = Date.now();
          const chats = [];
          for (const row of rows) {
            const id = chatIdDaLinha(row);
            if (!id) continue;
            chats.push({
              id,
              name: nomeDaLinha(row),
              group: /@g\.us$/.test(id),
              muted: mudoResistente(row, id),
              // M4: NÍVEL do marcador de menção. Serve só para o Rust saber que
              // a menção FOI LIDA (marcador sumiu) mesmo quando nenhuma
              // mensagem nova chegou naquele intervalo — sem isso a próxima
              // menção do mesmo grupo não seria uma subida de borda.
              mention: mencaoDaLinha(row),
            });
          }
          if (chats.length) invoke("report_chats", { chats }).catch(() => {});
        }
      }

      this._timer = setInterval(scan, 1200);
      scan();

      // 5) Clique no toast abre a conversa correspondente.
      // Resolve pelo ID da conversa. Se o id não estiver na lista (conversa
      // arquivada, lista filtrada, WhatsApp mudou a estrutura), NÃO abre nada:
      // errar aqui é abrir a conversa errada para quem manda a mensagem.
      this._linhaDoChat = function (chatId) {
        if (!chatId) return null;
        const pane = document.querySelector("#pane-side");
        if (!pane) return null;
        const rows = [...pane.querySelectorAll('[role="listitem"], [role="row"]')];
        return rows.find((r) => chatIdDaLinha(r) === chatId) || null;
      };

      // Y2 — o clique tem que sobreviver à janela em que a página não pode
      // atendê-lo. Dois buracos, um em cada ponta:
      //   * o `emit` do Tauri não tem buffer — se o clique cair durante um
      //     reload (nível 2) ou uma renavegação (nível 3), não existe listener
      //     e o evento se perde. Por isso o Rust GUARDA o pedido e a página
      //     pergunta por ele ao subir (`take_pending_chat`);
      //   * mesmo com o evento na mão, `_linhaDoChat` devolve `null` enquanto
      //     o `#pane-side` não terminou de renderizar. Por isso a tentativa é
      //     REPETIDA por alguns segundos em vez de desistir na primeira.
      // Se ainda assim não der, o usuário TEM que perceber: o toast já fechou,
      // então o aviso vai para o painel.
      const ABRIR_TENTATIVAS = 30;   // 30 x 400ms = 12s (cobre render + varredura da lista)
      const ABRIR_INTERVALO = 400;
      const REPETIDO_MS = 4000;      // mesma conversa duas vezes = um clique só
      const ESPERAR_RENDER = 3;      // tentativas antes de começar a rolar a lista

      // Z1 — POR QUE `elemento.click()` NUNCA ABRIU A CONVERSA.
      //
      // Medido no DOM real da sessão logada (16/08), quatro experimentos
      // seguidos na mesma lista, cada um mirando uma conversa diferente e
      // conferindo qual linha ficou com `aria-selected="true"` depois:
      //   `click` sozinho (o que este código fazia) .......... NÃO abriu
      //   `pointerdown`+`pointerup` .......................... NÃO abriu
      //   `mousedown` sozinho ................................ ABRIU
      //   `mousedown`+`mouseup`+`click` ...................... ABRIU
      // Ou seja: a lista do WhatsApp Web abre a conversa no **mousedown**, e
      // `HTMLElement.click()` dispara SÓ o evento `click` — por isso o clique
      // no toast fechava o toast e não abria nada, exatamente como o usuário
      // relatou. As duas tentativas reais dele ficaram no log: `achou=true`
      // seguido de `pos-clique selecionada=nenhuma`.
      //
      // Havia um segundo erro no mesmo ponto: o alvo era
      // `linha.querySelector('[role="gridcell"]')`, que devolve a PRIMEIRA
      // célula da linha — a que nem tem `aria-colindex` (medido:
      // `DIV|col=null`). O conteúdo clicável é a célula `aria-colindex="2"`.
      //
      // Vai a sequência inteira (ponteiro + mouse + click) porque é a que um
      // mouse de verdade produz: depender de um único evento é depender de um
      // detalhe interno do WhatsApp que já mudou antes.
      // A sequência em si mora em `cliqueReal` (um lugar só): o play da bolha
      // de áudio precisa exatamente da mesma, e duas cópias voltariam a
      // divergir. Aqui fica só a escolha do ALVO dentro da linha.
      function cliqueDeVerdade(linha) {
        cliqueReal(linha.querySelector('[role="gridcell"][aria-colindex="2"]') || linha);
      }

      // Qual conversa está aberta AGORA, pelo id — para conferir se o clique
      // pegou em vez de acreditar que pegou.
      this._chatAberto = function () {
        const pane = document.querySelector("#pane-side");
        if (!pane) return "";
        const sel = [...pane.querySelectorAll('[role="listitem"], [role="row"]')].find(
          (r) => r.querySelector('[aria-selected="true"]') || r.getAttribute("aria-selected") === "true"
        );
        return sel ? chatIdDaLinha(sel) : "";
      };

      this._abrirConversa = function (chatId, tentativa) {
        if (!chatId) return;
        const t = tentativa || 0;
        if (t === 0) {
          const agora = Date.now();
          if (self._ultimoAlvo === chatId && agora - (self._ultimoAlvoTs || 0) < REPETIDO_MS) {
            return; // o evento e o pedido pendente descrevem o MESMO clique
          }
          self._ultimoAlvo = chatId;
          self._ultimoAlvoTs = agora;
        }
        const pane = document.querySelector("#pane-side");
        if (t === 0) self._rolagemOriginal = pane ? pane.scrollTop : null;

        const linha = self._linhaDoChat(chatId);
        if (linha) {
          cliqueDeVerdade(linha);
          // Conferência: o clique ABRIU mesmo? Sem isto, uma mudança futura do
          // WhatsApp volta a falhar em silêncio — que é o defeito que estamos
          // consertando, não um detalhe.
          self._conferir = setTimeout(() => {
            const aberto = self._chatAberto();
            if (aberto === chatId) {
              // deu certo: devolve a lista para onde o usuário a deixou
              if (self._rolagemOriginal != null && pane) pane.scrollTop = self._rolagemOriginal;
              return;
            }
            console.warn("[ZapLite] cliquei na linha da conversa e ela não abriu");
            showPanel(
              "Conversa não aberta",
              "O ZapLite achou a conversa do toast na lista, clicou nela e o WhatsApp " +
                "não abriu. Isso costuma significar que a estrutura da lista mudou. " +
                "Abra a conversa manualmente e, se repetir, avise."
            );
          }, 1400);
          return;
        }

        // Z1(b) — a linha NÃO está no pedaço renderizado. A lista é
        // VIRTUALIZADA: medido na lista real do usuário, `#pane-side` tinha
        // scrollHeight 13024 para clientHeight 831 e apenas 71 linhas no DOM
        // (~181 conversas no total). Nenhum seletor acha o que não foi
        // renderizado — é preciso ROLAR para o WhatsApp montar o próximo
        // pedaço. As primeiras tentativas não rolam: cobrem o caso comum, em
        // que a página ainda está terminando de renderizar.
        if (pane && t >= ESPERAR_RENDER) {
          const antes = pane.scrollTop;
          // a varredura começa do topo, senão metade da lista nunca é olhada
          pane.scrollTop = t === ESPERAR_RENDER ? 0 : antes + Math.max(240, pane.clientHeight - 80);
          if (t > ESPERAR_RENDER && pane.scrollTop === antes) {
            // fim da lista e a conversa não apareceu: insistir só rola no vazio
            return self._desistirDeAbrir(pane);
          }
        }

        if (t + 1 < ABRIR_TENTATIVAS) {
          self._reabrir = setTimeout(
            () => self._abrirConversa(chatId, t + 1),
            ABRIR_INTERVALO
          );
          return;
        }
        self._desistirDeAbrir(pane);
      };

      // Desistência: devolve a lista para onde o usuário a deixou (rolar a
      // agenda dele e largar assim seria pior que não abrir) e avisa — o toast
      // já fechou, então o painel é o único lugar onde o aviso ainda aparece.
      this._desistirDeAbrir = function (pane) {
        if (pane && self._rolagemOriginal != null) pane.scrollTop = self._rolagemOriginal;
        self._rolagemOriginal = null;
        console.warn("[ZapLite] conversa do toast não apareceu na lista; nada aberto");
        showPanel(
          "Conversa não aberta",
          "O ZapLite não conseguiu abrir a conversa do toast que você clicou. " +
            "Ela pode estar arquivada, fora da lista filtrada, ou a página ainda " +
            "estava se recuperando. Abra a conversa manualmente."
        );
      };

      if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event
          .listen("zaplite://open-chat", (ev) => {
            const p = ev.payload || {};
            const chatId = typeof p === "string" ? "" : p.chatId;
            // consome o pedido guardado: o evento chegou vivo, ninguém precisa
            // reabrir a mesma conversa quando a página subir de novo.
            invoke("take_pending_chat").catch(() => {});
            self._abrirConversa(chatId, 0);
          })
          .then((un) => {
            // revert() pode ter rodado antes do listen resolver
            if (!self._started) un();
            else self._unlisten = un;
          })
          .catch(() => {});

        // Y2 — pedido feito enquanto esta página não existia (o clique caiu no
        // meio da recuperação). O Rust sobreviveu ao reload e ainda tem o alvo.
        invoke("take_pending_chat")
          .then((chatId) => {
            if (chatId && self._started) self._abrirConversa(chatId, 0);
          })
          .catch(() => {});
      }
    },

    revert() {
      clearInterval(this._timer);
      this._timer = null;
      // Y2: a repetição da abertura não pode sobreviver ao desligamento do
      // módulo — senão um clique velho abre conversa depois de o usuário
      // desligar as notificações.
      clearTimeout(this._reabrir);
      this._reabrir = null;
      clearTimeout(this._conferir);
      this._conferir = null;
      this._started = false;
      this._primed = false;
      this._seen.clear();
      // Sem isto, cada liga/desliga (e cada reinjeção depois de renavegação)
      // somava um listener, e um clique passava a abrir a conversa N vezes.
      if (this._unlisten) {
        try {
          this._unlisten();
        } catch (_) {}
        this._unlisten = null;
      }
      // devolve a notificação nativa
      if (this._native) {
        try {
          Object.defineProperty(window, "Notification", {
            value: this._native,
            writable: true,
            configurable: true,
          });
        } catch (_) {}
      }
      invoke("close_all_toasts").catch(() => {});
    },
  });

  /* 32. Menu de contexto no botão direito das mensagens ------------------ */
  reg({
    id: "contextMenu",
    apply() {
      if (this._on) return;
      this._on = true;
      const self = this;

      css(
        `#zl-ctx{position:fixed;z-index:2147483002;min-width:206px;padding:6px;
           background:#111b21;border:1px solid rgba(255,255,255,.10);border-radius:11px;
           box-shadow:0 14px 40px rgba(0,0,0,.55);font-family:system-ui,sans-serif}
         #zl-ctx button{display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;
           border:none;background:transparent;color:#e9edef;font-size:13px;border-radius:7px;
           cursor:pointer;text-align:left;font-family:inherit}
         #zl-ctx button:hover{background:rgba(255,255,255,.07)}
         #zl-ctx .ic{width:20px;text-align:center;color:var(--zl-accent,#22d3aa)}
         #zl-ctx .hd{padding:5px 10px 7px;font-size:10.5px;color:#6b7c89;
           border-bottom:1px solid rgba(255,255,255,.07);margin-bottom:4px;
           white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}`,
        "zl-ctx-style"
      );

      function fecha() {
        const m = document.getElementById("zl-ctx");
        if (m) m.remove();
      }

      function abre(x, y, titulo, itens) {
        fecha();
        const m = document.createElement("div");
        m.id = "zl-ctx";
        const hd = document.createElement("div");
        hd.className = "hd";
        hd.textContent = titulo;
        m.appendChild(hd);
        itens.forEach(([icone, rotulo, acao]) => {
          const b = document.createElement("button");
          b.innerHTML = '<span class="ic"></span><span class="lb"></span>';
          b.querySelector(".ic").textContent = icone;
          b.querySelector(".lb").textContent = rotulo;
          b.onclick = (e) => {
            e.stopPropagation();
            fecha();
            acao();
          };
          m.appendChild(b);
        });
        document.body.appendChild(m);
        // não deixa vazar para fora da tela
        const r = m.getBoundingClientRect();
        m.style.left = Math.min(x, innerWidth - r.width - 8) + "px";
        m.style.top = Math.min(y, innerHeight - r.height - 8) + "px";
      }

      self._close = fecha;
      document.addEventListener("click", fecha);
      document.addEventListener("scroll", fecha, true);

      self._handler = (ev) => {
        const bolha = bolhaDe(ev.target);
        if (!bolha) return; // fora de mensagem, deixa o menu nativo
        ev.preventDefault();
        ev.stopPropagation();

        const texto = textoDaBolha(bolha);
        // V2: nada de `querySelector("audio")` aqui — o mesmo helper do botão
        // da bolha decide o que é áudio e de onde vêm os bytes. Seletor
        // duplicado é o que faz um cisma do WhatsApp quebrar os dois de uma vez.
        const audio = ehBolhaDeAudio(bolha);
        const img = bolha.querySelector('img[src^="blob:"], img[src^="data:"]');
        const video = bolha.querySelector('video[src^="blob:"], video source[src^="blob:"]');
        const itens = [];

        /* A6 — "ver mensagem apagada". Só aparece quando ESTA bolha está
           marcada como apagada; se não temos o texto, o item continua
           aparecendo, mas dizendo por quê (a alternativa — sumir — faz o
           usuário achar que o recurso não existe, que foi exatamente o que
           aconteceu com a transcrição). */
        if (ehApagada(bolha)) {
          const ad = moduloPorId("antiDelete");
          const guardado = ad ? ad.textoGuardado(bolha) : "";
          if (guardado) {
            itens.push([
              "🕵",
              "Ver mensagem apagada",
              () => {
                if (ad) ad.revelarNaBolha(bolha, guardado);
                showPanel("Mensagem apagada", guardado);
              },
            ]);
          } else if (!on("antiDelete")) {
            itens.push([
              "🕵",
              "Mensagem apagada (módulo desligado)",
              () =>
                showPanel(
                  "Mensagem apagada",
                  "O módulo Anti-apagadas está desligado, então o ZapLite não guardou o texto desta mensagem.\n\n" +
                    "Ligue-o no Painel para que as próximas mensagens apagadas possam ser lidas.",
                  [["Abrir o Painel", () => invoke("open_settings", { secao: "mods" }).catch(() => {})]]
                ),
            ]);
          } else {
            itens.push([
              "🕵",
              "Mensagem apagada (sem cópia)",
              () =>
                showPanel(
                  "Mensagem apagada",
                  "Esta mensagem foi apagada antes de o ZapLite vê-la na tela — o texto original nunca chegou aqui, " +
                    "então não há o que mostrar.\n\nO ZapLite só guarda o que passou pela conversa aberta com ele rodando."
                ),
            ]);
          }
        }

        if (audio) {
          itens.push([
            "📝",
            "Transcrever este áudio",
            guarded(async () => {
              showPanel("Transcrição", "Transcrevendo…");
              try {
                showPanel("Transcrição", await transcreverBolha(bolha));
              } catch (e) {
                if (ehFaltaDeInstalacao(e)) return avisarInstalacaoDaTranscricao(e);
                throw e;
              }
            }, "Transcrição"),
          ]);
        }

        if (img) {
          itens.push([
            "🔤",
            "Extrair texto da imagem",
            guarded(async () => {
              showPanel("Texto da imagem", "Lendo…");
              const b = await (await fetch(img.src)).blob();
              const b64 = await new Promise((r) => {
                const fr = new FileReader();
                fr.onload = () => r(String(fr.result).split(",")[1]);
                fr.readAsDataURL(b);
              });
              const t = await ai(
                "Você transcreve todo o texto visível de uma imagem. Responda só com o texto, sem comentários.",
                "Extraia o texto desta imagem.",
                { image: b64, mediaType: b.type || "image/jpeg" }
              );
              showPanel("Texto da imagem", t);
            }, "OCR"),
          ]);
          itens.push([
            "💾",
            "Salvar imagem…",
            guarded(async () => {
              await salvarArquivo(await (await fetch(img.src)).blob(), "zaplite-imagem");
            }, "Salvar imagem"),
          ]);
        }

        if (video) {
          itens.push([
            "💾",
            "Salvar vídeo…",
            guarded(async () => {
              const src = video.src || (video.getAttribute && video.getAttribute("src")) || "";
              if (!src) throw new Error("não achei os bytes deste vídeo na página.");
              await salvarArquivo(await (await fetch(src)).blob(), "zaplite-video");
            }, "Salvar vídeo"),
          ]);
        }

        if (texto) {
          itens.push([
            "⧉",
            "Copiar texto",
            () => navigator.clipboard.writeText(texto).catch(() => {}),
          ]);
          itens.push([
            "🌐",
            "Traduzir para português",
            guarded(async () => {
              showPanel("Tradução", "Traduzindo…");
              const t = await ai(
                "Você traduz mensagens para português do Brasil. Responda só com a tradução.",
                texto
              );
              showPanel("Tradução", t);
            }, "Tradução"),
          ]);
          itens.push([
            "✍",
            "Responder com sugestão da IA",
            guarded(async () => {
              showPanel("Rascunho", "Escrevendo…");
              const tom = settings.aiTone || "direto, amigável e claro";
              const r = await ai(
                `Você sugere UMA resposta curta de WhatsApp em português do Brasil, no tom ${tom}. Responda apenas com o texto da mensagem.`,
                "Responder a esta mensagem:\n" + texto
              );
              const cx = document.querySelector('div[contenteditable="true"][data-tab]');
              if (cx) {
                cx.focus();
                document.execCommand("insertText", false, r.trim());
                const p = document.getElementById("zl-panel");
                if (p) p.remove();
              } else showPanel("Rascunho", r);
            }, "Sugestão"),
          ]);
          itens.push([
            "🛡",
            "Isso parece golpe?",
            guarded(async () => {
              showPanel("Análise", "Analisando…");
              const t = await ai(
                "Você avalia se uma mensagem é golpe, phishing ou fraude. Responda em português do Brasil, em até 4 linhas: veredito e os sinais que o justificam.",
                texto
              );
              showPanel("Análise", t);
            }, "Análise"),
          ]);
        }

        if (!itens.length) return;
        const titulo = texto ? texto.slice(0, 40) : audio ? "Mensagem de voz" : "Mídia";
        abre(ev.clientX, ev.clientY, titulo, itens);
      };

      document.addEventListener("contextmenu", self._handler, true);
    },

    revert() {
      if (this._handler) document.removeEventListener("contextmenu", this._handler, true);
      if (this._close) this._close();
      dropCss("zl-ctx-style");
      this._on = false;
    },
  });

  /* --- painel flutuante para exibir resultados de IA --------------------
     `acoes` é uma lista [[rótulo, função], ...] desenhada como botões abaixo
     do texto. Existe por causa do A7: erro cru ("whisper-cli não encontrado")
     fez o usuário concluir que o recurso não existe, quando o instalador está
     dentro do binário. Uma mensagem sem caminho de saída não é um aviso, é um
     beco. */
  function showPanel(title, body, acoes) {
    let p = document.getElementById("zl-panel");
    if (!p) {
      p = document.createElement("div");
      p.id = "zl-panel";
      p.innerHTML =
        '<div class="zl-panel-head"><b></b><span class="zl-acoes"><button class="zl-copy" title="Copiar texto">Copiar</button><button class="zl-x" title="Fechar">✕</button></span></div><div class="zl-panel-body"></div>';
      document.body.appendChild(p);
      p.querySelector(".zl-x").onclick = () => p.remove();
      p.querySelector(".zl-copy").onclick = async (ev) => {
        const txt = p.querySelector(".zl-panel-body").textContent || "";
        const b = ev.currentTarget;
        try {
          await navigator.clipboard.writeText(txt);
        } catch (_) {
          /* clipboard bloqueado: seleciona para o usuário copiar na mão */
          const r = document.createRange();
          r.selectNodeContents(p.querySelector(".zl-panel-body"));
          const sel = window.getSelection();
          sel.removeAllRanges(); sel.addRange(r);
        }
        const antes = b.textContent;
        b.textContent = "Copiado!";
        setTimeout(() => { b.textContent = antes; }, 1400);
      };
    }
    p.querySelector("b").textContent = title;
    p.querySelector(".zl-panel-body").textContent = body;
    const velhas = p.querySelector(".zl-panel-acoes");
    if (velhas) velhas.remove();
    if (acoes && acoes.length) {
      const barra = document.createElement("div");
      barra.className = "zl-panel-acoes";
      acoes.forEach(([rotulo, fn]) => {
        const b = document.createElement("button");
        b.textContent = rotulo;
        b.onclick = () => {
          try {
            fn();
          } catch (e) {
            console.error("[ZapLite] ação do painel falhou:", e);
          }
        };
        barra.appendChild(b);
      });
      p.appendChild(barra);
    }
    return p;
  }

  /* A7 — "ainda não instalado" nunca vira erro cru: vira convite com botão que
     abre o Painel JÁ na seção de transcrição. */
  function ehFaltaDeInstalacao(e) {
    const m = (e && e.message) || String(e || "");
    return m.indexOf("[zl-setup]") >= 0;
  }
  function textoSemCarimbo(e) {
    return ((e && e.message) || String(e || "")).replace("[zl-setup] ", "").replace(/^transcribe_audio → /, "");
  }
  function avisarInstalacaoDaTranscricao(e) {
    showPanel(
      "Transcrição ainda não instalada",
      textoSemCarimbo(e) +
        "\n\nO instalador vem dentro do ZapLite: o botão abaixo abre o Painel já na seção certa, " +
        "onde dá para baixar o motor e o modelo de voz sem sair do app.",
      [
        [
          "Instalar transcrição",
          () => invoke("open_settings", { secao: "ia" }).catch((err) => showPanel("Erro", err.message)),
        ],
      ]
    );
  }

  /* --- estilos base dos nossos elementos ------------------------------- */
  const BASE_CSS = `
    #zl-dock{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:2147483000;
      display:flex;align-items:flex-end;flex-direction:column;gap:0;font-family:system-ui,sans-serif}
    #zl-tab{width:34px;height:64px;border:none;cursor:pointer;color:#04120e;font-weight:800;
      font-size:17px;border-radius:12px 0 0 12px;background:var(--zl-accent,#22d3aa);
      box-shadow:-3px 0 14px rgba(0,0,0,.35);display:grid;place-items:center;
      transition:width .12s}
    #zl-tab:hover{width:40px}
    #zl-menu{display:none;flex-direction:column;gap:2px;margin-top:8px;padding:8px;
      background:#111b21;border:1px solid rgba(255,255,255,.10);border-radius:12px 0 0 12px;
      box-shadow:-6px 0 26px rgba(0,0,0,.5);min-width:214px}
    #zl-dock.open #zl-menu{display:flex}
    .zl-act{display:flex;align-items:center;gap:10px;width:100%;padding:9px 11px;border:none;
      background:transparent;color:#e9edef;font-size:13px;border-radius:8px;cursor:pointer;
      text-align:left;font-family:inherit}
    .zl-act:hover{background:rgba(255,255,255,.07)}
    .zl-act .ic{width:22px;text-align:center;font-size:14px;color:var(--zl-accent,#22d3aa);flex:0 0 auto}
    .zl-act .kbd{margin-left:auto;font-size:10px;color:#6b7c89;font-family:ui-monospace,monospace}
    .zl-sep{height:1px;background:rgba(255,255,255,.08);margin:5px 4px}
    .zl-note{padding:6px 11px 2px;font-size:10.5px;color:#6b7c89;line-height:1.4}

    .zl-tr-btn{margin:4px 6px 0;padding:2px 8px;font-size:11px;border:none;border-radius:8px;
      cursor:pointer;background:var(--zl-accent,#22d3aa);color:#04120e;opacity:.9;font-weight:600}
    .zl-recovered{margin-top:4px;padding:4px 8px;font-size:12.5px;border-radius:8px;
      background:rgba(34,211,170,.12);color:inherit;
      user-select:text;-webkit-user-select:text;cursor:text}
    .zl-tr-copy{display:inline-block;margin-left:6px;vertical-align:middle;
      background:rgba(34,211,170,.25);border:none;color:inherit;cursor:pointer;
      font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:6px;user-select:none}
    .zl-tr-copy:hover{background:rgba(34,211,170,.45)}
    #zl-panel{position:fixed;right:60px;bottom:20px;width:340px;max-height:60vh;z-index:2147483001;
      display:flex;flex-direction:column;background:#111b21;color:#e9edef;border-radius:14px;
      box-shadow:0 12px 40px rgba(0,0,0,.5);overflow:hidden;border:1px solid rgba(255,255,255,.08)}
    .zl-panel-head{display:flex;justify-content:space-between;align-items:center;
      padding:10px 14px;background:var(--zl-accent,#22d3aa);color:#04120e;font-weight:600}
    .zl-panel-head .zl-x{background:none;border:none;color:#04120e;cursor:pointer;font-size:14px}
    .zl-panel-body{padding:12px 14px;overflow:auto;white-space:pre-wrap;line-height:1.45;font-size:13.5px;user-select:text;-webkit-user-select:text;cursor:text}
    .zl-acoes{display:flex;align-items:center;gap:8px}
    .zl-panel-head .zl-copy{background:rgba(4,18,14,.14);border:none;color:#04120e;cursor:pointer;font-size:11.5px;font-weight:700;padding:3px 9px;border-radius:7px}
    .zl-panel-head .zl-copy:hover{background:rgba(4,18,14,.26)}
    .zl-panel-acoes{display:flex;gap:8px;flex-wrap:wrap;padding:0 14px 12px}
    .zl-panel-acoes button{background:var(--zl-accent,#22d3aa);color:#04120e;border:none;cursor:pointer;
      font-size:12px;font-weight:700;padding:7px 12px;border-radius:8px;font-family:inherit}
    .zl-panel-acoes button:hover{filter:brightness(1.1)}
    .zl-bar{margin-top:10px;height:8px;border-radius:99px;background:rgba(255,255,255,.13);overflow:hidden}
    .zl-bar i{display:block;height:100%;background:var(--zl-accent,#22d3aa);transition:width .1s linear}

    /* A4 — modo NSFW. O borrão vai SÓ nos elementos que o JS marcou (mídia
       dentro de bolha, prévia da lista, visualizador); a interface do WhatsApp
       usa <svg>/[data-icon], que nunca recebem a classe. */
    .zl-nsfw-alvo{filter:blur(20px) !important;transition:filter .12s ease}
    .zl-nsfw-alvo:hover{filter:blur(0) !important}
    .zl-nsfw-alvo.zl-nsfw-livre{filter:none !important}
  `;

  /* --- o dock: uma aba fixa na borda direita que abre o menu ------------ */
  function ensureDock() {
    if (document.getElementById("zl-dock")) return escoarActs(document.getElementById("zl-menu"));
    if (!document.body) return null;

    const dock = document.createElement("div");
    dock.id = "zl-dock";
    dock.innerHTML =
      '<button id="zl-tab" title="ZapLite (Ctrl+Shift+Z)">Z</button>' +
      '<div id="zl-menu"></div>';
    document.body.appendChild(dock);

    const tab = dock.querySelector("#zl-tab");
    tab.onclick = (e) => {
      e.stopPropagation();
      dock.classList.toggle("open");
    };
    // clicar fora fecha
    document.addEventListener("click", (e) => {
      if (!dock.contains(e.target)) dock.classList.remove("open");
    });

    const menu = dock.querySelector("#zl-menu");

    // O Painel é sempre a primeira entrada e nunca some.
    addAct(menu, "zl-open-panel", "⚙", "Painel do ZapLite", "Ctrl+Shift+Z", () =>
      invoke("open_settings").catch((e) => showPanel("Erro", e.message))
    );
    const sep = document.createElement("div");
    sep.className = "zl-sep";
    sep.id = "zl-sep";
    menu.appendChild(sep);

    if (!window.__TAURI__) {
      const n = document.createElement("div");
      n.className = "zl-note";
      n.textContent =
        "Ponte com o app indisponível: os módulos nativos não vão responder.";
      menu.appendChild(n);
    }
    return escoarActs(menu);
  }

  /* Monta o dock e as entradas que NÃO são módulo (Painel, dentro do
     `ensureDock`, e Diagnóstico). Idempotente e sem exigir ordem: qualquer
     caminho que precise do dock pronto chama isto — o boot, o observer que
     remonta depois de o SPA recriar a árvore, e o `applyAll` (que também é
     chamado pelo Rust, ao salvar settings, quando o boot pode nem ter
     acontecido). Antes existiam três cópias desta sequência; a que faltava
     era justamente a do `applyAll`. */
  function montarDock() {
    if (!document.body) return null;
    css(BASE_CSS, "zl-base");
    flushCss();
    const menu = ensureDock();
    addAct(menu, "zl-diag", "🩺", "Diagnóstico", "", diagnostico);
    return menu;
  }

  /* Diagnóstico: testa cada comando nativo e mostra o resultado.
     Existe porque uma falha de permissão silenciosa é impossível de debugar. */
  async function diagnostico() {
    const testes = [
      ["load_settings_public", {}],
      ["set_always_on_top", { value: false }],
      ["close_all_toasts", {}],
    ];
    const linhas = ["Ponte nativa: " + (window.__TAURI__ ? "presente" : "AUSENTE"), ""];
    for (const [cmd, args] of testes) {
      try {
        await invoke(cmd, args);
        linhas.push("ok    " + cmd);
      } catch (e) {
        linhas.push("FALHA " + cmd + "\n      " + e.message);
      }
    }
    linhas.push("");
    linhas.push(
      "Módulos ligados: " +
        (Object.entries(settings.modules || {})
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(", ") || "nenhum")
    );
    showPanel("Diagnóstico", linhas.join("\n"));
  }

  /* Botão dentro do cabeçalho do próprio WhatsApp, para o app não parecer
     duas coisas coladas. Remontado pelo observer se o SPA recriar o header. */
  function mountHeaderButton() {
    if (document.getElementById("zl-hdr")) return;
    // o cabeçalho da lista de conversas é o primeiro <header> da página
    const header = document.querySelector("header");
    if (!header) return;
    const alvo = header.querySelector("div:last-child") || header;

    const b = document.createElement("button");
    b.id = "zl-hdr";
    b.type = "button";
    b.title = "ZapLite (Ctrl+Shift+Z)";
    b.textContent = "Z";
    b.style.cssText =
      "width:30px;height:30px;margin:0 4px;border:none;border-radius:9px;cursor:pointer;" +
      "font-weight:800;font-size:14px;line-height:1;color:#04120e;" +
      "background:var(--zl-accent,#22d3aa);flex:0 0 auto";
    b.onclick = (e) => {
      e.stopPropagation();
      const d = document.getElementById("zl-dock");
      if (d) d.classList.toggle("open");
    };
    alvo.appendChild(b);
  }

  /* Itens pedidos enquanto o dock ainda não existia. Sem esta fila, `addAct`
     saía calado e o botão sumia de vez: quem paga é sempre o PRIMEIRO módulo a
     pedir o dock (os seguintes já o encontram criado), então o defeito mudava
     de dono a cada reordenação da lista de módulos em vez de aparecer. */
  const ACTS_PENDENTES = [];
  function escoarActs(menu) {
    if (menu && ACTS_PENDENTES.length) {
      ACTS_PENDENTES.splice(0).forEach((a) => addAct(menu, a.id, a.icon, a.label, a.kbd, a.fn));
    }
    return menu;
  }

  function addAct(menu, id, icon, label, kbd, fn) {
    if (document.getElementById(id)) return;
    if (!menu) {
      // Dock ainda não montado (sem `document.body`, ou `applyAll` rodando
      // antes do boot). Guarda o pedido: `ensureDock` o refaz ao montar.
      if (!ACTS_PENDENTES.some((a) => a.id === id)) {
        ACTS_PENDENTES.push({ id, icon, label, kbd, fn });
      }
      return;
    }
    const b = document.createElement("button");
    b.className = "zl-act";
    b.id = id;
    b.innerHTML =
      '<span class="ic"></span><span class="lb"></span>' +
      (kbd ? '<span class="kbd"></span>' : "");
    b.querySelector(".ic").textContent = icon;
    b.querySelector(".lb").textContent = label;
    if (kbd) b.querySelector(".kbd").textContent = kbd;
    b.onclick = (e) => {
      e.stopPropagation();
      document.getElementById("zl-dock").classList.remove("open");
      fn(b);
    };
    menu.appendChild(b);
  }
  const dropAct = (id) => {
    const b = document.getElementById(id);
    if (b) b.remove();
    // Um módulo desligado não pode continuar na fila de espera do dock.
    const i = ACTS_PENDENTES.findIndex((a) => a.id === id);
    if (i >= 0) ACTS_PENDENTES.splice(i, 1);
  };

  /* ========================================================================
     APLICAR / REAPLICAR conforme settings
     ======================================================================== */
  // Padrão de fábrica. Módulos novos precisam ser MESCLADOS com o que já
  // está salvo: se substituirmos tudo-ou-nada, quem já tem settings.json
  // nunca recebe um módulo novo, porque a chave simplesmente não existe lá.
  const MODULOS_PADRAO = {
    unsavedSend: true,
    antiDelete: true,
    transcribe: true,
    summarize: true,
    draftReply: true,
    audioSpeed: true,
    theme: true,
    smartNotify: true,
    contextMenu: true,
    // A4/A5 nascem DESLIGADOS: um muda a aparência de toda a tela, o outro
    // gasta CPU e manda recibo de "ouvida" sem o usuário pedir.
    nsfwBlur: false,
    autoTranscribe: false,
  };

  async function applyAll() {
    try {
      // load_settings_public, não load_settings: esta página é web.whatsapp.com,
      // e qualquer script de terceiros aqui dentro consegue chamar o mesmo
      // comando. O Rust devolve só as chaves de aparência/módulos — a chave da
      // API Anthropic nunca atravessa a ponte (quem precisa dela é o
      // ai_complete, que a lê do lado Rust).
      settings = (await invoke("load_settings_public")) || {};
    } catch (e) {
      console.warn("[ZapLite] load_settings_public falhou:", e.message);
      settings = {};
    }
    // o que o usuário salvou vence; o que ele nunca viu usa o padrão
    settings.modules = Object.assign({}, MODULOS_PADRAO, settings.modules || {});
    // O dock precisa existir ANTES do primeiro `m.apply()`: `applyAll` não é
    // chamado só pelo boot (o Rust dispara `__ZAPLITE_RELOAD__` ao salvar
    // settings, e o observer o chama ao remontar), e nesses caminhos o dock
    // pode não estar montado. Sem isto o primeiro módulo da lista recebia
    // `null` de `ensureDock()` e perdia o botão em silêncio.
    if (!document.getElementById("zl-dock")) {
      await until(() => document.body, 30000);
      montarDock();
    }
    for (const m of modules) {
      try {
        if (on(m.id)) m.apply();
        else m.revert();
      } catch (e) {
        console.warn("[ZapLite] módulo", m.id, e);
      }
    }
  }

  window.__ZAPLITE_RELOAD__ = applyAll;

  (async function boot() {
    try {
      // O initialization_script roda antes da página existir, então
      // esperamos o body antes de tocar em qualquer coisa do DOM.
      const body = await until(() => document.body, 30000);
      if (!body) {
        console.error("[ZapLite] body nunca apareceu; abortando.");
        return;
      }

      montarDock();
      mountHeaderButton();
      // A1/A3: precisa estar ouvindo ANTES de o usuário clicar em qualquer
      // botão de baixar do WhatsApp — o aviso de "salvo" vem do Rust por
      // evento, e um listener registrado tarde perde o primeiro download.
      ouvirEventosDeGravacao();
      // A2: não é módulo — link que não abre é defeito, não preferência.
      instalarAberturaDeLinks();
      // P2/P3: idem. Um link `whatsapp://` tem que abrir a conversa mesmo com
      // todos os módulos desligados, então isto não passa pelo `applyAll`.
      // O rascunho vem PRIMEIRO: se esta página é o resultado da navegação que
      // nós mesmos fizemos, o texto do link já está esperando no
      // `sessionStorage` e a caixa é o único lugar para onde ele pode ir —
      // preencher, jamais enviar.
      preencherRascunhoPendente();
      instalarLinksProfundos();
      await applyAll();

      // O WhatsApp é um SPA e às vezes recria a árvore. Se o dock ou o botão
      // do cabeçalho sumirem, remonta e reaplica os módulos.
      const guard = new MutationObserver(() => {
        if (!document.getElementById("zl-dock")) {
          montarDock();
          applyAll();
        }
        if (!document.getElementById("zl-hdr")) mountHeaderButton();
      });
      guard.observe(document.body, { childList: true, subtree: true });

      // Atalho local: Ctrl+Shift+Z abre o Painel.
      window.addEventListener("keydown", (e) => {
        if (e.ctrlKey && e.shiftKey && (e.key === "Z" || e.key === "z")) {
          e.preventDefault();
          invoke("open_settings").catch(() => {});
        }
      });

      console.log(
        "[ZapLite] pronto. Ponte nativa:",
        !!window.__TAURI__,
        "| módulos ligados:",
        Object.entries(settings.modules || {})
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(", ") || "nenhum"
      );
    } catch (e) {
      console.error("[ZapLite] falha no boot:", e);
    }
  })();

})();
