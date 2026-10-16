import { analisarPrePlainText, BOLHA_MIOLO, bolhasVisiveis, compositorDaConversa, ehDeSaida, idDaBolha, jidDoIdDeMensagem } from "../bolhas.js";
import { css, dropCss, reg, settings } from "../nucleo.js";
import { carregarSonsPersonalizados, somBorracha, somOhOh, somTecla } from "../sons.js";
import { observarTela } from "../tela.js";
import { modoEfetivo, TEMAS } from "../temas.js";

/* 25. Tema: acento + estilo visual (cor, FONTE e efeito) + sons do ICQ --- */

const OHOH_INTERVALO_MS = 1500; // duas mensagens juntas = um "oh-oh" só

function cfgIcq() {
  const c = (settings.theme && settings.theme.icq) || {};
  return {
    teclas: c.teclas !== false,
    borracha: c.borracha !== false,
    ohoh: c.ohoh !== false,
    volume: Number.isFinite(Number(c.volume)) ? Number(c.volume) : 0.6,
  };
}

/** Número de não lidas que o WhatsApp põe no título: "(3) WhatsApp". */
export function naoLidasDoTitulo(titulo) {
  const m = /^\((\d+)\)/.exec(String(titulo || "").trim());
  return m ? Number(m[1]) : 0;
}

/** Momento da mensagem a partir de "13:38" + "15/08/2026" (dd/mm/aaaa, o
 * formato do `data-pre-plain-text` no WhatsApp em português). `null` se não
 * der para ler. PURA e testada. */
