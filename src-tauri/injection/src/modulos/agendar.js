import { addAct, dropAct, ensureDock } from "../dock.js";
import { chatIdAberto, chatIdDaLinha, linhasDaLista, nomeDaConversaAberta } from "../lista.js";
import { cliqueReal } from "../midia.js";
import { reg, settings, wait } from "../nucleo.js";
import { showPanel } from "../painel.js";
import { invoke } from "../ponte.js";

/* 02. AGENDAR MENSAGEM ----------------------------------------------------
   A PRIMEIRA coisa neste app que manda alguma coisa sem o dedo do usuário no
   instante do envio. Todo o resto do ZapLite escreve na caixa e para ali (as
   respostas rápidas expandem `/pix` mas nunca apertam Enter; o rascunho de IA
   é aprovado antes). Aqui não dá: o valor do recurso É o envio sozinho.

   Por isso as guardas abaixo não são enfeite — são o que separa "agendar" de
   "um robô mandando mensagem no seu nome":

   1. A FILA É VISÍVEL. Uma entrada no dock mostra o quê, para quem e quando,
      com cancelar e editar antes da hora. Nada agendado fica escondido.

   2. AGENDAR É EM DOIS CLIQUES. O primeiro monta; o segundo confirma vendo o
      DESTINATÁRIO e o TEXTO INTEIRO na tela. Sem essa tela, "agendei sem
      querer para a conversa errada" seria fácil demais.

   3. O DESTINATÁRIO É SEMPRE A CONVERSA ABERTA NA HORA DE AGENDAR, e o que
      fica guardado é o `jid` (identificador estável), nunca o nome. Não
      existe campo "para quem": campo de destinatário é exatamente o lugar
      onde uma mensagem vai parar na pessoa errada.

   4. NADA DE ENVIO SILENCIOSO. Todo disparo produz (a) um aviso na mesma
      janela de toast dos lembretes e (b) uma linha no `connection.log`
      (`log_agendamento`, no Rust) — o aviso o usuário pode não ver com a
      máquina bloqueada; a linha fica.

   5. SÓ COM O APP ABERTO E CONECTADO. O relógio é desta página. Não existe
      agendador do Windows por trás disto, e a limitação está escrita na tela
      de agendar, na fila e no catálogo do Painel.

   6. HORA QUE PASSOU COM O APP FECHADO NÃO É ENVIADA POR CONTA PRÓPRIA.
      Mandar de madrugada um "chego em 10 minutos" que era para as 18h é pior
      que não mandar. Ela vira ATRASADA: aparece na fila, marcada, e quem
      decide é o usuário — enviar agora, reagendar ou descartar.

   7. FALHA É VISÍVEL, E NUNCA MANDA PARA O LUGAR ERRADO. Depois de clicar na
      linha da conversa, o disparo CONFERE que `chatIdAberto()` é o jid
      guardado. Se a linha não está renderizada, se a conversa não abriu, se a
      abriu e é outra, ou se a caixa de mensagem não foi encontrada — o envio
      é ABORTADO, o item volta para a fila marcado com o motivo, e o usuário
      vê o motivo no painel e no toast.

   8. ENSAIO. Cada item da fila tem "Ensaiar (não envia)": roda o disparo
      inteiro — abre a conversa, confere o jid, acha a caixa, escreve o texto
      — e PARA antes do botão de enviar, deixando o texto na caixa para o
      usuário conferir. É o que permite confiar no agendamento antes de a hora
      chegar, e foi por este caminho que o módulo foi verificado sem que uma
      única mensagem real saísse.

   PERSISTÊNCIA: ramo `scheduled` do settings.json (local).
   ------------------------------------------------------------------------ */

const ID_ACT = "zl-agendar";
const PASSO_MS = 15000;
/* Tolerância entre a hora marcada e o momento em que o app percebeu. Acima
   disto, o item é ATRASADO e não dispara sozinho — ver a guarda 6. Dois
   passos do relógio: cobre a máquina que dormiu alguns segundos, e não cobre
   o app que passou a noite fechado. */
const ATRASO_MAX_MS = 2 * PASSO_MS;

let fila = [];
let timer = null;
let disparando = false;

