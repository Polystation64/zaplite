/* ============================================================================
   ZapLite — ponto de entrada do bundle injetado no WhatsApp Web.

   ESTE ARQUIVO É A ORDEM DE EXECUÇÃO. Regra da casa, e a razão de ele existir:

     · todo arquivo em src/ contém SÓ DECLARAÇÕES (function / const / let) e
       nenhum efeito colateral de topo;
     · todo efeito colateral — instalar o gancho de WebSocket, registrar um
       módulo, pendurar `__ZAPLITE_RELOAD__`, subir o boot — é uma chamada
       AQUI, nesta lista, nesta ordem.

   Sem isso a ordem de execução passaria a ser a ordem em que o empacotador
   resolve os `import` — invisível, e diferente da ordem em que alguém lê o
   código. Foi uma composição implícita como essa (dois módulos corretos que,
   juntos, recarregavam a página a cada 5 min) que custou caro neste projeto.

   A ordem abaixo é a MESMA do bundle.js de antes da separação (v0.1.5), linha
   por linha: connCore, os 14 módulos na ordem original, a captura de áudio
   entre anti-apagadas e transcrever, e o boot por último. Os quatro módulos
   de IA sob demanda (tradução, OCR, golpe, resumo diário) entram no FIM da
   lista de registro, depois do menu de contexto — nenhum deles tem efeito
   fora do próprio `apply()`, então a ordem original continua intacta.
   ============================================================================ */
import { connCore } from "./conn-core.js";
import { instalarCapturaDeAudio } from "./midia.js";
import { applyAll } from "./nucleo.js";
import { boot } from "./boot.js";
import { registrarEnvioNaoSalvo } from "./modulos/envio-nao-salvo.js";
import { registrarAntiApagadas } from "./modulos/anti-apagadas.js";
import { registrarTranscrever } from "./modulos/transcrever.js";
import { registrarResumir } from "./modulos/resumir.js";
import { registrarRascunhoResposta } from "./modulos/rascunho-resposta.js";
import { registrarVelocidadeAudio } from "./modulos/velocidade-audio.js";
import { registrarSempreNoTopo } from "./modulos/sempre-no-topo.js";
import { registrarTema } from "./modulos/tema.js";
import { registrarDeclutter } from "./modulos/declutter.js";
import { registrarBlurPrivacidade } from "./modulos/blur-privacidade.js";
import { registrarNsfwBlur } from "./modulos/nsfw-blur.js";
import { registrarAutoTranscrever } from "./modulos/auto-transcrever.js";
import { registrarNotificacoes } from "./modulos/notificacoes.js";
import { registrarMenuContexto } from "./modulos/menu-contexto.js";
import { registrarTraduzir } from "./modulos/traduzir.js";
import { registrarOcr } from "./modulos/ocr.js";
import { registrarGolpe } from "./modulos/golpe.js";
import { registrarResumoDiario } from "./modulos/resumo-diario.js";
import { registrarNotas } from "./modulos/notas.js";
import { registrarRespostasRapidas } from "./modulos/respostas-rapidas.js";
import { registrarLembretes } from "./modulos/lembretes.js";
import { registrarAcoesEmMassa } from "./modulos/acoes-massa.js";
import { registrarExportar } from "./modulos/exportar.js";
import { registrarBaixarMassa } from "./modulos/baixar-massa.js";

/* 1. Camada de conexão: precisa do gancho no WebSocket ANTES de a página
      abrir o primeiro socket. É o primeiro efeito do bundle. */
connCore();

/* 2. Registro dos módulos, na ordem em que `applyAll` vai aplicá-los. */
registrarEnvioNaoSalvo();
registrarAntiApagadas();

/* 3. Captura dos bytes de áudio: Proxy em URL.createObjectURL e em
      HTMLMediaElement.play. Ficava aqui, entre anti-apagadas e transcrever. */
instalarCapturaDeAudio();

registrarTranscrever();
registrarResumir();
registrarRascunhoResposta();
registrarVelocidadeAudio();
registrarSempreNoTopo();
registrarTema();
registrarDeclutter();
registrarBlurPrivacidade();
registrarNsfwBlur();
registrarAutoTranscrever();
registrarNotificacoes();
registrarMenuContexto();

/* 2b. Os quatro módulos de IA SOB DEMANDA. Vêm DEPOIS do menu de contexto
      de propósito: o menu consulta o interruptor de cada um (`on("ocr")`,
      `on("translate")`, `on("scamDetect")`) para decidir o que oferecer, e
      a ordem de registro é a ordem em que `applyAll` os aplica. Nenhum
      deles observa nada nem varre nada: o efeito de `apply()` é uma
      entrada no dock, e toda chamada de IA nasce de um clique. */
registrarTraduzir();
registrarOcr();
registrarGolpe();
registrarResumoDiario();

/* 2c. ONDA 2 — os seis módulos LOCAIS (nenhuma chamada de IA, nenhum byte
      saindo da máquina). Vêm por último pelo mesmo motivo dos quatro de IA:
      são os mais novos, e a ordem de tudo o que já existia fica intacta.
      Nenhum deles observa a árvore inteira; ligado, cada um acrescenta uma
      entrada no dock — e, no caso das notas, um temporizador de 1,5 s que só
      pinta o indicador da conversa aberta.

      Nenhum destes seis escreve na caixa de mensagem por conta própria, e
      nenhum envia nada: a expansão de `/pix` é a única escrita, e ela nasce
      de uma tecla do usuário dentro da própria caixa. */
registrarRespostasRapidas();
registrarAcoesEmMassa();
registrarNotas();
registrarLembretes();
registrarBaixarMassa();
registrarExportar();

/* 4. O Rust chama isto ao salvar settings. */
window.__ZAPLITE_RELOAD__ = applyAll;

/* 5. Sobe. */
boot();
