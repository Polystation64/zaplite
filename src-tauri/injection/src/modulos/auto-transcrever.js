import { BOLHA_MIOLO, bolhasVisiveis, ehDeSaida, idDaBolha } from "../bolhas.js";
import { ehBolhaDeAudio, mostrarTranscricaoNaBolha, segundosDaBolha, transcreverBolha } from "../midia.js";
import { reg, settings } from "../nucleo.js";
import { avisarInstalacaoDaTranscricao, ehFaltaDeInstalacao } from "../painel.js";

/* 34. Transcrever automaticamente o áudio que chegar -------------------
   O que é fácil errar aqui, e como cada coisa está resolvida:
   · CPU: whisper é um processo por vez. Fila de um, nunca em paralelo.
   · Repetição: cada mensagem só é transcrita uma vez (id estável da bolha)
     e a presença da tarja também conta como "já feito".
   · Áudio longo: descartado ANTES de mandar a página reproduzir, pelo
     rótulo de duração que ela já desenha (`settings.transcricao.autoMaxSeg`).
   · Travar a interface: nada de laço síncrono — varredura a cada 2,5s e uma
     transcrição de cada vez, tudo em `await`.
   · Whisper ausente: o módulo se desliga na PRIMEIRA falha de instalação e
     avisa uma vez, com botão para o instalador (A7). Nunca fica em laço.
   · Histórico: ao abrir/trocar de conversa, o que JÁ estava na tela é
     marcado como visto sem transcrever. Obter os bytes exige mandar a página
     reproduzir, e reproduzir manda o recibo de "ouvida" — varrer um
     histórico inteiro marcaria dezenas de mensagens antigas como ouvidas.
     Só vale para o que chegar com a conversa aberta. */
const AT_VARREDURA_MS = 2500;
const AT_MAX_SEG_PADRAO = 180;
export function registrarAutoTranscrever() {
  reg({
    id: "autoTranscribe",
    _feitos: new Set(),
    apply() {
      if (this._timer) return;
      const self = this;
      self._fila = [];
      self._ocupado = false;
      self._desligado = false;
      self._conversa = null;

      const limite = () => {
        const v = Number((settings.transcricao && settings.transcricao.autoMaxSeg) || 0);
        return v > 0 ? v : AT_MAX_SEG_PADRAO;
      };
      const chaveDaConversa = () => {
        const t = document.querySelector("#main header span[title]");
        return (t && (t.getAttribute("title") || t.textContent)) || "";
      };
      const marcarFeito = (b) => {
        const id = idDaBolha(b);
        if (id) self._feitos.add(id);
      };
      const jaFeito = (b) => {
        const id = idDaBolha(b);
        if (id && self._feitos.has(id)) return true;
        return !!b.querySelector(".zl-tr-txt");
      };

      const varrer = () => {
        if (self._desligado) return;
        const chave = chaveDaConversa();
        if (!chave) return;
        const audios = bolhasVisiveis().filter((b) => ehBolhaDeAudio(b) && !ehDeSaida(b));
        if (chave !== self._conversa) {
          // Primeira vez nesta conversa: tudo que já está na tela é histórico.
          self._conversa = chave;
          audios.forEach(marcarFeito);
          return;
        }
        audios.forEach((b) => {
          if (jaFeito(b)) return;
          if (self._fila.indexOf(b) >= 0) return;
          const seg = segundosDaBolha(b);
          if (seg && seg > limite()) {
            marcarFeito(b);
            console.log("[ZapLite] áudio de " + seg + "s acima do limite: transcrição automática pulada.");
            return;
          }
          self._fila.push(b);
        });
        bombear();
      };

      const bombear = async () => {
        if (self._ocupado || self._desligado) return;
        const bolha = self._fila.shift();
        if (!bolha) return;
        if (!document.body.contains(bolha) || jaFeito(bolha)) {
          setTimeout(bombear, 0);
          return;
        }
        self._ocupado = true;
        marcarFeito(bolha);
        const espera = document.createElement("div");
        espera.className = "zl-recovered zl-tr-espera";
        espera.textContent = "⏳ transcrevendo…";
        (bolha.querySelector(BOLHA_MIOLO) || bolha).appendChild(espera);
        try {
          const texto = await transcreverBolha(bolha, limite());
          espera.remove();
          mostrarTranscricaoNaBolha(bolha, texto);
          const botao = bolha.querySelector(".zl-tr-btn");
          if (botao) botao.remove();
        } catch (e) {
          espera.remove();
          if (ehFaltaDeInstalacao(e)) {
            // Uma vez só. Ficar tentando em laço numa máquina sem whisper é
            // gastar CPU para repetir o mesmo aviso. O timer é ZERADO (e não
            // só marcado) para que, terminada a instalação pelo Painel, o
            // `applyAll()` que o `save_settings` dispara volte a armar o
            // módulo — senão ele ficaria morto até reiniciar o app.
            self._desligado = true;
            self._fila.length = 0;
            clearInterval(self._timer);
            self._timer = null;
            avisarInstalacaoDaTranscricao(e);
          } else if (!(e && e.zlLongoDemais)) {
            console.warn("[ZapLite] transcrição automática falhou:", (e && e.message) || e);
          }
        } finally {
          self._ocupado = false;
        }
        if (!self._desligado) setTimeout(bombear, 250);
      };

      self._timer = setInterval(varrer, AT_VARREDURA_MS);
      varrer();
    },
    revert() {
      clearInterval(this._timer);
      this._timer = null;
      this._desligado = true;
      if (this._fila) this._fila.length = 0;
      document.querySelectorAll(".zl-tr-espera").forEach((e) => e.remove());
    },
  });
}