/* PURA e testada (`bundle.test.js`): "15h", "15:30", "8:05" → o instante do
   PRÓXIMO 15:30; "amanhã 9h" e "dd/mm 15:30" também. 0 se não é hora.
   Mesma gramática dos lembretes, mais a data — um agendamento costuma ser
   para outro dia, um lembrete quase nunca é. */
export function quandoAgendar(texto, agora) {
  const t = String(texto || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!t) return 0;

  // "dd/mm hh:mm" ou "dd/mm/aaaa hh:mm"
  let m = t.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s+(\d{1,2})(?::(\d{2}))?h?$/);
  if (m) {
    const [dia, mes, ano, h, min] = [+m[1], +m[2], m[3], +m[4], m[5] === undefined ? 0 : +m[5]];
    if (!(dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12 && h <= 23 && min <= 59)) return 0;
    const base = new Date(agora);
    let a = ano === undefined ? base.getFullYear() : +ano;
    if (a < 100) a += 2000;
    const alvo = new Date(a, mes - 1, dia, h, min, 0, 0);
    // Data que já passou e sem ano escrito: o usuário quis o ano que vem.
    if (alvo.getTime() <= agora && ano === undefined) alvo.setFullYear(a + 1);
    if (!(alvo.getTime() > agora)) return 0;
    // Guarda contra "31/02": o Date rola o mês e a data vira outra coisa.
    if (alvo.getDate() !== dia || alvo.getMonth() !== mes - 1) return 0;
    return alvo.getTime();
  }

  // "amanhã 9h" / "amanha 9:30"
  m = t.match(/^amanh[ãa] (\d{1,2})(?::(\d{2}))?h?$/);
  if (m) {
    const h = +m[1];
    const min = m[2] === undefined ? 0 : +m[2];
    if (!(h <= 23 && min <= 59)) return 0;
    const alvo = new Date(agora);
    alvo.setDate(alvo.getDate() + 1);
    alvo.setHours(h, min, 0, 0);
    return alvo.getTime();
  }

  // "15h" / "15:30" — hoje, ou amanhã se já passou.
  m = t.match(/^(\d{1,2})(?::(\d{2}))?h?$/);
  if (m) {
    const h = +m[1];
    const min = m[2] === undefined ? 0 : +m[2];
    if (!(h <= 23 && min <= 59)) return 0;
    const alvo = new Date(agora);
    alvo.setHours(h, min, 0, 0);
    if (alvo.getTime() <= agora) alvo.setDate(alvo.getDate() + 1);
    return alvo.getTime();
  }

  // "em 20" / "em 20 min"
  m = t.match(/^em (\d{1,4})\s*(m|min|minutos?)?$/);
  if (m) {
    const n = +m[1];
    if (!(n >= 1 && n <= 10080)) return 0; // teto: uma semana em minutos
    return agora + n * 60000;
  }
  return 0;
}

const quando = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  const hoje = new Date().toDateString() === d.toDateString();
  return (hoje ? "hoje " : p(d.getDate()) + "/" + p(d.getMonth() + 1) + " ") + p(d.getHours()) + ":" + p(d.getMinutes());
};

const resumo = (txt, n) => (txt.length > n ? txt.slice(0, n - 1) + "…" : txt);

function carregar() {
  const bruto = (settings && settings.scheduled) || [];
  fila = (Array.isArray(bruto) ? bruto : [])
    .map((r) => ({
      id: String((r && r.id) || ""),
      jid: String((r && r.jid) || ""),
      nome: String((r && r.nome) || ""),
      texto: String((r && r.texto) || ""),
      quando: Number((r && r.quando) || 0),
      // "pendente" | "atrasado" | "falhou"
      estado: String((r && r.estado) || "pendente"),
      motivo: String((r && r.motivo) || ""),
    }))
    .filter((r) => r.id && r.jid && r.texto && r.quando > 0);
}

async function gravar() {
  try {
    await invoke("save_module_data", { chave: "scheduled", valor: fila });
  } catch (e) {
    showPanel(
      "O agendamento NÃO foi guardado",
      "Ele vale enquanto o app estiver aberto, mas some se você reiniciar.\n\n" + e.message
    );
  }
}

/* A linha no connection.log. Nunca leva o texto da mensagem — o log entra em
   relatório de diagnóstico, e conteúdo de mensagem não viaja junto. */
