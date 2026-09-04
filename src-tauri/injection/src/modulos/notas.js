import { chatIdAberto, chatIdDaLinha, linhasDaLista, nomeDaConversaAberta } from "../lista.js";
import { addAct, dropAct, ensureDock } from "../dock.js";
import { reg } from "../nucleo.js";
import { showPanel } from "../painel.js";
import { invoke } from "../ponte.js";

/* 08. NOTAS POR CONTATO ---------------------------------------------------
   Uma anotação privada por conversa, gravada só nesta máquina.

   CHAVE: o jid (`chatIdDaLinha`, o mesmo id que o `focus_chat` usa). Nome de
   conversa muda — a pessoa troca o "nome de exibição", o grupo é renomeado, o
   contato não está salvo e vira número — e uma nota que segue o nome vira uma
   nota sobre outra pessoa. Ainda por cima, nome é texto que qualquer remetente
   consegue reproduzir dentro de uma mensagem.

   ONDE FICA O DADO: `contactNotes`, no settings.json, do lado Rust — e de
   propósito FORA de `CHAVES_PUBLICAS`. Um caderno de anotações sobre pessoas,
   indexado por telefone, é agenda, exatamente como as regras de notificação:
   entregá-lo inteiro à página deixaria qualquer script de terceiro rodando em
   web.whatsapp.com lê-lo de uma vez. Este módulo pede UMA nota por vez
   (`note_get`) e, para o indicador da lista, só a relação de ids que TÊM nota
   (`note_ids`) — nunca o texto.

   NADA daqui escreve na caixa de mensagem nem envia coisa alguma.
   ------------------------------------------------------------------------ */

const ID_ACT = "zl-nota";
let timer = null;
let idsComNota = [];

/** Recarrega a relação de ids que têm nota. Só ids: o texto fica no Rust. */
async function recarregarIds() {
  try {
    idsComNota = (await invoke("note_ids")) || [];
  } catch (e) {
    // Falhar aqui não pode derrubar o módulo: sem a relação, o indicador
    // simplesmente não aparece, e a nota continua abrindo pelo dock.
    console.warn("[ZapLite] note_ids:", e.message);
    idsComNota = [];
  }
}

/** O botão de nota no cabeçalho da conversa aberta. Aceso = existe nota. */
function pintarCabecalho() {
  const header = document.querySelector("#main header");
  if (!header) {
    const velho = document.getElementById("zl-nota-hdr");
    if (velho) velho.remove();
    return;
  }
  let b = document.getElementById("zl-nota-hdr");
  if (!b) {
    b = document.createElement("button");
    b.id = "zl-nota-hdr";
    b.type = "button";
    b.textContent = "\u{1F4DD}";
    b.onclick = (e) => {
      e.stopPropagation();
      abrirEditor();
    };
    (header.querySelector("div:last-child") || header).appendChild(b);
  } else if (!header.contains(b)) {
    (header.querySelector("div:last-child") || header).appendChild(b);
  }
  const id = chatIdAberto();
  const tem = !!id && idsComNota.indexOf(id) >= 0;
  b.classList.toggle("tem", tem);
  b.title = tem ? "Esta conversa tem uma nota sua (clique para ver)" : "Escrever uma nota sobre esta conversa";
}

/** Ponto discreto nas linhas da lista que têm nota. */
function pintarLista() {
  for (const row of linhasDaLista()) {
    const tem = idsComNota.indexOf(chatIdDaLinha(row)) >= 0;
    const ja = row.querySelector(":scope > .zl-nota-dot");
    if (tem && !ja) {
      const d = document.createElement("span");
      d.className = "zl-nota-dot";
      d.title = "Você tem uma nota sobre esta conversa";
      // A linha do WhatsApp não é `position:relative` por padrão; sem isto o
      // ponto ancoraria no primeiro ancestral posicionado, que é a lista
      // inteira — e os 69 pontos empilhariam no mesmo canto.
      if (getComputedStyle(row).position === "static") row.style.position = "relative";
      row.appendChild(d);
    } else if (!tem && ja) {
      ja.remove();
    }
  }
}

function pintar() {
  pintarCabecalho();
  pintarLista();
}

function limparMarcas() {
  const b = document.getElementById("zl-nota-hdr");
  if (b) b.remove();
  document.querySelectorAll(".zl-nota-dot").forEach((d) => d.remove());
}

/** O editor. Um <textarea> dentro do painel que já existe. */
async function abrirEditor() {
  const id = chatIdAberto();
  if (!id) {
    return showPanel(
      "Notas por contato",
      "Nenhuma conversa aberta. Abra a conversa sobre a qual você quer anotar — a nota fica " +
        "presa ao identificador dela, não ao nome (nome muda, id não)."
    );
  }
  let texto = "";
  try {
    texto = (await invoke("note_get", { chatId: id })) || "";
  } catch (e) {
    return showPanel("Não deu para ler a nota", e.message);
  }

  const form = document.createElement("div");
  form.className = "zl-form";
  const ta = document.createElement("textarea");
  ta.value = texto;
  ta.placeholder = "O que você quer lembrar sobre esta conversa…";
  ta.spellcheck = false;
  const lim = document.createElement("div");
  lim.className = "zl-lim";
  lim.textContent =
    "Fica só nesta máquina, no settings.json, presa ao id da conversa (" +
    id +
    "). Não vai para o WhatsApp, não vira mensagem e a outra pessoa nunca fica sabendo.";
  form.appendChild(ta);
  form.appendChild(lim);

  const nome = nomeDaConversaAberta();
  const p = showPanel("Nota — " + (nome || "conversa aberta"), form, [
    [
      "Salvar",
      async () => {
        try {
          await invoke("note_set", { chatId: id, texto: ta.value });
          await recarregarIds();
          pintar();
          showPanel(
            "Nota salva",
            ta.value.trim()
              ? "Guardada nesta máquina para “" + (nome || id) + "”."
              : "A nota estava vazia, então foi apagada."
          );
        } catch (e) {
          showPanel("Não deu para salvar a nota", e.message);
        }
      },
    ],
    [
      "Apagar",
      async () => {
        try {
          await invoke("note_set", { chatId: id, texto: "" });
          await recarregarIds();
          pintar();
          showPanel("Nota apagada", "Nada mais guardado para “" + (nome || id) + "”.");
        } catch (e) {
          showPanel("Não deu para apagar a nota", e.message);
        }
      },
    ],
  ]);
  setTimeout(() => ta.focus(), 0);
  return p;
}

export function registrarNotas() {
  reg({
    id: "contactNotes",
    label: "Notas por contato",
    apply() {
      addAct(ensureDock(), ID_ACT, "\u{1F4DD}", "Nota desta conversa", "", abrirEditor);
      if (timer) return;
      recarregarIds().then(pintar);
      // 1,5 s: o suficiente para o indicador acompanhar a troca de conversa
      // sem observar a árvore inteira. A relação de ids só é relida quando o
      // usuário salva — o que muda de segundo em segundo é qual conversa está
      // aberta, não o caderno.
      timer = setInterval(pintar, 1500);
    },
    revert() {
      dropAct(ID_ACT);
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      limparMarcas();
    },
  });
}
