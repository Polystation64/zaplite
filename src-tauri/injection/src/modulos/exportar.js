import { bolhasVisiveis, ehApagada, ehDeSaida, idDaBolha, imagemDaBolha, textoDaBolha } from "../bolhas.js";
import { addAct, dropAct, ensureDock } from "../dock.js";
import { nomeDaConversaAberta } from "../lista.js";
import { salvarArquivo } from "../midia.js";
import { reg } from "../nucleo.js";
import { showPanel } from "../painel.js";

/* 30. EXPORTAR CONVERSA ---------------------------------------------------
   Salva a conversa ABERTA em .txt ou .json, pelo mesmo diálogo de "salvar
   como" dos outros arquivos (`salvarArquivo` → `save_media`), com progresso e
   com o aviso final que já traz "abrir arquivo" e "abrir a pasta".

   LIMITAÇÃO, dita na tela ANTES de exportar e escrita dentro do próprio
   arquivo: sai o que está RENDERIZADO. O painel de mensagens do WhatsApp é
   virtualizado — as mensagens antigas nem existem no DOM até você rolar até
   elas —, e o ZapLite não rola a conversa por conta própria. Rolar sozinho
   até o começo de uma conversa de anos é justamente o tipo de automação que
   dispara carregamento em massa e chama atenção da sessão. Então o número que
   aparece no painel é o número REAL de mensagens capturadas, e ele é a
   medida honesta do que o arquivo contém.
   ------------------------------------------------------------------------ */

const ID_ACT = "zl-exportar";

/* PURA e testada (`bundle.test.js`). O WhatsApp põe em `data-pre-plain-text`
   exatamente `"[13:38, 15/08/2026] Fulano: "`. É a única fonte estruturada de
   autor e horário dentro da bolha — o resto é texto de tela. */
export function analisarPrePlainText(pre) {
  const s = String(pre || "").trim();
  const m = s.match(/^\[([^\],]+),\s*([^\]]+)\]\s*(.*?):\s*$/);
  if (!m) return { hora: "", data: "", autor: "" };
  return { hora: m[1].trim(), data: m[2].trim(), autor: m[3].trim() };
}

/* PURA e testada. Uma linha do .txt, no formato do próprio WhatsApp. */
export function linhaDeExportacao(msg) {
  const carimbo = msg.data || msg.hora ? "[" + [msg.hora, msg.data].filter(Boolean).join(", ") + "] " : "";
  const quem = msg.autor ? msg.autor + ": " : "";
  return carimbo + quem + (msg.texto || "");
}

function tipoDeMidia(bolha) {
  try {
    if (imagemDaBolha(bolha)) return "imagem";
    if (bolha.querySelector("video")) return "vídeo";
    if (bolha.querySelector('audio,[data-testid="ptt-status"],[data-icon="ptt-status"]')) return "áudio";
    if (bolha.querySelector('[data-icon="document"],[data-testid="document-thumb"]')) return "documento";
  } catch (_) {}
  return "";
}

/** As mensagens renderizadas da conversa aberta, em ordem de tela. */
export function coletarMensagens() {
  const out = [];
  for (const bolha of bolhasVisiveis()) {
    const pre = bolha.querySelector("[data-pre-plain-text]");
    const meta = analisarPrePlainText(pre && pre.getAttribute("data-pre-plain-text"));
    let texto = (textoDaBolha(bolha) || "").trim();
    const midia = tipoDeMidia(bolha);
    if (!texto && midia) texto = "<" + midia + ">";
    if (!texto && ehApagada(bolha)) texto = "<mensagem apagada>";
    if (!texto) continue;
    out.push({
      id: idDaBolha(bolha),
      hora: meta.hora,
      data: meta.data,
      autor: meta.autor || (ehDeSaida(bolha) ? "Você" : ""),
      saida: ehDeSaida(bolha),
      midia,
      texto,
    });
  }
  return out;
}

const AVISO =
  "Só o que está RENDERIZADO na tela. A lista de mensagens do WhatsApp é virtualizada e o " +
  "ZapLite não rola a conversa sozinho — role até onde quiser antes de exportar e o número " +
  "abaixo sobe. Nada é enviado a servidor nenhum: o arquivo vai direto para o disco.";

function nomeSemAcentoNemBarra(s) {
  return String(s || "conversa")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\- ]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 48) || "conversa";
}

async function exportar(formato) {
  const msgs = coletarMensagens();
  if (!msgs.length) {
    return showPanel(
      "Exportar conversa",
      "Nenhuma mensagem renderizada. Abra uma conversa e role até o trecho que você quer salvar."
    );
  }
  const nome = nomeDaConversaAberta() || "conversa";
  const cabecalho =
    "Conversa: " + nome + "\n" +
    "Exportado pelo ZapLite em " + new Date().toLocaleString() + "\n" +
    "Mensagens capturadas: " + msgs.length + "\n" +
    "LIMITE: " + AVISO + "\n" +
    "----------------------------------------------------------------------\n";

  // Sem carimbo de hora próprio: `salvarArquivo` já acrescenta data e hora ao
  // nome sugerido. Com os dois, a prova da onda 2 produziu
  // `zaplite-Gi-20260904-0925-20260904-092510.json` — dois relógios no mesmo
  // nome, e nenhum deles explicando o outro.
  const prefixo = "zaplite-" + nomeSemAcentoNemBarra(nome);
  let blob;
  if (formato === "json") {
    blob = new Blob(
      [
        JSON.stringify(
          {
            conversa: nome,
            exportadoEm: new Date().toISOString(),
            mensagensCapturadas: msgs.length,
            limitacao: AVISO,
            mensagens: msgs,
          },
          null,
          2
        ),
      ],
      { type: "application/json" }
    );
  } else {
    blob = new Blob([cabecalho + msgs.map(linhaDeExportacao).join("\n") + "\n"], {
      type: "text/plain;charset=utf-8",
    });
  }
  // `salvarArquivo` já pergunta onde, mostra progresso e termina com o aviso
  // que tem "abrir arquivo" e "abrir a pasta".
  await salvarArquivo(blob, prefixo);
}

function abrir() {
  const msgs = coletarMensagens();
  const nome = nomeDaConversaAberta();
  const form = document.createElement("div");
  form.className = "zl-form";
  const cab = document.createElement("div");
  cab.textContent = nome
    ? "Conversa aberta: " + nome + "\nMensagens renderizadas agora: " + msgs.length
    : "Nenhuma conversa aberta.";
  cab.style.whiteSpace = "pre-wrap";
  const lim = document.createElement("div");
  lim.className = "zl-lim";
  lim.textContent = AVISO;
  form.appendChild(cab);
  form.appendChild(lim);

  return showPanel("Exportar conversa", form, [
    ["Salvar .txt", () => exportar("txt")],
    ["Salvar .json", () => exportar("json")],
  ]);
}

export function registrarExportar() {
  reg({
    id: "exportChat",
    label: "Exportar conversa",
    apply() {
      addAct(ensureDock(), ID_ACT, "⭳", "Exportar conversa", "", abrir);
    },
    revert() {
      dropAct(ID_ACT);
    },
  });
}
