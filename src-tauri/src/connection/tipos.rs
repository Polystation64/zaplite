//! Constantes, tipos simples e funções puras da camada de conexão.
//! Nada aqui toca `Inner`, o log ou o `AppHandle`: é o vocabulário que os
//! outros submódulos usam.

use super::*;

/* --- E1/E2: silêncio de heartbeat NÃO é prova de webview morta -----------
   O defeito que este bloco existe para matar, medido no `connection.log` de
   17/08 (a sessão real do usuário, sem nenhum agente na máquina):

     09:45:31  CONNECTED->RECONNECTING  ">15s sem heartbeat"; renavegou
     09:46:04  RECONNECTING             ">15s sem heartbeat"; renavegou
     09:46:40  RECONNECTING             "episódio ruim persistiu 5s
                                         (estado da página: CONNECTED)"
     09:47:19  RECONNECTING->FAILED     convergiu
     09:47:28  FAILED                   3x "carga de documento NÃO declarada"
     09:47:33  STARTING->CONNECTED

   As três navegações postadas em 09:45:31, 09:46:04 e 09:46:40 só commitaram
   documento às 09:47:28 — TODAS de uma vez. A sonda de URL continuou
   respondendo o tempo inteiro (nenhuma linha "thread principal sem
   responder"), então a thread principal do processo estava viva: quem estava
   congelado era o RENDERIZADOR. Ou seja: o silêncio durou ~2min12s e a
   webview não estava morta — estava parada. O mesmo padrão se repete às
   09:52:43 → 09:56:17 (~3min49s de silêncio, mesmo desfecho).

   `HEARTBEAT_TIMEOUT = 15s` transformou uma pausa de JS num diagnóstico de
   morte, e a cura (renavegar) é que destruía o que o usuário tinha digitado.
   Agora são DOIS limiares, com papéis separados:
     · `HEARTBEAT_TIMEOUT` — a partir de quando o heartbeat deixa de ser
       "fresco" para efeito de JULGAR SAÚDE (contador K1). Nada é destruído
       aqui.
     · `SILENCIO_ZUMBI` — a partir de quando o nível 3 pode sequer ser
       CONSIDERADO, e ainda assim só com corroboração independente
       (`evidencia_de_morte`).                                              */