function anotar(evento, jid) {
  invoke("log_agendamento", { evento, chatId: jid || "" }).catch(() => {});
}

async function avisar(titulo, corpo, id) {
  try {
    await invoke("show_toast", {
      toast: {
        // `chat_id` vazio, pelo mesmo motivo do lembrete: nenhuma regra de
        // conversa pode silenciar um aviso do próprio app, e clicar nele não
        // abre conversa (abrir mandaria recibo de leitura).
        id: "agendado-" + id,
        sender: titulo,
        author: "",
        body: corpo,
        avatar: "",
        chat_id: "",
        muted: false,
        time: quando(Date.now()),
        clock: "",
        is_group: false,
        mention_mark: false,
      },
    });
  } catch (_) {
    // A janela de toast falhou. O aviso ainda tem que chegar.
    showPanel(titulo, corpo);
  }
}

/* --- a caixa de mensagem da conversa ABERTA ------------------------------
   Mesma definição do módulo de respostas rápidas: a única contenteditable do
   <footer> de #main. A busca dentro da conversa vive no painel lateral, fora
   do rodapé — por isso o `closest("footer")`, e não um seletor solto. */
function caixaDeMensagem() {
  try {
    const main = document.querySelector("#main");
    if (!main) return null;
    const cx = main.querySelector('footer [contenteditable="true"]');
    return cx && cx.closest("footer") ? cx : null;
  } catch (_) {
    return null;
  }
}

function escreverNaCaixa(cx, texto) {
  cx.focus();
  const sel = window.getSelection();
  if (!sel) return false;
  const r = document.createRange();
  r.selectNodeContents(cx);
  sel.removeAllRanges();
  sel.addRange(r);
  // `insertText` é o caminho que o próprio navegador usa quando alguém digita:
  // dispara os eventos de input que o WhatsApp escuta. Escrever `textContent`
  // na mão deixa a caixa com texto e o app achando que ela está vazia.
  return document.execCommand("insertText", false, texto);
}

/* O botão de ENVIAR do rodapé da conversa aberta, ou null.
   Procurado por `aria-label`/`data-icon`, nunca por posição: o rodapé tem
   também o microfone e o clipe, e clicar no errado seria começar a gravar um
   áudio. `null` aqui é falha VISÍVEL, nunca um "clica em qualquer coisa". */
function botaoEnviar() {
  try {
    const main = document.querySelector("#main");
    const rodape = main && main.querySelector("footer");
    if (!rodape) return null;
    const porIcone = rodape.querySelector('[data-icon="send"], [data-icon="wds-ic-send-filled"]');
    if (porIcone) return porIcone.closest("button") || porIcone;
    const cands = rodape.querySelectorAll('button[aria-label], [role="button"][aria-label]');
    for (const b of cands) {
      const rot = (b.getAttribute("aria-label") || "").toLowerCase();
      if (rot === "enviar" || rot === "send") return b;
    }
    return null;
  } catch (_) {
    return null;
  }
}

/* --- O DISPARO -----------------------------------------------------------
   `ensaio = true` faz tudo menos clicar em enviar. Devolve
   `{ ok, etapa, erro }` — `etapa` é o ponto exato onde parou, e é isso que o
   usuário lê quando falha. */
