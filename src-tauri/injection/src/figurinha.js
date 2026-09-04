/* ========================================================================
   FIGURINHAS — o desenho, UM lugar só (módulos 18 e 19)
   ------------------------------------------------------------------------
   O "Criador de figurinhas" (18) e o "Imagem → figurinha" (19) são a MESMA
   conversão com interfaces diferentes: 19 é o caminho curto (pega a imagem que
   já está na conversa e salva), 18 é o mesmo com ajuste de recorte, texto e
   croma antes. Duas cópias do enquadramento e do encoder divergiriam no
   primeiro ajuste — e o defeito apareceria só num dos dois.

   FORMATO, medido contra o que o WhatsApp aceita como figurinha:
     · 512 x 512 px exatos;
     · WebP com canal alfa (fundo transparente, não branco);
     · arquivo pequeno — o app recusa figurinha grande, e o teto prático que
       adotamos aqui é 500 KB. A qualidade cai em degraus até caber.

   TUDO no Canvas da própria página: a WebView2 é Chromium, então ela já traz
   o encoder WebP. Nenhuma dependência nativa, nenhum ffmpeg, nenhuma
   ferramenta externa — pelo mesmo motivo que `wav16kMono` decodifica áudio
   aqui em vez de exigir ffmpeg instalado em toda máquina.

   O QUE ESTE ARQUIVO NÃO FAZ, e o catálogo foi corrigido para dizer isso:
   recorte inteligente de objeto. O que existe é `removerCroma` — remoção por
   COR, do tipo que funciona em fundo liso (print com fundo branco, foto de
   estúdio) e falha em foto de rua. Prometer "remove fundo" e entregar croma é
   a mesma promessa falsa que a área de "planejados" existe para evitar.

   NADA aqui envia mensagem: o destino de uma figurinha pronta é o disco, pelo
   mesmo diálogo de "salvar como" de todos os outros arquivos.
   ======================================================================== */

export const LADO = 512;
/* Teto prático do arquivo. Acima disto o WhatsApp costuma recusar a figurinha
   na hora de anexar — e um .webp que não vira figurinha é um arquivo inútil
   com nome bonito. */
export const TETO_BYTES = 500 * 1024;
const QUALIDADES = [0.92, 0.8, 0.65, 0.5, 0.35];

/** Uma imagem já decodificada a partir de uma URL da própria página
    (`blob:`/`data:`, que é como o WhatsApp entrega a mídia decifrada). */
export function carregarImagem(src) {
  return new Promise((resolve, reject) => {
    if (!src) return reject(new Error("nenhuma imagem para carregar."));
    const img = new Image();
    // Mesma origem (blob:/data:), então o canvas não é contaminado e o
    // `toBlob` continua funcionando. Marcado por clareza, não por necessidade.
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new Error("a página não entregou os bytes desta imagem (ela pode não ter carregado ainda)."));
    img.src = src;
  });
}

/** Uma imagem escolhida pelo usuário no seletor de arquivos do navegador.
    Não é diálogo nativo: é o `<input type=file>` da própria página, aberto por
    um clique dele. Nada é lido do disco sem essa escolha. */
export function carregarDeArquivo(file) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error("nenhum arquivo escolhido."));
    if (String(file.type || "").indexOf("image/") !== 0) {
      return reject(new Error("“" + file.name + "” não é uma imagem."));
    }
    const fr = new FileReader();
    fr.onload = () => carregarImagem(fr.result).then(resolve, reject);
    fr.onerror = () => reject(new Error("não deu para ler “" + file.name + "” do disco."));
    fr.readAsDataURL(file);
  });
}

/* PURA e testada por `bundle.test.js`. O enquadramento: a imagem inteira cabe
   no quadrado (contain) quando `zoom` é 1; acima disso ela transborda e o
   quadrado vira recorte. `dx`/`dy` vão de -1 a 1 e deslocam em metades de
   lado, que é o que os controles do criador entregam. */
export function enquadrar(larguraImg, alturaImg, zoom, dx, dy, lado) {
  const L = lado || LADO;
  if (!(larguraImg > 0) || !(alturaImg > 0)) return { x: 0, y: 0, w: 0, h: 0 };
  const z = Math.max(0.1, Math.min(8, zoom || 1));
  const base = Math.min(L / larguraImg, L / alturaImg);
  const w = larguraImg * base * z;
  const h = alturaImg * base * z;
  return {
    x: (L - w) / 2 + (dx || 0) * (L / 2),
    y: (L - h) / 2 + (dy || 0) * (L / 2),
    w,
    h,
  };
}