/// Silêncio a partir do qual o heartbeat deixa de ser "fresco". Não dispara
/// nada sozinho — só deixa o contador K1 julgar. Calibrado para a realidade
/// desta conta: heap do WhatsApp Web medido em 1,2–1,3 GB (~181 conversas),
/// em que uma coleta maior congela o JS por dezenas de segundos, e o pior
/// silêncio observado no log foi de 132 s e 229 s.
pub(crate) const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(60);
/// Silêncio a partir do qual o nível 3 é CONSIDERADO — nunca sozinho. Vale
/// ~1,7x o maior silêncio já medido nesta máquina que terminou em página VIVA
/// (229 s → o teto adaptativo abaixo cobre o resto).
pub(crate) const SILENCIO_ZUMBI: Duration = Duration::from_secs(390);
/// Teto absoluto: nenhuma pausa explicada compra mais espera que isto.
pub(crate) const SILENCIO_TETO: Duration = Duration::from_secs(15 * 60);
/// Intervalo entre heartbeats que merece uma linha de calibração no log
/// (3 batimentos perdidos). É a trilha de evidência deste defeito.
pub(crate) const GAP_NOTAVEL: Duration = Duration::from_secs(9);
/// De quanto em quanto tempo a distribuição medida de intervalos entre
/// heartbeats vai ao log. Uma linha por período: o custo é desprezível e é a
/// única forma de escolher os limiares acima com DADO em vez de palpite.
pub(crate) const CALIBRACAO_TICK: Duration = Duration::from_secs(5 * 60);
/// E3 — um rascunho visto no campo de mensagem segura nível 2/3 por isto,
/// renovado a cada heartbeat que ainda vê texto lá.
pub(crate) const RASCUNHO_JANELA: Duration = Duration::from_secs(45);
/// Teto do adiamento por rascunho: passado isso a recuperação acontece, e o
/// motivo que vai ao badge diz ao usuário o que aconteceu.
pub(crate) const RASCUNHO_ADIAMENTO_MAX: Duration = Duration::from_secs(5 * 60);
pub(crate) const WATCHDOG_TICK: Duration = Duration::from_secs(3);
/// Com que frequência a thread principal é sondada pela URL corrente.
pub(crate) const URL_PROBE_TICK: Duration = Duration::from_secs(3);
/// Tolerância APENAS do boot: a primeira carga do WhatsApp Web foi medida entre
/// 20,2s e 54s pelo auditor. Não se aplica a recuperação (ver `RECOVERY_GRACE`).
pub(crate) const STARTUP_GRACE: Duration = Duration::from_secs(60);
/// Carência depois de uma renavegação do nível 3. É MENOR que a do boot porque
/// o bundle roda em `document-start` (a ponte já responde antes de a interface
/// do WhatsApp montar) e porque o detector de "carregou e não fala" (K12) cobre
/// o caso de página morta em 10s. Menor que o teto do backoff, de propósito:
/// era isso que fazia o backoff nunca decidir nada (K7).
pub(crate) const RECOVERY_GRACE: Duration = Duration::from_secs(30);
/// Carência depois que a janela volta a ficar VISÍVEL (não: ganhar foco).
/// Escondida, o Chromium estrangula timers e o heartbeat rareia.
pub(crate) const VISIBILITY_GRACE: Duration = Duration::from_secs(30);
/// Carência depois de um salto de relógio (retorno de suspensão do Windows).
pub(crate) const WAKE_GRACE: Duration = Duration::from_secs(45);
/// TETO ABSOLUTO de carência acumulada (K3/K7). Encadear recuperação (+60s) →
/// reexibição (+30s) → salto de relógio (+45s) dava ~135s sem NENHUMA
/// recuperação possível. Agora nenhuma combinação passa disto.
pub(crate) const MAX_GRACE_AHEAD: Duration = Duration::from_secs(60);
/// Tick monotônico maior que isto = o processo não rodou nesse intervalo.
pub(crate) const CLOCK_JUMP: Duration = Duration::from_secs(20);
/// Divergência entre o avanço de `Instant` e o de `SystemTime` no mesmo tick.
pub(crate) const CLOCK_SKEW: Duration = Duration::from_secs(10);
/// Trava de segurança: `recovering` nunca fica preso além disso.
pub(crate) const RECOVERY_TIMEOUT: Duration = Duration::from_secs(30);
/// Circuit breaker do nível 3: no máximo N recuperações numa janela de tempo.
pub(crate) const RECOVERY_WINDOW: Duration = Duration::from_secs(10 * 60);
pub(crate) const MAX_RECOVERIES_IN_WINDOW: usize = 5;

/* --- M1/M3: breaker da COMPOSIÇÃO (níveis 1, 2 e 3 no mesmo lugar) ------
   O defeito que este bloco existe para matar: o contador contava ESTADO DO
   LINK, não RECUPERAÇÃO DISPARADA. O nível 2 é um `location.reload()`, todo
   reload passa por STARTING, o contador congelava em `ESTADOS_INDEFINIDOS`, e
   ao voltar o JS lia 0 do Rust e recomeçava do zero. Resultado medido em
   produção, sem nenhum agente na máquina: 8 recargas da tela de QR do usuário
   em 35 min (16:03:49 → 16:39:26), TODAS com `attempts=0` e "tentativa 1".
   Agora quem conta é `decidir_recuperacao`, e ela conta o DISPARO. */