async function preparar(item) {
  // 1. A linha da conversa tem que estar RENDERIZADA. A lista é virtualizada
  //    e este app não a rola sozinho (rolar a lista inteira por conta própria
  //    é o tipo de automação que chama atenção da sessão).
  const linha = linhasDaLista().find((r) => chatIdDaLinha(r) === item.jid);
  if (!linha) {
    return {
      ok: false,
      etapa: "abrir a conversa",
      erro:
        "a linha de “" + (item.nome || item.jid) + "” não está no pedaço da lista que o WhatsApp " +
        "desenhou agora. Role a lista até ela aparecer e use “Enviar agora”.",
    };
  }

  // 2. Abre pela própria linha — o mesmo clique que o usuário daria.
  cliqueReal(linha);
  let aberta = "";
  for (let i = 0; i < 30; i++) {
    await wait(100);
    aberta = chatIdAberto();
    if (aberta === item.jid) break;
  }

  // 3. A CONFERÊNCIA que impede mandar para o lugar errado. Se o que abriu
  //    não é o jid guardado, para aqui — sem exceção e sem "quase certo".
  if (aberta !== item.jid) {
    return {
      ok: false,
      etapa: "conferir a conversa aberta",
      erro:
        "cliquei na linha e a conversa aberta é outra (" + (aberta || "nenhuma") + "), não " +
        (item.nome || item.jid) + ". Nada foi escrito nem enviado.",
    };
  }

  // 4. A caixa de mensagem.
  let cx = null;
  for (let i = 0; i < 20; i++) {
    cx = caixaDeMensagem();
    if (cx) break;
    await wait(100);
  }
  if (!cx) {
    return {
      ok: false,
      etapa: "achar a caixa de mensagem",
      erro:
        "a conversa certa abriu, mas o campo de escrever não foi encontrado no rodapé " +
        "(o WhatsApp pode ter mudado a estrutura, ou a conversa é só leitura). Nada foi enviado.",
    };
  }

  // 5. Escreve. A caixa fica VISÍVEL com o texto — inclusive no ensaio, que
  //    é justamente o ponto: o usuário vê o que sairia.
  if (!escreverNaCaixa(cx, item.texto)) {
    return {
      ok: false,
      etapa: "escrever na caixa",
      erro: "não consegui escrever o texto na caixa de mensagem. Nada foi enviado.",
    };
  }
  await wait(250);
  return { ok: true, etapa: "texto na caixa", caixa: cx };
}

async function disparar(item, ensaio) {
  if (disparando) return { ok: false, etapa: "fila", erro: "outro agendamento está sendo disparado agora." };
  disparando = true;
  try {
    anotar(ensaio ? "ensaio" : "disparando", item.jid);
    const r = await preparar(item);
    if (!r.ok) return r;

    if (ensaio) {
      return {
        ok: true,
        etapa: "ensaio",
        erro: "",
        ensaio: true,
      };
    }

    const btn = botaoEnviar();
    if (!btn) {
      return {
        ok: false,
        etapa: "achar o botão de enviar",
        erro:
          "o texto está na caixa da conversa certa, mas o botão de enviar não foi encontrado. " +
          "NADA foi enviado — o texto ficou lá para você mandar (ou apagar).",
      };
    }
    cliqueReal(btn);
    return { ok: true, etapa: "enviado", erro: "" };
  } finally {
    disparando = false;
  }
}

/* --- o relógio ----------------------------------------------------------- */
async function conferir() {
  const agora = Date.now();
  const vencidos = fila.filter((r) => r.estado === "pendente" && r.quando <= agora);
  if (!vencidos.length) return;

  let mudou = false;
  for (const item of vencidos) {
    // Guarda 6: hora que passou com o app fechado NÃO é enviada sozinha.
    if (agora - item.quando > ATRASO_MAX_MS) {
      item.estado = "atrasado";
      item.motivo =
        "a hora (" + quando(item.quando) + ") passou com o ZapLite fechado ou dormindo. " +
        "Nada foi enviado: quem decide é você.";
      mudou = true;
      anotar("atrasado", item.jid);
      await avisar(
        "Agendamento ficou para trás",
        "“" + resumo(item.texto, 90) + "”\nPara: " + (item.nome || item.jid) + "\n" + item.motivo,
        item.id
      );
      continue;
    }

    const r = await disparar(item, false);
    if (r.ok) {
      fila = fila.filter((o) => o.id !== item.id);
      mudou = true;
      anotar("enviado", item.jid);
      await avisar(
        "Mensagem agendada ENVIADA",
        "Para: " + (item.nome || item.jid) + "\n“" + resumo(item.texto, 140) + "”\n" +
          "Enviada agora pelo ZapLite, conforme você agendou para " + quando(item.quando) + ".",
        item.id
      );
    } else {
      item.estado = "falhou";
      item.motivo = "parou em “" + r.etapa + "”: " + r.erro;
      mudou = true;
      anotar("falhou", item.jid);
      await avisar(
        "Agendamento NÃO foi enviado",
        "Para: " + (item.nome || item.jid) + "\n" + item.motivo,
        item.id
      );
    }
  }
  if (mudou) await gravar();
}

