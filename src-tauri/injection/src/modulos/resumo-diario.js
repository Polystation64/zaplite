import { addAct, dropAct, ensureDock } from "../dock.js";
import { ai, cfgIa, collectVisibleMessages } from "../ia.js";
import {
  autorDaLinha,
  horaDaLinha,
  linhaSelecionada,
  linhasDaLista,
  nomeDaLinha,
  previaDaLinha,
  rotuloIndicaNovo,
} from "../lista.js";
import { reg } from "../nucleo.js";
import { showPanel } from "../painel.js";

/* 17. Resumo diário ---------------------------------------------------
   "O que rolou hoje", num painel. É o mais caro dos quatro, e por isso o
   único com uma tela de escopo ANTES da chamada.

   DE ONDE SAEM AS MENSAGENS — e esta é a decisão que define o módulo.
   O WhatsApp Web renderiza UMA conversa por vez. Juntar o histórico de
   vários grupos exigiria ABRIR cada conversa, e abrir conversa tem efeito
   colateral no mundo real: marca como lida e manda recibo de leitura para o
   outro lado. Um resumo não pode avisar 30 pessoas de que você leu. Então o
   escopo é o que já está na tela, sem clicar em nada:

     · a LISTA de conversas (#pane-side): nome, quem falou por último e a
       prévia da última mensagem, para as conversas cujo rótulo é um relógio
       dentro da janela configurada. Rótulo de data ("Ontem", "quarta-feira")
       é prova de que a conversa não teve movimento hoje e nunca entra;
     · a conversa ABERTA, se houver: aí sim as mensagens visíveis inteiras,
       pelo mesmo `collectVisibleMessages` do resumo de conversa.

   Limite honesto que o painel diz em voz alta: a lista é VIRTUALIZADA — só
   existe no DOM o pedaço renderizado. Este módulo não rola a lista para
   buscar mais (rolar a lista do usuário sozinho é mexer na tela dele), então
   ele resume o que está carregado, e diz quantas linhas eram.

   CUSTO: UMA chamada, e só depois do segundo clique. O primeiro clique
   monta o escopo e NÃO fala com modelo nenhum: mostra quantas conversas e
   quantas mensagens entraram, e um botão para ver o texto exato que seria
   enviado, palavra por palavra, antes de decidir. */
const PREVIA_MAX = 160;
const ABERTA_MAX = 4000;

/** Monta o escopo — LOCAL, sem chamada nenhuma. Devolve o que entrou, o que
    ficou de fora e o texto exato que seria enviado. */
export function montarEscopo() {
  const cfg = cfgIa();
  const agora = Date.now();
  const desde = agora - cfg.digestHoras * 3600 * 1000;
  const todas = linhasDaLista();

  const dentro = [];
  for (const row of todas) {
    const nome = nomeDaLinha(row);
    if (!nome) continue; // linha ainda renderizando
    // `true` só para rótulo de RELÓGIO dentro da janela. Data → false.
    if (rotuloIndicaNovo(horaDaLinha(row), desde, agora) !== true) continue;
    const previa = previaDaLinha(row);
    if (!previa) continue;
    const autor = autorDaLinha(row);
    dentro.push({
      nome,
      hora: horaDaLinha(row),
      autor,
      previa: previa.slice(0, PREVIA_MAX),
    });
    if (dentro.length >= cfg.digestMaxConversas) break;
  }

  let aberta = null;
  if (cfg.digestIncluirAberta) {
    const texto = collectVisibleMessages();
    if (texto) {
      const linha = linhaSelecionada();
      aberta = {
        nome: (linha && nomeDaLinha(linha)) || "conversa aberta",
        texto: texto.length > ABERTA_MAX ? texto.slice(-ABERTA_MAX) : texto,
        mensagens: texto.split("\n").length,
        cortado: texto.length > ABERTA_MAX,
      };
    }
  }

  const partes = [];
  if (dentro.length) {
    partes.push(
      "ÚLTIMA MENSAGEM DE CADA CONVERSA COM MOVIMENTO NAS ÚLTIMAS " +
        cfg.digestHoras +
        "H (só a prévia que a lista mostra):"
    );
    dentro.forEach((c) => {
      partes.push(
        "- [" + (c.hora || "?") + "] " + c.nome + ": " + (c.autor ? c.autor + " — " : "") + c.previa
      );
    });
  }
  if (aberta) {
    partes.push("");
    partes.push(
      "CONVERSA ABERTA (" + aberta.nome + ") — mensagens visíveis" + (aberta.cortado ? ", cortadas nas mais recentes" : "") + ":"
    );
    partes.push(aberta.texto);
  }

  return {
    horas: cfg.digestHoras,
    linhasCarregadas: todas.length,
    conversas: dentro,
    aberta,
    limite: cfg.digestMaxConversas,
    payload: partes.join("\n"),
  };
}