/// Recuperações no MESMO cenário, sem progresso, antes de convergir.
pub(crate) const MAX_DISPAROS_CENARIO: u32 = 3;
/// Recuperações de QUALQUER nível/cenário aceitas numa janela.
pub(crate) const MAX_DISPAROS_JANELA: usize = 6;
/// Primeiro descanso depois de convergir: o app PARA de recuperar e espera.
/// Não é fim de linha — acaba sozinho (M2) e encurta com sinal positivo (M4).
pub(crate) const DESCANSO_CONVERGIDO: Duration = Duration::from_secs(5 * 60);
/// Teto do descanso, por maior que seja a insistência do cenário.
pub(crate) const DESCANSO_MAX: Duration = Duration::from_secs(60 * 60);
/// M2 — teto de tempo do veredito FAILED do Rust. Era `RECOVERY_WINDOW`
/// (10 min) e nada o encurtava: o pior caso media ~10 min sem NENHUMA
/// recuperação possível.
pub(crate) const DESCANSO_FAILED: Duration = Duration::from_secs(5 * 60);
/// M4 — sinal positivo observado pelo RUST (CONNECTED com heartbeat fresco,
/// fora de carência) encurta qualquer descanso para isto.
pub(crate) const REARME_POR_SINAL: Duration = Duration::from_secs(20);
/// M2 — heartbeat CHEGANDO e link reportado ruim por mais que isto: a página
/// está viva e não está se recuperando. Alguma camada precisa agir, e a única
/// que sobra é esta. Maior que o pior backoff do JS (60s) para não atropelar
/// uma recuperação da página que ainda está em curso.
pub(crate) const LINK_MORTO: Duration = Duration::from_secs(90);
/// Intervalo mínimo entre PEDIDOS de recuperação vindos da origem remota.
pub(crate) const PEDIDO_MIN_INTERVALO: Duration = Duration::from_secs(2);
/// Depois de autorizar um nível 2, a carga de documento é ESPERADA por isto —
/// senão o detector de reload não declarado a contaria duas vezes.
pub(crate) const RELOAD_ESPERADO: Duration = Duration::from_secs(30);
/// Página commitada (ou `about:blank`) sem nenhum sinal do bundle por mais que
/// isto = o documento existe mas não é o nosso app rodando.
pub(crate) const BLANK_TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) const MAX_BLANK_RECOVERIES_IN_WINDOW: usize = 5;
/// Sem resposta da thread principal por mais que isto = UI travada.
pub(crate) const MAIN_STUCK: Duration = Duration::from_secs(30);
pub(crate) const LOG_MAX_BYTES: u64 = 1024 * 1024;

/* --- K1: parâmetros do contador derivado ------------------------------- */
/// Mesmo teto do `MAX_ATTEMPTS` do bundle.js: é este número que o JS lê de
/// volta e usa como circuit breaker.
pub(crate) const MAX_ATTEMPTS: u32 = 10;
/// Um episódio ruim só vira "tentativa" depois de PERSISTIR isto, medido pelo
/// relógio do Rust. Um script que pisca de CONNECTED para OFFLINE e volta não
/// consegue inflar o contador.
pub(crate) const ATTEMPT_EPISODE: Duration = Duration::from_secs(5);
/// CONNECTED sustentado por isto zera o contador (espelha `STABLE_OK_MS` do JS).
pub(crate) const STABLE_OK: Duration = Duration::from_secs(15);

/* --- K5: teto da superfície remota ------------------------------------- */
/// Fila de escrita do log. `sync_channel` limitado: a versão anterior usava
/// `mpsc::channel()` ILIMITADO, então um laço da página crescia a fila até a
/// memória acabar.
pub(crate) const LOG_QUEUE_MAX: usize = 512;
/// Janela e teto de transições aceitas da origem remota POR JANELA.
pub(crate) const REMOTE_WINDOW: Duration = Duration::from_secs(60);
pub(crate) const MAX_REMOTE_TRANSITIONS: u32 = 30;
/// Transição idêntica repetida dentro disto não gera linha nova.
pub(crate) const REMOTE_DEDUP: Duration = Duration::from_millis(1500);
/// K9: teto de TAMANHO da string de timestamp vinda da página, antes de
/// qualquer parse.
pub(crate) const MAX_TS_LEN: usize = 64;
/// Quantas linhas geradas pelo próprio app a rotação preserva do trecho velho.
pub(crate) const ROT_LOCAIS_MAX: usize = 1500;

