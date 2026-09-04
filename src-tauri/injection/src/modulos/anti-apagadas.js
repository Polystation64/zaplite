import { bolhasEm, bolhasVisiveis, ehApagada, idDaBolha, textoDaBolha } from "../bolhas.js";
import { reg, throttleComCauda } from "../nucleo.js";

/* 4. Anti-apagadas ------------------------------------------------------ */
// Tetos do histórico capturado. Sem eles o `_store` era um vazamento por
// construção: uma entrada por linha de mensagem que passasse pela tela, texto
// inteiro, para sempre. Medido no perfil real, é a única estrutura NOSSA que
// cresce sem parar. 600 mensagens cobrem folgadamente a rolagem que o
// WhatsApp mantém viva; o que cair fora dela não estava mais na tela.
const AD_MAX_ENTRADAS = 600;
const AD_MAX_TEXTO = 4096;   // por mensagem (uma colagem enorme não fica retida)
const AD_VARREDURA_MS = 500; // piso entre varreduras do documento inteiro
const AD_INICIAL_TENTATIVAS = 12;  // Y4: ~7s esperando a lista renderizar
const AD_INICIAL_INTERVALO = 600;


export function registrarAntiApagadas() {
  reg({
    id: "antiDelete",
    _store: new Map(),
    /** A6 — consulta pública do que foi guardado. O `_store` existia mas não
        havia como perguntar nada a ele: o texto só aparecia se a varredura
        conseguisse pendurar a tarja na hora certa. Agora o menu do botão
        direito pergunta aqui. Devolve string ou "". */
    textoGuardado(bolha) {
      const id = idDaBolha(bolha);
      return (id && this._store.get(id)) || "";
    },
    /** Pendura a tarja "(recuperada)" nesta bolha, se ainda não estiver lá. */
    revelarNaBolha(bolha, texto) {
      if (!bolha || !texto || bolha.querySelector(".zl-recovered")) return false;
      const tag = document.createElement("div");
      tag.className = "zl-recovered";
      tag.textContent = "🕵️ (recuperada) " + texto;
      bolha.appendChild(tag);
      return true;
    },
    apply() {
      if (this._hooked) return;
      this._hooked = true;
      const store = this._store;
      // Guarda com teto e ordem LRU (Map itera na ordem de inserção).
      const guarda = (id, texto) => {
        // Sem `data-id` não há como casar a recuperação depois: a versão antiga
        // gravava sob `Math.random()`, uma chave que NUNCA seria consultada —
        // retenção pura, uma entrada por linha renderizada.
        if (!id) return;
        if (store.has(id)) store.delete(id);
        store.set(id, texto.length > AD_MAX_TEXTO ? texto.slice(0, AD_MAX_TEXTO) : texto);
        while (store.size > AD_MAX_ENTRADAS) {
          store.delete(store.keys().next().value);
        }
      };
      // Captura o texto de uma linha já renderizada (usada tanto pelo
      // observer quanto pela varredura inicial do Y4). Passa pelo MESMO
      // `guarda`, então os tetos (LRU de 600, 4 KB por mensagem) valem igual.
      const capturar = (row) => {
        const txt = textoDaBolha(row);
        if (txt) guarda(idDaBolha(row), txt);
      };
      // Detecta o texto "Esta mensagem foi apagada". A varredura é do
      // DOCUMENTO INTEIRO e lê o `textContent` de cada bolha: rodá-la a cada
      // lote de mutação (o WhatsApp muta a árvore continuamente) era a maior
      // fonte de lixo do nosso lado — daí o piso de meio segundo, agora com
      // borda de saída (Y3), que preserva o objetivo de memória sem perder o
      // último lote da janela.
      const marcarApagadas = () => {
        bolhasVisiveis()
          .forEach((row) => {
            if (row.querySelector(".zl-recovered")) return;
            if (!ehApagada(row)) return;
            const id = idDaBolha(row);
            const original = id && store.get(id);
            if (original) {
              const tag = document.createElement("div");
              tag.className = "zl-recovered";
              tag.textContent = "🕵️ (recuperada) " + original;
              row.appendChild(tag);
            }
          });
      };
      const pedirVarredura = throttleComCauda(marcarApagadas, AD_VARREDURA_MS);
      this._pedirVarredura = pedirVarredura;

      // Observa nós de mensagem; ao detectar remoção do texto original,
      // reinsere a versão capturada com marcação.
      const obs = new MutationObserver((muts) => {
        for (const m of muts) {
          for (const node of m.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;
            bolhasEm(node).forEach(capturar);
          }
        }
        pedirVarredura();
      });
      obs.observe(document.body, { childList: true, subtree: true });
      this._obs = obs;

      // Y4 — varredura INICIAL. O observer só vê `addedNodes`: tudo que já
      // estava na tela quando o módulo subiu ficava sem captura. E como cada
      // reload (nível 2) e cada renavegação (nível 3) nasce com `_store`
      // vazio, sem isto o módulo ficava cego justamente depois de uma
      // recuperação, até novas mensagens renderizarem. Repete algumas vezes
      // porque o `apply()` roda assim que existe `document.body` — o SPA ainda
      // não desenhou a conversa — e para assim que encontra a primeira linha.
      let tentativa = 0;
      const varreduraInicial = () => {
        const rows = bolhasVisiveis();
        rows.forEach(capturar);
        pedirVarredura();
        if (rows.length === 0 && ++tentativa < AD_INICIAL_TENTATIVAS) {
          this._inicial = setTimeout(varreduraInicial, AD_INICIAL_INTERVALO);
        } else {
          this._inicial = null;
        }
      };
      varreduraInicial();
    },
    revert() {
      /* mantém captura ativa; só remove marcações visuais */
      document.querySelectorAll(".zl-recovered").forEach((e) => e.remove());
    },
  });
}
