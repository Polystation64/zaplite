/* Testes do bundle injetado. Sem dependência nenhuma: `node bundle.test.js`.
   Extrai a função REAL do bundle.js (não uma cópia) e a exercita fora do
   navegador. Existe por causa do Y3: o piso de varredura do anti-apagadas era
   um `return` seco, e a regressão que ele causava — a mutação que chega dentro
   da janela e não é seguida de nenhum outro lote — não aparecia em teste
   nenhum. */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const SRC = fs.readFileSync(path.join(__dirname, "bundle.js"), "utf8");

/** Recorta uma declaração de função do fonte, contando chaves. */
function extrair(nome) {
  const ini = SRC.indexOf("function " + nome + "(");
  assert.ok(ini >= 0, "função " + nome + " não encontrada em bundle.js");
  let i = SRC.indexOf("{", ini);
  let nivel = 0;
  for (let j = i; j < SRC.length; j++) {
    if (SRC[j] === "{") nivel++;
    else if (SRC[j] === "}") {
      nivel--;
      if (nivel === 0) return SRC.slice(ini, j + 1);
    }
  }
  throw new Error("chaves desbalanceadas ao extrair " + nome);
}

const throttleComCauda = new Function(
  extrair("throttleComCauda") + "; return throttleComCauda;"
)();

const rotuloIndicaNovo = new Function(
  extrair("rotuloIndicaNovo") + "; return rotuloIndicaNovo;"
)();

/* `textoDaBolha` depende de duas constantes do bundle; extraí-las junto
   garante que o teste morre se elas mudarem de nome. */
/* `(?:const|let|var)`: o bundle.js é GERADO pelo esbuild a partir de
   injection/src/, e um `const` de topo de módulo sai como `var` no arquivo
   empacotado — o escopo de módulo virou escopo de função. O que este teste
   precisa amarrar é o NOME e o VALOR da constante, não a palavra-chave. */
function constante(nome) {
  const m = SRC.match(new RegExp("(?:const|let|var) " + nome + " = (.*);"));
  assert.ok(m, "constante " + nome + " não encontrada em bundle.js");
  return "const " + nome + " = " + m[1] + ";";
}
const textoDaBolha = new Function(
  constante("TEXTO_SELS") +
    constante("META_SEL") +
    extrair("textoDaBolha") +
    "; return textoDaBolha;"
)();

/* E3 — `temRascunho` é o que impede o watchdog de recarregar por cima do que o
   usuário escreveu. Ele SÓ pode ler: se algum dia alguém puser aqui um `focus`,
   um `dispatchEvent` ou uma escrita, o custo do erro é mandar mensagem sozinho.
   O teste amarra as duas propriedades: o resultado certo e a ausência de
   qualquer chamada que não seja leitura. */
const temRascunho = new Function(extrair("temRascunho") + "; return temRascunho;")();

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const casos = [];
const teste = (nome, fn) => casos.push([nome, fn]);

/* Y3 — O CASO DA REGRESSÃO.
   Lote 1 dispara a varredura (borda de entrada). Lote 2, com o "Esta mensagem
   foi apagada", chega DENTRO da janela e NÃO vem mais nada depois. Com o piso
   puro a segunda varredura nunca acontecia e a marcação nunca aparecia. */
teste("mutação dentro da janela sem lote seguinte ainda é varrida", async () => {
  let varreduras = 0;
  const pedir = throttleComCauda(() => varreduras++, 200);

  pedir(); // lote 1 (borda de entrada)
  assert.strictEqual(varreduras, 1, "a primeira varredura roda na hora");

  await espera(40);
  pedir(); // lote 2: a mensagem apagada. Nada mais acontece depois disto.
  assert.strictEqual(varreduras, 1, "o piso continua valendo dentro da janela");

  await espera(400);
  assert.strictEqual(
    varreduras,
    2,
    "a borda de saída tem que reexaminar a linha mesmo sem novo lote"
  );
});

/* O objetivo de memória que motivou o piso continua de pé: uma rajada de
   mutações (o WhatsApp muta a árvore continuamente) não pode virar uma
   varredura do documento inteiro por lote. */
teste("rajada dentro da janela não vira uma varredura por lote", async () => {
  let varreduras = 0;
  const pedir = throttleComCauda(() => varreduras++, 200);

  for (let i = 0; i < 50; i++) pedir();
  assert.strictEqual(varreduras, 1, "a rajada inteira cabe em uma varredura");

  await espera(400);
  assert.strictEqual(varreduras, 2, "a rajada rende no máximo uma cauda");
});

