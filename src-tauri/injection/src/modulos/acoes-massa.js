import { addAct, dropAct, ensureDock } from "../dock.js";
import { chatIdDaLinha, limparTexto, linhasDaLista, nomeDaLinha, textoSemIcone } from "../lista.js";
import { cliqueReal } from "../midia.js";
import { reg, until, wait } from "../nucleo.js";
import { showPanel } from "../painel.js";

/* 05. AÇÕES EM MASSA (marcar não lidas, arquivar) -------------------------
   Uma ação sobre VÁRIAS conversas da lista, em vez de abrir o menu de cada
   uma na mão.

   O PONTO DELICADO, e a razão de este módulo não fazer o óbvio: qualquer
   coisa que ABRA uma conversa manda recibo de leitura para o outro lado. Ou
   seja, "marcar tudo como lido clicando em cada uma" não é uma comodidade —
   é avisar dezenas de pessoas que você leu, sem você ter decidido ler.

   Por isso as ações daqui são as que o PRÓPRIO WhatsApp oferece no menu do
   botão direito da linha, que agem sobre a conversa SEM abri-la. Nós não
   inventamos ação nenhuma: abrimos o menu nativo da linha, procuramos o item
   pelo rótulo e clicamos nele. Se o rótulo não estiver lá, a conversa é
   RELATADA como não feita — nunca "resolvida" abrindo a conversa por baixo.

   As duas primeiras (não lida, arquivar) não produzem recibo de leitura. A
   terceira (marcar como lida) produz, e por isso vem separada, com o aviso
   antes e uma confirmação a mais.
   ------------------------------------------------------------------------ */

const ID_ACT = "zl-massa";

/* Os rótulos do menu nativo, MEDIDOS no menu real da lista logada
   (04/09/2026, primeira conversa da lista, sem não lidas):

     ic-archiveArquivar conversa
     wds-ic-chatlock-outlineTrancar conversa
     ic-notifications-offSilenciar notificaçõesic-arrow-right
     wds-ic-push-pin-slashDesafixar conversa
     ic-unreadMarcar como não lida
     list-peopleMudar listaic-arrow-right
     ic-blockBloquear
     ic-do-not-disturb-onLimpar conversa
     ic-deleteApagar conversa

   Repare no que a medição pegou e o que a primeira versão errava: o
   `textContent` do item vem com o NOME DO ÍCONE colado na frente
   ("ic-archiveArquivar conversa"), porque o `<title>` do <svg> é texto. Um
   padrão ancorado em `^arquivar` NUNCA casava — e o módulo respondia "o
   WhatsApp não ofereceu Arquivar" num menu que oferecia. É o mesmo defeito que
   `textoSemIcone` (lista.js) já existia para resolver no autor da linha; usar
   o helper em vez de `textContent` é a correção, e não um padrão mais frouxo.

   `nao` é uma NEGATIVA obrigatória: sem ela, "Marcar como não lida" casaria
   com o padrão de "Marcar como lida".

   "Marcar como lida" só aparece no menu quando a conversa TEM não lidas — na
   medição acima ele estava legitimamente ausente, e o módulo relatou a
   conversa como não feita, que é o comportamento certo. */
const ACOES = [
  {
    chave: "naolida",
    rotulo: "Marcar como NÃO lida",
    re: /marcar como n[ãa]o.?lida|mark as unread/i,
    recibo: false,
    nota: "Não abre a conversa e não manda recibo de leitura.",
  },
  {
    chave: "arquivar",
    rotulo: "Arquivar",
    re: /arquivar conversa|arquivar|archive/i,
    nao: /desarquivar|unarchive/i,
    recibo: false,
    nota: "Não abre a conversa e não manda recibo de leitura. Dá para desarquivar depois.",
  },
  {
    chave: "lida",
    rotulo: "Marcar como lida",
    re: /marcar como lida|mark as read/i,
    nao: /n[ãa]o.?lida|unread/i,
    recibo: true,
    nota:
      "ATENÇÃO: marcar como lida é o mesmo que ler — o WhatsApp manda RECIBO DE LEITURA para " +
      "quem escreveu (o segundo tique fica azul, se a pessoa não desligou isso). É irreversível.",
  },
];

