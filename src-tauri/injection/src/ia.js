import { bolhasVisiveis, ehDeSaida, textoDaBolha } from "./bolhas.js";
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
export function collectVisibleMessages(limit = 200) {
  const rows = bolhasVisiveis().slice(-limit);
  return rows
    .map((r) => {
      const t = textoDaBolha(r);
      return t ? `${ehDeSaida(r) ? "Você" : "Contato"}: ${t}` : null;
    })
    .filter(Boolean)
    .join("\n");
}
