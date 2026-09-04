import {
  autorDaLinha,
  chatIdDaLinha,
  horaDaLinha,
  linhaSelecionada,
  linhasDaLista,
  nomeDaLinha,
  previaDaLinha,
  rotuloIndicaNovo,
} from "../lista.js";
import { cliqueReal } from "../midia.js";
import { reg, settings } from "../nucleo.js";
import { showPanel } from "../painel.js";
import { invoke } from "../ponte.js";

/* 31. Notificações próprias com regras por contato --------------------- */
export function registrarNotificacoes() {
  reg({
    id: "smartNotify",
    _seen: new Map(), // id ESTÁVEL da conversa -> última prévia notificada
    _primed: false, // ignora a primeira varredura (senão notifica tudo ao abrir)
    _desde: 0, // V2: instante em que este módulo começou a observar
    _conhecidas: new Set(), // V2: conversas que já apareceram numa varredura anterior
    // U1(b): id da conversa -> silenciada no WhatsApp, do jeito que a última
    // observação CONFIÁVEL viu. Um sumiço momentâneo do sino (menção pendente,
    // linha ainda renderizando) não pode desfazer isto. Ver `mudoResistente`.
    _mudos: new Map(),
    _unlisten: null, // devolvido pelo listen(); sem guardar, cada ciclo somava um listener
    _reabrir: null, // Y2: timer da nova tentativa de abrir a conversa clicada
    _conferir: null, // Z1: timer da conferência "a conversa abriu mesmo?"
    _rolagemOriginal: null, // Z1: onde o usuário deixou a lista antes da varredura
    _ultimoAlvo: "", // Y2: dedupe entre o evento vivo e o pedido pendente
    _ultimoAlvoTs: 0,

    apply() {
      if (this._started) return;
      this._started = true;
      const self = this;
      // V2: marco zero da observação. Tudo que a linha datar ANTES disto é
      // não lida antiga — estava lá quando o app subiu, não chegou agora.
      this._desde = Date.now();

      // 1) Cala a notificação nativa do WhatsApp Web para não duplicar.
      try {
        const Native = window.Notification;
        function Silent() {
          return { close() {}, onclick: null, onclose: null };
        }
        Silent.permission = "granted";
        Silent.requestPermission = () => Promise.resolve("granted");
        Object.defineProperty(window, "Notification", {
          value: Silent,
          writable: true,
          configurable: true,
        });
        self._native = Native;
      } catch (e) {
        console.warn("[ZapLite] não consegui silenciar a notificação nativa", e);
      }

      // 2) Converte o avatar (blob: da página) em data: para a janela do toast conseguir exibir.
      async function avatarAsData(img) {
        try {
          if (!img || !img.src) return "";
          const r = await fetch(img.src);
          const b = await r.blob();
          if (b.size > 300000) return "";
          return await new Promise((res) => {
            const fr = new FileReader();
            fr.onload = () => res(fr.result);
            fr.onerror = () => res("");
            fr.readAsDataURL(b);
          });
        } catch (_) {
          return "";
        }
      }

      // 3) Identificador ESTÁVEL da conversa: `chatIdDaLinha`, agora em
      // `lista.js`. Saiu daqui na onda 2 porque as notas por contato, os
      // lembretes e as ações em massa precisam EXATAMENTE do mesmo id — e
      // uma segunda cópia da varredura do fiber do React divergiria no
      // primeiro cisma do WhatsApp, igual ao que já aconteceu com o seletor
      // de bolha (ver V1 em bolhas.js).

      // U1: a conversa está SILENCIADA no próprio WhatsApp?
      // Medido na lista real do usuário (69 linhas, 22 silenciadas): o sino
      // cortado aparece como `data-testid="mute-notifications-refreshed"` E
      // como `aria-label="Conversa silenciada"` na MESMA linha — os dois sinais
      // bateram nas mesmas 22 linhas, zero divergência. Os seletores do
      // WhatsApp mudam sozinhos (o "-refreshed" no nome do testid é a prova de
      // que já mudou), então aqui vai uma lista de sinais e basta UM bater.
      //
      // U1(20/08/2026) — REMEDIÇÃO no DOM real (69 linhas, 22 silenciadas). Dois
      // fatos novos, e os dois quebravam o silenciamento:
      //
      //  (1) O sino NÃO é um enfeite ao lado do contador: ele ocupa um SLOT.
      //      Caminho medido do sino, numa linha silenciada com não lidas:
      //        div[data-testid="mute-notifications-refreshed"]  (filho 0 de 2)
      //          └ span (filho 0 de 3) └ div.xhslqc4…x193iq5w (filho 1 de 2)
      //            └ div[data-testid="cell-frame-secondary"]
      //      Caminho medido do marcador de MENÇÃO, na linha que tinha menção
      //      pendente:
      //        div[data-testid="icon-mentions"][aria-label="Menção"] (filho 0 de 2)
      //          └ span (filho 0 de 3) └ div.xhslqc4…x193iq5w (filho 1 de 2)
      //            └ div[data-testid="cell-frame-secondary"]
      //      MESMO pai, MESMAS classes, MESMO índice, e o irmão nos dois casos é
      //      o `icon-unread-count`. Ou seja: menção pendente e sino disputam o
      //      mesmo lugar. Quem só procura o sino perde o silenciamento
      //      exatamente enquanto a menção estiver pendente — que é o relato
      //      "fui citado e passei a receber TUDO daquele grupo". Daí a memória
      //      por conversa em `mudoResistente()`.
      //
      //  (2) `[title*="ilenciad"]` era um buraco: `title` na linha é ATRIBUTO DE
      //      TEXTO — o nome da conversa e a PRÉVIA da mensagem moram em
      //      `span[title]`. Bastava alguém escrever "silenciada" para a linha
      //      passar por silenciada e a notificação sumir. Sinal de estado agora
      //      só conta se for ÍCONE (elemento com <svg> dentro ou sem texto
      //      próprio) — ver `sinalDeEstado()`.
      //
      // Sinais medidos do silenciado, na mesma linha e sempre juntos:
      //   data-testid="mute-notifications-refreshed"
      //   aria-label="Conversa silenciada"
      //   <svg><title>ic-notifications-off</title>
      const SINAIS_MUDO = [
        '[data-testid*="mute" i]',
        '[data-icon*="mute" i]',
        '[data-icon*="notifications-off" i]',
        '[aria-label*="ilenciad" i]', // pt/es: "Conversa silenciada" / "silenciado"
        '[aria-label*="mute" i]', // en: "muted"
      ].join(",");
      // Ícone (família `wds-ic-*`/`ic-*`) só se identifica pelo <title> do SVG,
      // que NENHUM seletor de atributo alcança. Medido: `ic-notifications-off`
      // em 22 linhas — as mesmas 22 do `mute-notifications-refreshed`.
      const RE_ICONE_MUDO = /(^|[-_])(notifications?-off|muted?|silenc)/i;

      // Um marcador de ESTADO é um ícone: ou tem <svg> dentro, ou não tem texto
      // próprio. Texto na linha é escrito por terceiro (nome e prévia vêm em
      // `span[title]`) e não pode virar sinal de estado.
      function sinalDeEstado(el) {
        try {
          if (!el) return false;
          if (el.querySelector("svg") || el.tagName.toLowerCase() === "svg") return true;
          return (el.textContent || "").trim() === "";
        } catch (_) {
          return false;
        }
      }

      function algumSinal(row, seletor, reIcone) {
        try {
          for (const el of row.querySelectorAll(seletor)) {
            if (sinalDeEstado(el)) return true;
          }
          if (reIcone) {
            for (const t of row.querySelectorAll("svg > title")) {
              if (reIcone.test((t.textContent || "").trim())) return true;
            }
          }
        } catch (_) {}
        return false;
      }

      // Estado CRU da linha: o sino está visível AGORA?
      function mudoDaLinha(row) {
        return algumSinal(row, SINAIS_MUDO, RE_ICONE_MUDO);
      }

      // A linha terminou de renderizar? A lista é virtualizada: uma linha pela
      // metade não pode ser lida como "não tem sino, logo não é silenciada".
      function linhaLegivel(row) {
        try {
          return !!(
            row.querySelector('[data-testid="cell-frame-title"]') &&
            row.querySelector('[data-testid="cell-frame-secondary"], [data-testid="cell-frame-container"]')
          );
        } catch (_) {
          return false;
        }
      }

      // U1(b) — MEMÓRIA do silenciamento, por conversa.
      // O sumiço do sino NÃO é prova de que o grupo deixou de ser silenciado:
      // menção pendente o esconde (medido acima), e a linha pode estar pela
      // metade. Então:
      //   · sino visível            → silenciada, e fica lembrado;
      //   · sem sino, linha legível E sem menção pendente → OBSERVAÇÃO POSITIVA
      //     de "não silenciada": só aqui a memória é apagada;
      //   · qualquer outro caso     → vale o que já se sabia da conversa.
      // Teto de MUDO_MEM_MAX conversas, descartando as mais antigas (o Map do
      // JS preserva ordem de inserção, então reinserir é um LRU de graça).
      const MUDO_MEM_MAX = 2000;
      function lembrarMudo(id, valor) {
        const m = self._mudos;
        if (m.has(id)) m.delete(id);
        m.set(id, valor);
        while (m.size > MUDO_MEM_MAX) m.delete(m.keys().next().value);
      }
      function mudoResistente(row, chatId) {
        const agora = mudoDaLinha(row);
        if (!chatId) return agora; // sem id não há memória possível
        if (agora) {
          lembrarMudo(chatId, true);
          return true;
        }
        if (linhaLegivel(row) && !mencaoDaLinha(row)) {
          lembrarMudo(chatId, false);
          return false;
        }
        return self._mudos.get(chatId) === true;
      }

      // V3 — RELÓGIO da linha, quando ele existir em algum lugar ESTRUTURAL.
      // O rótulo do dia ("quarta-feira", "Ontem") não traz hora, e o Rust não
      // pode inventar uma. Aqui se procura uma hora de verdade em atributos
      // (title/aria-label/datetime) do próprio bloco de data — NUNCA no texto
      // da prévia, que é escrito por terceiro (medido: uma prévia de jornal
      // trazia "🌐 Notícias ... 08:00" e viraria "hora da mensagem").
      // Medição de 16/08/2026, 69 linhas: NENHUMA linha com rótulo de dia da
      // semana tem hora em atributo nenhum. Ou seja, hoje isto devolve ""
      // e o rótulo continua saindo como está — que é o comportamento certo.
      function relogioDaLinha(row) {
        try {
          const el =
            row.querySelector('[data-testid="cell-frame-primary-detail"]') ||
            row.querySelector('[role="gridcell"][aria-colindex="2"] [data-testid*="detail"]');
          if (!el) return "";
          const fontes = [el, el.parentElement].filter(Boolean);
          for (const f of fontes) {
            for (const attr of ["title", "aria-label", "datetime"]) {
              const v = f.getAttribute && f.getAttribute(attr);
              const m = v && String(v).match(/\b(\d{1,2}):(\d{2})\b/);
              if (m && +m[1] <= 23 && +m[2] <= 59) return m[1] + ":" + m[2];
            }
          }
        } catch (_) {}
        return "";
      }

      // W4 — MARCADOR de menção na linha. Como o silenciamento (U1), vai uma
      // lista de sinais e basta um bater: os atributos do WhatsApp mudam
      // sozinhos. AVISO HONESTO: ao contrário do sino de silenciado — que foi
      // medido em 22 linhas reais — nenhuma conversa da lista tinha menção
      // pendente no momento da medição, então estes seletores NÃO foram
      // confirmados no DOM ao vivo. Por isso a menção não depende só deles: o
      // Rust também casa os apelidos do usuário contra o texto da prévia.
      //
      // MEDIDO EM 20/08/2026 — o aviso acima deixou de valer: a lista real
      // tinha UMA linha de grupo com menção pendente, e ela traz
      //   <div data-testid="icon-mentions" aria-label="Menção">
      //     <svg><title>ic-alternate-email</title>…</svg>
      //   <span data-testid="icon-unread-count" aria-label="1 mensagem não lida">
      // Note o nome do ícone: `ic-alternate-email`, que não tem "mention"
      // nenhum no meio — por isso ele entra na lista explicitamente.
      // `[title*="mencion"]` saiu pelo mesmo motivo que saiu do silenciamento:
      // `title` na linha é a prévia da mensagem, texto de terceiro.
      const SINAIS_MENCAO = [
        '[data-icon*="mention" i]',
        '[data-testid*="mention" i]',
        '[data-icon*="alternate-email" i]',
        '[aria-label*="mencion" i]', // pt: "Você foi mencionado"
        '[aria-label*="menç" i]',
        '[aria-label*="mention" i]',
      ].join(",");
      const RE_ICONE_MENCAO = /(^|[-_])(mention|alternate-email)/i;
      function mencaoDaLinha(row) {
        return algumSinal(row, SINAIS_MENCAO, RE_ICONE_MENCAO);
      }

      // 4) Varre a lista de conversas atrás de badge de não lida.
      async function scan() {
        const rows = linhasDaLista();
        if (!rows.length) return;

        for (const row of rows) {
          const sender = nomeDaLinha(row);
          if (!sender) continue;
          const chatId = chatIdDaLinha(row);

          // U1(b): a memória do silenciamento é alimentada em TODA linha de
          // TODA varredura, ANTES de qualquer `continue`. Se só rodasse no
          // caminho do toast, um grupo silenciado sem não lidas nunca entraria
          // na memória — e a primeira menção nele cairia de novo no bug, que é
          // justamente quando a memória precisa existir.
          const mudo = mudoResistente(row, chatId);

          // badge de não lidas (o WhatsApp usa aria-label com "não lida"/"unread")
          const badge = row.querySelector(
            '[aria-label*="ão lida"], [aria-label*="unread"], [aria-label*="no leído"]'
          );
          const key = chatId || sender;
          // V2: a conversa passou a ser CONHECIDA no momento em que a linha
          // dela apareceu — com ou sem badge. É esta marca que separa "estava
          // aqui quando chegamos" de "mudou enquanto olhávamos".
          const jaConhecida = self._conhecidas.has(key);
          if (!jaConhecida) {
            if (self._conhecidas.size > 5000) self._conhecidas.clear();
            self._conhecidas.add(key);
          }
          if (!badge) {
            self._seen.delete(key);
            continue;
          }

          const preview = previaDaLinha(row);
          if (!preview) continue;

          if (self._seen.get(key) === preview) continue; // já notificado
          self._seen.set(key, preview);
          if (!self._primed) continue; // primeira passada: só popula o estado

          // V2 — NOTIFICAR SÓ O QUE É NOVO DESDE QUE O APP ESTÁ OLHANDO.
          //
          // Antes: bastava "tem badge de não lida" + "a prévia mudou desde a
          // última vez que vi esta linha". Parece razoável, mas a lista do
          // WhatsApp NÃO nasce pronta: `#pane-side` existe antes das linhas
          // renderizarem, a primeira varredura roda com a lista vazia e já
          // marca `_primed = true`. Toda conversa com não lidas ANTIGAS que
          // renderizasse depois disso era "prévia nova" e virava toast — foi
          // o que o usuário viu, dois avisos de mensagens de "quarta-feira"
          // aparecendo agora. O mesmo acontecia a cada rolagem da lista
          // virtualizada e a cada renavegação (nível 3), que recomeça do zero.
          //
          // Agora a decisão precisa de uma AFIRMAÇÃO de novidade:
          //   · o rótulo da linha é um relógio de hoje posterior ao início da
          //     observação (mensagem que chegou com o app rodando); ou
          //   · não há rótulo legível, mas a conversa já era conhecida numa
          //     varredura anterior — então a prévia mudou na nossa frente.
          // Rótulo de DATA ("Ontem", "quarta-feira", "07/08/2026") é prova de
          // que a mensagem é velha: nunca notifica.
          const hora = horaDaLinha(row);
          const novo = rotuloIndicaNovo(hora, self._desde, Date.now());
          if (novo === false) continue;
          if (novo === null && !jaConhecida) continue;

          // Não notificar a conversa já aberta e em foco. A marca vem da própria
          // linha (`aria-selected`), não de comparar títulos: comparação por nome
          // deixaria um remetente calar o aviso escolhendo o texto certo.
          const isOpen = !!row.querySelector('[aria-selected="true"]');
          const skipFocused =
            settings.notify && settings.notify.skipWhenFocused !== false;
          if (skipFocused && document.hasFocus() && isOpen) continue;

          // W3 — quem falou no grupo. Primeiro pela ESTRUTURA da linha (é o
          // formato de hoje, medido no DOM real da sessão logada); só se ela
          // não devolver nada é que se tenta o formato antigo, em que a prévia
          // inteira vinha "Fulano: texto". A tentativa anterior fazia o
          // contrário e morria numa guarda que comparava `sec.innerText` com a
          // prévia — ver o comentário de `autorDaLinha`.
          let author = autorDaLinha(row);
          let body = preview;
          if (!author) {
            const m = preview.match(/^([^:]{1,28}):\s(.+)$/);
            if (m) {
              author = m[1];
              body = m[2];
            }
          }

          // Lido ANTES do await: a lista é virtualizada e a linha pode ser
          // reciclada enquanto o avatar é convertido.
          const relogio = relogioDaLinha(row); // V3: "" quando a linha não tem hora
          const grupo = /@g\.us$/.test(chatId);
          const mencao = mencaoDaLinha(row);

          const avatar = await avatarAsData(row.querySelector("img"));

          // Só fato bruto: quem aplica a regra (estilo, som, máscara de prévia,
          // silenciar) é o Rust, que lê o settings.json. Assim a lista de regras
          // — que é a lista de contatos do usuário — nunca chega à página.
          invoke("show_toast", {
            toast: {
              id: String(Date.now()) + Math.random().toString(36).slice(2, 7),
              sender,
              author,
              body,
              avatar,
              chat_id: chatId,
              muted: mudo,
              time: hora,
              clock: relogio,
              is_group: grupo,
              mention_mark: mencao,
            },
          }).catch((e) => console.warn("[ZapLite] toast", e));
        }

        if (!self._primed) self._primed = true;

        // W1(b): a lista de conversas vai para o Rust para o PAINEL poder
        // oferecer caixinhas de "silenciar" em vez de obrigar o usuário a
        // escrever uma regra por grupo. É insumo de UI: nenhuma decisão de
        // notificação depende disto (a decisão usa o `chat_id` do toast).
        // A varredura roda a cada 1,2s; reportar a lista a cada 15s basta.
        if (Date.now() - (self._ultimoReport || 0) > 15000) {
          self._ultimoReport = Date.now();
          const chats = [];
          for (const row of rows) {
            const id = chatIdDaLinha(row);
            if (!id) continue;
            chats.push({
              id,
              name: nomeDaLinha(row),
              group: /@g\.us$/.test(id),
              muted: mudoResistente(row, id),
              // M4: NÍVEL do marcador de menção. Serve só para o Rust saber que
              // a menção FOI LIDA (marcador sumiu) mesmo quando nenhuma
              // mensagem nova chegou naquele intervalo — sem isso a próxima
              // menção do mesmo grupo não seria uma subida de borda.
              mention: mencaoDaLinha(row),
            });
          }
          if (chats.length) invoke("report_chats", { chats }).catch(() => {});
        }
      }

      this._timer = setInterval(scan, 1200);
      scan();

      // 5) Clique no toast abre a conversa correspondente.
      // Resolve pelo ID da conversa. Se o id não estiver na lista (conversa
      // arquivada, lista filtrada, WhatsApp mudou a estrutura), NÃO abre nada:
      // errar aqui é abrir a conversa errada para quem manda a mensagem.
      this._linhaDoChat = function (chatId) {
        if (!chatId) return null;
        return linhasDaLista().find((r) => chatIdDaLinha(r) === chatId) || null;
      };

      // Y2 — o clique tem que sobreviver à janela em que a página não pode
      // atendê-lo. Dois buracos, um em cada ponta:
      //   * o `emit` do Tauri não tem buffer — se o clique cair durante um
      //     reload (nível 2) ou uma renavegação (nível 3), não existe listener
      //     e o evento se perde. Por isso o Rust GUARDA o pedido e a página
      //     pergunta por ele ao subir (`take_pending_chat`);
      //   * mesmo com o evento na mão, `_linhaDoChat` devolve `null` enquanto
      //     o `#pane-side` não terminou de renderizar. Por isso a tentativa é
      //     REPETIDA por alguns segundos em vez de desistir na primeira.
      // Se ainda assim não der, o usuário TEM que perceber: o toast já fechou,
      // então o aviso vai para o painel.
      const ABRIR_TENTATIVAS = 30;   // 30 x 400ms = 12s (cobre render + varredura da lista)
      const ABRIR_INTERVALO = 400;
      const REPETIDO_MS = 4000;      // mesma conversa duas vezes = um clique só
      const ESPERAR_RENDER = 3;      // tentativas antes de começar a rolar a lista

      // Z1 — POR QUE `elemento.click()` NUNCA ABRIU A CONVERSA.
      //
      // Medido no DOM real da sessão logada (16/08), quatro experimentos
      // seguidos na mesma lista, cada um mirando uma conversa diferente e
      // conferindo qual linha ficou com `aria-selected="true"` depois:
      //   `click` sozinho (o que este código fazia) .......... NÃO abriu
      //   `pointerdown`+`pointerup` .......................... NÃO abriu
      //   `mousedown` sozinho ................................ ABRIU
      //   `mousedown`+`mouseup`+`click` ...................... ABRIU
      // Ou seja: a lista do WhatsApp Web abre a conversa no **mousedown**, e
      // `HTMLElement.click()` dispara SÓ o evento `click` — por isso o clique
      // no toast fechava o toast e não abria nada, exatamente como o usuário
      // relatou. As duas tentativas reais dele ficaram no log: `achou=true`
      // seguido de `pos-clique selecionada=nenhuma`.
      //
      // Havia um segundo erro no mesmo ponto: o alvo era
      // `linha.querySelector('[role="gridcell"]')`, que devolve a PRIMEIRA
      // célula da linha — a que nem tem `aria-colindex` (medido:
      // `DIV|col=null`). O conteúdo clicável é a célula `aria-colindex="2"`.
      //
      // Vai a sequência inteira (ponteiro + mouse + click) porque é a que um
      // mouse de verdade produz: depender de um único evento é depender de um
      // detalhe interno do WhatsApp que já mudou antes.
      // A sequência em si mora em `cliqueReal` (um lugar só): o play da bolha
      // de áudio precisa exatamente da mesma, e duas cópias voltariam a
      // divergir. Aqui fica só a escolha do ALVO dentro da linha.
      function cliqueDeVerdade(linha) {
        cliqueReal(linha.querySelector('[role="gridcell"][aria-colindex="2"]') || linha);
      }

      // Qual conversa está aberta AGORA, pelo id — para conferir se o clique
      // pegou em vez de acreditar que pegou.
      this._chatAberto = function () {
        const sel = linhaSelecionada();
        return sel ? chatIdDaLinha(sel) : "";
      };

      this._abrirConversa = function (chatId, tentativa) {
        if (!chatId) return;
        const t = tentativa || 0;
        if (t === 0) {
          const agora = Date.now();
          if (self._ultimoAlvo === chatId && agora - (self._ultimoAlvoTs || 0) < REPETIDO_MS) {
            return; // o evento e o pedido pendente descrevem o MESMO clique
          }
          self._ultimoAlvo = chatId;
          self._ultimoAlvoTs = agora;
        }
        const pane = document.querySelector("#pane-side");
        if (t === 0) self._rolagemOriginal = pane ? pane.scrollTop : null;

        const linha = self._linhaDoChat(chatId);
        if (linha) {
          cliqueDeVerdade(linha);
          // Conferência: o clique ABRIU mesmo? Sem isto, uma mudança futura do
          // WhatsApp volta a falhar em silêncio — que é o defeito que estamos
          // consertando, não um detalhe.
          self._conferir = setTimeout(() => {
            const aberto = self._chatAberto();
            if (aberto === chatId) {
              // deu certo: devolve a lista para onde o usuário a deixou
              if (self._rolagemOriginal != null && pane) pane.scrollTop = self._rolagemOriginal;
              return;
            }
            console.warn("[ZapLite] cliquei na linha da conversa e ela não abriu");
            showPanel(
              "Conversa não aberta",
              "O ZapLite achou a conversa do toast na lista, clicou nela e o WhatsApp " +
                "não abriu. Isso costuma significar que a estrutura da lista mudou. " +
                "Abra a conversa manualmente e, se repetir, avise."
            );
          }, 1400);
          return;
        }

        // Z1(b) — a linha NÃO está no pedaço renderizado. A lista é
        // VIRTUALIZADA: medido na lista real do usuário, `#pane-side` tinha
        // scrollHeight 13024 para clientHeight 831 e apenas 71 linhas no DOM
        // (~181 conversas no total). Nenhum seletor acha o que não foi
        // renderizado — é preciso ROLAR para o WhatsApp montar o próximo
        // pedaço. As primeiras tentativas não rolam: cobrem o caso comum, em
        // que a página ainda está terminando de renderizar.
        if (pane && t >= ESPERAR_RENDER) {
          const antes = pane.scrollTop;
          // a varredura começa do topo, senão metade da lista nunca é olhada
          pane.scrollTop = t === ESPERAR_RENDER ? 0 : antes + Math.max(240, pane.clientHeight - 80);
          if (t > ESPERAR_RENDER && pane.scrollTop === antes) {
            // fim da lista e a conversa não apareceu: insistir só rola no vazio
            return self._desistirDeAbrir(pane);
          }
        }

        if (t + 1 < ABRIR_TENTATIVAS) {
          self._reabrir = setTimeout(
            () => self._abrirConversa(chatId, t + 1),
            ABRIR_INTERVALO
          );
          return;
        }
        self._desistirDeAbrir(pane);
      };

      // Desistência: devolve a lista para onde o usuário a deixou (rolar a
      // agenda dele e largar assim seria pior que não abrir) e avisa — o toast
      // já fechou, então o painel é o único lugar onde o aviso ainda aparece.
      this._desistirDeAbrir = function (pane) {
        if (pane && self._rolagemOriginal != null) pane.scrollTop = self._rolagemOriginal;
        self._rolagemOriginal = null;
        console.warn("[ZapLite] conversa do toast não apareceu na lista; nada aberto");
        showPanel(
          "Conversa não aberta",
          "O ZapLite não conseguiu abrir a conversa do toast que você clicou. " +
            "Ela pode estar arquivada, fora da lista filtrada, ou a página ainda " +
            "estava se recuperando. Abra a conversa manualmente."
        );
      };

      if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event
          .listen("zaplite://open-chat", (ev) => {
            const p = ev.payload || {};
            const chatId = typeof p === "string" ? "" : p.chatId;
            // consome o pedido guardado: o evento chegou vivo, ninguém precisa
            // reabrir a mesma conversa quando a página subir de novo.
            invoke("take_pending_chat").catch(() => {});
            self._abrirConversa(chatId, 0);
          })
          .then((un) => {
            // revert() pode ter rodado antes do listen resolver
            if (!self._started) un();
            else self._unlisten = un;
          })
          .catch(() => {});

        // Y2 — pedido feito enquanto esta página não existia (o clique caiu no
        // meio da recuperação). O Rust sobreviveu ao reload e ainda tem o alvo.
        invoke("take_pending_chat")
          .then((chatId) => {
            if (chatId && self._started) self._abrirConversa(chatId, 0);
          })
          .catch(() => {});
      }
    },

    revert() {
      clearInterval(this._timer);
      this._timer = null;
      // Y2: a repetição da abertura não pode sobreviver ao desligamento do
      // módulo — senão um clique velho abre conversa depois de o usuário
      // desligar as notificações.
      clearTimeout(this._reabrir);
      this._reabrir = null;
      clearTimeout(this._conferir);
      this._conferir = null;
      this._started = false;
      this._primed = false;
      this._seen.clear();
      // Sem isto, cada liga/desliga (e cada reinjeção depois de renavegação)
      // somava um listener, e um clique passava a abrir a conversa N vezes.
      if (this._unlisten) {
        try {
          this._unlisten();
        } catch (_) {}
        this._unlisten = null;
      }
      // devolve a notificação nativa
      if (this._native) {
        try {
          Object.defineProperty(window, "Notification", {
            value: this._native,
            writable: true,
            configurable: true,
          });
        } catch (_) {}
      }
      invoke("close_all_toasts").catch(() => {});
    },
  });
}
