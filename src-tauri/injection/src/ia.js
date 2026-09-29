import { bolhasVisiveis, ehDeSaida, textoDaBolha } from "./bolhas.js";
import { settings } from "./nucleo.js";
import { invoke } from "./ponte.js";

/* IA genérica: resumo / tradução / rascunho / detector de golpe -------- */
export async function ai(system, prompt, extra) {
  return invoke("ai_complete", {
    system,
    prompt,
    imageB64: (extra && extra.image) || null,
    mediaType: (extra && extra.mediaType) || null,
  });
}
/* Orçamento em BYTES UTF-8 — é o que o `ai_complete` mede (teto de 64 KB no
   prompt inteiro). 200 mensagens de ~350 bytes (acento ocupa 2) já passavam
   do teto, e o resumo de uma conversa longa falhava com "selecione menos
   mensagens" num módulo que não tem como selecionar. Folga para o texto de
   instrução que cada chamador acrescenta. */
export const ORCAMENTO_MENSAGENS_BYTES = 56 * 1024;

/** As mensagens visíveis MAIS RECENTES que cabem em `maxBytes`. Devolve o
 * texto e quantas ficaram de fora, para quem chama poder dizer isso. */
export function coletarMensagens(limit = 200, maxBytes = ORCAMENTO_MENSAGENS_BYTES) {
  const linhas = bolhasVisiveis()
    .slice(-limit)
    .map((r) => {
      const t = textoDaBolha(r);
      return t ? `${ehDeSaida(r) ? "Você" : "Contato"}: ${t}` : null;
    })
    .filter(Boolean);
  const enc = new TextEncoder();
  const dentro = [];
  let bytes = 0;
  for (let i = linhas.length - 1; i >= 0; i--) {
    const n = enc.encode(linhas[i]).length + 1; // + a quebra de linha
    if (bytes + n > maxBytes) break;
    bytes += n;
    dentro.push(linhas[i]);
  }
  dentro.reverse();
  return { texto: dentro.join("\n"), incluidas: dentro.length, deFora: linhas.length - dentro.length };
}

export function collectVisibleMessages(limit = 200) {
  return coletarMensagens(limit).texto;
}

/* --- preferências dos módulos de IA sob demanda -----------------------
   Ficam em `settings.ia`, que é uma das CHAVES_PUBLICAS do Rust (não há
   segredo nenhum num idioma de destino). Toda leitura passa por aqui, com
   limites: o valor vem de um arquivo que o usuário edita à mão, e um
   `digestHoras: 99999` viraria um resumo do ano inteiro numa chamada só. */
export function cfgIa() {
  const c = (settings && settings.ia) || {};
  const num = (v, padrao, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : padrao;
  };
  const idioma = String(c.traduzirPara || "").trim();
  return {
    traduzirPara: idioma ? idioma.slice(0, 40) : "português do Brasil",
    digestHoras: num(c.digestHoras, 12, 1, 48),
    digestMaxConversas: num(c.digestMaxConversas, 40, 1, 200),
    digestIncluirAberta: c.digestIncluirAberta !== false,
  };
}

/* Os bytes de uma <img> da conversa em base64, que é o formato que o
   `ai_complete` espera. O WhatsApp entrega a mídia decifrada como `blob:`,
   então é um `fetch` na própria página — nada sai para a rede. */
export async function imagemEmBase64(img) {
  const src = (img && img.src) || "";
  if (!src) throw new Error("não achei os bytes desta imagem na página.");
  const blob = await (await fetch(src)).blob();
  const b64 = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1]);
    fr.onerror = () => reject(new Error("não consegui ler os bytes da imagem."));
    fr.readAsDataURL(blob);
  });
  return { b64, mediaType: blob.type || "image/jpeg" };
}