/* --- a fila visível ------------------------------------------------------ */
function linhaDaFila(item, redesenhar) {
  const li = document.createElement("div");
  li.className = "zl-item";
  li.style.alignItems = "flex-start";
  li.style.flexWrap = "wrap";

  const s = document.createElement("span");
  const marca = item.estado === "pendente" ? "" : item.estado === "atrasado" ? "⚠ ATRASADO — " : "✖ FALHOU — ";
  s.textContent = marca + quando(item.quando) + " → " + (item.nome || item.jid) + ": “" + resumo(item.texto, 60) + "”";
  li.appendChild(s);

  const botao = (rotulo, fn) => {
    const b = document.createElement("button");
    b.className = "zl-x2";
    b.textContent = rotulo;
    b.onclick = fn;
    return b;
  };

  li.appendChild(
    botao("ensaiar (não envia)", async () => {
      const r = await disparar(item, true);
      showPanel(
        r.ok ? "Ensaio: chegou até a caixa de mensagem" : "Ensaio: parou em “" + r.etapa + "”",
        r.ok
          ? "A conversa de " + (item.nome || item.jid) + " está aberta e o texto está na caixa " +
            "de mensagem — e PAROU AÍ. Nada foi enviado.\n\n" +
            "Confira se é a conversa e o texto certos. Para descartar, apague o texto da caixa " +
            "(ele não some sozinho: mexer na caixa por conta própria depois do ensaio seria " +
            "escrever na tela sem você pedir).\n\n" +
            "Na hora marcada, o passo seguinte é clicar em enviar."
          : r.erro
      );
    })
  );

  if (item.estado !== "pendente") {
    li.appendChild(
      botao("enviar agora", async () => {
        const r = await disparar(item, false);
        if (r.ok) {
          fila = fila.filter((o) => o.id !== item.id);
          anotar("enviado", item.jid);
          await gravar();
          showPanel("Enviada", "A mensagem foi enviada para " + (item.nome || item.jid) + ".");
        } else {
          item.motivo = "parou em “" + r.etapa + "”: " + r.erro;
          await gravar();
          showPanel("Não deu para enviar", item.motivo);
        }
        redesenhar();
      })
    );
    li.appendChild(
      botao("reagendar", async () => {
        const novo = prompt(
          "Nova hora para “" + resumo(item.texto, 40) + "”\n\n" +
            "Formatos: 15h · 15:30 · amanhã 9h · 25/12 20:00 · em 30 (minutos)",
          ""
        );
        if (novo === null) return;
        const t = quandoAgendar(novo, Date.now());
        if (!t) return showPanel("Não entendi o horário", "Foi digitado: “" + novo + "”.");
        item.quando = t;
        item.estado = "pendente";
        item.motivo = "";
        await gravar();
        redesenhar();
      })
    );
  }

  li.appendChild(
    botao("cancelar", async () => {
      fila = fila.filter((o) => o.id !== item.id);
      anotar("cancelado", item.jid);
      await gravar();
      redesenhar();
    })
  );

  if (item.motivo) {
    const m = document.createElement("div");
    m.className = "zl-lim";
    m.style.flexBasis = "100%";
    m.textContent = item.motivo;
    li.appendChild(m);
  }
  return li;
}

