import { addAct, dropAct, ensureDock } from "../dock.js";
import { reg } from "../nucleo.js";
import { showPanel } from "../painel.js";
import { invoke } from "../ponte.js";

/* 27. ATALHO GLOBAL -------------------------------------------------------
   A parte da PÁGINA. O registro de verdade é do lado Rust (`aplicar_atalhos`
   em src-tauri/src/lib.rs), porque um atalho global vive no sistema
   operacional: uma tecla apertada com o ZapLite escondido nunca chega a um
   `keydown` de página nenhuma. Era esse o defeito do "Ctrl+Shift+Z" antigo —
   ele era um `keydown` no `boot.js`, ou seja, só funcionava com a janela do
   WhatsApp já em foco. Continua existindo (é útil e não custa nada), mas agora
   há um atalho de verdade por trás dele.

   O QUE MORA AQUI: a ação "novo lembrete". Quem tem o formulário de lembrete é
   a página, então o Rust traz a janela para a frente e emite `zaplite://atalho`;
   este módulo recebe e aciona o MESMO botão do dock que o usuário clicaria.
   Acionar o botão em vez de importar `abrirLembretes` é de propósito: assim a
   ação obedece ao interruptor do módulo de lembretes — se ele estiver
   desligado, o botão não existe e o usuário recebe a explicação em vez de um
   formulário que não deveria estar ali.

   NADA daqui envia, escreve na caixa ou abre conversa. A ação "abrir a última
   não lida", que o roteiro cogitava, ficou DE FORA: abrir conversa manda
   recibo de leitura, e um atalho de teclado disparando recibo por acidente com
   a janela escondida é pior do que a comodidade que ele daria.
   ------------------------------------------------------------------------ */

const ID_ACT = "zl-atalhos";
const EVENTO = "zaplite://atalho";

/* O que cada ação vinda do Rust aciona na página: o id do botão do dock e o
   nome do módulo que o cria (para a mensagem, quando ele está desligado). */
const ACOES = {
  newReminder: { botao: "zl-lembretes", modulo: "Lembretes" },
};

let desligar = null;

function executar(acao) {
  const alvo = ACOES[acao];
  if (!alvo) {
    console.warn("[ZapLite] atalho global desconhecido:", acao);
    return;
  }
  const b = document.getElementById(alvo.botao);
  if (!b) {
    return showPanel(
      "Atalho sem destino",
      "O atalho global pediu “" + alvo.modulo + "”, mas esse módulo está desligado — então não " +
        "existe nada para abrir.\n\nLigue “" + alvo.modulo + "” no Painel, ou tire este atalho da " +
        "aba de atalhos.",
      [["Abrir o Painel", () => invoke("open_settings", { secao: "mods" }).catch(() => {})]]
    );
  }
  b.click();
}

function explicar() {
  showPanel(
    "Atalhos globais",
    "Os atalhos globais são registrados no Windows pelo ZapLite, então funcionam mesmo com a " +
      "janela escondida ou com outro programa em foco.\n\n" +
      "· Esconder / mostrar o ZapLite\n" +
      "· Abrir o Painel\n" +
      "· Novo lembrete (nasce desligado)\n\n" +
      "Quem escolhe as combinações é o Painel, na aba MÓDULOS. Lá também aparece o resultado REAL " +
      "do registro: se outro programa já tiver tomado uma combinação, o Windows recusa aquele " +
      "atalho — o ZapLite continua funcionando normalmente e diz qual falhou e por quê.\n\n" +
      "Nenhum atalho envia mensagem, escreve na caixa ou abre conversa.",
    [["Abrir o Painel", () => invoke("open_settings", { secao: "mods" }).catch((e) => showPanel("Erro", e.message))]]
  );
}

export function registrarAtalhoGlobal() {
  reg({
    id: "globalHotkey",
    label: "Atalho global",
    apply() {
      addAct(ensureDock(), ID_ACT, "⌨", "Atalhos globais", "", explicar);
      if (desligar) return;
      if (!window.__TAURI__ || !window.__TAURI__.event) return;
      window.__TAURI__.event
        .listen(EVENTO, (ev) => {
          const p = (ev && ev.payload) || {};
          executar(String(p.acao || ""));
        })
        .then((off) => {
          desligar = off;
        })
        .catch((e) => console.warn("[ZapLite] atalho global (listen):", e && e.message));
    },
    revert() {
      dropAct(ID_ACT);
      if (desligar) {
        try {
          desligar();
        } catch (_) {}
        desligar = null;
      }
    },
  });
}