/// Único destino de navegação desta camada.
pub(crate) const WHATSAPP_URL: &str = "https://web.whatsapp.com/";

pub(crate) const STATES: [&str; 8] = [
    "STARTING",
    "NEEDS_AUTH",
    "CONNECTED",
    "OFFLINE",
    "DEGRADED",
    "RECONNECTING",
    "FAILED",
    "BOOT",
];

/// Estados que representam link ruim — os que contam episódio (K1).
pub(crate) const ESTADOS_RUINS: [&str; 4] = ["OFFLINE", "DEGRADED", "RECONNECTING", "FAILED"];
/// Estados em que o Rust NÃO sabe julgar (boot, QR na tela): o contador de
/// EPISÓDIO congela em vez de contar tentativa ou zerar.
///
/// M1: congelar aqui está certo para episódio de link — e era catastrófico
/// como ÚNICA fonte do contador, porque todo reload passa por STARTING. O
/// contador de RECUPERAÇÃO DISPARADA (`decidir_recuperacao`) não passa por
/// aqui: ele não olha estado nenhum, olha o disparo.
pub(crate) const ESTADOS_INDEFINIDOS: [&str; 4] = ["STARTING", "BOOT", "NEEDS_AUTH", "UNKNOWN"];

/// Rótulos de cenário aceitos. A página escolhe o rótulo, então ele é
/// whitelist: cenário desconhecido vira "outro" e cai no MESMO balde, o que só
/// torna a convergência mais rápida — nunca mais lenta.
pub(crate) const CENARIOS: [&str; 9] = [
    "login-parado",
    "login-apos-queda",
    "carregamento",
    "socket",
    "link-morto",
    "documento-mudo",
    "sem-heartbeat",
    "reload-nao-declarado",
    // W2 — envio preso na tela (bolha de saída com relógio). É o cenário do
    // defeito canônico "recebe mas não envia" e merece balde próprio: ele não
    // tem nada a ver com o socket que caiu nem com a tela que não carregou.
    "envio-preso",
];

pub(crate) fn cenario_valido(s: &str) -> String {
    if CENARIOS.contains(&s) {
        s.to_string()
    } else {
        "outro".into()
    }
}

/// Classificação da página corrente. Guardamos isto, nunca a URL completa.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum PageKind {
    /// `about:blank`, `data:`, vazio: a navegação não commitou um documento
    /// nosso. **No WebView2 a página de ERRO não cai aqui** — ver `K12` e o
    /// detector `carregou_mudo`.
    Blank,
    WhatsApp,
    Other,
}

impl PageKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            PageKind::Blank => "blank",
            PageKind::WhatsApp => "whatsapp",
            PageKind::Other => "outra",
        }
    }
}

/* ------------------------------------------------------------------------ */
/* K1 — contador de tentativas derivado pelo Rust                            */
/* ------------------------------------------------------------------------ */

/// Saúde do link como o RUST a enxerga neste tick.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Saude {
    Boa,
    Ruim,
    /// Boot, QR, carência, recuperação em voo, janela escondida: não dá para
    /// julgar. Congela o contador em vez de contar tentativa fantasma.
    Indefinida,
}