/* Duas janelas seguidas com trabalho em cada uma: a segunda também tem cauda. */
teste("janelas consecutivas mantêm o ritmo do piso", async () => {
  let varreduras = 0;
  const pedir = throttleComCauda(() => varreduras++, 100);

  pedir();
  await espera(30);
  pedir();
  await espera(200); // cauda da 1a janela já rodou
  assert.strictEqual(varreduras, 2);
  pedir();
  await espera(20);
  pedir();
  await espera(200);
  assert.strictEqual(varreduras, 4, "cada janela com pedido rende sua varredura");
});

/* `cancelar` existe para o desligamento do módulo não deixar timer vivo. */
teste("cancelar impede a cauda pendente de rodar", async () => {
  let varreduras = 0;
  const pedir = throttleComCauda(() => varreduras++, 200);
  pedir();
  await espera(20);
  pedir();
  pedir.cancelar();
  await espera(400);
  assert.strictEqual(varreduras, 1, "a cauda cancelada não roda");
});

/* V1 — o texto da mensagem não pode vir com o horário grudado.
   `querySelector("a,b")` devolve o primeiro nó na ordem do DOCUMENTO, e o
   envoltório `.copyable-text` vem ANTES do `span.selectable-text` que ele
   contém — trazendo junto o "13:38" do `msg-meta`. */
function bolhaFalsa(mapa) {
  const nó = (texto, meta) => ({
    textContent: texto,
    cloneNode: () => ({
      textContent: meta ? texto.replace(meta, "") : texto,
      querySelectorAll: () => [],
    }),
    querySelectorAll: () => [],
  });
  return {
    querySelector(sel) {
      const v = mapa[sel];
      return v ? nó(v[0], v[1]) : null;
    },
  };
}

teste("texto da bolha prefere o span e não gruda o horário", () => {
  // o formato de hoje: os dois existem, o span é que vale
  assert.strictEqual(
    textoDaBolha(
      bolhaFalsa({
        "span.selectable-text": ["bom dia"],
        ".copyable-text": ["bom dia13:38", "13:38"],
      })
    ),
    "bom dia"
  );
  // só o envoltório: o bloco de hora/status sai antes de ler
  assert.strictEqual(
    textoDaBolha(bolhaFalsa({ ".copyable-text": ["bom dia13:38", "13:38"] })),
    "bom dia"
  );
  // bolha sem texto (mídia pura) devolve vazio, e é isso que faz o
  // collectVisibleMessages pular a linha em vez de inventar conteúdo
  assert.strictEqual(textoDaBolha(bolhaFalsa({})), "");
  assert.strictEqual(textoDaBolha(null), "");
});

/* V2 — O CASO DO PRINT.
   Duas conversas com não lidas de "quarta-feira" viraram toast no momento em
   que o app subiu. A decisão era "tem badge e a prévia mudou desde a última
   vez que vi ESTA linha" — e a lista renderiza depois da primeira varredura,
   então toda não lida antiga era "prévia nova". O rótulo da linha é a prova
   documental de que a mensagem é velha. */
const HOJE = new Date(2026, 7, 16, 11, 36, 0).getTime(); // 16/08/2026 11:36
const AGORA = new Date(2026, 7, 16, 12, 10, 0).getTime();

teste("rótulo de dia da semana nunca é mensagem nova", () => {
  for (const r of ["quarta-feira", "Ontem", "ontem", "07/08/2026", "sexta-feira"]) {
    assert.strictEqual(rotuloIndicaNovo(r, HOJE, AGORA), false, "rótulo " + r);
  }
});

teste("hora anterior ao início da observação é não lida antiga", () => {
  assert.strictEqual(rotuloIndicaNovo("10:48", HOJE, AGORA), false);
  assert.strictEqual(rotuloIndicaNovo("11:30", HOJE, AGORA), false);
});

teste("hora posterior ao início é mensagem que chegou com o app rodando", () => {
  assert.strictEqual(rotuloIndicaNovo("11:37", HOJE, AGORA), true);
  assert.strictEqual(rotuloIndicaNovo("12:09", HOJE, AGORA), true);
  // a folga de 90s cobre o minuto de resolução do rótulo
  assert.strictEqual(rotuloIndicaNovo("11:35", HOJE, AGORA), true);
});

teste("formato de 12 horas também é lido", () => {
  const desde = new Date(2026, 7, 16, 9, 0, 0).getTime();
  const agora = new Date(2026, 7, 16, 15, 0, 0).getTime();
  assert.strictEqual(rotuloIndicaNovo("2:30 PM", desde, agora), true);
  assert.strictEqual(rotuloIndicaNovo("7:30 AM", desde, agora), false);
});

teste("depois da virada do dia, relógio é sempre de hoje", () => {
  const desde = new Date(2026, 7, 15, 23, 50, 0).getTime();
  const agora = new Date(2026, 7, 16, 0, 20, 0).getTime();
  assert.strictEqual(rotuloIndicaNovo("00:05", desde, agora), true);
});

