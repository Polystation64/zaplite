import { addAct, dropAct, ensureDock } from "../dock.js";
import { nomeDaConversaAberta } from "../lista.js";
import { reg, settings } from "../nucleo.js";
import { showPanel } from "../painel.js";
import { invoke } from "../ponte.js";

/* 09. LEMBRETES -----------------------------------------------------------
   "Me lembre de responder o Fulano às 15h."

   ONDE APARECE: no sistema de notificação que já existe — `show_toast`, a
   mesma janela dos avisos de mensagem, com o botão de FIXAR (que é
   exatamente o que um lembrete quer: ficar na tela até você resolver) e o de
   lembrar depois.

   O toast do lembrete vai com `chat_id` VAZIO, e isso é decisão, não
   descuido. Duas consequências, as duas desejadas:
     · `decidir()` (notify.rs) não tem como silenciá-lo por regra nem por
       conversa silenciada — um lembrete que o usuário pediu não pode ser
       engolido por uma regra escrita para o barulho dos grupos;
     · clicar nele NÃO abre conversa nenhuma. Abrir mandaria recibo de
       leitura para o outro lado sem o usuário ter decidido ler. O nome da
       conversa vai no TEXTO do lembrete; quem abre é ele, quando quiser.

   LIMITAÇÃO HONESTA, dita na interface e no catálogo do Painel: o disparo é
   um temporizador DESTA página. Com o ZapLite fechado nada dispara, e um
   lembrete cuja hora passou com o app fechado aparece na próxima abertura,
   atrasado e marcado como atrasado. Não existe agendador no Windows por
   trás disto — dizer que existiria seria mentir sobre a única coisa que o
   usuário precisa saber antes de confiar num lembrete.

   PERSISTÊNCIA: `reminders`, no settings.json (local). Sobrevive a reiniciar.
   ------------------------------------------------------------------------ */

const ID_ACT = "zl-lembretes";
const PASSO_MS = 20000;

let pendentes = [];
let timer = null;

/* PURA e testada (`bundle.test.js`). "15h", "15:30", "8:05" → o instante do
   PRÓXIMO 15:30. Se a hora de hoje já passou, é amanhã — que é o que "às 8h"
   quer dizer quando alguém digita isso às 23h. Devolve 0 se não é hora. */
export function proximoDisparo(texto, agora) {
  const t = String(texto || "").trim().toLowerCase().replace(/\s+/g, "");
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?h?$/);
  if (!m) return 0;
  const h = +m[1];
  const min = m[2] === undefined ? 0 : +m[2];
  if (!(h >= 0 && h <= 23 && min >= 0 && min <= 59)) return 0;
  const base = new Date(agora);
  const alvo = new Date(agora);
  alvo.setHours(h, min, 0, 0);
  if (alvo.getTime() <= base.getTime()) alvo.setDate(alvo.getDate() + 1);
  return alvo.getTime();
}

/* PURA e testada. "em 20" / "20" minutos a partir de agora. 0 se não serve. */
export function daquiAMinutos(texto, agora) {
  const t = String(texto || "").trim().toLowerCase().replace(/^em\s+/, "");
  const m = t.match(/^(\d{1,4})\s*(m|min|minutos?)?$/);
  if (!m) return 0;
  const n = +m[1];
  if (!(n >= 1 && n <= 1440)) return 0;
  return agora + n * 60000;
}

const hhmm = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  const hoje = new Date().toDateString() === d.toDateString();
  return (hoje ? "" : p(d.getDate()) + "/" + p(d.getMonth() + 1) + " ") + p(d.getHours()) + ":" + p(d.getMinutes());
};

function carregar() {
  const bruto = (settings && settings.reminders) || [];
  pendentes = (Array.isArray(bruto) ? bruto : [])
    .map((r) => ({
      id: String((r && r.id) || ""),
      quando: Number((r && r.quando) || 0),
      texto: String((r && r.texto) || ""),
      conversa: String((r && r.conversa) || ""),
    }))
    .filter((r) => r.id && r.quando > 0 && r.texto);
}

async function gravar() {
  try {
    await invoke("save_module_data", { chave: "reminders", valor: pendentes });
  } catch (e) {
    showPanel(
      "O lembrete NÃO foi guardado",
      "Ele vale enquanto o app estiver aberto, mas some se você reiniciar.\n\n" + e.message
    );
  }
}