/* PURA e testada. Distância de cor ao quadrado, no cubo RGB. Serve ao croma:
   comparar o quadrado evita a raiz e mantém a conta em inteiros. */
export function distanciaCor(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return dr * dr + dg * dg + db * db;
}

/** Remoção de fundo POR COR (croma). Zera o alfa de todo pixel cuja cor está
    dentro da tolerância em relação a `alvo`. Não é recorte de objeto: é o que
    dá para fazer com honestidade dentro do Canvas, e funciona onde o fundo é
    liso. `tolerancia` vai de 0 a 100 e vira raio no cubo RGB. */
export function removerCroma(ctx, alvo, tolerancia, lado) {
  const L = lado || LADO;
  const t = Math.max(0, Math.min(100, tolerancia || 0));
  // 0..100 -> raio 0..~255. O quadrado do raio é o que a comparação usa.
  const raio = (t / 100) * 255;
  const limite = raio * raio * 3;
  const dados = ctx.getImageData(0, 0, L, L);
  const px = dados.data;
  let apagados = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue; // já transparente: não conta como fundo
    if (distanciaCor(px[i], px[i + 1], px[i + 2], alvo.r, alvo.g, alvo.b) <= limite) {
      px[i + 3] = 0;
      apagados++;
    }
  }
  ctx.putImageData(dados, 0, 0);
  return apagados;
}

/** O texto no estilo de figurinha: branco com contorno preto grosso, que é o
    único jeito de um texto ficar legível sobre imagem qualquer. Encolhe a
    fonte até caber na largura. */
function escreverLinha(ctx, texto, y, lado) {
  const L = lado || LADO;
  const t = String(texto || "").trim();
  if (!t) return;
  let tam = Math.round(L * 0.13);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (; tam > 10; tam -= 2) {
    ctx.font = "800 " + tam + "px Impact, 'Arial Black', system-ui, sans-serif";
    if (ctx.measureText(t).width <= L * 0.92) break;
  }
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  ctx.lineWidth = Math.max(3, Math.round(tam * 0.18));
  ctx.strokeStyle = "#000";
  ctx.strokeText(t, L / 2, y);
  ctx.fillStyle = "#fff";
  ctx.fillText(t, L / 2, y);
}

/** Desenha a figurinha final num canvas 512x512 com fundo TRANSPARENTE.
    `op`: { zoom, dx, dy, croma:{r,g,b,tolerancia}|null, textoTopo, textoBase }.
    A ordem importa: imagem, croma, texto — o croma não pode comer o texto. */
export function desenharFigurinha(img, op, canvasAlvo) {
  const o = op || {};
  const cv = canvasAlvo || document.createElement("canvas");
  cv.width = LADO;
  cv.height = LADO;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.clearRect(0, 0, LADO, LADO);
  if (img) {
    const q = enquadrar(img.naturalWidth || img.width, img.naturalHeight || img.height, o.zoom, o.dx, o.dy);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, q.x, q.y, q.w, q.h);
  }
  if (o.croma) removerCroma(ctx, o.croma, o.croma.tolerancia);
  if (o.textoTopo) escreverLinha(ctx, o.textoTopo, Math.round(LADO * 0.11));
  if (o.textoBase) escreverLinha(ctx, o.textoBase, Math.round(LADO * 0.89));
  return cv;
}

/** A cor de um pixel do canvas, para o "escolher a cor do fundo" do criador. */
export function corDoPixel(canvas, x, y) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const d = ctx.getImageData(Math.max(0, Math.min(LADO - 1, x | 0)), Math.max(0, Math.min(LADO - 1, y | 0)), 1, 1).data;
  return { r: d[0], g: d[1], b: d[2], a: d[3] };
}

/** Canvas → Blob WebP dentro do teto, baixando a qualidade em degraus.
    Erro legível quando a webview não souber gerar WebP: um `.png` renomeado
    para `.webp` não vira figurinha, ele só falha mais tarde e sem explicação. */
export function paraWebp(canvas) {
  const tentar = (i) =>
    new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => {
          if (!b) return reject(new Error("esta webview não gerou o WebP da figurinha."));
          if (String(b.type || "").indexOf("image/webp") !== 0) {
            return reject(
              new Error(
                "esta webview não sabe gravar WebP (devolveu “" + (b.type || "?") +
                  "”). A figurinha do WhatsApp precisa ser WebP, e um arquivo de outro formato com " +
                  "o nome trocado não funcionaria."
              )
            );
          }
          if (b.size <= TETO_BYTES || i >= QUALIDADES.length - 1) return resolve(b);
          resolve(tentar(i + 1));
        },
        "image/webp",
        QUALIDADES[i]
      );
    });
  return tentar(0);
}