/** O resumo dessas conversas. UMA chamada. */
export async function resumirEscopo(escopo) {
  return await ai(
    "Você resume, em português do Brasil, o movimento do dia no WhatsApp de alguém. " +
      "Escreva no máximo 10 linhas, agrupadas por conversa, começando pelo que parece " +
      "pedir resposta. Destaque perguntas em aberto, combinados e prazos. " +
      "Você recebe, na maior parte, apenas a PRÉVIA da última mensagem de cada conversa: " +
      "não invente o que não está escrito e diga 'sem contexto' quando a prévia não " +
      "permitir concluir nada.",
    "Resuma o dia:\n\n" + escopo.payload
  );
}

function textoDoEscopo(e) {
  const l = [];
  l.push("Janela: últimas " + e.horas + " h.");
  l.push(
    "Conversas com movimento na janela: " +
      e.conversas.length +
      (e.conversas.length >= e.limite ? " (teto de " + e.limite + " atingido)" : "")
  );
  l.push(
    "Linhas carregadas na lista agora: " +
      e.linhasCarregadas +
      " — a lista do WhatsApp é virtualizada e o ZapLite não a rola sozinho, então " +
      "conversas ainda não renderizadas ficam de fora."
  );
  l.push(
    e.aberta
      ? "Conversa aberta: " + e.aberta.nome + " (" + e.aberta.mensagens + " mensagens visíveis)"
      : "Conversa aberta: nenhuma (ou sem mensagens visíveis)."
  );
  l.push("");
  if (!e.conversas.length && !e.aberta) {
    l.push("Não há nada para resumir: nenhuma conversa carregada tem rótulo de hora dentro da janela.");
    return l.join("\n");
  }
  l.push("Entram no resumo:");
  e.conversas.forEach((c) => l.push("  · " + c.nome + "  [" + (c.hora || "?") + "]"));
  l.push("");
  l.push("Nada foi enviado a modelo nenhum ainda. São " + e.payload.length + " caracteres, UMA chamada.");
  return l.join("\n");
}

export function registrarResumoDiario() {
  reg({
    id: "dailyDigest",
    apply() {
      addAct(ensureDock(), "zl-digest", "🗓", "Resumo do dia", "", () => {
        let e;
        try {
          e = montarEscopo();
        } catch (err) {
          return showPanel("Resumo do dia", "Falhou ao montar o escopo: " + ((err && err.message) || err));
        }
        const acoes = [];
        if (e.conversas.length || e.aberta) {
          acoes.push([
            "Ver o texto exato",
            () => showPanel("Resumo do dia — o que seria enviado", e.payload, [
              ["Voltar", () => showPanel("Resumo do dia", textoDoEscopo(e), acoes)],
            ]),
          ]);
          acoes.push([
            "Resumir (1 chamada)",
            async () => {
              showPanel("Resumo do dia", "Resumindo " + e.conversas.length + " conversas…");
              try {
                showPanel("Resumo do dia", await resumirEscopo(e));
              } catch (err) {
                showPanel("Resumo do dia", "Falhou: " + ((err && err.message) || err));
              }
            },
          ]);
        }
        showPanel("Resumo do dia", textoDoEscopo(e), acoes);
      });
    },
    revert() {
      dropAct("zl-digest");
    },
  });
}