/// Contador de tentativas — **autoridade do Rust**.
///
/// Por que o valor que a página manda NÃO é confiável: `conn_heartbeat` e
/// `conn_transition` estão na capability `remote-whatsapp`, ou seja, são
/// chamáveis por qualquer script carregado em `https://web.whatsapp.com`
/// (extensão, código de terceiro, XSS no app da Meta). Na iteração 2 esses dois
/// comandos eram os ÚNICOS escritores do contador e o JS lia o valor de volta
/// por `get_connection_state`: um ciclo de realimentação fechado. Bastava
/// `invoke('conn_heartbeat',{state:'CONNECTED',attempts:10})` para o JS clampar
/// em MAX_ATTEMPTS, ir a FAILED e desligar TODA a recuperação; ou `attempts:0`
/// em laço para garantir reload eterno. É o mesmo defeito da iteração 1, que
/// morava no sessionStorage, apenas migrado para a ponte nativa.
///
/// Aqui o valor é derivado de EVENTOS QUE O RUST OBSERVA com o próprio relógio:
///  * um episódio ruim que PERSISTE `ATTEMPT_EPISODE` conta exatamente uma
///    tentativa (piscar de estado não conta nada);
///  * cada recuperação de nível 3 disparada pelo watchdog conta uma;
///  * `CONNECTED` sustentado por `STABLE_OK` zera.
/// O número que a página manda é guardado à parte (`attempts_reported`), só
/// para diagnóstico, com faixa validada — nunca realimenta a decisão.
#[derive(Debug)]
pub(crate) struct Tentativas {
    pub(crate) valor: u32,
    pub(crate) ruim_desde: Option<Instant>,
    pub(crate) episodio_contado: bool,
    pub(crate) bom_desde: Option<Instant>,
}

impl Default for Tentativas {
    fn default() -> Self {
        Self {
            valor: 0,
            ruim_desde: None,
            episodio_contado: false,
            bom_desde: None,
        }
    }
}

impl Tentativas {
    /// Um tick de observação. Devolve o que mudou, para o chamador logar.
    pub(crate) fn observar(&mut self, now: Instant, saude: Saude) -> Option<&'static str> {
        match saude {
            Saude::Indefinida => {
                self.ruim_desde = None;
                self.bom_desde = None;
                self.episodio_contado = false;
                None
            }
            Saude::Boa => {
                self.ruim_desde = None;
                self.episodio_contado = false;
                let inicio = *self.bom_desde.get_or_insert(now);
                if self.valor > 0 && now.saturating_duration_since(inicio) >= STABLE_OK {
                    self.valor = 0;
                    self.bom_desde = Some(now);
                    return Some("zerado");
                }
                None
            }
            Saude::Ruim => {
                self.bom_desde = None;
                let inicio = *self.ruim_desde.get_or_insert(now);
                if !self.episodio_contado
                    && now.saturating_duration_since(inicio) >= ATTEMPT_EPISODE
                {
                    self.episodio_contado = true;
                    if self.valor < MAX_ATTEMPTS {
                        self.valor += 1;
                        return Some("incremento");
                    }
                }
                None
            }
        }
    }

    /// Uma recuperação foi DISPARADA: isso É uma tentativa, observada pelo
    /// Rust, em qualquer nível (1 e 2 passam por `decidir_recuperacao`, 3 vem
    /// do watchdog, e o reload não declarado vem de `note_page_load`).
    ///
    /// M1 — este é o único incremento que importa para a convergência, e ele:
    ///  * não olha estado nenhum, então NÃO congela em STARTING/NEEDS_AUTH;
    ///  * mora no processo, então o `location.reload()` do nível 2 não o zera;
    ///  * não aceita valor da página, então ela não o controla.
    /// Só `observar(Boa)` sustentado por `STABLE_OK` zera.
    pub(crate) fn conta_recuperacao(&mut self) {
        if self.valor < MAX_ATTEMPTS {
            self.valor += 1;
        }
        self.episodio_contado = true;
        self.bom_desde = None;
    }
}


/* ------------------------------------------------------------------------ */
/* Funções puras (testáveis sem app Tauri)                                   */
/* ------------------------------------------------------------------------ */