export function momentoDaMensagem(hora, data) {
  const h = /^(\d{1,2}):(\d{2})/.exec(String(hora || "").trim());
  const d = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(String(data || "").trim());
  if (!h || !d) return null;
  const ano = d[3].length === 2 ? 2000 + Number(d[3]) : Number(d[3]);
  const t = new Date(ano, Number(d[2]) - 1, Number(d[1]), Number(h[1]), Number(h[2])).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Chegou AGORA? Só mensagem com horário dos últimos 90 s. Abrir uma conversa
 * não lida faz o WhatsApp descer desde "mensagens não lidas" até o fim — cada
 * bolha que aparece embaixo parecia "chegada" e tocava o alerta (relato real).
 * Sem horário legível (mídia sem legenda), só depois de a conversa assentar. */
function chegouAgora(bolha, assentouEm) {
  try {
    const pre = bolha.querySelector("[data-pre-plain-text]");
    const m = analisarPrePlainText(pre && pre.getAttribute("data-pre-plain-text"));
    const t = momentoDaMensagem(m.hora, m.data);
    if (t !== null) return Date.now() - t <= 90000;
  } catch (_) {}
  return Date.now() - assentouEm > 3000;
}

/** Marca a bolha desenhada com a direção — o CSS dos temas pinta por aqui. */
function marcarBolhas() {
  for (const b of bolhasVisiveis()) {
    const miolo = b.querySelector(BOLHA_MIOLO) || b;
    const saida = ehDeSaida(b);
    miolo.classList.toggle("zl-out", saida);
    miolo.classList.toggle("zl-in", !saida);
  }
}

function desmarcarBolhas() {
  document.querySelectorAll(".zl-in, .zl-out").forEach((el) => {
    el.classList.remove("zl-in");
    el.classList.remove("zl-out");
  });
}

export function registrarTema() {
  reg({
    id: "theme",
    apply() {
      // Idempotente: o Rust chama `applyAll` ao salvar, e o tema pode ter
      // trocado. Desfaz tudo e monta de novo com o que está salvo agora.
      this.revert();
      const t = settings.theme || {};
      const accent = t.accent || "#7c3aed";
      const radius = t.radius || "14px";
      css(
        `:root{--zl-accent:${accent};--zl-radius:${radius}}
         [data-icon="status-refreshed"] , span[data-icon="status-outline"]{filter:hue-rotate(0)}
         .zl-fab{background:var(--zl-accent)!important}
         header ._ak8i, .app-wrapper-web{--wa-accent:var(--zl-accent)}`,
        "zl-theme"
      );

      const estilo = TEMAS[t.estilo];
      if (!estilo) return; // "Padrão": só o acento, como sempre foi
      // Claro/escuro: escolha do usuário, ou — no automático — o modo do
      // próprio WhatsApp, acompanhado ao vivo (a classe `dark` do <body>
      // muda quando a pessoa troca o tema nas configurações do WhatsApp).
      const aplicarModo = () => {
        const modo = modoEfetivo(t.modo, !!(document.body && document.body.classList.contains("dark")));
        if (modo === this._modo) return;
        this._modo = modo;
        css(estilo.css(modo), "zl-tema-estilo");
      };
      aplicarModo();
      if (t.modo !== "claro" && t.modo !== "escuro" && document.body) {
        this._obsModo = new MutationObserver(aplicarModo);
        this._obsModo.observe(document.body, { attributes: true, attributeFilter: ["class"] });
      }
      // Bolhas: marcar rápido (é visual), e só com a janela visível.
      this._pararMarcas = observarTela(marcarBolhas, false, 250);

      if (t.estilo === "icq") {
        this._ligarSons();
        // Arquivos de som escolhidos no Painel (só flags aqui; o caminho
        // fica no Rust e a página pede o som pelo NOME).
        carregarSonsPersonalizados((t.icq && t.icq.personalizado) || {});
      }
    },

    /* Sons do ICQ. Só ESCUTA: nenhum preventDefault, nenhuma escrita. */
    _ligarSons() {
      const self = this;
      self._tecla = (e) => {
        const caixa = compositorDaConversa();
        if (!caixa || !e.target || !caixa.contains(e.target)) return;
        if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
        const c = cfgIcq();
        if (e.key === "Backspace" || e.key === "Delete") {
          if (c.borracha) somBorracha(c.volume);
        } else if (e.key.length === 1 || e.key === "Enter") {
          if (c.teclas) somTecla(c.volume);
        }
      };
      document.addEventListener("keydown", self._tecla, true);

      // "Oh-oh": (1) mensagem nova na conversa ABERTA — o título não muda
      // quando ela está na tela; (2) o número de não lidas do título subiu —
      // mensagem em outra conversa. Os dois juntos tocam uma vez só.
      // UM som por mensagem. Com o módulo de notificações ligado, quem toca é o
      // TOAST — ele sabe se o contato tem som próprio (e aí o do contato
      // vence) e, se não tem, toca o "oh-oh". A página só toca o dela quando
      // não haverá toast: mensagem na conversa ABERTA com a janela em foco.
      const toastCuida = () => !!(settings.modules && settings.modules.smartNotify);
      let ultimo = 0;
      const ohoh = () => {
        const c = cfgIcq();
        if (!c.ohoh || Date.now() - ultimo < OHOH_INTERVALO_MS) return;
        ultimo = Date.now();
        somOhOh(c.volume);
      };
      // Chegada = a ÚLTIMA bolha da conversa é de entrada e nunca foi vista.
      // Só a última: rolar para cima carrega mensagens ANTIGAS no topo, e
      // elas não são chegada. Trocar de conversa também não (outro jid).
      const vistas = new Set();
      let jidAnterior = null;
      let assentouEm = Date.now();
      self._pararChegada = observarTela(() => {
        const bs = bolhasVisiveis();
        const ultima = bs[bs.length - 1];
        const id = ultima && idDaBolha(ultima);
        if (!id) return;
        const jid = jidDoIdDeMensagem(id) || "?";
        const mesmaConversa = jidAnterior !== null && jid === jidAnterior;
        const semToast = !toastCuida() || (document.hasFocus() && !document.hidden);
        if (!mesmaConversa) assentouEm = Date.now();
        if (mesmaConversa && !vistas.has(id) && !ehDeSaida(ultima) && semToast && chegouAgora(ultima, assentouEm)) ohoh();
        for (const b of bs) {
          const i = idDaBolha(b);
          if (i) vistas.add(i);
        }
        if (vistas.size > 5000) vistas.clear();
        jidAnterior = jid;
      }, true, 400);

      let naoLidas = naoLidasDoTitulo(document.title);
      const tituloEl = document.querySelector("title");
      if (tituloEl) {
        self._obsTitulo = new MutationObserver(() => {
          const n = naoLidasDoTitulo(document.title);
          if (n > naoLidas && !toastCuida()) ohoh();
          naoLidas = n;
        });
        self._obsTitulo.observe(tituloEl, { childList: true, characterData: true, subtree: true });
      }
    },

    revert() {
      if (this._obsModo) this._obsModo.disconnect();
      this._obsModo = null;
      this._modo = null;
      dropCss("zl-theme");
      dropCss("zl-tema-estilo");
      if (this._pararMarcas) this._pararMarcas();
      this._pararMarcas = null;
      desmarcarBolhas();
      if (this._tecla) document.removeEventListener("keydown", this._tecla, true);
      this._tecla = null;
      if (this._pararChegada) this._pararChegada();
      this._pararChegada = null;
      if (this._obsTitulo) this._obsTitulo.disconnect();
      this._obsTitulo = null;
    },
  });
}
