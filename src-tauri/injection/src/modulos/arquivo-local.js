import { bolhasVisiveis, jidDoIdDeMensagem } from "../bolhas.js";
import { chatIdAberto, nomeDaConversaAberta } from "../lista.js";
import { reg } from "../nucleo.js";
import { invoke } from "../ponte.js";
import { observarTela } from "../tela.js";
import { dadosDaBolha } from "./exportar.js";

/* 35. ARQUIVO LOCAL PARA O CLAUDE -----------------------------------------
   Guarda, na máquina, as mensagens que o WhatsApp Web JÁ DESENHOU na conversa
   aberta, para o `zaplite.exe --mcp` (Claude Desktop) consultar depois.

   PASSIVO por construção: não rola, não abre conversa, não carrega histórico
   — só lê o que está na tela, pelas mesmas funções da exportação. Rolar
   sozinho é o tipo de automação que chama atenção da sessão (ver
   exportar.js), e a sessão deste usuário já caiu antes.

   A conversa de CADA mensagem sai do `data-id` dela mesma (`false_<jid>_…`),
   não da conversa selecionada: na troca de conversa ainda há bolhas antigas na
   tela, e arquivar uma delas na conversa errada é pior que não arquivar.
   ------------------------------------------------------------------------ */

const LOTE = 300; // = MAX_MSGS_POR_CHAMADA em arquivo.rs
const LEMBRAR_MAX = 6000;
let enviados = new Set(); // ids que o Rust já aceitou nesta página

export function registroDaBolha(d) {
  if (!d || !d.id || !d.data || !d.hora) return null;
  return {
    id: d.id,
    data: d.data,
    hora: d.hora,
    autor: d.autor || "",
    deMim: !!d.saida,
    texto: d.texto || "",
    tipo: d.midia || "",
  };
}

async function capturar() {
  const aberta = chatIdAberto();
  const porConversa = new Map();
  for (const b of bolhasVisiveis()) {
    const r = registroDaBolha(dadosDaBolha(b));
    if (!r || enviados.has(r.id)) continue;
    const jid = jidDoIdDeMensagem(r.id) || aberta;
    if (!jid) continue;
    if (!porConversa.has(jid)) porConversa.set(jid, []);
    porConversa.get(jid).push(r);
  }
  for (const [jid, msgs] of porConversa) {
    // O nome do cabeçalho só vale se a lista concorda que ESTA é a conversa
    // aberta (ou se a linha dela não está desenhada). Vazio = não mexe.
    const nome = !aberta || aberta === jid ? nomeDaConversaAberta() : "";
    const conversa = { id: jid, nome, grupo: /@g\.us$/.test(jid) };
    for (let i = 0; i < msgs.length; i += LOTE) {
      const lote = msgs.slice(i, i + LOTE);
      await invoke("arquivo_registrar", { conversa, mensagens: lote });
      lote.forEach((m) => enviados.add(m.id));
    }
  }
  if (enviados.size > LEMBRAR_MAX) enviados = new Set([...enviados].slice(-LEMBRAR_MAX / 2));
}

export function registrarArquivoLocal() {
  reg({
    id: "localArchive",
    apply() {
      if (this._parar) return;
      // `background`: mensagem que chega na conversa aberta com a janela
      // minimizada também é guardada. 2 s entre rodadas basta — ninguém lê o
      // arquivo local em tempo real.
      this._parar = observarTela(async () => {
        try {
          await capturar();
        } catch (e) {
          console.warn("[ZapLite] arquivo local", e);
        }
      }, true, 2000);
    },
    revert() {
      if (this._parar) this._parar();
      this._parar = null;
    },
  });
}