/// Classifica a URL corrente e devolve só a ORIGEM (esquema + host).
///
/// K12: `chrome-error:`/`edge-error:` NÃO aparecem aqui no Windows. O
/// `ICoreWebView2::Source` continua sendo a URL TENTADA depois de uma falha de
/// navegação, então `w.url()` devolve `https://web.whatsapp.com/` mesmo com a
/// página de erro na tela (verificado empiricamente — ver `note_page_load`).
/// Os prefixos seguem tratados por completude (outras plataformas / casos em
/// que o WebView2 realmente troca o Source), mas o detector que funciona de
/// fato é o `carregou_mudo`, baseado no `NavigationCompleted`.
pub(crate) fn classify_url(url: &str) -> (PageKind, String) {
    let u = url.trim();
    if u.is_empty()
        || u.starts_with("about:")
        || u.starts_with("data:")
        || u.starts_with("chrome-error:")
        || u.starts_with("edge-error:")
    {
        let rotulo: String = if u.is_empty() {
            "(vazio)".into()
        } else {
            u.chars().take(40).collect()
        };
        return (PageKind::Blank, rotulo);
    }
    let origem = match u.find("://") {
        Some(i) => {
            let resto = &u[i + 3..];
            let fim = resto.find('/').unwrap_or(resto.len());
            format!("{}://{}", &u[..i], &resto[..fim])
        }
        None => u.chars().take(40).collect(),
    };
    let host = origem.rsplit("://").next().unwrap_or("");
    let kind = if host == "web.whatsapp.com" || host.ends_with(".web.whatsapp.com") {
        PageKind::WhatsApp
    } else {
        PageKind::Other
    };
    (kind, origem)
}

pub(crate) fn is_clock_jump(mono: Duration, wall: Duration) -> bool {
    let skew = if mono > wall { mono - wall } else { wall - mono };
    mono >= CLOCK_JUMP || wall >= CLOCK_JUMP || skew >= CLOCK_SKEW
}

pub(crate) fn prune(fila: &mut VecDeque<Instant>, now: Instant, janela: Duration) -> usize {
    while let Some(t) = fila.front() {
        if now.saturating_duration_since(*t) > janela {
            fila.pop_front();
        } else {
            break;
        }
    }
    fila.len()
}

/// Backoff exponencial entre recuperações: 2, 4, 8… teto 60s.
pub(crate) fn backoff_secs(n: usize) -> u64 {
    2u64.saturating_pow(n.clamp(1, 8) as u32).min(60)
}


/// Timestamp opcional vindo do JS (R12).
///
/// K9: teto de TAMANHO antes de qualquer parse. `parse_from_rfc3339` e
/// `parse::<f64>()` sobre uma string de dezenas de MB vinda da página é CPU
/// gratuita para quem chama do outro lado da ponte.
pub(crate) fn ts_from_js(ts: Option<&Value>, ts_ms: Option<f64>) -> Option<String> {
    // 2020-01-01 .. 2100-01-01, em ms
    const MIN: i64 = 1_577_836_800_000;
    const MAX: i64 = 4_102_444_800_000;

    let mut ms: Option<f64> = ts_ms;
    match ts {
        Some(Value::Number(n)) => ms = n.as_f64().or(ms),
        Some(Value::String(s)) => {
            if s.len() > MAX_TS_LEN {
                return None;
            }
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
                return Some(
                    dt.with_timezone(&chrono::Local)
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, false),
                );
            }
            ms = s.trim().parse::<f64>().ok().or(ms);
        }
        _ => {}
    }
    let ms = ms?;
    if !ms.is_finite() {
        return None;
    }
    let millis = ms as i64;
    if !(MIN..=MAX).contains(&millis) {
        return None;
    }
    chrono::DateTime::from_timestamp_millis(millis).map(|dt| {
        dt.with_timezone(&chrono::Local)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, false)
    })
}
