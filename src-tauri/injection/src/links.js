import { until } from "./nucleo.js";
import { invoke } from "./ponte.js";

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
export async function preencherRascunhoPendente() {
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
export function instalarLinksProfundos() {
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

export function instalarAberturaDeLinks() {
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