/** Abre o menu nativo da linha e devolve os itens que APARECERAM.
    Comparação por diferença de conjunto, e não por seletor do menu: o
    seletor do popup do WhatsApp muda de nome sozinho (ver V1 em bolhas.js),
    mas "os elementos clicáveis que não existiam antes do botão direito"
    continua verdadeiro em qualquer versão. */
async function itensDoMenu(row) {
  const alvo = row.querySelector('[role="gridcell"][aria-colindex="2"]') || row;
  const antes = new Set([...document.querySelectorAll('li,[role="button"],[role="menuitem"]')]);
  const r = alvo.getBoundingClientRect();
  alvo.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: r.left + Math.min(60, r.width / 2),
      clientY: r.top + r.height / 2,
      button: 2,
      buttons: 2,
    })
  );
  const novos = await until(
    () => {
      const v = [...document.querySelectorAll('li,[role="button"],[role="menuitem"]')].filter(
        (e) => !antes.has(e) && (e.textContent || "").trim()
      );
      return v.length ? v : null;
    },
    2000,
    50
  );
  return novos || [];
}

/** Fecha o menu nativo sem escolher nada. */
async function fecharMenu() {
  for (const t of ["keydown", "keyup"]) {
    try {
      document.dispatchEvent(
        new KeyboardEvent(t, { key: "Escape", code: "Escape", keyCode: 27, bubbles: true })
      );
    } catch (_) {}
  }
  await wait(120);
  // Escape sintético nem sempre passa: um clique num canto morto fecha.
  if (document.querySelector('[role="menuitem"]')) {
    try {
      document.body.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 2, clientY: 2 })
      );
      document.body.dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: 2, clientY: 2 })
      );
    } catch (_) {}
  }
  await wait(120);
}

/** O rótulo LEGÍVEL de um item de menu: sem o <title> dos ícones. */
export function rotuloDoItem(el) {
  return limparTexto(textoSemIcone(el));
}

function casar(itens, acao) {
  for (const el of itens) {
    const t = rotuloDoItem(el);
    if (!t || t.length > 60) continue;
    if (!acao.re.test(t)) continue;
    if (acao.nao && acao.nao.test(t)) continue;
    return { el, texto: t };
  }
  return null;
}

/** Executa `acao` nas linhas escolhidas, uma de cada vez. */
async function executar(acao, escolhidas) {
  const feitos = [];
  const faltaram = [];
  for (let i = 0; i < escolhidas.length; i++) {
    const { id, nome } = escolhidas[i];
    showPanel(
      acao.rotulo,
      "Conversa " + (i + 1) + " de " + escolhidas.length + "…\n" + nome +
        "\n\nNenhuma conversa é aberta: a ação sai pelo menu do botão direito da linha."
    );
    const row = linhasDaLista().find((r) => chatIdDaLinha(r) === id);
    if (!row) {
      faltaram.push(nome + " — a linha saiu da lista (ela é virtualizada)");
      continue;
    }
    const itens = await itensDoMenu(row);
    const item = casar(itens, acao);
    if (!item) {
      await fecharMenu();
      faltaram.push(
        nome + " — o WhatsApp não ofereceu “" + acao.rotulo + "” no menu desta conversa"
      );
      continue;
    }
    cliqueReal(item.el);
    feitos.push(nome);
    await wait(320);
  }
  showPanel(
    acao.rotulo + " — resultado",
    "Feitas: " + feitos.length + " de " + escolhidas.length +
      (feitos.length ? "\n  · " + feitos.join("\n  · ") : "") +
      (faltaram.length ? "\n\nNão deu em " + faltaram.length + ":\n  · " + faltaram.join("\n  · ") : "") +
      "\n\nNenhuma conversa foi aberta por este módulo" +
      (acao.recibo ? ", mas “marcar como lida” manda recibo de leitura por si só." : ", então nenhum recibo de leitura saiu daqui.")
  );
}