teste("rótulo ausente ou ilegível não decide sozinho", () => {
  assert.strictEqual(rotuloIndicaNovo("", HOJE, AGORA), null);
  assert.strictEqual(rotuloIndicaNovo("   ", HOJE, AGORA), null);
  assert.strictEqual(rotuloIndicaNovo("99:99", HOJE, AGORA), null);
});

/* --- E3: detecção de rascunho ----------------------------------------- */

/** DOM mínimo: um `#main` com (ou sem) a caixa de mensagem. Toda chamada feita
    no elemento fica registrada, para o teste provar que nada além de leitura
    aconteceu. */
function palcoComCaixa(texto, opts) {
  const o = opts || {};
  const chamadas = [];
  const armadilha = (nome) => () => {
    chamadas.push(nome);
    throw new Error("temRascunho não pode chamar " + nome);
  };
  const caixa =
    texto === null
      ? null
      : {
          innerText: texto,
          textContent: texto,
          focus: armadilha("focus"),
          click: armadilha("click"),
          dispatchEvent: armadilha("dispatchEvent"),
        };
  const main = {
    querySelector(sel) {
      chamadas.push("querySelector:" + sel);
      return caixa;
    },
  };
  global.document = {
    getElementById(id) {
      chamadas.push("getElementById:" + id);
      return o.semMain ? null : id === "main" ? main : null;
    },
  };
  return chamadas;
}

teste("texto no campo de mensagem é rascunho; campo vazio não é", () => {
  palcoComCaixa("oi, tudo bem?");
  assert.strictEqual(temRascunho(), true);
  palcoComCaixa("");
  assert.strictEqual(temRascunho(), false);
  palcoComCaixa("   \n  ");
  assert.strictEqual(temRascunho(), false, "só espaço em branco não é rascunho");
});

teste("sem conversa aberta ou sem caixa, não há rascunho e nada explode", () => {
  palcoComCaixa("qualquer coisa", { semMain: true });
  assert.strictEqual(temRascunho(), false);
  palcoComCaixa(null);
  assert.strictEqual(temRascunho(), false);
  delete global.document; // sem DOM nenhum: falha fechada, nunca lança
  assert.strictEqual(temRascunho(), false);
});

teste("temRascunho só lê: não foca, não clica, não despacha evento", () => {
  const chamadas = palcoComCaixa("rascunho do usuário");
  temRascunho();
  const proibidas = chamadas.filter((c) => !c.startsWith("getElementById") && !c.startsWith("querySelector"));
  assert.deepStrictEqual(proibidas, [], "nenhuma chamada além de leitura do DOM");
  assert.ok(
    chamadas.some((c) => c.startsWith("querySelector") && c.includes("#main") === false),
    "a busca é feita DENTRO de #main, não no documento inteiro"
  );
});

/* A6 — o item "ver mensagem apagada" só pode aparecer em bolha APAGADA, e a
   tarja que nós mesmos penduramos não pode ser confundida com o aviso do
   WhatsApp (ela contém o texto original, que pode conter a palavra "apagada").
   A5 — o teto de duração é lido do rótulo que a página já desenha, ANTES de
   mandar reproduzir; errar aqui é auto-reproduzir um áudio de meia hora. */
const ehApagada = new Function(
  constante("APAGADA_RE") + extrair("ehApagada") + "; return ehApagada;"
)();
const segundosDaBolha = new Function(
  extrair("segundosDaBolha") + "; return segundosDaBolha;"
)();

/** Bolha de mentira suficiente para as duas funções: textContent, cloneNode
    e querySelectorAll(".zl-recovered"). */
function bolhaApagavel(texto, recuperada) {
  const no = {
    textContent: texto + (recuperada ? recuperada : ""),
    cloneNode() {
      return {
        textContent: texto,
        querySelectorAll: () => [],
      };
    },
    querySelectorAll: () => (recuperada ? [{}] : []),
  };
  return no;
}

teste("apagada é reconhecida em pt e en", () => {
  assert.ok(ehApagada(bolhaApagavel("Esta mensagem foi apagada")));
  assert.ok(ehApagada(bolhaApagavel("This message was deleted")));
  assert.ok(ehApagada(bolhaApagavel("Se eliminó este mensaje")));
  assert.ok(!ehApagada(bolhaApagavel("bom dia, tudo certo?")));
});

teste("nossa tarja recuperada não faz uma bolha comum parecer apagada", () => {
  // o texto guardado fala de "apagada", mas está DENTRO da tarja: o clone
  // remove `.zl-recovered` antes de olhar.
  const b = bolhaApagavel("mensagem normal", "🕵️ (recuperada) a foto foi apagada do álbum");
  assert.ok(!ehApagada(b));
});

/* A2 — o clique só é sequestrado quando é MESMO um link externo. Errar para
   mais aqui quebra o clique dentro da conversa; errar para menos deixa o link
   sem abrir, que é o defeito original. */