function abrirFila() {
  const form = document.createElement("div");
  form.className = "zl-form";

  const jid = chatIdAberto();
  const nome = nomeDaConversaAberta();

  const texto = document.createElement("textarea");
  texto.placeholder = jid
    ? "A mensagem que vai ser enviada para “" + nome + "”"
    : "Abra a conversa de destino primeiro";
  texto.disabled = !jid;

  const hora = document.createElement("input");
  hora.type = "text";
  hora.placeholder = "Quando: 15h · 15:30 · amanhã 9h · 25/12 20:00 · em 30 (minutos)";
  hora.disabled = !jid;

  const destino = document.createElement("div");
  destino.className = "zl-lim";
  destino.textContent = jid
    ? "Destinatário: " + nome + " (" + jid + ") — a conversa ABERTA agora. Não existe campo “para " +
      "quem”: o destino é sempre a conversa que está na sua frente, e o que fica guardado é o " +
      "identificador dela, não o nome."
    : "Nenhuma conversa aberta. Abra a conversa para quem a mensagem deve ir e volte aqui.";

  const lim = document.createElement("div");
  lim.className = "zl-lim";
  lim.textContent =
    "COMO ISTO FUNCIONA, sem letra miúda: o ZapLite vai ABRIR a conversa, escrever o texto e " +
    "CLICAR EM ENVIAR sozinho, na hora marcada. Só acontece com o app ABERTO e conectado — o " +
    "relógio é desta página, não do Windows. Se a hora passar com o app fechado, a mensagem NÃO " +
    "é enviada atrasada por conta própria: ela aparece aqui marcada como atrasada e quem decide " +
    "é você. Se a conversa não puder ser aberta ou o campo não for encontrado, o envio é " +
    "abortado e você é avisado — nunca vai para outra conversa. Todo disparo deixa aviso na tela " +
    "e linha no connection.log.";

  form.appendChild(destino);
  form.appendChild(texto);
  form.appendChild(hora);
  form.appendChild(lim);

  if (fila.length) {
    const t = document.createElement("div");
    t.className = "zl-lim";
    t.textContent = "NA FILA (" + fila.length + "):";
    form.appendChild(t);
    const lista = document.createElement("div");
    lista.className = "zl-lista";
    fila
      .slice()
      .sort((a, b) => a.quando - b.quando)
      .forEach((r) => lista.appendChild(linhaDaFila(r, abrirFila)));
    form.appendChild(lista);
  }

  const acoes = [];
  if (jid) {
    acoes.push([
      "Agendar…",
      () => {
        const oque = texto.value.trim();
        if (!oque) return showPanel("Falta o texto", "Escreva a mensagem que deve ser enviada.");
        const agora = Date.now();
        const t = quandoAgendar(hora.value, agora);
        if (!t) {
          return showPanel(
            "Não entendi o horário",
            "Use “15h”, “15:30”, “amanhã 9h”, “25/12 20:00” ou “em 30” (minutos).\n" +
              "Foi digitado: “" + hora.value + "”."
          );
        }
        // A TELA DE CONFIRMAÇÃO — guarda 2. O texto inteiro, o destinatário e
        // a hora, antes de qualquer coisa entrar na fila.
        const conf = document.createElement("div");
        conf.className = "zl-form";
        const p1 = document.createElement("div");
        p1.textContent = "PARA: " + nome + "  (" + jid + ")";
        const p2 = document.createElement("div");
        p2.textContent = "QUANDO: " + quando(t);
        const p3 = document.createElement("div");
        p3.style.whiteSpace = "pre-wrap";
        p3.style.borderLeft = "3px solid var(--zl-accent,#22d3aa)";
        p3.style.padding = "4px 0 4px 8px";
        p3.textContent = oque;
        const p4 = document.createElement("div");
        p4.className = "zl-lim";
        p4.textContent =
          "Ao confirmar, o ZapLite vai enviar este texto para esta conversa, sozinho, nesta hora — " +
          "desde que esteja aberto e conectado. Você pode cancelar ou editar até lá, pela fila.";
        conf.appendChild(p1);
        conf.appendChild(p2);
        conf.appendChild(p3);
        conf.appendChild(p4);
        showPanel("Confirmar agendamento", conf, [
          [
            "Confirmar e agendar",
            async () => {
              fila.push({
                id: String(agora) + Math.random().toString(36).slice(2, 7),
                jid,
                nome,
                texto: oque,
                quando: t,
                estado: "pendente",
                motivo: "",
              });
              await gravar();
              anotar("agendado", jid);
              abrirFila();
            },
          ],
          ["Voltar", () => abrirFila()],
        ]);
      },
    ]);
  }

  const p = showPanel(
    "Agendar mensagem — " + fila.length + " na fila",
    form,
    acoes
  );
  if (jid) setTimeout(() => texto.focus(), 0);
  return p;
}

export function registrarAgendar() {
  reg({
    id: "scheduleSend",
    label: "Agendar mensagem",
    apply() {
      addAct(ensureDock(), ID_ACT, "🕒", "Agendar mensagem", "", abrirFila);
      carregar();
      if (timer) return;
      timer = setInterval(conferir, PASSO_MS);
      // O primeiro `conferir` é também o que resgata — como ATRASADO, nunca
      // enviando — o que venceu com o app fechado.
      setTimeout(conferir, 6000);
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