/** Só descobre: abre o menu da PRIMEIRA escolhida, lê os rótulos e fecha. */
async function conferir(escolhidas) {
  const { id, nome } = escolhidas[0];
  const row = linhasDaLista().find((r) => chatIdDaLinha(r) === id);
  if (!row) return showPanel("Conferir ações", "A linha de “" + nome + "” saiu da lista.");
  const itens = await itensDoMenu(row);
  const rotulos = itens.map(rotuloDoItem).filter((t) => t && t.length <= 60);
  await fecharMenu();
  const achadas = ACOES.map(
    (a) => (casar(itens, a) ? "  ok    " : "  FALTA ") + a.rotulo
  ).join("\n");
  showPanel(
    "Ações que o WhatsApp oferece",
    "Menu do botão direito de “" + nome + "” (aberto e fechado, nada foi clicado):\n\n" +
      (rotulos.length ? rotulos.map((t) => "  · " + t).join("\n") : "  (nenhum item apareceu)") +
      "\n\nDo que este módulo usa:\n" + achadas
  );
}

function abrir() {
  const linhas = linhasDaLista()
    .map((r) => ({ id: chatIdDaLinha(r), nome: nomeDaLinha(r) || "(sem nome)" }))
    .filter((x) => x.id);
  if (!linhas.length) {
    return showPanel("Ações em massa", "Nenhuma conversa renderizada na lista agora.");
  }

  const form = document.createElement("div");
  form.className = "zl-form";

  const aviso = document.createElement("div");
  aviso.className = "zl-lim";
  aviso.textContent =
    "Só aparecem aqui as conversas RENDERIZADAS: a lista do WhatsApp é virtualizada e o ZapLite " +
    "não a rola sozinho. Role a lista antes de abrir esta janela para alcançar mais. " +
    "Nenhuma ação daqui ABRE conversa — abrir mandaria recibo de leitura para quem escreveu.";

  const lista = document.createElement("div");
  lista.className = "zl-lista";
  const caixas = [];
  linhas.forEach((x) => {
    const l = document.createElement("label");
    const c = document.createElement("input");
    c.type = "checkbox";
    l.appendChild(c);
    l.appendChild(document.createTextNode(x.nome));
    lista.appendChild(l);
    caixas.push({ c, x });
  });

  const todas = document.createElement("label");
  const ct = document.createElement("input");
  ct.type = "checkbox";
  ct.onchange = () => caixas.forEach((k) => (k.c.checked = ct.checked));
  todas.appendChild(ct);
  todas.appendChild(document.createTextNode("marcar todas as " + linhas.length + " visíveis"));

  form.appendChild(aviso);
  form.appendChild(todas);
  form.appendChild(lista);

  const escolhidas = () => caixas.filter((k) => k.c.checked).map((k) => k.x);
  const exigir = (fn) => async () => {
    const e = escolhidas();
    if (!e.length) return showPanel("Ações em massa", "Nenhuma conversa marcada.");
    await fn(e);
  };

  const acoes = [["Conferir ações (não executa)", exigir(conferir)]];
  for (const a of ACOES) {
    acoes.push([
      a.rotulo,
      exigir(async (e) => {
        showPanel(
          "Confirmar: " + a.rotulo,
          a.nota + "\n\nConversas (" + e.length + "):\n  · " + e.map((x) => x.nome).join("\n  · ") +
            "\n\nNada acontece até você clicar no botão abaixo.",
          [[a.recibo ? "Sim, e eu aceito o recibo de leitura" : "Confirmar", () => executar(a, e)]]
        );
      }),
    ]);
  }

  return showPanel("Ações em massa (" + linhas.length + " conversas visíveis)", form, acoes);
}

export function registrarAcoesEmMassa() {
  reg({
    id: "bulkUnread",
    label: "Ações em massa",
    apply() {
      addAct(ensureDock(), ID_ACT, "☑", "Ações em massa", "", abrir);
    },
    revert() {
      dropAct(ID_ACT);
    },
  });
}
