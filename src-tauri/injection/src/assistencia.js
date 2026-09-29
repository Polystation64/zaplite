import { compositorDaConversa, bolhasVisiveis, chatIdDasBolhas, textoDaBolha, ehDeSaida } from "./bolhas.js";
import { chatIdAberto, nomeDaConversaAberta } from "./lista.js";

/* De onde sai a identidade da conversa aberta, na ordem de preferência. A
   linha selecionada da lista é a fonte medida, mas a lista é virtualizada:
   conversa aberta por busca, link ou arquivo, ou lista rolada, não tem linha
   desenhada. A captura anota a FONTE e a conferência usa a mesma — trocar de
   fonte no meio (a linha apareceu) não pode virar "a conversa mudou". */
const FONTES_DA_CONVERSA = [["lista", chatIdAberto], ["bolhas", chatIdDasBolhas]];
function idDaConversa(fonte) {
  const f = FONTES_DA_CONVERSA.find(([nome]) => nome === fonte);
  return f ? f[1]() : "";
}

export function capturarDestino() {
  const box = compositorDaConversa();
  let fonte = "", jid = "";
  for (const [nome, ler] of FONTES_DA_CONVERSA) {
    jid = ler();
    if (jid) { fonte = nome; break; }
  }
  if (!box || !jid) throw new Error("Abra uma conversa identificavel antes de pedir uma resposta.");
  return {jid, fonte, nome:nomeDaConversaAberta(), box, texto:box.textContent || ""};
}
export function conferirDestino(alvo) {
  const box = compositorDaConversa();
  if (!alvo || idDaConversa(alvo.fonte) !== alvo.jid || box !== alvo.box || !box || !box.isConnected) {
    throw new Error("A conversa mudou. Nada foi inserido. Volte a pedir a resposta na conversa desejada.");
  }
  if ((box.textContent || "") !== alvo.texto || alvo.texto.trim()) {
    throw new Error("Ha texto seu na caixa ou ele mudou durante a espera. Copie a sugestao e revise manualmente; nada foi substituido.");
  }
  return box;
}
export function inserirSugestao(alvo, texto) {
  const box = conferirDestino(alvo);
  box.focus();
  conferirDestino(alvo);
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(box); range.collapse(false);
  sel.removeAllRanges(); sel.addRange(range);
  if (!document.execCommand("insertText", false, String(texto).trim())) {
    throw new Error("O editor recusou a insercao. Copie o texto para revisar manualmente.");
  }
}
export function mensagensParaSelecao(max = 60) {
  return bolhasVisiveis().slice(-max).map((b, index) => ({
    id:index+1, texto:textoDaBolha(b), autor:ehDeSaida(b) ? "Voce" : "Contato"
  })).filter(m => m.texto);
}
export function seletorDeMensagens(mensagens, escolhidas = 10) {
  const host = document.createElement("div");
  const entradas = mensagens.map((m, i) => {
    const label = document.createElement("label"); label.style.display = "block";
    const input = document.createElement("input"); input.type = "checkbox";
    input.checked = i >= mensagens.length - escolhidas;
    label.append(input, document.createTextNode(" ["+m.id+"] "+m.autor+": "+m.texto.slice(0,240)));
    host.appendChild(label); return {input,m};
  });
  return {host, ler:() => entradas.filter(x=>x.input.checked).map(x=>"["+x.m.id+"] "+x.m.autor+": "+x.m.texto).join("\n")};
}