async function disparar(r, atrasado) {
  const quando = hhmm(r.quando);
  const corpo =
    r.texto +
    (r.conversa ? "\n\nConversa: " + r.conversa : "") +
    (atrasado ? "\n\n(era para " + quando + " — o app estava fechado na hora)" : "");
  try {
    await invoke("show_toast", {
      toast: {
        id: "lembrete-" + r.id,
        sender: "Lembrete do ZapLite",
        author: "",
        body: corpo,
        avatar: "",
        // vazio de propósito: ver o cabeçalho deste arquivo
        chat_id: "",
        muted: false,
        time: quando,
        clock: "",
        is_group: false,
        mention_mark: false,
      },
    });
  } catch (e) {
    // A janela de toast falhou: o lembrete ainda tem que chegar ao usuário.
    showPanel("Lembrete — " + quando, corpo + "\n\n(o aviso flutuante falhou: " + e.message + ")");
  }
}

async function conferir() {
  const agora = Date.now();
  const vencidos = pendentes.filter((r) => r.quando <= agora);
  if (!vencidos.length) return;
  pendentes = pendentes.filter((r) => r.quando > agora);
  await gravar();
  for (const r of vencidos) await disparar(r, agora - r.quando > 2 * PASSO_MS);
}

function abrir() {
  const form = document.createElement("div");
  form.className = "zl-form";

  const texto = document.createElement("input");
  texto.type = "text";
  texto.placeholder = "O que lembrar (ex.: responder o orçamento)";

  const hora = document.createElement("input");
  hora.type = "text";
  hora.placeholder = "Quando: 15h, 15:30, ou “em 20” (minutos)";

  const conversa = nomeDaConversaAberta();
  const marcar = document.createElement("label");
  const cx = document.createElement("input");
  cx.type = "checkbox";
  cx.checked = !!conversa;
  cx.disabled = !conversa;
  marcar.appendChild(cx);
  marcar.appendChild(
    document.createTextNode(
      conversa
        ? "Citar a conversa aberta (“" + conversa + "”) no texto do lembrete"
        : "Nenhuma conversa aberta para citar"
    )
  );

  const lim = document.createElement("div");
  lim.className = "zl-lim";
  lim.textContent =
    "LIMITAÇÃO: o lembrete só dispara com o ZapLite ABERTO — o relógio é desta página, não do " +
    "Windows. Se a hora passar com o app fechado, ele aparece na próxima vez que você abrir, " +
    "marcado como atrasado. O aviso não abre a conversa (abrir mandaria recibo de leitura); " +
    "ele só diz qual é.";

  form.appendChild(texto);
  form.appendChild(hora);
  form.appendChild(marcar);
  form.appendChild(lim);

  if (pendentes.length) {
    const lista = document.createElement("div");
    lista.className = "zl-lista";
    pendentes
      .slice()
      .sort((a, b) => a.quando - b.quando)
      .forEach((r) => {
        const li = document.createElement("div");
        li.className = "zl-item";
        const s = document.createElement("span");
        s.textContent = hhmm(r.quando) + " — " + r.texto;
        const x = document.createElement("button");
        x.className = "zl-x2";
        x.textContent = "cancelar";
        x.onclick = async () => {
          pendentes = pendentes.filter((o) => o.id !== r.id);
          await gravar();
          abrir();
        };
        li.appendChild(s);
        li.appendChild(x);
        lista.appendChild(li);
      });
    form.appendChild(lista);
  }

  const p = showPanel("Lembretes (" + pendentes.length + " pendente" + (pendentes.length === 1 ? "" : "s") + ")", form, [
    [
      "Criar lembrete",
      async () => {
        const oque = texto.value.trim();
        if (!oque) return showPanel("Falta o texto", "Escreva o que você quer lembrar.");
        const agora = Date.now();
        const quando = proximoDisparo(hora.value, agora) || daquiAMinutos(hora.value, agora);
        if (!quando) {
          return showPanel(
            "Não entendi o horário",
            "Escreva “15h”, “15:30” ou “em 20” (minutos). Foi digitado: “" + hora.value + "”."
          );
        }
        pendentes.push({
          id: String(agora) + Math.random().toString(36).slice(2, 7),
          quando,
          texto: oque,
          conversa: cx.checked ? conversa : "",
        });
        await gravar();
        showPanel(
          "Lembrete criado",
          "“" + oque + "” às " + hhmm(quando) + ".\n\n" +
            "Vale só com o ZapLite aberto. Fechou o app antes da hora, o aviso aparece atrasado " +
            "na próxima abertura."
        );
      },
    ],
  ]);
  setTimeout(() => texto.focus(), 0);
  return p;
}

export function registrarLembretes() {
  reg({
    id: "reminders",
    label: "Lembretes",
    apply() {
      addAct(ensureDock(), ID_ACT, "⏰", "Lembretes", "", abrir);
      carregar();
      if (timer) return;
      // O primeiro `conferir` também é o que resgata o lembrete cuja hora
      // passou com o app fechado.
      timer = setInterval(conferir, PASSO_MS);
      setTimeout(conferir, 4000);
    },
    revert() {
      dropAct(ID_ACT);
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  });
}
