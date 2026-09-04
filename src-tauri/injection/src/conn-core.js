import { bolhasVisiveis, ehDeSaida } from "./bolhas.js";
import { wait } from "./nucleo.js";
import { invoke } from "./ponte.js";

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
export function connCore() {
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

}