const ehLinkDoWhatsApp = new Function(
  "location",
  extrair("ehLinkDoWhatsApp") + "; return ehLinkDoWhatsApp;"
)({ href: "https://web.whatsapp.com/" });
const LINK_ESQUEMA = new Function(constante("LINK_ESQUEMA") + "; return LINK_ESQUEMA;")();

teste("link do próprio WhatsApp continua com a página", () => {
  assert.ok(ehLinkDoWhatsApp("https://web.whatsapp.com/send?phone=5511999998888"));
  assert.ok(ehLinkDoWhatsApp("https://static.whatsapp.net/x"));
  assert.ok(!ehLinkDoWhatsApp("https://exemplo.com/"));
  assert.ok(!ehLinkDoWhatsApp("https://naowhatsapp.com/"));
  assert.ok(!ehLinkDoWhatsApp("https://whatsapp.com.mau.test/"));
});

teste("só esquema de link vira abertura externa", () => {
  for (const bom of ["https://a.b", "http://a.b", "mailto:a@b.c", "tel:+55"]) {
    assert.ok(LINK_ESQUEMA.test(bom), bom);
  }
  for (const mau of ["#", "javascript:alert(1)", "/relativo", "blob:https://x/y", "file:///C:/"]) {
    assert.ok(!LINK_ESQUEMA.test(mau), mau);
  }
});

teste("duração vem do rótulo da bolha, em m:ss e h:mm:ss", () => {
  assert.strictEqual(segundosDaBolha({ textContent: "0:37 13:45" }), 37);
  assert.strictEqual(segundosDaBolha({ textContent: "12:05" }), 725);
  assert.strictEqual(segundosDaBolha({ textContent: "1:02:03" }), 3723);
  assert.strictEqual(segundosDaBolha({ textContent: "sem duração aqui" }), 0);
});

/* P4 — link https clicado DENTRO do ZapLite vira conversa local?
   `alvoDeLinkWeb` decide isso, e decidir errado tem dois custos opostos:
   deixar passar (o link vai para o navegador, que chama o app oficial — o
   defeito que estamos consertando) ou capturar demais (um link qualquer
   sequestrado e a janela navegando para onde não devia). As funções REAIS são
   recortadas do bundle, com um `location` de mentira só para o `new URL`. */
const alvoDeLinkWeb = new Function(
  "location",
  extrair("telefoneValido") +
    ";" +
    extrair("codigoValido") +
    ";" +
    extrair("textoDeLink") +
    ";" +
    extrair("alvoDeLinkWeb") +
    "; return alvoDeLinkWeb;"
)({ href: "https://web.whatsapp.com/" });

teste("wa.me e api.whatsapp.com viram conversa local", () => {
  assert.deepStrictEqual(alvoDeLinkWeb("https://wa.me/5511999998888"), {
    phone: "5511999998888",
    code: "",
    text: "",
  });
  // o rascunho vem junto e é só isso: um rascunho.
  assert.deepStrictEqual(alvoDeLinkWeb("https://wa.me/5511999998888?text=oi%20a%C3%AD"), {
    phone: "5511999998888",
    code: "",
    text: "oi aí",
  });
  assert.strictEqual(
    alvoDeLinkWeb("https://api.whatsapp.com/send?phone=+55 (11) 99999-8888").phone,
    "5511999998888"
  );
  assert.strictEqual(
    alvoDeLinkWeb("https://chat.whatsapp.com/ABCdef123-_x").code,
    "ABCdef123-_x"
  );
});

teste("o que não é link de conversa segue o caminho antigo", () => {
  for (const u of [
    "https://exemplo.com/5511999998888", // outro site
    "https://wa.me.exemplo.com/5511999998888", // host parecido, não é o mesmo
    "https://wa.me/message/ABC123", // link curto: só o servidor resolve
    "https://wa.me/123", // curto demais para ser telefone
    "https://wa.me/", // sem número
    "https://web.whatsapp.com/", // a própria página
    "https://api.whatsapp.com/send?phone=abc", // sem dígito
    "https://web.whatsapp.com/outra/coisa?phone=5511999998888", // caminho errado
    "javascript:alert(1)",
    "nao e uma url",
  ]) {
    assert.strictEqual(alvoDeLinkWeb(u), null, "deveria recusar: " + u);
  }
});

(async () => {
  let falhas = 0;
  for (const [nome, fn] of casos) {
    try {
      await fn();
      console.log("ok    " + nome);
    } catch (e) {
      falhas++;
      console.log("FALHA " + nome + "\n      " + e.message);
    }
  }
  console.log(
    (falhas ? "FALHOU" : "PASSOU") + ": " + (casos.length - falhas) + "/" + casos.length
  );
  process.exit(falhas ? 1 : 0);
})();
