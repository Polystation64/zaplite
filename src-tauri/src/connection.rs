//! Camada de conexão (T2.1), lado Rust.
//!
//! O bundle.js manda heartbeats (~3s) e cada transição de estado. Aqui:
//! - guardamos o estado corrente (consultável por `get_connection_state`);
//! - gravamos uma linha JSON por transição em `<app_config_dir>\connection.log`
//!   (rotação que PRESERVA o histórico gerado pelo próprio app);
//! - emitimos o evento `zaplite://conn-state` a cada transição;
//! - um watchdog detecta webview zumbi (janela visível e >15s sem heartbeat) e
//!   RENAVEGA a webview para o WhatsApp Web (nível 3);
//! - um detector dedicado pega a página que CARREGOU mas não roda o nosso
//!   bundle (página de erro do WebView2, `about:blank`) em ~10s e renavega.
//!
//! Regras de projeto desta camada, todas consequência de auditoria:
//!
//! * **O nível 3 NUNCA destrói a janela.** `WindowDispatcher::destroy()` do
//!   tauri-runtime-wry 2.11.4 só faz `proxy.send_event(WindowMessage::Destroy)`
//!   (verificado na fonte, `src/lib.rs:2283`): é assíncrono. Destruir e recriar
//!   inline no mesmo closure sempre falhava com `WindowLabelAlreadyExists`,
//!   deixando o app sem janela — e, sem janela, o tao emite `ExitRequested`
//!   (`tauri-runtime-wry/src/lib.rs:4310-4324`) e o processo morre. Como a
//!   janela nunca é destruída, o app não tem como ficar sem janela.
//!   Renavegar resolve o caso real (documento travado/zumbi): o WebView2
//!   recarrega o documento, reaplica os `initialization_script` (o nosso bundle
//!   e a ponte `window.__TAURI__`) e o heartbeat volta. O perfil do WebView2
//!   não é tocado, então a sessão logada sobrevive.
//!
//! * **O laço do watchdog nunca chama getter de dispatcher.** `is_visible()` e
//!   `url()` viram `send_user_message` + `rx.recv()` sem timeout
//!   (`webview_getter!`, mesma fonte): se a UI travar, o watchdog trava junto,
//!   cego justamente para o travamento que ele existe para detectar.
//!   Visibilidade vem de um `AtomicBool` alimentado por quem chama show/hide;
//!   a URL vem de uma sonda que POSTA um closure na thread principal.
//!
//! * **A página é fonte de SINAL, nunca de AUTORIDADE.** Tudo que chega por
//!   `conn_heartbeat`/`conn_transition` vem da origem remota
//!   `https://web.whatsapp.com` (ver `capabilities/remote-whatsapp.json`) e
//!   portanto é escrevível por QUALQUER script daquela página. Estado de link
//!   (CONNECTED/OFFLINE/…) só a página enxerga, então ela reporta; contador de
//!   tentativas, veredito de falha e decisão de recuperação são derivados AQUI,
//!   de eventos que o Rust observa com o próprio relógio. Ver `Tentativas`.
//!
//! O log NUNCA recebe conteúdo de mensagens, nomes de contatos, tokens ou URLs
//! com dados: só nomes de estados, origens (esquema+host) e motivos técnicos.

use serde_json::{json, Value};
use std::collections::VecDeque;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

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
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(60);
/// Silêncio a partir do qual o nível 3 é CONSIDERADO — nunca sozinho. Vale
/// ~1,7x o maior silêncio já medido nesta máquina que terminou em página VIVA
/// (229 s → o teto adaptativo abaixo cobre o resto).
const SILENCIO_ZUMBI: Duration = Duration::from_secs(390);
/// Teto absoluto: nenhuma pausa explicada compra mais espera que isto.
const SILENCIO_TETO: Duration = Duration::from_secs(15 * 60);
/// Intervalo entre heartbeats que merece uma linha de calibração no log
/// (3 batimentos perdidos). É a trilha de evidência deste defeito.
const GAP_NOTAVEL: Duration = Duration::from_secs(9);
/// De quanto em quanto tempo a distribuição medida de intervalos entre
/// heartbeats vai ao log. Uma linha por período: o custo é desprezível e é a
/// única forma de escolher os limiares acima com DADO em vez de palpite.
const CALIBRACAO_TICK: Duration = Duration::from_secs(5 * 60);
/// E3 — um rascunho visto no campo de mensagem segura nível 2/3 por isto,
/// renovado a cada heartbeat que ainda vê texto lá.
const RASCUNHO_JANELA: Duration = Duration::from_secs(45);
/// Teto do adiamento por rascunho: passado isso a recuperação acontece, e o
/// motivo que vai ao badge diz ao usuário o que aconteceu.
const RASCUNHO_ADIAMENTO_MAX: Duration = Duration::from_secs(5 * 60);
const WATCHDOG_TICK: Duration = Duration::from_secs(3);
/// Com que frequência a thread principal é sondada pela URL corrente.
const URL_PROBE_TICK: Duration = Duration::from_secs(3);
/// Tolerância APENAS do boot: a primeira carga do WhatsApp Web foi medida entre
/// 20,2s e 54s pelo auditor. Não se aplica a recuperação (ver `RECOVERY_GRACE`).
const STARTUP_GRACE: Duration = Duration::from_secs(60);
/// Carência depois de uma renavegação do nível 3. É MENOR que a do boot porque
/// o bundle roda em `document-start` (a ponte já responde antes de a interface
/// do WhatsApp montar) e porque o detector de "carregou e não fala" (K12) cobre
/// o caso de página morta em 10s. Menor que o teto do backoff, de propósito:
/// era isso que fazia o backoff nunca decidir nada (K7).
const RECOVERY_GRACE: Duration = Duration::from_secs(30);
/// Carência depois que a janela volta a ficar VISÍVEL (não: ganhar foco).
/// Escondida, o Chromium estrangula timers e o heartbeat rareia.
const VISIBILITY_GRACE: Duration = Duration::from_secs(30);
/// Carência depois de um salto de relógio (retorno de suspensão do Windows).
const WAKE_GRACE: Duration = Duration::from_secs(45);
/// TETO ABSOLUTO de carência acumulada (K3/K7). Encadear recuperação (+60s) →
/// reexibição (+30s) → salto de relógio (+45s) dava ~135s sem NENHUMA
/// recuperação possível. Agora nenhuma combinação passa disto.
const MAX_GRACE_AHEAD: Duration = Duration::from_secs(60);
/// Tick monotônico maior que isto = o processo não rodou nesse intervalo.
const CLOCK_JUMP: Duration = Duration::from_secs(20);
/// Divergência entre o avanço de `Instant` e o de `SystemTime` no mesmo tick.
const CLOCK_SKEW: Duration = Duration::from_secs(10);
/// Trava de segurança: `recovering` nunca fica preso além disso.
const RECOVERY_TIMEOUT: Duration = Duration::from_secs(30);
/// Circuit breaker do nível 3: no máximo N recuperações numa janela de tempo.
const RECOVERY_WINDOW: Duration = Duration::from_secs(10 * 60);
const MAX_RECOVERIES_IN_WINDOW: usize = 5;

/* --- M1/M3: breaker da COMPOSIÇÃO (níveis 1, 2 e 3 no mesmo lugar) ------
   O defeito que este bloco existe para matar: o contador contava ESTADO DO
   LINK, não RECUPERAÇÃO DISPARADA. O nível 2 é um `location.reload()`, todo
   reload passa por STARTING, o contador congelava em `ESTADOS_INDEFINIDOS`, e
   ao voltar o JS lia 0 do Rust e recomeçava do zero. Resultado medido em
   produção, sem nenhum agente na máquina: 8 recargas da tela de QR do usuário
   em 35 min (16:03:49 → 16:39:26), TODAS com `attempts=0` e "tentativa 1".
   Agora quem conta é `decidir_recuperacao`, e ela conta o DISPARO. */
/// Recuperações no MESMO cenário, sem progresso, antes de convergir.
const MAX_DISPAROS_CENARIO: u32 = 3;
/// Recuperações de QUALQUER nível/cenário aceitas numa janela.
const MAX_DISPAROS_JANELA: usize = 6;
/// Primeiro descanso depois de convergir: o app PARA de recuperar e espera.
/// Não é fim de linha — acaba sozinho (M2) e encurta com sinal positivo (M4).
const DESCANSO_CONVERGIDO: Duration = Duration::from_secs(5 * 60);
/// Teto do descanso, por maior que seja a insistência do cenário.
const DESCANSO_MAX: Duration = Duration::from_secs(60 * 60);
/// M2 — teto de tempo do veredito FAILED do Rust. Era `RECOVERY_WINDOW`
/// (10 min) e nada o encurtava: o pior caso media ~10 min sem NENHUMA
/// recuperação possível.
const DESCANSO_FAILED: Duration = Duration::from_secs(5 * 60);
/// M4 — sinal positivo observado pelo RUST (CONNECTED com heartbeat fresco,
/// fora de carência) encurta qualquer descanso para isto.
const REARME_POR_SINAL: Duration = Duration::from_secs(20);
/// M2 — heartbeat CHEGANDO e link reportado ruim por mais que isto: a página
/// está viva e não está se recuperando. Alguma camada precisa agir, e a única
/// que sobra é esta. Maior que o pior backoff do JS (60s) para não atropelar
/// uma recuperação da página que ainda está em curso.
const LINK_MORTO: Duration = Duration::from_secs(90);
/// Intervalo mínimo entre PEDIDOS de recuperação vindos da origem remota.
const PEDIDO_MIN_INTERVALO: Duration = Duration::from_secs(2);
/// Depois de autorizar um nível 2, a carga de documento é ESPERADA por isto —
/// senão o detector de reload não declarado a contaria duas vezes.
const RELOAD_ESPERADO: Duration = Duration::from_secs(30);
/// Página commitada (ou `about:blank`) sem nenhum sinal do bundle por mais que
/// isto = o documento existe mas não é o nosso app rodando.
const BLANK_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_BLANK_RECOVERIES_IN_WINDOW: usize = 5;
/// Sem resposta da thread principal por mais que isto = UI travada.
const MAIN_STUCK: Duration = Duration::from_secs(30);
const LOG_MAX_BYTES: u64 = 1024 * 1024;

/* --- K1: parâmetros do contador derivado ------------------------------- */
/// Mesmo teto do `MAX_ATTEMPTS` do bundle.js: é este número que o JS lê de
/// volta e usa como circuit breaker.
const MAX_ATTEMPTS: u32 = 10;
/// Um episódio ruim só vira "tentativa" depois de PERSISTIR isto, medido pelo
/// relógio do Rust. Um script que pisca de CONNECTED para OFFLINE e volta não
/// consegue inflar o contador.
const ATTEMPT_EPISODE: Duration = Duration::from_secs(5);
/// CONNECTED sustentado por isto zera o contador (espelha `STABLE_OK_MS` do JS).
const STABLE_OK: Duration = Duration::from_secs(15);

/* --- K5: teto da superfície remota ------------------------------------- */
/// Fila de escrita do log. `sync_channel` limitado: a versão anterior usava
/// `mpsc::channel()` ILIMITADO, então um laço da página crescia a fila até a
/// memória acabar.
const LOG_QUEUE_MAX: usize = 512;
/// Janela e teto de transições aceitas da origem remota POR JANELA.
const REMOTE_WINDOW: Duration = Duration::from_secs(60);
const MAX_REMOTE_TRANSITIONS: u32 = 30;
/// Transição idêntica repetida dentro disto não gera linha nova.
const REMOTE_DEDUP: Duration = Duration::from_millis(1500);
/// K9: teto de TAMANHO da string de timestamp vinda da página, antes de
/// qualquer parse.
const MAX_TS_LEN: usize = 64;
/// Quantas linhas geradas pelo próprio app a rotação preserva do trecho velho.
const ROT_LOCAIS_MAX: usize = 1500;

/// Único destino de navegação desta camada.
const WHATSAPP_URL: &str = "https://web.whatsapp.com/";

const STATES: [&str; 8] = [
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
const ESTADOS_RUINS: [&str; 4] = ["OFFLINE", "DEGRADED", "RECONNECTING", "FAILED"];
/// Estados em que o Rust NÃO sabe julgar (boot, QR na tela): o contador de
/// EPISÓDIO congela em vez de contar tentativa ou zerar.
///
/// M1: congelar aqui está certo para episódio de link — e era catastrófico
/// como ÚNICA fonte do contador, porque todo reload passa por STARTING. O
/// contador de RECUPERAÇÃO DISPARADA (`decidir_recuperacao`) não passa por
/// aqui: ele não olha estado nenhum, olha o disparo.
const ESTADOS_INDEFINIDOS: [&str; 4] = ["STARTING", "BOOT", "NEEDS_AUTH", "UNKNOWN"];

/// Rótulos de cenário aceitos. A página escolhe o rótulo, então ele é
/// whitelist: cenário desconhecido vira "outro" e cai no MESMO balde, o que só
/// torna a convergência mais rápida — nunca mais lenta.
const CENARIOS: [&str; 9] = [
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

fn cenario_valido(s: &str) -> String {
    if CENARIOS.contains(&s) {
        s.to_string()
    } else {
        "outro".into()
    }
}

/// Classificação da página corrente. Guardamos isto, nunca a URL completa.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum PageKind {
    /// `about:blank`, `data:`, vazio: a navegação não commitou um documento
    /// nosso. **No WebView2 a página de ERRO não cai aqui** — ver `K12` e o
    /// detector `carregou_mudo`.
    Blank,
    WhatsApp,
    Other,
}

impl PageKind {
    fn as_str(self) -> &'static str {
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
enum Saude {
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
struct Tentativas {
    valor: u32,
    ruim_desde: Option<Instant>,
    episodio_contado: bool,
    bom_desde: Option<Instant>,
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
    fn observar(&mut self, now: Instant, saude: Saude) -> Option<&'static str> {
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
    fn conta_recuperacao(&mut self) {
        if self.valor < MAX_ATTEMPTS {
            self.valor += 1;
        }
        self.episodio_contado = true;
        self.bom_desde = None;
    }
}

struct Inner {
    /// Estado EFETIVO (reconciliado). É o que vai ao log, ao evento e ao
    /// `get_connection_state`. Ver `reconciliar` (K6).
    state: String,
    /// Último estado REPORTADO pela página. Sinal, não veredito.
    page_state: String,
    reason: String,
    since_ms: u64,

    /// Contador derivado pelo Rust (K1).
    tent: Tentativas,
    /// Valor que a página informou por último. Diagnóstico apenas.
    attempts_reported: u32,

    last_heartbeat: Option<Instant>,

    /* --- E1/E2: distinguir "JS congelou" de "webview morreu" ------------- */
    /// E2 — maior pausa que a PRÓPRIA página relatou (salto entre execuções do
    /// seu tique de 1s). Um atraso EXPLICADO não é zumbi, e o limiar de morte
    /// se calibra por ele: ver `limiar_zumbi`.
    maior_pausa_js: Duration,
    /// Quando a última pausa auto-declarada chegou (para não valer para sempre).
    pausa_js_em: Option<Instant>,
    /// Distribuição medida dos intervalos entre heartbeats NESTA máquina.
    hb_total: u64,
    hb_max: Duration,
    hb_soma: Duration,
    hb_acima_9s: u64,
    hb_acima_30s: u64,
    hb_acima_60s: u64,
    calibracao_em: Option<Instant>,
    /// Já logamos o silêncio do episódio corrente? (uma linha por episódio,
    /// não uma a cada tick de 3s).
    silencio_logado: bool,

    /* --- E3: o que o usuário digitou não se joga fora -------------------- */
    /// Até quando um rascunho visto no campo de mensagem segura nível 2/3.
    rascunho_ate: Option<Instant>,
    /// Desde quando estamos adiando por causa do rascunho (tem teto).
    adiando_desde: Option<Instant>,
    /// A próxima recuperação autorizada vai acontecer POR CIMA de um rascunho:
    /// o motivo precisa dizer isso ao usuário.
    rascunho_em_risco: bool,

    /// Nenhuma recuperação antes deste instante. Unifica TODAS as carências,
    /// sempre com semântica de MÁXIMO e sempre com teto (`MAX_GRACE_AHEAD`).
    grace_until: Instant,

    /// Trava anti-corrida: impede o watchdog de disparar duas recuperações.
    recovering: bool,
    recovering_since: Option<Instant>,

    recoveries: VecDeque<Instant>,
    blank_recoveries: VecDeque<Instant>,
    recoveries_total: u32,
    hold_until: Option<Instant>,
    blank_hold_until: Option<Instant>,

    /* M1/M3 — breaker da COMPOSIÇÃO: toda recuperação disparada, de qualquer
       nível e de qualquer camada, passa por aqui. */
    /// Instantes de TODAS as recuperações disparadas (níveis 1, 2 e 3).
    disparos: VecDeque<Instant>,
    /// Rótulo do cenário da última recuperação autorizada.
    cenario: String,
    /// Quantas recuperações seguidas no MESMO cenário sem progresso.
    cenario_disparos: u32,
    /// Convergiu: nenhuma recuperação até aqui, em nenhum nível. Só espera.
    descanso_ate: Option<Instant>,
    /// Quantas vezes já convergimos sem NENHUM sucesso no meio. Cada uma
    /// dobra o descanso: é isto que impede o app de voltar a recarregar em
    /// ritmo constante para sempre. Só sucesso sustentado zera.
    convergencias: u32,
    /// W2 — instantes dos FUROS de carência concedidos a falha comprovada.
    /// Orçamento próprio e pequeno: ver `MAX_FUROS_JANELA`.
    furos: VecDeque<Instant>,
    /// Último pedido vindo da origem remota (anti-rajada).
    ultimo_pedido: Option<Instant>,
    /// Último motivo de recusa já logado (o log não repete recusa igual).
    ultima_recusa: String,
    /// Depois de autorizar um nível 2, a carga seguinte é esperada.
    reload_esperado_ate: Option<Instant>,
    /// Já vimos a primeira carga de documento (a do boot não é recuperação).
    carga_vista: bool,
    /// M2 — desde quando o link é reportado ruim COM heartbeat chegando.
    link_ruim_desde: Option<Instant>,

    /// Veredito de FALHA do Rust (K6). Enquanto valer, o estado efetivo é
    /// FAILED mesmo que o heartbeat seguinte diga outra coisa — e o `check()`
    /// LÊ isto para não recuperar.
    rust_failed_until: Option<Instant>,

    /// Último tick do watchdog nos dois relógios, para detectar salto.
    tick_mono: Instant,
    tick_wall: SystemTime,

    /// Última leitura feita NA thread principal (sonda de URL).
    page: Option<PageKind>,
    page_origin: String,
    page_at: Option<Instant>,
    blank_since: Option<Instant>,
    /// K12: instante do `NavigationCompleted` do WebView2 (via `on_page_load`).
    loaded_at: Option<Instant>,
    loaded_origin: String,
    main_stuck_logged: bool,

    visible_since: Option<Instant>,

    /* K5 — controle da vazão remota */
    remote_window_start: Instant,
    remote_count: u32,
    remote_suppressed: u32,
    last_remote_sig: Option<String>,
    last_remote_at: Option<Instant>,
}

pub struct ConnMonitor {
    inner: Mutex<Inner>,
    started: Instant,
    /// Visibilidade da janela main SEM IPC bloqueante.
    visible: AtomicBool,
    /// Idem para o foco. NÃO concede carência nenhuma (K3).
    focused: AtomicBool,
    /// Espelho lock-free de `recovering`, lido pelo guarda de saída.
    recovering: AtomicBool,
    /// K10: o USUÁRIO pediu para fechar (X, Alt+F4, comando externo). O guarda
    /// de saída nunca ressuscita a janela nesse caso.
    user_exit: AtomicBool,
}

impl Default for ConnMonitor {
    fn default() -> Self {
        let now = Instant::now();
        Self {
            inner: Mutex::new(Inner {
                state: "STARTING".into(),
                page_state: "STARTING".into(),
                reason: "aguardando primeiro heartbeat".into(),
                since_ms: now_ms(),
                tent: Tentativas::default(),
                attempts_reported: 0,
                last_heartbeat: None,
                maior_pausa_js: Duration::ZERO,
                pausa_js_em: None,
                hb_total: 0,
                hb_max: Duration::ZERO,
                hb_soma: Duration::ZERO,
                hb_acima_9s: 0,
                hb_acima_30s: 0,
                hb_acima_60s: 0,
                calibracao_em: None,
                silencio_logado: false,
                rascunho_ate: None,
                adiando_desde: None,
                rascunho_em_risco: false,
                grace_until: now + STARTUP_GRACE,
                recovering: false,
                recovering_since: None,
                recoveries: VecDeque::new(),
                blank_recoveries: VecDeque::new(),
                recoveries_total: 0,
                hold_until: None,
                blank_hold_until: None,
                disparos: VecDeque::new(),
                cenario: String::new(),
                cenario_disparos: 0,
                descanso_ate: None,
                convergencias: 0,
                furos: VecDeque::new(),
                ultimo_pedido: None,
                ultima_recusa: String::new(),
                reload_esperado_ate: None,
                carga_vista: false,
                link_ruim_desde: None,
                rust_failed_until: None,
                tick_mono: now,
                tick_wall: SystemTime::now(),
                page: None,
                page_origin: String::new(),
                page_at: None,
                blank_since: None,
                loaded_at: None,
                loaded_origin: String::new(),
                main_stuck_logged: false,
                visible_since: Some(now),
                remote_window_start: now,
                remote_count: 0,
                remote_suppressed: 0,
                last_remote_sig: None,
                last_remote_at: None,
            }),
            started: now,
            visible: AtomicBool::new(true),
            focused: AtomicBool::new(true),
            recovering: AtomicBool::new(false),
            user_exit: AtomicBool::new(false),
        }
    }
}

/// `lock()` que sobrevive a mutex envenenado.
fn lock_inner(mon: &ConnMonitor) -> MutexGuard<'_, Inner> {
    mon.inner.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn iso_now() -> String {
    chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, false)
}

/// Whitelist de estados: nada fora da lista entra no log ou no estado.
fn valid_state(s: &str) -> String {
    if STATES.contains(&s) {
        s.to_string()
    } else {
        "UNKNOWN".into()
    }
}

fn sanitize_reason(r: &str) -> String {
    r.chars().take(160).collect()
}

/* ------------------------------------------------------------------------ */
/* K4/K5 — UM ÚNICO caminho de escrita, serializado                          */
/* ------------------------------------------------------------------------ */

/// Portão de escrita. **Todo** byte que entra no `connection.log` passa por
/// aqui, venha da thread `zaplite-connlog` ou da escrita síncrona de fim de
/// vida. Antes havia dois handles append independentes e `writeln!` fazia DUAS
/// escritas (conteúdo + '\n'), então os pares se intercalavam e o arquivo saía
/// com dois JSON na mesma linha e uma linha vazia logo abaixo — observado em 3
/// de 12 fechamentos, justamente na telemetria de fim de vida.
///
/// Agora: um mutex de processo, e cada linha é UM `write_all` com o '\n' já
/// dentro do buffer. A rotação (que trunca) roda sob o mesmo mutex, então
/// nenhuma escrita se perde no meio dela.
static LOG_GATE: Mutex<()> = Mutex::new(());
static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
static LOG_TX: OnceLock<SyncSender<String>> = OnceLock::new();
static LOG_DROPPED: AtomicU32 = AtomicU32::new(0);

fn contem(agulha: &[u8], palheiro: &[u8]) -> bool {
    if palheiro.is_empty() || agulha.len() < palheiro.len() {
        return false;
    }
    agulha.windows(palheiro.len()).any(|w| w == palheiro)
}

/// Linha gerada pelo PRÓPRIO app (watchdog, ciclo de vida da janela). São as
/// que a rotação protege: é o histórico de diagnóstico.
fn linha_local(l: &[u8]) -> bool {
    contem(l, br#""src":"app""#)
}

/// Rotação como função PURA, para poder ser testada.
///
/// A versão anterior cortava o arquivo na metade e jogava fora o começo. Com a
/// página conseguindo 3,8 transições por segundo (medido), ~20 min de rede
/// instável (ou um laço hostil) APAGAVAM todo o histórico: negação de serviço
/// sobre a própria observabilidade. Agora o trecho descartado é filtrado — as
/// linhas do app sobrevivem (até `ROT_LOCAIS_MAX`), as da página é que saem.
fn rotacionar_conteudo(content: &[u8], max: u64) -> Option<Vec<u8>> {
    if content.len() as u64 <= max {
        return None;
    }
    let mut cut = content.len() / 2;
    while cut < content.len() && content[cut] != b'\n' {
        cut += 1;
    }
    if cut < content.len() {
        cut += 1; // consome a própria quebra
    }
    let (cabeca, cauda) = content.split_at(cut.min(content.len()));
    let mut locais: Vec<&[u8]> = cabeca
        .split(|b| *b == b'\n')
        .filter(|l| !l.is_empty() && linha_local(l))
        .collect();
    if locais.len() > ROT_LOCAIS_MAX {
        locais.drain(..locais.len() - ROT_LOCAIS_MAX);
    }
    let mut out = Vec::with_capacity(cauda.len() + locais.len() * 200);
    for l in locais {
        out.extend_from_slice(l);
        out.push(b'\n');
    }
    out.extend_from_slice(cauda);
    Some(out)
}

/// Só pode ser chamada com `LOG_GATE` na mão.
fn rotacionar_travado(path: &Path) {
    let Ok(meta) = fs::metadata(path) else { return };
    if meta.len() <= LOG_MAX_BYTES {
        return;
    }
    let Ok(content) = fs::read(path) else { return };
    let Some(novo) = rotacionar_conteudo(&content, LOG_MAX_BYTES) else {
        return;
    };
    // grava num temporário e renomeia: nunca existe um instante com o log
    // truncado no disco (o `fs::write` truncante da versão anterior perdia
    // qualquer escrita que caísse no meio).
    let tmp = path.with_extension("log.tmp");
    if fs::write(&tmp, &novo).is_ok() {
        let _ = fs::rename(&tmp, path);
    }
}

/// O ÚNICO ponto de escrita do arquivo.
fn escrever_linha(path: &Path, linha: &str) {
    let _g = LOG_GATE.lock().unwrap_or_else(|e| e.into_inner());
    rotacionar_travado(path);
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(path) {
        // uma linha = UMA escrita (o '\n' vai junto no mesmo buffer)
        let mut buf = String::with_capacity(linha.len() + 1);
        buf.push_str(linha);
        buf.push('\n');
        let _ = f.write_all(buf.as_bytes());
        let _ = f.flush();
    }
}

fn log_path(app: &AppHandle) -> Option<&'static PathBuf> {
    if let Some(p) = LOG_PATH.get() {
        return Some(p);
    }
    let dir = app.path().app_config_dir().ok()?;
    let _ = fs::create_dir_all(&dir);
    let _ = LOG_PATH.set(dir.join("connection.log"));
    LOG_PATH.get()
}

fn log_sender(app: &AppHandle) -> Option<&'static SyncSender<String>> {
    if let Some(tx) = LOG_TX.get() {
        return Some(tx);
    }
    let path = log_path(app)?.clone();
    // K5: fila LIMITADA. Cheia, a linha é descartada e contada — nunca bloqueia
    // o chamador nem cresce sem teto.
    let (tx, rx) = sync_channel::<String>(LOG_QUEUE_MAX);
    std::thread::Builder::new()
        .name("zaplite-connlog".into())
        .spawn(move || {
            while let Ok(line) = rx.recv() {
                let d = LOG_DROPPED.swap(0, Ordering::SeqCst);
                if d > 0 {
                    escrever_linha(
                        &path,
                        &json!({
                            "ts": iso_now(),
                            "prev": "UNKNOWN",
                            "state": "UNKNOWN",
                            "reason": format!("{d} linhas de log descartadas (fila cheia, teto {LOG_QUEUE_MAX})"),
                            "note": true,
                            "src": "app",
                        })
                        .to_string(),
                    );
                }
                escrever_linha(&path, &line);
            }
        })
        .ok()?;
    let _ = LOG_TX.set(tx);
    LOG_TX.get()
}

fn append_log(app: &AppHandle, line: String) {
    if let Some(tx) = log_sender(app) {
        if let Err(TrySendError::Full(_)) = tx.try_send(line) {
            LOG_DROPPED.fetch_add(1, Ordering::SeqCst);
        }
    }
}

/// Escrita SÍNCRONA, só para os caminhos de fim de vida do processo: a thread
/// escritora é background e morre junto com o processo, então uma linha
/// enfileirada às vésperas da saída simplesmente não seria gravada.
/// Usa o MESMO `escrever_linha` da thread — portanto o mesmo mutex, a mesma
/// escrita única. É isso que mata a corrupção sem perder a garantia de entrega.
fn note_sync(app: &AppHandle, state: &str, attempts: u32, reason: &str) {
    let Some(path) = log_path(app) else { return };
    let line = json!({
        "ts": iso_now(),
        "prev": state,
        "state": state,
        "reason": sanitize_reason(reason),
        "attempts": attempts,
        "note": true,
        "src": "app",
    })
    .to_string();
    escrever_linha(path, &line);
}

/// Linha de diagnóstico que NÃO é transição.
/// K11: `attempts` é o valor REAL (antes era `0` fixo, e notas com `attempts:0`
/// no meio de linhas com `attempts:6` corrompiam qualquer agregação).
fn note(app: &AppHandle, state: &str, attempts: u32, reason: &str) {
    let line = json!({
        "ts": iso_now(),
        "prev": state,
        "state": state,
        "reason": sanitize_reason(reason),
        "attempts": attempts,
        "note": true,
        "src": "app",
    });
    append_log(app, line.to_string());
}

#[allow(clippy::too_many_arguments)]
fn log_and_emit(
    app: &AppHandle,
    prev: &str,
    state: &str,
    reason: &str,
    attempts: u32,
    since_ms: u64,
    ts: Option<String>,
    src: &str,
) {
    let line = json!({
        "ts": ts.unwrap_or_else(iso_now),
        "prev": prev,
        "state": state,
        "reason": reason,
        "attempts": attempts,
        "src": src,
    });
    append_log(app, line.to_string());
    let _ = app.emit(
        "zaplite://conn-state",
        json!({ "state": state, "since": since_ms, "attempts": attempts, "reason": reason }),
    );
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
fn classify_url(url: &str) -> (PageKind, String) {
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

fn is_clock_jump(mono: Duration, wall: Duration) -> bool {
    let skew = if mono > wall { mono - wall } else { wall - mono };
    mono >= CLOCK_JUMP || wall >= CLOCK_JUMP || skew >= CLOCK_SKEW
}

fn prune(fila: &mut VecDeque<Instant>, now: Instant, janela: Duration) -> usize {
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
fn backoff_secs(n: usize) -> u64 {
    2u64.saturating_pow(n.clamp(1, 8) as u32).min(60)
}

/// K7 — semântica ÚNICA de carência: máximo com o que já existe, e teto
/// absoluto em `MAX_GRACE_AHEAD` a partir de agora.
///
/// Antes havia duas semânticas no mesmo campo: `:585` fazia máximo e `:777`
/// SOBRESCREVIA. Pior, o encadeamento não tinha teto.
fn nova_carencia(atual: Instant, now: Instant, dur: Duration) -> Instant {
    let alvo = now + dur;
    let escolhido = if alvo > atual { alvo } else { atual };
    let teto = now + MAX_GRACE_AHEAD;
    if escolhido > teto {
        teto
    } else {
        escolhido
    }
}

fn estender_carencia(i: &mut Inner, now: Instant, dur: Duration) {
    i.grace_until = nova_carencia(i.grace_until, now, dur);
}

/* ------------------------------------------------------------------------ */
/* M1/M3 — a autoridade única sobre DISPARAR recuperação                      */
/* ------------------------------------------------------------------------ */

/// Veredito de um pedido de recuperação.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Veredito {
    pub permitido: bool,
    pub espera: Duration,
    pub motivo: String,
    /// Contador de recuperações DISPARADAS depois desta decisão.
    pub tentativa: u32,
    pub convergiu: bool,
    /// Classe da decisão, ESTÁVEL entre ticks (o `motivo` tem o tempo que
    /// falta, então muda sempre). É por esta chave que o log evita repetir a
    /// mesma recusa milhares de vezes.
    pub chave: &'static str,
}

/// Decide — e CONTA — uma recuperação, em qualquer nível e de qualquer camada.
///
/// Esta função é o breaker que faltava na COMPOSIÇÃO. Antes, o JS tinha um
/// contador (zerado por todo reload, porque vinha do Rust congelado) e o Rust
/// tinha outro (que só o nível 3 movia). Nenhum dos dois via o total, e a
/// composição recarregava para sempre. Agora existe um só, aqui, e ele:
///
///  * conta o DISPARO, nunca o estado do link (`conta_recuperacao`);
///  * é imune ao `location.reload()`, porque mora no processo;
///  * não aceita número da página — a página só consegue PEDIR, e pedir demais
///    apenas antecipa a convergência (falha para o lado de parar, não para o
///    lado de recarregar);
///  * converge: `MAX_DISPAROS_CENARIO` no mesmo cenário sem progresso e o app
///    para de recuperar e passa a esperar.
/// W2 — quanto tempo a ação de recuperação precisa para MOSTRAR efeito, por
/// cenário. Sem isto o orçamento do cenário queima antes de a ação agir.
fn piso_de_espera(cen: &str) -> Duration {
    match cen {
        // fechar o socket implicado e cutucar a reconexão: o WhatsApp precisa
        // reabrir o socket e drenar a fila antes de valer a pena tentar de novo.
        "envio-preso" | "link-morto" => Duration::from_secs(20),
        _ => Duration::ZERO,
    }
}

/// W2 — quanto tempo um furo de carência vale como orçamento.
const FUROS_JANELA: Duration = Duration::from_secs(10 * 60);
/// E quantos cabem nela. Dois, de propósito: o suficiente para atravessar um
/// retorno de suspensão (o momento em que a carência e a falha real colidem) e
/// pouco o bastante para que um sinal falso repetido não vire laço — o terceiro
/// pedido volta a esperar a carência inteira.
const MAX_FUROS_JANELA: usize = 2;

/// W2 — "silêncio suspeito" e "falha comprovada" não são a mesma coisa.
///
/// A carência (boot, reexibição, retorno de suspensão) existe porque, logo
/// depois desses eventos, TUDO parece quebrado por alguns segundos: sockets
/// ainda não reabriram, a árvore ainda não montou, o relógio deu salto. Sinal
/// nascido de AUSÊNCIA — silêncio do servidor, envio sem resposta, tela que não
/// ficou pronta — não distingue "morto" de "ainda subindo", e por isso tem de
/// respeitar a carência.
///
/// Só que em 16/08 22:19:42, cinco segundos depois de um retorno de suspensão,
/// a página reportou `websocket fechado sem retomada` — um fato POSITIVO,
/// medido, não uma ausência — e a resposta foi
/// `recuperação nível 1 NEGADA: backoff em curso: faltam 39s`. A carência
/// bloqueou a única ação que resolveria, exatamente no instante de maior
/// probabilidade de conexão zumbi; o usuário ficou 4 minutos com a mensagem
/// presa e o app dizendo CONNECTED.
///
/// Sinal POSITIVO de falha é diferente: ele afirma um fato observado no lado do
/// usuário — o socket fechou e não voltou, a fila de envio não drena, a
/// mensagem está na tela com relógio. Esses furam a carência, e só eles.
///
/// O que o furo NÃO faz, para não desmontar a convergência (que foi quem matou
/// o laço de reload):
///  * não vale para nível 2 (reload) — só para o nível 1, a ação mais branda;
///  * não fura descanso pós-convergência, veredito FAILED, anti-rajada, nem o
///    teto por cenário/janela: tudo isso continua valendo e continua contando;
///  * tem orçamento PRÓPRIO (`MAX_FUROS_JANELA` em `FUROS_JANELA`), então um
///    sinal positivo falso e repetido converge como qualquer outro em vez de
///    reabrir o laço.
fn falha_comprovada_fura(i: &mut Inner, now: Instant, nivel: u32, comprovada: bool) -> bool {
    if !comprovada || nivel != 1 {
        return false;
    }
    let usados = prune(&mut i.furos, now, FUROS_JANELA);
    if usados >= MAX_FUROS_JANELA {
        return false;
    }
    i.furos.push_back(now);
    true
}

fn decidir_recuperacao(
    i: &mut Inner,
    now: Instant,
    nivel: u32,
    cenario: &str,
    remoto: bool,
    comprovada: bool,
) -> Veredito {
    let cen = cenario_valido(cenario);
    let nega = |i: &Inner, espera: Duration, motivo: String, convergiu: bool, chave| Veredito {
        permitido: false,
        espera,
        motivo,
        tentativa: i.tent.valor,
        convergiu,
        chave,
    };

    // 1. anti-rajada: só para quem vem da origem remota. O watchdog tem tick
    //    fixo de 3s e não precisa ser contido por isto.
    if remoto {
        if let Some(t) = i.ultimo_pedido {
            let desde = now.saturating_duration_since(t);
            if desde < PEDIDO_MIN_INTERVALO {
                return nega(
                    i,
                    PEDIDO_MIN_INTERVALO - desde,
                    "pedidos de recuperação em rajada: ignorado".into(),
                    false,
                    "rajada",
                );
            }
        }
        i.ultimo_pedido = Some(now);
    }

    /* 1b. E3 — NUNCA descartar o que o usuário digitou.
       Níveis 2 (reload) e 3 (renavegação) destroem o documento; o que estiver
       no campo de mensagem e não tiver sido enviado morre junto. O relato é
       exatamente esse: "eu estou escrevendo e enviando e a msg nem aparece na
       conversa". Enquanto houver texto lá, a recuperação ESPERA.
       O adiamento tem teto (`RASCUNHO_ADIAMENTO_MAX`): um rascunho esquecido
       na tela não pode desligar a recuperação para sempre. Quando o teto
       vence, a recuperação acontece — mas marcada, para que o motivo que vai
       ao badge diga ao usuário o que houve. */
    if nivel >= 2 {
        let segurando = i.rascunho_ate.map(|r| now < r).unwrap_or(false);
        if segurando {
            let desde = *i.adiando_desde.get_or_insert(now);
            let adiado = now.saturating_duration_since(desde);
            if adiado < RASCUNHO_ADIAMENTO_MAX {
                let falta = i
                    .rascunho_ate
                    .map(|r| r.saturating_duration_since(now))
                    .unwrap_or(RASCUNHO_JANELA);
                return nega(
                    i,
                    falta,
                    format!(
                        "há texto não enviado no campo de mensagem: nível {nivel} adiado há {}s (teto {}s) — recarregar por cima apagaria o que o usuário escreveu",
                        adiado.as_secs(),
                        RASCUNHO_ADIAMENTO_MAX.as_secs()
                    ),
                    false,
                    "rascunho",
                );
            }
            // Teto vencido: segue, mas o usuário será avisado.
            i.rascunho_em_risco = true;
        }
        i.adiando_desde = None;
    }

    // 2. convergiu antes: o app está descansando, e descansar é a decisão.
    if let Some(d) = i.descanso_ate {
        if now < d {
            let falta = d.saturating_duration_since(now);
            return nega(
                i,
                falta,
                format!(
                    "em descanso após convergir no cenário '{}': faltam {}s",
                    i.cenario,
                    falta.as_secs()
                ),
                true,
                "descanso",
            );
        }
        // Descanso vencido: o app volta a tentar — mas com UMA tentativa,
        // não com o orçamento inteiro. Se ela também não resolver, converge
        // de novo e o próximo descanso é o dobro.
        i.descanso_ate = None;
        i.cenario_disparos = MAX_DISPAROS_CENARIO.saturating_sub(1);
    }

    // 3. veredito FAILED do Rust (tem teto de tempo — ver M2).
    if let Some(f) = i.rust_failed_until {
        if now < f {
            let falta = f.saturating_duration_since(now);
            return nega(
                i,
                falta,
                format!("veredito FAILED do Rust ainda vale por {}s", falta.as_secs()),
                false,
                "failed",
            );
        }
    }

    // 4. backoff global entre recuperações — e a carência mora no MESMO campo.
    //    W2: é aqui que a falha comprovada fura, e só aqui. Os passos 1, 2, 3,
    //    5 e 6 acima/abaixo continuam intocados: o furo compra UM nível 1, não
    //    imunidade.
    let mut furou = None;
    if let Some(h) = i.hold_until {
        if now < h {
            let falta = h.saturating_duration_since(now);
            if falha_comprovada_fura(i, now, nivel, comprovada) {
                furou = Some(falta);
            } else {
                return nega(
                    i,
                    falta,
                    format!(
                        "backoff em curso: faltam {}s{}",
                        falta.as_secs(),
                        if comprovada {
                            format!(
                                " (falha comprovada, mas o orçamento de {MAX_FUROS_JANELA} furos da janela acabou)"
                            )
                        } else {
                            String::new()
                        }
                    ),
                    false,
                    "backoff",
                );
            }
        }
    }

    // 5. cenário: um problema DIFERENTE merece orçamento próprio — mas só
    //    enquanto ainda não convergimos nenhuma vez. Depois da primeira
    //    convergência sem sucesso, trocar o rótulo não compra orçamento novo:
    //    senão bastaria alternar o cenário a cada pedido para voltar a
    //    recarregar sem parar (medido: 8 recargas/hora com rótulo alternado).
    //    Quem devolve o orçamento cheio é o sucesso sustentado, e só ele.
    if i.cenario != cen {
        i.cenario = cen.clone();
        if i.convergencias == 0 {
            i.cenario_disparos = 0;
        }
    }
    if i.cenario_disparos >= MAX_DISPAROS_CENARIO {
        i.convergencias = i.convergencias.saturating_add(1);
        let descanso = descanso_de(i.convergencias);
        i.descanso_ate = Some(now + descanso);
        return nega(
            i,
            descanso,
            format!(
                "convergiu ({}ª vez): {} recuperações no cenário '{cen}' sem progresso; insistir não conserta, aguardando {}s",
                i.convergencias,
                i.cenario_disparos,
                descanso.as_secs()
            ),
            true,
            "convergiu-cenario",
        );
    }

    // 6. teto global da janela, somando TODOS os níveis.
    let n = prune(&mut i.disparos, now, RECOVERY_WINDOW);
    if n >= MAX_DISPAROS_JANELA {
        i.convergencias = i.convergencias.saturating_add(1);
        let descanso = descanso_de(i.convergencias);
        i.descanso_ate = Some(now + descanso);
        return nega(
            i,
            descanso,
            format!(
                "convergiu ({}ª vez): {n} recuperações de todos os níveis em {} min; aguardando {}s",
                i.convergencias,
                RECOVERY_WINDOW.as_secs() / 60,
                descanso.as_secs()
            ),
            true,
            "convergiu-janela",
        );
    }

    // 7. autorizado — e CONTADO aqui, não onde a recuperação acontece.
    i.cenario_disparos += 1;
    i.disparos.push_back(now);
    i.tent.conta_recuperacao();
    i.link_ruim_desde = None;
    /* W2 — PISO DE ESPERA POR CENÁRIO. Medido ao vivo em 16/08 23:19, com a
       detecção de "envio preso" já funcionando: o backoff é 2s, 4s, 8s, então
       o app disparou os TRÊS níveis 1 do cenário em SEIS SEGUNDOS e convergiu
       para FAILED antes que o primeiro cutucão tivesse qualquer chance de
       fazer efeito. Convergir é certo; convergir em 6s é só desistir depressa.
       Um cutucão de nível 1 precisa do tempo de o WhatsApp reabrir o socket e
       drenar a fila — dezenas de segundos, não dois. */
    let espera = Duration::from_secs(backoff_secs(i.cenario_disparos as usize))
        .max(piso_de_espera(&cen));
    let alvo = now + espera;
    if i.hold_until.map(|h| alvo > h).unwrap_or(true) {
        i.hold_until = Some(alvo);
    }
    if nivel >= 2 {
        // o reload é esperado: não pode ser contado de novo como carga não
        // declarada, e a página nova precisa de carência para subir.
        i.reload_esperado_ate = Some(now + RELOAD_ESPERADO);
        estender_carencia(i, now, RECOVERY_GRACE);
    }
    Veredito {
        permitido: true,
        espera,
        motivo: format!(
            "nível {nivel} autorizado no cenário '{cen}' ({}/{} do cenário){}",
            i.cenario_disparos,
            MAX_DISPAROS_CENARIO,
            match furou {
                Some(falta) => format!(
                    " [falha COMPROVADA furou {}s de carência/backoff; furo {}/{} da janela de {} min]",
                    falta.as_secs(),
                    i.furos.len(),
                    MAX_FUROS_JANELA,
                    FUROS_JANELA.as_secs() / 60
                ),
                None => String::new(),
            }
        ),
        tentativa: i.tent.valor,
        convergiu: false,
        chave: "autorizado",
    }
}

/// M3 — descanso da n-ésima convergência SEM nenhum sucesso no meio.
///
/// Isto é o que faz a recuperação CONVERGIR de verdade, e a primeira versão
/// desta correção não tinha: com descanso fixo e orçamento renovado, o app
/// voltava a recarregar 3 vezes a cada 5 min — mais do que o defeito original
/// (8 recargas em 35 min). Dobrando o descanso a cada convergência e liberando
/// UMA tentativa por descanso, a frequência tende a zero enquanto o problema
/// não muda; qualquer sucesso sustentado zera tudo (ver `observar`).
fn descanso_de(convergencias: u32) -> Duration {
    let n = convergencias.saturating_sub(1).min(8);
    let d = DESCANSO_CONVERGIDO.saturating_mul(1u32 << n);
    if d > DESCANSO_MAX {
        DESCANSO_MAX
    } else {
        d
    }
}

/// Uma carga de documento foi PEDIDA por esta camada?
///
/// M1: só a carga do boot, a da renavegação do watchdog e a do nível 2 já
/// autorizado são esperadas. Qualquer outra é um `location.reload()` que a
/// página deu por conta própria — e isso É uma recuperação, avisada ou não.
fn carga_esperada(i: &Inner, now: Instant, primeira: bool) -> bool {
    primeira
        || i.recovering
        || i.reload_esperado_ate.map(|t| now < t).unwrap_or(false)
}

/// M4 — sinal positivo OBSERVADO PELO RUST encurta todo descanso.
///
/// `hold_until` e `rust_failed_until` eram fixados em `now + 10min` e nada os
/// rearmava: rede de volta, heartbeat saudável e tráfego não mudavam nada, e o
/// pior caso media ~10 minutos sem NENHUMA recuperação possível. Agora o
/// primeiro tick com saúde boa puxa todos os prazos para `REARME_POR_SINAL`.
fn rearmar_por_sinal(i: &mut Inner, now: Instant) -> bool {
    let alvo = now + REARME_POR_SINAL;
    let mut mudou = false;
    for campo in [
        &mut i.hold_until,
        &mut i.blank_hold_until,
        &mut i.descanso_ate,
        &mut i.rust_failed_until,
    ] {
        if let Some(t) = *campo {
            if t > alvo {
                *campo = Some(alvo);
                mudou = true;
            }
        }
    }
    mudou
}

/// K6 — quem manda em quê.
///
/// * A PÁGINA é autoridade sobre o estado do link: só ela vê os WebSockets.
/// * O RUST é autoridade sobre o veredito de FALHA (circuit breaker) e sobre o
///   contador. Enquanto o veredito do Rust vale, ele PREVALECE — a única coisa
///   que o derruba é a página reportar `CONNECTED`, que é exatamente o sinal de
///   que o problema acabou.
///
/// Antes, `conn_heartbeat` fazia `i.state = valid_state(state)` sem logar, e o
/// `FAILED` que `falhar()` tinha acabado de gravar sumia da memória ≤3s depois:
/// o Rust dizia FAILED no log e RECONNECTING na memória, no mesmo instante.
fn reconciliar(page_state: &str, veredito_ativo: bool) -> String {
    if veredito_ativo && page_state != "CONNECTED" {
        "FAILED".to_string()
    } else {
        page_state.to_string()
    }
}

/// K1 — como o Rust julga a saúde neste tick, sem acreditar em número nenhum
/// vindo da página.
/// E1/E2 — a partir de quanto silêncio o nível 3 pode SEQUER ser considerado.
///
/// Base fixa (`SILENCIO_ZUMBI`) mais um termo adaptativo: 2x a maior pausa que
/// a própria página ADMITIU ter sofrido (E2). Se o JS desta máquina congela por
/// 3 minutos numa coleta maior, o app aprende isso com o dado e para de chamar
/// de morte o que é pausa. A pausa só calibra enquanto for recente — uma pausa
/// de ontem não compra tolerância hoje.
fn limiar_zumbi(i: &Inner, now: Instant) -> Duration {
    let recente = i
        .pausa_js_em
        .map(|t| now.saturating_duration_since(t) <= SILENCIO_TETO)
        .unwrap_or(false);
    let adaptativo = if recente {
        i.maior_pausa_js.saturating_mul(2)
    } else {
        Duration::ZERO
    };
    SILENCIO_ZUMBI.max(adaptativo).min(SILENCIO_TETO)
}

/// E1 — **a corroboração exigida antes de destruir a página.**
///
/// O silêncio do heartbeat, sozinho, não é evidência de nada: ele é
/// consistente com "webview morta" E com "JS congelado por GC", e o log de
/// 17/08 mostra que o segundo caso é o que acontece nesta máquina. Renavegar
/// custa o rascunho do usuário e ~4s de boot do WhatsApp; esperar custa alguns
/// segundos de badge desatualizado. Na dúvida, espera-se.
///
/// Devolve `Some(prova)` só quando há sinal INDEPENDENTE do heartbeat de que a
/// página não existe mais. Nenhum destes sinais vem do JS da página:
///  * a sonda de URL roda na thread PRINCIPAL e diz que o documento corrente
///    não é o nosso (`about:blank`, outra origem);
///  * a página não estava saudável quando emudeceu — quem congela por GC
///    emudece a partir de `CONNECTED`, quem morre normalmente emudece de um
///    estado ruim ou indefinido;
///  * o silêncio passou de qualquer pausa plausível (limiar adaptativo).
///
/// O caso "documento carregou e não fala" tem detector próprio e mais rápido
/// (K12, `carregou_mudo`), que continua intocado: ele age em 10s porque tem
/// prova de verdade — o `NavigationCompleted` do WebView2.
fn evidencia_de_morte(i: &Inner, silencio: Duration, limiar: Duration) -> Option<String> {
    match i.page {
        Some(PageKind::Blank) => {
            return Some("a sonda de URL não vê documento nosso (about:blank/vazio)".into())
        }
        Some(PageKind::Other) => {
            return Some(format!(
                "a sonda de URL vê outra origem ({})",
                i.page_origin
            ))
        }
        _ => {}
    }
    // A partir daqui o documento AINDA é o WhatsApp (ou a sonda nunca rodou).
    // Só o tempo pode decidir, e ele precisa passar do limiar calibrado.
    if silencio < limiar {
        return None;
    }
    if i.page_state == "CONNECTED" {
        // A última coisa que a página disse foi que estava conectada, e o
        // documento continua lá. É a assinatura EXATA da pausa de GC do log de
        // 17/08. Renavegar aqui é o dano — exige-se o dobro do limiar.
        if silencio < limiar.saturating_mul(2).min(SILENCIO_TETO) {
            return None;
        }
        return Some(format!(
            "silêncio de {}s passou do dobro do limiar calibrado ({}s) mesmo com a página tendo reportado CONNECTED",
            silencio.as_secs(),
            limiar.as_secs()
        ));
    }
    Some(format!(
        "silêncio de {}s acima do limiar calibrado ({}s) e o último estado reportado foi {} (não CONNECTED)",
        silencio.as_secs(),
        limiar.as_secs(),
        i.page_state
    ))
}

fn julgar_saude(page_state: &str, heartbeat_fresco: bool, neutro: bool) -> Saude {
    if neutro || ESTADOS_INDEFINIDOS.contains(&page_state) {
        return Saude::Indefinida;
    }
    if !heartbeat_fresco || ESTADOS_RUINS.contains(&page_state) {
        return Saude::Ruim;
    }
    if page_state == "CONNECTED" {
        Saude::Boa
    } else {
        Saude::Indefinida
    }
}

/// Timestamp opcional vindo do JS (R12).
///
/// K9: teto de TAMANHO antes de qualquer parse. `parse_from_rfc3339` e
/// `parse::<f64>()` sobre uma string de dezenas de MB vinda da página é CPU
/// gratuita para quem chama do outro lado da ponte.
fn ts_from_js(ts: Option<&Value>, ts_ms: Option<f64>) -> Option<String> {
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

/// K5 — decisão do limitador de vazão da origem remota.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Vazao {
    Aceita,
    /// Mesma transição repetida em rajada: estado atualiza, log não.
    Duplicada,
    /// Teto da janela estourado.
    Excedeu,
    /// Primeira supressão da janela: vale uma nota única no log.
    ExcedeuPrimeira,
}

fn limitar_remoto(i: &mut Inner, now: Instant, sig: &str) -> Vazao {
    if now.saturating_duration_since(i.remote_window_start) >= REMOTE_WINDOW {
        i.remote_window_start = now;
        i.remote_count = 0;
        i.remote_suppressed = 0;
    }
    if let (Some(anterior), Some(t)) = (i.last_remote_sig.as_deref(), i.last_remote_at) {
        if anterior == sig && now.saturating_duration_since(t) < REMOTE_DEDUP {
            return Vazao::Duplicada;
        }
    }
    i.last_remote_sig = Some(sig.to_string());
    i.last_remote_at = Some(now);
    if i.remote_count >= MAX_REMOTE_TRANSITIONS {
        i.remote_suppressed = i.remote_suppressed.saturating_add(1);
        return if i.remote_suppressed == 1 {
            Vazao::ExcedeuPrimeira
        } else {
            Vazao::Excedeu
        };
    }
    i.remote_count += 1;
    Vazao::Aceita
}

/* ------------------------------------------------------------------------ */
/* Comandos expostos à ponte (assinaturas congeladas + extras opcionais)     */
/* ------------------------------------------------------------------------ */

/// Heartbeat (~3s) vindo do bundle.js com o estado corrente.
///
/// K8: `async` de propósito. Comando síncrono roda na thread da UI, e este é
/// chamável pela origem remota: um laço da página congelava a interface E
/// mantinha `last_heartbeat` fresco, cegando o watchdog exatamente para o
/// travamento que ele próprio estava sofrendo.
///
/// K1: `attempts` é aceito por compatibilidade de assinatura mas NÃO escreve o
/// contador — só o campo informativo, com faixa validada.
/// `paused_ms` e `draft` são OPCIONAIS de propósito: uma página antiga (ou um
/// documento ainda subindo) simplesmente não os manda, e o comportamento cai
/// no conservador. Os dois vêm da origem remota, então os dois são tratados
/// como SINAL, nunca como veredito, e os dois têm teto:
///  * `paused_ms` só consegue empurrar o limiar de zumbi até `SILENCIO_TETO`;
///  * `draft` só consegue adiar recuperação até `RASCUNHO_ADIAMENTO_MAX`.
/// Nenhum dos dois toca no detector K12 (documento mudo), que é o caminho
/// rápido para webview de verdade morta.
#[tauri::command]
pub async fn conn_heartbeat(
    app: AppHandle,
    state: String,
    attempts: u32,
    paused_ms: Option<u64>,
    draft: Option<bool>,
) {
    let st = valid_state(&state);
    let now = Instant::now();
    let mut notas: Vec<String> = Vec::new();
    let (mudou, prev, efetivo, motivo, at, since) = {
        let mon = app.state::<ConnMonitor>();
        let mut i = lock_inner(&mon);

        /* --- E1/E2: medir o intervalo real entre heartbeats --------------- */
        if let Some(anterior) = i.last_heartbeat {
            let gap = now.saturating_duration_since(anterior);
            i.hb_total += 1;
            i.hb_soma += gap;
            if gap > i.hb_max {
                i.hb_max = gap;
            }
            if gap >= GAP_NOTAVEL {
                i.hb_acima_9s += 1;
            }
            if gap >= Duration::from_secs(30) {
                i.hb_acima_30s += 1;
            }
            if gap >= HEARTBEAT_TIMEOUT {
                i.hb_acima_60s += 1;
            }
            if gap >= GAP_NOTAVEL {
                notas.push(format!(
                    "heartbeat voltou depois de {}s de silêncio (a página declara {}s de pausa de JS); estado reportado: {st}",
                    gap.as_secs(),
                    paused_ms.unwrap_or(0) / 1000
                ));
            }
        }
        // E2 — pausa que a PRÓPRIA página admite. Um atraso explicado não é
        // zumbi: é isto que separa "JS congelou por GC" de "webview morreu".
        if let Some(p) = paused_ms {
            let p = Duration::from_millis(p).min(SILENCIO_TETO);
            if p >= GAP_NOTAVEL {
                i.pausa_js_em = Some(now);
                if p > i.maior_pausa_js {
                    i.maior_pausa_js = p;
                    notas.push(format!(
                        "pausa de JS auto-declarada pela página: {}s (recorde desta sessão) — limiar de renavegação recalibrado para {}s",
                        p.as_secs(),
                        limiar_zumbi(&i, now).as_secs()
                    ));
                }
            }
        }
        // E3 — texto não enviado no campo de mensagem segura nível 2/3.
        if draft.unwrap_or(false) {
            i.rascunho_ate = Some(now + RASCUNHO_JANELA);
        }
        // Uma linha por período com a distribuição medida: é o dado que
        // justifica os limiares, e ele fica no log do usuário, não num
        // experimento que sai do release.
        let calibrar = i
            .calibracao_em
            .map(|t| now.saturating_duration_since(t) >= CALIBRACAO_TICK)
            .unwrap_or(true);
        if calibrar && i.hb_total >= 10 {
            i.calibracao_em = Some(now);
            notas.push(format!(
                "calibração do heartbeat: {} intervalos medidos, média {}ms, máximo {}s, >=9s: {}, >=30s: {}, >={}s: {}",
                i.hb_total,
                i.hb_soma.as_millis() as u64 / i.hb_total.max(1),
                i.hb_max.as_secs(),
                i.hb_acima_9s,
                i.hb_acima_30s,
                HEARTBEAT_TIMEOUT.as_secs(),
                i.hb_acima_60s
            ));
        } else if calibrar {
            i.calibracao_em = Some(now);
        }

        i.last_heartbeat = Some(now);
        i.silencio_logado = false;
        i.page_state = st.clone();
        // valor da página: informativo, faixa validada, jamais realimenta.
        i.attempts_reported = attempts.min(MAX_ATTEMPTS * 10);
        i.blank_since = None;

        let veredito = i.rust_failed_until.map(|t| now < t).unwrap_or(false);
        let efetivo = reconciliar(&st, veredito);
        if efetivo == i.state {
            let (s, at) = (i.state.clone(), i.tent.valor);
            drop(i);
            for n in notas {
                note(&app, &s, at, &n);
            }
            return;
        }
        // K6: mudança de estado efetivo NUNCA é silenciosa.
        let prev = std::mem::replace(&mut i.state, efetivo.clone());
        i.reason = sanitize_reason(&format!(
            "reconciliação no heartbeat: página reporta {st}{}",
            if veredito {
                " (veredito FAILED do Rust ainda vale)"
            } else {
                ""
            }
        ));
        i.since_ms = now_ms();
        (
            true,
            prev,
            efetivo,
            i.reason.clone(),
            i.tent.valor,
            i.since_ms,
        )
    };
    for n in notas {
        note(&app, &efetivo, at, &n);
    }
    if mudou {
        log_and_emit(&app, &prev, &efetivo, &motivo, at, since, None, "app");
    }
}

/// Transição de estado detectada na página: uma linha de log por transição.
///
/// `async` porque é chamável pela origem remota. Os parâmetros `ts`/`tsMs` são
/// OPCIONais — o contrato da ponte segue congelado.
#[tauri::command]
pub async fn conn_transition(
    app: AppHandle,
    prev: String,
    state: String,
    reason: String,
    attempts: u32,
    ts: Option<Value>,
    ts_ms: Option<f64>,
    at: Option<f64>,
) {
    let st = valid_state(&state);
    let pv = valid_state(&prev);
    let rs = sanitize_reason(&reason);
    let since = now_ms();
    let carimbo = ts_from_js(ts.as_ref(), ts_ms.or(at));
    let now = Instant::now();

    let (vazao, efetivo, motivo, tentativas, suprimidas) = {
        let mon = app.state::<ConnMonitor>();
        let mut i = lock_inner(&mon);
        let sig = format!("{pv}>{st}:{rs}");
        let vazao = limitar_remoto(&mut i, now, &sig);

        i.page_state = st.clone();
        i.attempts_reported = attempts.min(MAX_ATTEMPTS * 10);
        i.last_heartbeat = Some(now);
        i.blank_since = None;

        let veredito = i.rust_failed_until.map(|t| now < t).unwrap_or(false);
        let efetivo = reconciliar(&st, veredito);
        let motivo = if efetivo != st {
            sanitize_reason(&format!(
                "{rs} [veredito FAILED do Rust prevalece; página reportou {st}]"
            ))
        } else {
            rs.clone()
        };
        let anterior = std::mem::replace(&mut i.state, efetivo.clone());
        i.reason = motivo.clone();
        i.since_ms = since;
        let _ = anterior;
        (
            vazao,
            efetivo,
            motivo,
            i.tent.valor,
            i.remote_suppressed,
        )
    };

    match vazao {
        Vazao::Aceita => log_and_emit(
            &app, &pv, &efetivo, &motivo, tentativas, since, carimbo, "page",
        ),
        Vazao::ExcedeuPrimeira => note(
            &app,
            &efetivo,
            tentativas,
            &format!(
                "limite de vazão da origem remota: >{MAX_REMOTE_TRANSITIONS} transições em {}s; log suprimido até o fim da janela",
                REMOTE_WINDOW.as_secs()
            ),
        ),
        Vazao::Excedeu | Vazao::Duplicada => {
            let _ = suprimidas; // contabilizado; nada vai ao disco
        }
    }
}

/// M1 — a página PEDE para recuperar; quem decide e conta é o Rust.
///
/// Este comando é a peça que faltava na composição. O nível 1 (fechar socket
/// implicado) e o nível 2 (`location.reload()`) moram no JS, e o JS perde toda
/// a memória a cada reload — então ele não pode ser o dono do contador. Aqui:
///
///  * o disparo é contado ANTES de acontecer, no processo que sobrevive ao
///    reload (`decidir_recuperacao`);
///  * a resposta traz o contador REAL, e o JS adota esse número;
///  * quando o cenário não converge, a resposta é `permitido: false` e o JS
///    para de recarregar — em vez de repetir "tentativa 1" para sempre.
///
/// Superfície remota: `nivel` e `cenario` são clampados/whitelistados, os
/// pedidos são limitados por `PEDIDO_MIN_INTERVALO`, e o pior que um script
/// hostil consegue é consumir o orçamento de recuperação — ou seja, empurrar o
/// app para PARAR de recarregar. O erro cai para o lado seguro.
#[tauri::command]
pub async fn conn_recovery(
    app: AppHandle,
    nivel: u32,
    cenario: String,
    reason: Option<String>,
    // W2 — a página marca se o pedido nasce de um FATO OBSERVADO (socket
    // fechado sem retomada, fila de envio que não drena, bolha de saída presa
    // com relógio) ou de uma AUSÊNCIA (silêncio, tela que não ficou pronta).
    // Superfície remota: um script hostil que marque tudo como comprovado
    // ganha, no máximo, `MAX_FUROS_JANELA` níveis 1 (fechar o socket
    // implicado) por janela — e consome o mesmo orçamento de convergência, ou
    // seja, empurra o app para PARAR de recuperar. Erra para o lado seguro.
    comprovada: Option<bool>,
) -> Value {
    let nivel = nivel.clamp(1, 2);
    let now = Instant::now();
    let motivo_pagina = sanitize_reason(reason.as_deref().unwrap_or(""));
    let comprovada = comprovada.unwrap_or(false);

    let (v, cen, logar) = {
        let mon = app.state::<ConnMonitor>();
        let mut i = lock_inner(&mon);
        let v = decidir_recuperacao(&mut i, now, nivel, &cenario, true, comprovada);
        let cen = i.cenario.clone();
        // recusa idêntica não vira linha nova (a página pode pedir em laço).
        let logar = if v.permitido {
            i.ultima_recusa.clear();
            true
        } else if i.ultima_recusa != v.chave {
            i.ultima_recusa = v.chave.to_string();
            true
        } else {
            false
        };
        (v, cen, logar)
    };

    // Y1 — EFEITO da autorização, não parte da decisão (o veredito acima já
    // está fechado e não é tocado aqui). O nível 2 é um `location.reload()`:
    // ele destrói o contexto JS sem passar por `revert()`, então quem tem de
    // fechar os toasts é este lado, que sabe que o reload vem e sobrevive a
    // ele. Sem isto sobram janelas `toast-*` órfãs e always-on-top por cima de
    // um WhatsApp em branco.
    let toasts_fechados = if v.permitido && nivel == 2 {
        crate::notify::fechar_toasts_por_recuperacao(&app)
    } else {
        0
    };

    if logar {
        let estado = {
            let mon = app.state::<ConnMonitor>();
            let i = lock_inner(&mon);
            i.state.clone()
        };
        note(
            &app,
            &estado,
            v.tentativa,
            &format!(
                "recuperação nível {nivel} {}: {} [pedido da página: {motivo_pagina}]{}",
                if v.permitido { "AUTORIZADA" } else { "NEGADA" },
                v.motivo,
                if toasts_fechados > 0 {
                    format!(" [toasts fechados antes do reload: {toasts_fechados}]")
                } else {
                    String::new()
                }
            ),
        );
    }

    json!({
        "permitido": v.permitido,
        "attempts": v.tentativa,
        "esperaMs": v.espera.as_millis() as u64,
        "motivo": v.motivo,
        "convergiu": v.convergiu,
        "cenario": cen,
    })
}

/// Estado corrente, consultável por qualquer janela.
/// K8: `async` — era síncrono, logo rodava na thread da UI.
#[tauri::command]
pub async fn get_connection_state(app: AppHandle) -> Value {
    let mon = app.state::<ConnMonitor>();
    let mut i = lock_inner(&mon);
    let now = Instant::now();
    let recentes = prune(&mut i.recoveries, now, RECOVERY_WINDOW);
    let brancas = prune(&mut i.blank_recoveries, now, RECOVERY_WINDOW);
    let disparos = prune(&mut i.disparos, now, RECOVERY_WINDOW);
    json!({
        "state": i.state,
        "since": i.since_ms,
        // K1: contador DERIVADO PELO RUST. É este valor que o JS lê de volta.
        "attempts": i.tent.valor,
        // o que a página informou, só para diagnóstico
        "attemptsReported": i.attempts_reported,
        "pageState": i.page_state,
        "reason": i.reason,
        "heartbeatAgeMs": i.last_heartbeat.map(|t| t.elapsed().as_millis() as u64),
        "rebuilds": i.recoveries_total,
        "recoveriesInWindow": recentes,
        "blankRecoveriesInWindow": brancas,
        // M1/M3 — o estado do breaker da composição, para o JS dizer a verdade
        // no indicador em vez de inventar "tentativa 1" a cada reload.
        "disparosInWindow": disparos,
        "cenario": i.cenario,
        "cenarioDisparos": i.cenario_disparos,
        "descansoMs": i.descanso_ate.and_then(|t| t.checked_duration_since(now)).map(|d| d.as_millis() as u64).unwrap_or(0),
        "holdMs": i.hold_until.and_then(|t| t.checked_duration_since(now)).map(|d| d.as_millis() as u64).unwrap_or(0),
        "recovering": i.recovering,
        "visible": mon.visible.load(Ordering::SeqCst),
        "focused": mon.focused.load(Ordering::SeqCst),
        "graceMs": i.grace_until.checked_duration_since(now).map(|d| d.as_millis() as u64).unwrap_or(0),
        "breakerMs": i.rust_failed_until.and_then(|t| t.checked_duration_since(now)).map(|d| d.as_millis() as u64).unwrap_or(0),
        "page": i.page.map(|p| p.as_str()),
        "pageOrigin": i.page_origin,
        "loadedAgeMs": i.loaded_at.map(|t| t.elapsed().as_millis() as u64),
        "mainThreadAgeMs": i.page_at.map(|t| t.elapsed().as_millis() as u64),
        "uptimeMs": mon.started.elapsed().as_millis() as u64,
    })
}

/* ------------------------------------------------------------------------ */
/* Sinais vindos do lib.rs (sem IPC bloqueante)                              */
/* ------------------------------------------------------------------------ */

/// Registra que a janela principal passou a ficar visível (ou escondida).
///
/// K3: a carência SÓ é concedida na transição REAL invisível→visível. Antes,
/// qualquer ganho de foco caía aqui e empurrava `grace_until` +30s; o reflexo
/// humano diante de um app travado é clicar nele repetidamente, e cada clique
/// com intervalo <30s suprimia o nível 3 para sempre.
pub fn note_window_visible(app: &AppHandle, visible: bool) {
    let Some(mon) = app.try_state::<ConnMonitor>() else {
        return;
    };
    let anterior = mon.visible.swap(visible, Ordering::SeqCst);
    if !visible {
        mon.focused.store(false, Ordering::SeqCst);
    }
    if anterior == visible {
        // nada mudou de fato: nenhuma carência, nenhuma linha de log.
        return;
    }
    let mut i = lock_inner(&mon);
    let now = Instant::now();
    if visible {
        i.visible_since = Some(now);
        estender_carencia(&mut i, now, VISIBILITY_GRACE);
        let (estado, at) = (i.state.clone(), i.tent.valor);
        drop(i);
        note(
            app,
            &estado,
            at,
            &format!(
                "janela voltou a ficar visível (transição real): carência de até {}s, teto acumulado {}s",
                VISIBILITY_GRACE.as_secs(),
                MAX_GRACE_AHEAD.as_secs()
            ),
        );
    } else {
        i.visible_since = None;
        let (estado, at) = (i.state.clone(), i.tent.valor);
        drop(i);
        note(app, &estado, at, "janela escondida: watchdog em silêncio");
    }
}

/// Registra ganho/perda de foco da janela principal.
///
/// K3: foco é APENAS foco. Não concede carência e não conta como reexibição.
/// A única coisa que ele faz é atualizar o `AtomicBool` que o Ctrl+Shift+W lê.
/// Se a janela estiver marcada como invisível e ganhar foco, isso É uma
/// transição real de visibilidade (o gerenciador de janelas a trouxe de volta),
/// e aí sim `note_window_visible` decide.
pub fn note_window_focus(app: &AppHandle, focused: bool) {
    let Some(mon) = app.try_state::<ConnMonitor>() else {
        return;
    };
    mon.focused.store(focused, Ordering::SeqCst);
    if focused && !mon.visible.load(Ordering::SeqCst) {
        note_window_visible(app, true);
    }
}

/// K12 — sinal de ciclo de vida do documento, vindo do `on_page_load`.
///
/// No WebView2 `PageLoadEvent::Started` vem do `ContentLoading` e
/// `PageLoadEvent::Finished` do `NavigationCompleted` (wry 0.55.1,
/// `src/webview2/mod.rs:647-670`). O `NavigationCompleted` dispara TAMBÉM
/// quando a navegação falha e a página de erro é renderizada — e é justamente
/// esse o caso em que `Source` (logo, `w.url()`) continua devolvendo a URL
/// tentada. Por isso o detector de 10s passou a se apoiar aqui, e não na URL.
pub fn note_page_load(app: &AppHandle, terminou: bool, url: &str) {
    let Some(mon) = app.try_state::<ConnMonitor>() else {
        return;
    };
    let (_, origem) = classify_url(url);
    let now = Instant::now();
    let mut i = lock_inner(&mon);
    if terminou {
        i.loaded_at = Some(now);
        i.loaded_origin = origem;
        return;
    }
    i.loaded_at = None;
    i.loaded_origin = origem.clone();

    /* M1 — RETAGUARDA: uma carga de documento que o Rust não pediu É uma
       recuperação de nível 2, tenha a página avisado ou não. Sem isto o
       contador continuaria dependendo da boa vontade da página: bastava
       chamar `location.reload()` sem pedir para o ciclo de recargas voltar a
       ser invisível — que é exatamente o defeito de produção. */
    let primeira = !i.carga_vista;
    i.carga_vista = true;
    if carga_esperada(&i, now, primeira) {
        i.reload_esperado_ate = None;
        return;
    }
    i.tent.conta_recuperacao();
    i.disparos.push_back(now);
    if i.cenario == "reload-nao-declarado" {
        i.cenario_disparos = i.cenario_disparos.saturating_add(1);
    } else {
        i.cenario = "reload-nao-declarado".into();
        i.cenario_disparos = 1;
    }
    // a página nova precisa de carência, e a próxima recuperação precisa
    // esperar: um reload não declarado consome o mesmo orçamento dos outros.
    estender_carencia(&mut i, now, RECOVERY_GRACE);
    let alvo = now + Duration::from_secs(backoff_secs(i.cenario_disparos as usize));
    if i.hold_until.map(|h| alvo > h).unwrap_or(true) {
        i.hold_until = Some(alvo);
    }
    let convergiu = i.cenario_disparos >= MAX_DISPAROS_CENARIO;
    if convergiu {
        // mesma regra de convergência das outras camadas: o descanso dobra a
        // cada vez que insistimos sem nenhum sucesso no meio.
        i.convergencias = i.convergencias.saturating_add(1);
        i.descanso_ate = Some(now + descanso_de(i.convergencias));
    }
    let (estado, at, n) = (i.state.clone(), i.tent.valor, i.cenario_disparos);
    drop(i);
    note(
        app,
        &estado,
        at,
        &format!(
            "carga de documento NÃO declarada ({origem}): contada como recuperação de nível 2 ({n}/{MAX_DISPAROS_CENARIO}){}",
            if convergiu {
                "; convergiu — nenhuma recuperação até o fim do descanso"
            } else {
                ""
            }
        ),
    );
}

/// Linha de diagnóstico avulsa, escrita de forma síncrona. Usada pelos ganchos
/// de teste (K12) para deixar prova empírica no mesmo arquivo.
#[allow(dead_code)] // só os ganchos de teste (debug) chamam
pub fn note_diag(app: &AppHandle, texto: &str) {
    note_sync(app, "UNKNOWN", 0, texto);
}


/// K10 — o usuário pediu para fechar. A partir daqui, nenhuma recuperação
/// ressuscita a janela.
pub fn note_user_close(app: &AppHandle) {
    if let Some(mon) = app.try_state::<ConnMonitor>() {
        mon.user_exit.store(true, Ordering::SeqCst);
    }
}

pub fn is_window_visible(app: &AppHandle) -> bool {
    app.try_state::<ConnMonitor>()
        .map(|m| m.visible.load(Ordering::SeqCst))
        .unwrap_or(true)
}

pub fn is_window_focused(app: &AppHandle) -> bool {
    app.try_state::<ConnMonitor>()
        .map(|m| m.focused.load(Ordering::SeqCst))
        .unwrap_or(true)
}

/// Registra no log o fim de vida da janela principal.
pub fn note_window_event(app: &AppHandle, evento: &str) {
    let (estado, at) = app
        .try_state::<ConnMonitor>()
        .map(|m| {
            let i = lock_inner(&m);
            (i.state.clone(), i.tent.valor)
        })
        .unwrap_or_else(|| ("UNKNOWN".into(), 0));
    note_sync(app, &estado, at, &format!("janela principal: {evento}"));
}

/// Guarda de saída, chamado no `RunEvent::ExitRequested`.
///
/// K10: se quem pediu a saída foi o USUÁRIO (clique no X, Alt+F4, comando
/// externo), a saída passa — sempre. Antes, `recovering == true` fazia o app se
/// ressuscitar por até 30s e ele simplesmente não podia ser fechado. Recriar a
/// janela só faz sentido quando ela SUMIU durante uma recuperação, que é a
/// condição que mata o processo por falta de janela.
pub fn guard_exit(app: &AppHandle) -> bool {
    let Some(mon) = app.try_state::<ConnMonitor>() else {
        return false;
    };
    let recuperando = mon.recovering.load(Ordering::SeqCst);
    let pedido_do_usuario = mon.user_exit.load(Ordering::SeqCst);
    let (estado, at) = {
        let i = lock_inner(&mon);
        (i.state.clone(), i.tent.valor)
    };
    note_sync(
        app,
        &estado,
        at,
        &format!(
            "saída solicitada; pedido do usuário={pedido_do_usuario}; recuperação em voo={recuperando}"
        ),
    );
    if pedido_do_usuario || !recuperando {
        return false;
    }
    match crate::create_main_window(app) {
        Ok(()) => {
            {
                let mut i = lock_inner(&mon);
                let now = Instant::now();
                estender_carencia(&mut i, now, RECOVERY_GRACE);
            }
            mon.visible.store(true, Ordering::SeqCst);
            note_sync(
                app,
                "RECONNECTING",
                at,
                "watchdog: saída impedida (janela sumiu durante recuperação); janela principal recriada",
            );
            true
        }
        Err(e) => {
            note_sync(
                app,
                "FAILED",
                at,
                &format!("watchdog: recriação na saída falhou ({e}); deixando o app encerrar"),
            );
            false
        }
    }
}

/* ------------------------------------------------------------------------ */
/* Watchdog                                                                  */
/* ------------------------------------------------------------------------ */

pub fn start_watchdog(app: AppHandle) {
    // MEDIÇÃO, só em debug: no controle sem injeção (`ZAPLITE_SEM_INJECAO`) não
    // existe heartbeat, e o watchdog renavegaria a página a cada 15 s — o que
    // destruiria a medida de memória em repouso. No release não existe.
    #[cfg(debug_assertions)]
    if std::env::var("ZAPLITE_SEM_WATCHDOG").is_ok() {
        note_diag(&app, "watchdog DESLIGADO por ZAPLITE_SEM_WATCHDOG (medição)");
        return;
    }
    let sonda = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(URL_PROBE_TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            probe_url(&sonda);
        }
    });

    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(WATCHDOG_TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            check(&app);
        }
    });
}

/// Sonda URL e visibilidade POSTANDO um closure na thread principal.
fn probe_url(app: &AppHandle) {
    let a = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(w) = a.get_webview_window("main") else {
            return;
        };
        let url = w.url().map(|u| u.to_string()).unwrap_or_default();
        let visivel = w.is_visible().unwrap_or(true);
        let (kind, origem) = classify_url(&url);
        let Some(mon) = a.try_state::<ConnMonitor>() else {
            return;
        };
        let mudou = {
            let mut i = lock_inner(&mon);
            let now = Instant::now();
            i.page = Some(kind);
            i.page_origin = origem;
            i.page_at = Some(now);
            i.main_stuck_logged = false;
            if kind == PageKind::Blank {
                if i.blank_since.is_none() {
                    i.blank_since = Some(now);
                }
            } else {
                i.blank_since = None;
            }
            mon.visible.load(Ordering::SeqCst) != visivel
        };
        if mudou {
            note_window_visible(&a, visivel);
        }
    });
}

fn check(app: &AppHandle) {
    let mon = app.state::<ConnMonitor>();
    let mut i = lock_inner(&mon);
    let now = Instant::now();

    /* 1. salto de relógio (suspensão do Windows) --------------------------- */
    let mono = now.saturating_duration_since(i.tick_mono);
    let wall = SystemTime::now()
        .duration_since(i.tick_wall)
        .unwrap_or(Duration::ZERO);
    let primeiro = i.tick_mono == mon.started && i.last_heartbeat.is_none() && i.page_at.is_none();
    i.tick_mono = now;
    i.tick_wall = SystemTime::now();
    if !primeiro && is_clock_jump(mono, wall) {
        // K7: MESMA semântica das outras carências (máximo + teto), não mais
        // uma sobrescrita.
        estender_carencia(&mut i, now, WAKE_GRACE);
        i.hold_until = Some(now + WAKE_GRACE);
        i.blank_hold_until = Some(now + WAKE_GRACE);
        i.blank_since = None;
        i.loaded_at = None;
        let (s, at) = (i.state.clone(), i.tent.valor);
        drop(i);
        note(
            app,
            &s,
            at,
            &format!(
                "salto de relógio ({}s monotônico / {}s de parede): retorno de suspensão; carência até {}s",
                mono.as_secs(),
                wall.as_secs(),
                WAKE_GRACE.as_secs()
            ),
        );
        return;
    }

    /* 2. recuperação em voo + trava de segurança --------------------------- */
    if i.recovering {
        let travado = i
            .recovering_since
            .map(|t| now.saturating_duration_since(t) > RECOVERY_TIMEOUT)
            .unwrap_or(true);
        if !travado {
            // congela o contador enquanto não dá para julgar
            i.tent.observar(now, Saude::Indefinida);
            return;
        }
        i.recovering = false;
        i.recovering_since = None;
        mon.recovering.store(false, Ordering::SeqCst);
        let (s, at) = (i.state.clone(), i.tent.valor);
        drop(i);
        note(
            app,
            &s,
            at,
            &format!(
                "watchdog: trava de segurança liberou o flag de recuperação após {}s sem resposta da thread principal",
                RECOVERY_TIMEOUT.as_secs()
            ),
        );
        return;
    }

    /* 3. K1 — contador derivado + K6 reconciliação ------------------------- */
    let heartbeat_fresco = i
        .last_heartbeat
        .map(|t| now.saturating_duration_since(t) <= HEARTBEAT_TIMEOUT)
        .unwrap_or(false);
    let visivel = mon.visible.load(Ordering::SeqCst);
    let neutro = !visivel || now < i.grace_until;
    let saude = julgar_saude(&i.page_state, heartbeat_fresco, neutro);

    /* 3b. M4 — sinal positivo encurta QUALQUER descanso -------------------- */
    if saude == Saude::Boa && rearmar_por_sinal(&mut i, now) {
        let (s, at) = (i.state.clone(), i.tent.valor);
        drop(i);
        note(
            app,
            &s,
            at,
            &format!(
                "sinal positivo (CONNECTED com heartbeat fresco, fora de carência): descansos encurtados para {}s",
                REARME_POR_SINAL.as_secs()
            ),
        );
        i = lock_inner(&mon);
    }

    let mudanca = i.tent.observar(now, saude);
    if let Some(m) = mudanca {
        let (s, at, ps) = (i.state.clone(), i.tent.valor, i.page_state.clone());
        // CONNECTED sustentado também derruba o veredito de falha do Rust (K6)
        // e, agora, o breaker inteiro da composição: sucesso real e sustentado
        // é a ÚNICA coisa que zera qualquer um deles (M1).
        let liberou = if m == "zerado" {
            let tinha = i.rust_failed_until.is_some();
            i.rust_failed_until = None;
            i.hold_until = None;
            i.descanso_ate = None;
            i.cenario_disparos = 0;
            i.convergencias = 0;
            i.cenario.clear();
            i.disparos.clear();
            i.ultima_recusa.clear();
            if tinha {
                // K6: o veredito caiu, então o estado efetivo volta a ser o da
                // página — e essa mudança vai ao log logo abaixo.
                i.state = reconciliar(&ps, false);
            }
            tinha
        } else {
            false
        };
        let estado_final = i.state.clone();
        drop(i);
        let texto = if m == "zerado" {
            format!(
                "contador de tentativas zerado pelo Rust: {}s de CONNECTED sustentado{}",
                STABLE_OK.as_secs(),
                if liberou {
                    "; veredito FAILED do breaker liberado"
                } else {
                    ""
                }
            )
        } else {
            format!(
                "tentativa contada pelo Rust: episódio ruim persistiu {}s (estado da página: {ps})",
                ATTEMPT_EPISODE.as_secs()
            )
        };
        note(app, if liberou { &estado_final } else { &s }, at, &texto);
        i = lock_inner(&mon);
    }

    /* 4. K12 — documento carregou mas o bundle não fala -------------------- */
    // Roda ANTES da carência: é o caso em que esperar não resolve. Sinal
    // Rust-observável que FUNCIONA no WebView2 (o `w.url()` não funciona:
    // depois de falha de navegação o `Source` continua sendo a URL tentada).
    let carregou_mudo = visivel
        && i.loaded_at
            .map(|t| {
                now.saturating_duration_since(t) >= BLANK_TIMEOUT
                    && i.last_heartbeat.map(|h| h < t).unwrap_or(true)
            })
            .unwrap_or(false);
    let blank_pronto = i
        .blank_since
        .map(|t| now.saturating_duration_since(t) >= BLANK_TIMEOUT)
        .unwrap_or(false);
    let blank_liberado = i.blank_hold_until.map(|h| now >= h).unwrap_or(true);
    if (carregou_mudo || blank_pronto) && blank_liberado {
        let n = prune(&mut i.blank_recoveries, now, RECOVERY_WINDOW);
        if n >= MAX_BLANK_RECOVERIES_IN_WINDOW {
            i.blank_since = None;
            i.loaded_at = None;
            i.blank_hold_until = Some(now + RECOVERY_WINDOW);
            return falhar(
                app,
                i,
                format!(
                    "watchdog: {n} renavegações por documento mudo em {} min sem sucesso (breaker); janela preservada",
                    RECOVERY_WINDOW.as_secs() / 60
                ),
            );
        }
        let motivo = if carregou_mudo {
            format!(
                "watchdog: documento de {} carregou (NavigationCompleted) e não emitiu heartbeat em {}s — página de erro ou bundle não rodou; renavegando",
                i.loaded_origin,
                BLANK_TIMEOUT.as_secs()
            )
        } else {
            format!(
                "watchdog: página presa em {} há >{}s (navegação nunca commitou); renavegando",
                i.page_origin,
                BLANK_TIMEOUT.as_secs()
            )
        };
        // M1/M3 — o nível 3 também passa pela autoridade única: é ela que
        // conta o disparo e que faz o app CONVERGIR em vez de renavegar para
        // sempre no mesmo cenário.
        let v = decidir_recuperacao(&mut i, now, 3, "documento-mudo", false, false);
        if !v.permitido {
            i.blank_since = None;
            i.loaded_at = None;
            i.blank_hold_until = Some(now + v.espera);
            return recusar(app, i, v);
        }
        return start_recovery(app, &mon, i, motivo, v.espera, true);
    }

    /* 5. carência (boot, reexibição, página nova, retorno de suspensão) ---- */
    if now < i.grace_until {
        return;
    }

    /* 6. visibilidade — do AtomicBool, jamais de is_visible() -------------- */
    if !visivel {
        return;
    }

    /* 7. K6 — o FAILED do breaker é LIDO, não decorativo ------------------- */
    /* M2 — mas agora ele TEM TETO. Antes, `FAILED` desligava as duas camadas
       para sempre: o JS fazia `if (state === "FAILED") return;` e o Rust só
       agia no silêncio do heartbeat. O usuário ficava com um badge mandando
       "reabra o ZapLite" — reinício manual, que é o defeito que este projeto
       existe para eliminar. Passado o descanso, o app volta a tentar sozinho. */
    if i.state == "FAILED" {
        if i.rust_failed_until.map(|t| now < t).unwrap_or(false) {
            return;
        }
        if i.rust_failed_until.take().is_some() {
            let ps = i.page_state.clone();
            let prev = std::mem::replace(&mut i.state, reconciliar(&ps, false));
            i.reason = sanitize_reason(&format!(
                "descanso do veredito FAILED terminou ({}s): o app volta a tentar sozinho",
                DESCANSO_FAILED.as_secs()
            ));
            i.since_ms = now_ms();
            let (novo, rs, at, since) =
                (i.state.clone(), i.reason.clone(), i.tent.valor, i.since_ms);
            drop(i);
            log_and_emit(app, &prev, &novo, &rs, at, since, None, "app");
            i = lock_inner(&mon);
        }
    }

    /* 8. backoff do nível 3 ------------------------------------------------ */
    if let Some(h) = i.hold_until {
        if now < h {
            return;
        }
    }

    /* 9. heartbeat -------------------------------------------------------- */
    /* M2 — o `return` seco aqui era metade do silêncio eterno: com a página
       VIVA (heartbeat chegando) e o link MORTO, o watchdog não agia porque só
       sabia agir no silêncio, e o JS não agia porque estava em FAILED. As duas
       camadas se calavam. Agora o heartbeat fresco só cala o watchdog enquanto
       o estado reportado não for ruim de forma sustentada. */
    let mut cenario_nivel3 = "sem-heartbeat";
    let mut prova_morte = String::new();
    let silencio = i
        .last_heartbeat
        .map(|t| now.saturating_duration_since(t))
        .unwrap_or_else(|| now.saturating_duration_since(mon.started));
    if heartbeat_fresco {
        if !ESTADOS_RUINS.contains(&i.page_state.as_str()) {
            i.link_ruim_desde = None;
            return;
        }
        let inicio = *i.link_ruim_desde.get_or_insert(now);
        let dura = now.saturating_duration_since(inicio);
        if dura < LINK_MORTO {
            return;
        }
        cenario_nivel3 = "link-morto";
    } else {
        i.link_ruim_desde = None;
        /* E1 — AQUI mora o dano que esta tarefa existe para parar. O silêncio
           do heartbeat sozinho NÃO autoriza mais destruir a página: exige-se
           corroboração independente do JS (ver `evidencia_de_morte`). */
        let limiar = limiar_zumbi(&i, now);
        match evidencia_de_morte(&i, silencio, limiar) {
            Some(p) => prova_morte = p,
            None => {
                if !i.silencio_logado {
                    i.silencio_logado = true;
                    let (s, at, ps) = (i.state.clone(), i.tent.valor, i.page_state.clone());
                    let pausa = i.maior_pausa_js.as_secs();
                    drop(i);
                    note(
                        app,
                        &s,
                        at,
                        &format!(
                            "watchdog: {}s sem heartbeat SEM evidência de webview morta (documento ainda é o nosso; último estado da página: {ps}; maior pausa de JS auto-declarada: {pausa}s; limiar de zumbi {}s) — esperando, NÃO renavegando",
                            silencio.as_secs(),
                            limiar.as_secs()
                        ),
                    );
                }
                return;
            }
        }
    }

    let ui_travada = i
        .page_at
        .map(|t| now.saturating_duration_since(t) > MAIN_STUCK)
        .unwrap_or(false);
    if ui_travada && !i.main_stuck_logged {
        i.main_stuck_logged = true;
        let (s, at) = (i.state.clone(), i.tent.valor);
        let idade = i.page_at.map(|t| t.elapsed().as_secs()).unwrap_or(0);
        drop(i);
        note(
            app,
            &s,
            at,
            &format!("watchdog: thread principal sem responder há {idade}s"),
        );
        i = lock_inner(&mon);
    }

    /* 10. circuit breaker por janela de tempo ------------------------------- */
    let n = prune(&mut i.recoveries, now, RECOVERY_WINDOW);
    if n >= MAX_RECOVERIES_IN_WINDOW {
        i.hold_until = Some(now + RECOVERY_WINDOW);
        return falhar(
            app,
            i,
            format!(
                "watchdog: {n} recuperações em {} min sem sucesso (circuit breaker); janela preservada",
                RECOVERY_WINDOW.as_secs() / 60
            ),
        );
    }

    /* 11. nível 3: renavegar (NUNCA destruir) ------------------------------- */
    // M1/M3 — passa pela autoridade única, que conta o disparo e converge.
    let v = decidir_recuperacao(&mut i, now, 3, cenario_nivel3, false, false);
    if !v.permitido {
        return recusar(app, i, v);
    }
    let motivo = if cenario_nivel3 == "link-morto" {
        format!(
            "watchdog: heartbeat CHEGANDO e link reportado {} há >{}s (página viva, link morto); renavegando a webview (nível 3, tentativa {})",
            i.page_state,
            LINK_MORTO.as_secs(),
            v.tentativa
        )
    } else {
        format!(
            "watchdog: {}s sem heartbeat COM evidência de webview morta ({prova_morte}); renavegando a webview (nível 3, tentativa {})",
            silencio.as_secs(),
            v.tentativa
        )
    };
    // E3 — se chegamos aqui com rascunho em risco, o usuário PRECISA saber:
    // o motivo é o que aparece no badge da página.
    let motivo = if std::mem::take(&mut i.rascunho_em_risco) {
        format!("{motivo} [ATENÇÃO: havia texto não enviado no campo de mensagem e o adiamento de {}min se esgotou; confira o rascunho da conversa]", RASCUNHO_ADIAMENTO_MAX.as_secs() / 60)
    } else {
        motivo
    };
    start_recovery(app, &mon, i, motivo, v.espera, false);
}

/// Recusa de recuperação decidida pelo Rust: uma linha de log (sem repetir a
/// mesma recusa) e, se convergiu, o estado efetivo passa a dizer a verdade —
/// o app PAROU de tentar por ora, e vai voltar sozinho.
fn recusar(app: &AppHandle, mut i: MutexGuard<'_, Inner>, v: Veredito) {
    if i.ultima_recusa == v.chave {
        return;
    }
    i.ultima_recusa = v.chave.to_string();
    if v.convergiu {
        return falhar(
            app,
            i,
            format!("watchdog: {} — aguardando em vez de insistir", v.motivo),
        );
    }
    let (s, at) = (i.state.clone(), i.tent.valor);
    drop(i);
    note(app, &s, at, &format!("watchdog: recuperação adiada — {}", v.motivo));
}

/// Marca FAILED de forma que o estado em memória e o log digam a MESMA coisa,
/// e que o heartbeat seguinte não apague o veredito (K6).
fn falhar(app: &AppHandle, mut i: MutexGuard<'_, Inner>, motivo: String) {
    let now = Instant::now();
    // M2 — FAILED é DESCANSO, não fim de linha: tem teto de tempo, e sinal
    // positivo (M4) o encurta. Era `RECOVERY_WINDOW` (10 min) e nada o mexia.
    // Semântica de MÁXIMO: chamadas repetidas não empilham descanso novo.
    let alvo = now + DESCANSO_FAILED;
    if i.rust_failed_until.map(|t| alvo > t).unwrap_or(true) {
        i.rust_failed_until = Some(alvo);
    }
    if i.state == "FAILED" && i.reason == sanitize_reason(&motivo) {
        return;
    }
    let prev = std::mem::replace(&mut i.state, "FAILED".into());
    i.reason = sanitize_reason(&motivo);
    i.since_ms = now_ms();
    let (rs, at, since) = (i.reason.clone(), i.tent.valor, i.since_ms);
    drop(i);
    log_and_emit(app, &prev, "FAILED", &rs, at, since, None, "app");
}

/// Dispara a recuperação: marca o estado, solta o mutex, loga e posta o
/// trabalho na thread principal.
fn start_recovery(
    app: &AppHandle,
    mon: &ConnMonitor,
    mut i: MutexGuard<'_, Inner>,
    motivo: String,
    espera: Duration,
    blank: bool,
) {
    let now = Instant::now();
    i.recovering = true;
    i.recovering_since = Some(now);
    mon.recovering.store(true, Ordering::SeqCst);
    // K1/M1: o disparo JÁ foi contado por `decidir_recuperacao` — que é agora
    // o único lugar que conta, para os três níveis. Contar aqui de novo
    // significaria dois contadores outra vez.
    i.loaded_at = None;
    // A renavegação vai gerar um `ContentLoading`: ele é ESPERADO, senão o
    // detector de carga não declarada (M1) contaria o mesmo disparo duas
    // vezes. `recovering` não basta — ele cai assim que `navigate()` retorna,
    // possivelmente antes de o documento novo começar.
    i.reload_esperado_ate = Some(now + RELOAD_ESPERADO);
    // K7: a espera efetiva é carência + backoff. Antes, `grace = 60s` e
    // `backoff <= 60s` no MESMO campo faziam a carência dominar sempre e os
    // níveis 3 saíam espaçados exatamente 60s — o backoff não decidia nada.
    let liberacao = now + RECOVERY_GRACE + espera;
    if blank {
        i.blank_recoveries.push_back(now);
        i.blank_hold_until = Some(liberacao);
        i.blank_since = None;
    } else {
        i.recoveries.push_back(now);
        i.hold_until = Some(liberacao);
    }
    i.recoveries_total = i.recoveries_total.saturating_add(1);
    estender_carencia(&mut i, now, RECOVERY_GRACE);
    let prev = std::mem::replace(&mut i.state, "RECONNECTING".into());
    i.reason = sanitize_reason(&motivo);
    i.since_ms = now_ms();
    let (rs, at, since) = (i.reason.clone(), i.tent.valor, i.since_ms);
    drop(i);
    // Y1 — a renavegação (nível 3) também destrói o contexto JS sem passar por
    // `revert()`. Fecha-se aqui, com o mutex JÁ solto, antes de postar a
    // navegação: nenhuma janela `toast-*` sobrevive à recuperação. É efeito da
    // decisão já tomada — nada acima é alterado.
    let toasts = crate::notify::fechar_toasts_por_recuperacao(app);
    if toasts > 0 {
        note_diag(
            app,
            &format!("recuperação nível 3: {toasts} toast(s) fechado(s) antes da renavegação"),
        );
    }
    log_and_emit(app, &prev, "RECONNECTING", &rs, at, since, None, "app");

    let a = app.clone();
    let enviado = app.run_on_main_thread(move || {
        let r = navegar_ou_recriar(&a);
        finish_recovery(&a, r);
    });
    if let Err(e) = enviado {
        finish_recovery(
            app,
            Err(format!("não foi possível falar com a thread principal: {e}")),
        );
    }
}

/// Executado NA thread principal. Não destrói nada: renavega a webview.
fn navegar_ou_recriar(app: &AppHandle) -> Result<String, String> {
    // Banco de provas (só em debug, igual ao `create_main_window`): sem isto a
    // renavegação do bench sairia do documento descartável direto para o
    // WhatsApp Web — que, num perfil de teste VAZIO, é a tela de QR. No release
    // o destino é constante.
    #[cfg(debug_assertions)]
    let destino = std::env::var("ZAPLITE_ALVO").unwrap_or_else(|_| WHATSAPP_URL.to_string());
    #[cfg(not(debug_assertions))]
    let destino = WHATSAPP_URL.to_string();
    let url: tauri::Url = destino
        .parse()
        .map_err(|e| format!("URL inválida: {e}"))?;
    match app.get_webview_window("main") {
        Some(w) => {
            w.navigate(url)
                .map_err(|e| format!("renavegação falhou: {e}"))?;
            Ok("webview renavegada para o WhatsApp Web (janela preservada)".into())
        }
        None => {
            crate::create_main_window(app)
                .map_err(|e| format!("recriação da janela falhou: {e}"))?;
            Ok("janela principal recriada (não havia janela)".into())
        }
    }
}

fn finish_recovery(app: &AppHandle, resultado: Result<String, String>) {
    let mon = app.state::<ConnMonitor>();
    let mut i = lock_inner(&mon);
    if !i.recovering {
        return;
    }
    i.recovering = false;
    i.recovering_since = None;
    mon.recovering.store(false, Ordering::SeqCst);
    match resultado {
        Ok(msg) => {
            let (s, at) = (i.state.clone(), i.tent.valor);
            drop(i);
            note(app, &s, at, &format!("watchdog: {msg}"));
        }
        Err(e) => {
            // M2: descanso com teto, não sentença perpétua.
            i.rust_failed_until = Some(Instant::now() + DESCANSO_FAILED);
            let prev = std::mem::replace(&mut i.state, "FAILED".into());
            i.reason = sanitize_reason(&format!("watchdog: {e}"));
            i.since_ms = now_ms();
            let (rs, at, since) = (i.reason.clone(), i.tent.valor, i.since_ms);
            drop(i);
            log_and_emit(app, &prev, "FAILED", &rs, at, since, None, "app");
        }
    }
}

/* ------------------------------------------------------------------------ */

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn about_blank_e_pagina_de_erro_contam_como_navegacao_nao_commitada() {
        for u in [
            "about:blank",
            "about:srcdoc",
            "",
            "   ",
            "chrome-error://chromewebdata/",
            "data:text/html,",
        ] {
            assert_eq!(classify_url(u).0, PageKind::Blank, "{u:?} deveria ser Blank");
        }
    }

    #[test]
    fn url_do_whatsapp_e_reconhecida_e_so_a_origem_e_guardada() {
        let (kind, origem) = classify_url("https://web.whatsapp.com/send?phone=5511999999999");
        assert_eq!(kind, PageKind::WhatsApp);
        assert_eq!(origem, "https://web.whatsapp.com");
        assert!(!origem.contains("phone"));

        let (kind, origem) = classify_url("https://exemplo.invalido/x");
        assert_eq!(kind, PageKind::Other);
        assert_eq!(origem, "https://exemplo.invalido");

        assert_eq!(
            classify_url("https://web.whatsapp.com.evil.test/").0,
            PageKind::Other
        );
    }

    #[test]
    fn salto_de_relogio_e_detectado_por_tick_gigante_e_por_divergencia() {
        assert!(!is_clock_jump(
            Duration::from_secs(3),
            Duration::from_secs(3)
        ));
        assert!(!is_clock_jump(
            Duration::from_millis(3100),
            Duration::from_millis(3000)
        ));
        assert!(is_clock_jump(
            Duration::from_secs(7200),
            Duration::from_secs(7200)
        ));
        assert!(is_clock_jump(
            Duration::from_secs(3),
            Duration::from_secs(600)
        ));
        assert!(is_clock_jump(
            Duration::from_secs(600),
            Duration::from_secs(3)
        ));
    }

    #[test]
    fn breaker_conta_por_janela_de_tempo_e_nao_por_sequencia() {
        let base = Instant::now();
        let mut fila: VecDeque<Instant> = VecDeque::new();
        for m in 0..5u64 {
            fila.push_back(base + Duration::from_secs(m * 60));
        }
        let agora = base + Duration::from_secs(4 * 60);
        assert_eq!(prune(&mut fila, agora, RECOVERY_WINDOW), 5);
        assert!(prune(&mut fila, agora, RECOVERY_WINDOW) >= MAX_RECOVERIES_IN_WINDOW);

        let depois = base + Duration::from_secs(30 * 60);
        assert_eq!(prune(&mut fila, depois, RECOVERY_WINDOW), 0);
    }

    #[test]
    fn backoff_cresce_e_tem_teto() {
        assert_eq!(backoff_secs(1), 2);
        assert_eq!(backoff_secs(2), 4);
        assert_eq!(backoff_secs(3), 8);
        assert_eq!(backoff_secs(9), 60);
        assert_eq!(backoff_secs(0), 2);
    }

    #[test]
    fn timestamp_do_js_e_usado_quando_vem_e_ignorado_quando_e_lixo() {
        let ms = 1_786_968_000_000f64;
        let a = ts_from_js(Some(&json!(ms)), None).expect("epoch em ms deveria valer");
        let b = ts_from_js(None, Some(ms)).expect("alias tsMs deveria valer");
        assert_eq!(a, b);
        assert!(a.starts_with("2026-08-17"), "{a}");

        let c = ts_from_js(Some(&json!("2026-08-17T12:00:00.000Z")), None).unwrap();
        assert_eq!(c, a);
        assert_eq!(ts_from_js(Some(&json!("1786968000000")), None).unwrap(), a);

        assert!(ts_from_js(None, None).is_none());
        assert!(ts_from_js(Some(&Value::Null), None).is_none());
        assert!(ts_from_js(Some(&json!(0)), None).is_none());
        assert!(ts_from_js(Some(&json!(-5)), None).is_none());
        assert!(ts_from_js(Some(&json!(1e18)), None).is_none());
        assert!(ts_from_js(Some(&json!("ontem à tarde")), None).is_none());
        assert!(ts_from_js(Some(&json!(f64::NAN)), None).is_none());
    }

    /// K9: nada de parsear megabytes vindos da página.
    #[test]
    fn k9_string_de_timestamp_gigante_e_rejeitada_sem_parsear() {
        let gigante = "9".repeat(4 * 1024 * 1024);
        assert!(ts_from_js(Some(&json!(gigante)), None).is_none());
        // um ISO válido com lixo colado também estoura o teto
        let iso_inchado = format!("2026-08-17T12:00:00.000Z{}", " ".repeat(MAX_TS_LEN));
        assert!(ts_from_js(Some(&json!(iso_inchado)), None).is_none());
        // e o caso legítimo continua passando
        assert!(ts_from_js(Some(&json!("2026-08-17T12:00:00.000Z")), None).is_some());
    }

    #[test]
    fn estados_fora_da_whitelist_nao_entram_no_log() {
        assert_eq!(valid_state("CONNECTED"), "CONNECTED");
        assert_eq!(valid_state("<script>"), "UNKNOWN");
        assert_eq!(sanitize_reason(&"a".repeat(500)).chars().count(), 160);
    }

    #[test]
    fn pagina_nova_recebe_carencia_menor_que_a_do_boot() {
        assert_eq!(STARTUP_GRACE, Duration::from_secs(60));
        assert!(RECOVERY_GRACE < STARTUP_GRACE);
        /* E1 — a invariante antiga era `VISIBILITY_GRACE >= HEARTBEAT_TIMEOUT
           * 2`: com o timeout em 15s ela pedia 30s de carência para cobrir o
           silêncio. Ela partia do pressuposto ERRADO de que o silêncio, por si
           só, decide alguma coisa. Agora quem decide o nível 3 é
           `SILENCIO_ZUMBI` mais corroboração, e a invariante que importa é que
           o silêncio tolerado seja MUITO maior que qualquer carência — nenhuma
           combinação de carências chega perto de virar diagnóstico de morte. */
        assert!(HEARTBEAT_TIMEOUT >= VISIBILITY_GRACE * 2);
        assert!(SILENCIO_ZUMBI >= HEARTBEAT_TIMEOUT * 2);
        assert!(SILENCIO_ZUMBI > MAX_GRACE_AHEAD * 4);
        assert!(SILENCIO_TETO >= SILENCIO_ZUMBI);
    }

    /* --- E1/E2/E3: o watchdog não destrói página viva -------------------- */

    /// E1 — o caso real de 17/08 09:45:31, reproduzido: heartbeat mudo, página
    /// tendo reportado CONNECTED, documento ainda no lugar. O binário anterior
    /// renavegava em 15s. Agora, nada — em nenhum instante plausível de uma
    /// pausa de GC.
    #[test]
    fn e1_silencio_com_pagina_viva_nunca_autoriza_renavegacao() {
        let now = Instant::now();
        let mut i = inner_de_teste(now);
        i.page = Some(PageKind::WhatsApp);
        i.page_state = "CONNECTED".into();
        let limiar = limiar_zumbi(&i, now);
        // Os dois silêncios efetivamente medidos no log de 17/08 (132s e 229s)
        // e mais um pior caso confortável.
        for s in [15u64, 33, 132, 229, 300, 600] {
            assert!(
                evidencia_de_morte(&i, Duration::from_secs(s), limiar).is_none(),
                "silêncio de {s}s com página viva NÃO pode virar renavegação"
            );
        }
    }

    /// ...e o contrapeso: a evidência REAL continua acionável, senão o
    /// remédio teria virado inércia.
    #[test]
    fn e1_evidencia_real_de_morte_continua_acionavel() {
        let now = Instant::now();
        let limiar = limiar_zumbi(&inner_de_teste(now), now);

        // (a) a sonda de URL — que roda na thread principal, não no JS da
        //     página — não vê documento nosso: age NA HORA, sem esperar.
        let mut morta = inner_de_teste(now);
        morta.page = Some(PageKind::Blank);
        morta.page_state = "CONNECTED".into();
        assert!(evidencia_de_morte(&morta, Duration::from_secs(1), limiar).is_some());

        let mut outra = inner_de_teste(now);
        outra.page = Some(PageKind::Other);
        outra.page_origin = "https://exemplo.invalido".into();
        assert!(evidencia_de_morte(&outra, Duration::from_secs(1), limiar).is_some());

        // (b) emudeceu de um estado que NÃO era CONNECTED e passou do limiar.
        let mut ruim = inner_de_teste(now);
        ruim.page = Some(PageKind::WhatsApp);
        ruim.page_state = "OFFLINE".into();
        assert!(evidencia_de_morte(&ruim, limiar - Duration::from_secs(1), limiar).is_none());
        assert!(evidencia_de_morte(&ruim, limiar, limiar).is_some());

        // (c) silêncio absurdo mesmo tendo reportado CONNECTED: o dobro do
        //     limiar ainda destrava, senão uma página realmente morta que
        //     morreu conectada ficaria presa para sempre.
        let mut viva = inner_de_teste(now);
        viva.page = Some(PageKind::WhatsApp);
        viva.page_state = "CONNECTED".into();
        assert!(evidencia_de_morte(&viva, limiar * 2, limiar).is_some());
    }

    /// E2 — um atraso EXPLICADO pela própria página recalibra o limiar, com
    /// teto: a origem remota pode empurrar, não pode desligar o watchdog.
    #[test]
    fn e2_pausa_declarada_recalibra_o_limiar_e_tem_teto() {
        // `base` fica no passado SEM subtrair de `Instant::now()`: numa máquina
        // recém-ligada o `Instant` pode ser menor que o valor subtraído e o
        // teste explodiria por baixo, não pelo que ele quer provar.
        let base = Instant::now();
        let now = base + SILENCIO_TETO + Duration::from_secs(60);
        let mut i = inner_de_teste(now);
        assert_eq!(limiar_zumbi(&i, now), SILENCIO_ZUMBI);

        i.maior_pausa_js = Duration::from_secs(300);
        i.pausa_js_em = Some(now);
        assert_eq!(limiar_zumbi(&i, now), Duration::from_secs(600));

        // Teto: nem uma pausa declarada de horas passa disto.
        i.maior_pausa_js = Duration::from_secs(10 * 3600);
        assert_eq!(limiar_zumbi(&i, now), SILENCIO_TETO);

        // Pausa velha não compra tolerância nenhuma.
        i.pausa_js_em = Some(base);
        assert_eq!(limiar_zumbi(&i, now), SILENCIO_ZUMBI);
    }

    /// E3 — o que o usuário digitou não se joga fora: nível 2 e 3 esperam.
    /// O nível 1 (cutucar o socket) não destrói nada e por isso não espera.
    #[test]
    fn e3_rascunho_adia_reload_e_renavegacao_mas_tem_teto() {
        let now = Instant::now();
        let mut i = inner_de_teste(now);
        i.rascunho_ate = Some(now + RASCUNHO_JANELA);

        // Nível 1 passa: cutucar a reconexão não apaga texto nenhum.
        assert!(decidir_recuperacao(&mut i, now, 1, "envio-preso", false, false).permitido);

        let mut i = inner_de_teste(now);
        i.rascunho_ate = Some(now + RASCUNHO_JANELA);
        let v = decidir_recuperacao(&mut i, now, 3, "sem-heartbeat", false, false);
        assert!(!v.permitido, "nível 3 não pode recarregar por cima do texto");
        assert_eq!(v.chave, "rascunho");
        assert_eq!(i.cenario_disparos, 0, "adiar não gasta orçamento do cenário");

        let v = decidir_recuperacao(&mut i, now, 2, "sem-heartbeat", false, false);
        assert!(!v.permitido);
        assert_eq!(v.chave, "rascunho");

        // Teto do adiamento: o rascunho segue lá (renovado a cada heartbeat),
        // mas passado o teto a recuperação acontece — MARCADA, para o usuário
        // ser avisado no badge.
        let depois = now + RASCUNHO_ADIAMENTO_MAX + Duration::from_secs(1);
        i.rascunho_ate = Some(depois + RASCUNHO_JANELA);
        let v = decidir_recuperacao(&mut i, depois, 3, "sem-heartbeat", false, false);
        assert!(v.permitido, "rascunho esquecido não desliga a recuperação");
        assert!(i.rascunho_em_risco, "o usuário precisa ser avisado");

        // Sem rascunho, nada muda: o caminho normal continua igual.
        let mut limpo = inner_de_teste(now);
        assert!(decidir_recuperacao(&mut limpo, now, 3, "sem-heartbeat", false, false).permitido);
    }

    /* --- K1 ------------------------------------------------------------- */

    /// O núcleo do K1: o número que a página manda não move o contador.
    /// Aqui provamos a máquina que o SUBSTITUI.
    #[test]
    fn k1_contador_so_anda_com_episodio_ruim_sustentado() {
        let t0 = Instant::now();
        let mut t = Tentativas::default();

        // piscada: ruim por 1s, bom, ruim de novo… nunca completa episódio
        for k in 0..20u64 {
            let now = t0 + Duration::from_secs(k);
            t.observar(now, if k % 2 == 0 { Saude::Ruim } else { Saude::Boa });
        }
        assert_eq!(t.valor, 0, "piscar de estado não pode inflar o contador");

        // episódio real: ruim contínuo
        let mut t = Tentativas::default();
        assert_eq!(t.observar(t0, Saude::Ruim), None);
        assert_eq!(t.observar(t0 + Duration::from_secs(4), Saude::Ruim), None);
        assert_eq!(
            t.observar(t0 + Duration::from_secs(5), Saude::Ruim),
            Some("incremento")
        );
        assert_eq!(t.valor, 1);
        // continuar ruim NÃO conta de novo: é o mesmo episódio
        for k in 6..60u64 {
            assert_eq!(t.observar(t0 + Duration::from_secs(k), Saude::Ruim), None);
        }
        assert_eq!(t.valor, 1);
    }

    #[test]
    fn k1_conectado_sustentado_zera_e_conectado_curto_nao() {
        let t0 = Instant::now();
        let mut t = Tentativas::default();
        t.conta_recuperacao();
        t.conta_recuperacao();
        assert_eq!(t.valor, 2);

        // 14s de CONNECTED: ainda NÃO zera
        for k in 0..15u64 {
            t.observar(t0 + Duration::from_secs(k), Saude::Boa);
        }
        assert_eq!(t.valor, 2, "14s de CONNECTED não podem zerar");
        // o 15º segundo zera
        assert_eq!(
            t.observar(t0 + Duration::from_secs(15), Saude::Boa),
            Some("zerado")
        );
        assert_eq!(t.valor, 0);

        // e uma piscada de CONNECTED não zera
        let mut t = Tentativas::default();
        t.conta_recuperacao();
        t.observar(t0, Saude::Boa);
        t.observar(t0 + Duration::from_secs(2), Saude::Boa);
        t.observar(t0 + Duration::from_secs(3), Saude::Ruim);
        assert_eq!(t.valor, 1, "3s de CONNECTED não podem zerar o contador");
    }

    #[test]
    fn k1_contador_tem_teto_e_recuperacao_do_watchdog_conta() {
        let mut t = Tentativas::default();
        for _ in 0..50 {
            t.conta_recuperacao();
        }
        assert_eq!(t.valor, MAX_ATTEMPTS, "o teto é o mesmo MAX_ATTEMPTS do JS");
    }

    #[test]
    fn k1_estados_de_boot_e_qr_congelam_o_contador() {
        // boot / QR na tela: nem conta tentativa nem zera
        assert_eq!(
            julgar_saude("STARTING", true, false),
            Saude::Indefinida,
            "boot não é falha"
        );
        assert_eq!(julgar_saude("NEEDS_AUTH", true, false), Saude::Indefinida);
        assert_eq!(julgar_saude("CONNECTED", true, false), Saude::Boa);
        assert_eq!(julgar_saude("OFFLINE", true, false), Saude::Ruim);
        // heartbeat velho é ruim mesmo com a página jurando CONNECTED
        assert_eq!(julgar_saude("CONNECTED", false, false), Saude::Ruim);
        // dentro da carência / janela escondida: neutro
        assert_eq!(julgar_saude("OFFLINE", false, true), Saude::Indefinida);

        let t0 = Instant::now();
        let mut t = Tentativas::default();
        for k in 0..30u64 {
            t.observar(t0 + Duration::from_secs(k), Saude::Indefinida);
        }
        assert_eq!(t.valor, 0);
    }

    /* --- K3 / K7 -------------------------------------------------------- */

    #[test]
    fn k3_k7_carencia_tem_teto_e_semantica_unica() {
        let now = Instant::now();
        // encadeamento do pior caso da auditoria: 60 + 30 + 45
        let mut g = now;
        g = nova_carencia(g, now, RECOVERY_GRACE);
        g = nova_carencia(g, now, VISIBILITY_GRACE);
        g = nova_carencia(g, now, WAKE_GRACE);
        let total = g.saturating_duration_since(now);
        assert!(
            total <= MAX_GRACE_AHEAD,
            "carência encadeada {total:?} passou do teto"
        );
        assert!(
            total < Duration::from_secs(135),
            "o pior caso antigo (135s) não pode mais acontecer"
        );
        // e a semântica é sempre MÁXIMO: uma carência curta não encurta a longa
        let longa = nova_carencia(now, now, WAKE_GRACE);
        let depois = nova_carencia(longa, now, Duration::from_secs(1));
        assert_eq!(depois, longa, "carência curta não pode sobrescrever a longa");
    }

    #[test]
    fn k7_backoff_volta_a_separar_as_recuperacoes() {
        // espera efetiva = carência + backoff, então cada nível 3 fica mais
        // espaçado que o anterior (antes eram todos exatamente 60s)
        let esperas: Vec<u64> = (1..=4)
            .map(|n| RECOVERY_GRACE.as_secs() + backoff_secs(n))
            .collect();
        assert_eq!(esperas, vec![32, 34, 38, 46]);
        for par in esperas.windows(2) {
            assert!(par[1] > par[0], "o backoff tem que separar mais a cada vez");
        }
    }

    /* --- K6 ------------------------------------------------------------- */

    #[test]
    fn k6_veredito_do_rust_prevalece_ate_a_pagina_reportar_connected() {
        // heartbeat dizendo RECONNECTING não apaga o FAILED do breaker
        assert_eq!(reconciliar("RECONNECTING", true), "FAILED");
        assert_eq!(reconciliar("OFFLINE", true), "FAILED");
        // CONNECTED é o único sinal que derruba o veredito
        assert_eq!(reconciliar("CONNECTED", true), "CONNECTED");
        // sem veredito ativo, a página manda no estado do link
        assert_eq!(reconciliar("RECONNECTING", false), "RECONNECTING");
        assert_eq!(reconciliar("CONNECTED", false), "CONNECTED");
    }

    /* --- K4 / K5 -------------------------------------------------------- */

    #[test]
    fn k4_uma_linha_por_escrita_e_rotacao_nao_perde_o_historico_do_app() {
        // arquivo com muita linha da página e poucas do app
        let mut buf: Vec<u8> = Vec::new();
        for k in 0..4000 {
            buf.extend_from_slice(
                format!(
                    r#"{{"attempts":0,"reason":"transicao {k}","src":"page","state":"OFFLINE"}}"#
                )
                .as_bytes(),
            );
            buf.push(b'\n');
            if k % 500 == 0 {
                buf.extend_from_slice(
                    format!(r#"{{"attempts":3,"reason":"watchdog {k}","src":"app","state":"RECONNECTING"}}"#)
                        .as_bytes(),
                );
                buf.push(b'\n');
            }
        }
        let novo = rotacionar_conteudo(&buf, 1024).expect("deveria rotacionar");
        let texto = String::from_utf8_lossy(&novo);
        // TODAS as 8 linhas do app sobrevivem
        assert_eq!(
            texto.matches(r#""src":"app""#).count(),
            8,
            "a rotação apagou histórico do app"
        );
        // e o arquivo encolheu de verdade
        assert!(novo.len() < buf.len());
        // sem linha vazia e sem dois JSON grudados
        assert!(!texto.contains("}{"), "linha com dois JSON");
        assert!(
            !texto.lines().any(|l| l.trim().is_empty()),
            "linha vazia sobrou"
        );
        // abaixo do teto não rotaciona nada
        assert!(rotacionar_conteudo(b"pequeno\n", 1024).is_none());
    }

    #[test]
    fn k5_vazao_remota_limitada_dedup_e_janela() {
        let now = Instant::now();
        let mut i = inner_de_teste(now);

        // duplicata em rajada não vira linha
        assert_eq!(limitar_remoto(&mut i, now, "A>B:x"), Vazao::Aceita);
        assert_eq!(
            limitar_remoto(&mut i, now + Duration::from_millis(100), "A>B:x"),
            Vazao::Duplicada
        );

        // 3,8 transições por segundo (o número medido em produção) durante
        // um minuto: o log não pode receber mais que o teto da janela
        let mut i = inner_de_teste(now);
        let mut aceitas = 0;
        for k in 0..228u64 {
            let t = now + Duration::from_millis(k * 263);
            if limitar_remoto(&mut i, t, &format!("A>B:{k}")) == Vazao::Aceita {
                aceitas += 1;
            }
        }
        assert!(
            aceitas <= MAX_REMOTE_TRANSITIONS as usize + 1,
            "vazaram {aceitas} linhas numa janela"
        );

        // e a janela seguinte volta a aceitar
        let t = now + REMOTE_WINDOW + Duration::from_secs(1);
        assert_eq!(limitar_remoto(&mut i, t, "A>B:novo"), Vazao::Aceita);
    }

    #[test]
    fn k5_fila_do_log_e_limitada() {
        assert!(LOG_QUEUE_MAX > 0, "canal ilimitado é o defeito original");
        let (tx, _rx) = sync_channel::<String>(LOG_QUEUE_MAX);
        for _ in 0..LOG_QUEUE_MAX {
            tx.try_send("x".into()).expect("deveria caber");
        }
        // cheia: descarta em vez de crescer
        assert!(matches!(
            tx.try_send("estouro".into()),
            Err(TrySendError::Full(_))
        ));
    }

    /* --- M1: o contador conta RECUPERAÇÃO DISPARADA -------------------- */

    /// O teste que o binário anterior não tinha e que teria pego o defeito:
    /// três recuperações de nível 2 (cada uma É um `location.reload()`) com o
    /// estado do link passando por STARTING/NEEDS_AUTH entre elas — que é por
    /// onde TODO reload passa. O contador tem que SUBIR, e na quarta o app tem
    /// que parar de recarregar.
    #[test]
    fn m1_contador_sobe_atraves_dos_reloads_e_converge() {
        let t0 = Instant::now();
        let mut i = inner_de_teste(t0);
        let mut t = t0;
        let mut vistos = Vec::new();

        for _ in 0..3 {
            let v = decidir_recuperacao(&mut i, t, 2, "login-apos-queda", true, false);
            assert!(v.permitido, "recuperação {} deveria ser autorizada", v.tentativa);
            vistos.push(v.tentativa);

            // ---- aqui acontece o `location.reload()` ----
            // O JS perde TUDO: contador, backoff, cenário. O que ele lê de
            // volta é `i.tent.valor`. E o Rust, do lado dele, vê o documento
            // novo passar por STARTING e depois NEEDS_AUTH (a tela de QR),
            // exatamente os `ESTADOS_INDEFINIDOS` que congelavam o contador.
            i.reload_esperado_ate = None;
            for estado in ["STARTING", "NEEDS_AUTH", "NEEDS_AUTH"] {
                i.page_state = estado.into();
                t += Duration::from_secs(20);
                let saude = julgar_saude(estado, true, false);
                assert_eq!(saude, Saude::Indefinida);
                i.tent.observar(t, saude);
            }
            // e o congelamento NÃO pode ter apagado nada
            assert_eq!(
                i.tent.valor,
                *vistos.last().unwrap(),
                "o reload/QR zerou o contador — é exatamente o defeito de produção"
            );
            t += Duration::from_secs(120);
        }

        assert_eq!(vistos, vec![1, 2, 3], "o contador tem que SUBIR entre reloads");

        // quarta tentativa no MESMO cenário: o app para de recarregar.
        let v = decidir_recuperacao(&mut i, t, 2, "login-apos-queda", true, false);
        assert!(!v.permitido, "a 4ª recarga no mesmo cenário tinha que ser negada");
        assert!(v.convergiu, "negar sem convergir não é convergência");
        assert!(v.motivo.contains("convergiu"), "{}", v.motivo);
        assert_eq!(v.tentativa, 3, "recusa não pode inflar o contador");

        // e continua negando enquanto durar o descanso — sem recarregar nada
        for k in 1..40u64 {
            let tt = t + Duration::from_secs(k * 5);
            let v = decidir_recuperacao(&mut i, tt, 2, "login-apos-queda", true, false);
            assert!(!v.permitido, "recarregou durante o descanso (k={k})");
        }
    }

    /// A prova do lado oposto: só sucesso REAL e sustentado zera.
    #[test]
    fn m1_so_connected_sustentado_zera_o_contador_de_recuperacao() {
        let t0 = Instant::now();
        let mut i = inner_de_teste(t0);
        assert!(decidir_recuperacao(&mut i, t0, 1, "socket", true, false).permitido);
        assert_eq!(i.tent.valor, 1);

        // NEEDS_AUTH por 5 minutos não zera nada (não é sucesso)
        let mut t = t0;
        for _ in 0..100 {
            t += Duration::from_secs(3);
            i.tent.observar(t, julgar_saude("NEEDS_AUTH", true, false));
        }
        assert_eq!(i.tent.valor, 1, "QR na tela não é sucesso");

        // CONNECTED por 14s também não (o 1º tick só INICIA a contagem)
        for _ in 0..15 {
            t += Duration::from_secs(1);
            i.tent.observar(t, Saude::Boa);
        }
        assert_eq!(i.tent.valor, 1, "14s de CONNECTED não podem zerar");
        // o 15º segundo zera
        t += Duration::from_secs(1);
        assert_eq!(i.tent.observar(t, Saude::Boa), Some("zerado"));
        assert_eq!(i.tent.valor, 0);
    }

    /// A página não controla o contador: pedir em rajada não o infla, e o
    /// máximo que ela consegue é ANTECIPAR a própria parada.
    #[test]
    fn m1_pagina_nao_controla_o_contador() {
        let t0 = Instant::now();
        let mut i = inner_de_teste(t0);
        let mut autorizadas = 0;
        for k in 0..500u64 {
            let t = t0 + Duration::from_millis(k * 100); // 10 pedidos/s
            if decidir_recuperacao(&mut i, t, 2, "socket", true, false).permitido {
                autorizadas += 1;
            }
        }
        assert!(
            autorizadas <= MAX_DISPAROS_CENARIO as usize,
            "500 pedidos em rajada viraram {autorizadas} recuperações"
        );
        assert!(i.tent.valor <= MAX_ATTEMPTS);
        assert!(i.descanso_ate.is_some(), "a rajada tinha que levar a descanso");

        // E trocar o RÓTULO do cenário a cada pedido — a manobra óbvia para
        // comprar orçamento novo — não escapa da convergência: o teto global
        // da janela pega a rajada inicial e, a partir da primeira
        // convergência, rótulo novo não devolve orçamento nenhum.
        let mut i = inner_de_teste(t0);
        let rotulos = ["socket", "carregamento", "login-apos-queda", "documento-mudo"];
        let mut por_hora = [0usize; 6];
        for k in 0..(6 * 3600u64) {
            let t = t0 + Duration::from_secs(k); // 1 pedido/s por 6 horas
            let cen = rotulos[(k % 4) as usize];
            if decidir_recuperacao(&mut i, t, 2, cen, true, false).permitido {
                por_hora[(k / 3600) as usize] += 1;
            }
        }
        for h in 1..6 {
            assert!(
                por_hora[h] <= por_hora[h - 1],
                "alternando rótulos as recuperações voltaram a subir: {por_hora:?}"
            );
        }
        assert!(
            por_hora[5] <= 1 && por_hora[0] <= MAX_DISPAROS_JANELA + MAX_DISPAROS_CENARIO as usize,
            "alternar rótulos driblou a convergência: {por_hora:?}"
        );
    }

    /// W2 — o caso real de 16/08 22:19:42, reproduzido: cinco segundos depois
    /// do retorno de suspensão (carência de 45s em curso), a página reporta
    /// `websocket fechado sem retomada` e pede nível 1.
    #[test]
    fn w2_falha_comprovada_fura_a_carencia_pos_suspensao() {
        let t0 = Instant::now();
        let mut i = inner_de_teste(t0);
        // retorno de suspensão: exatamente o que o handler de salto de relógio faz
        i.grace_until = nova_carencia(i.grace_until, t0, WAKE_GRACE);
        i.hold_until = Some(t0 + WAKE_GRACE);

        let t = t0 + Duration::from_secs(5);
        // (a) SUSPEITA (silêncio) continua esperando a carência — a carência
        //     existe por causa dela, e desmontar isso traria o laço de volta.
        let v = decidir_recuperacao(&mut i, t, 1, "socket", true, false);
        assert!(!v.permitido, "silêncio suspeito não pode furar: {}", v.motivo);
        assert_eq!(v.chave, "backoff");

        // (b) FATO OBSERVADO fura — e é o nível 1, a ação mais branda.
        let t = t + PEDIDO_MIN_INTERVALO + Duration::from_secs(1);
        let v = decidir_recuperacao(&mut i, t, 1, "socket", true, true);
        assert!(v.permitido, "falha comprovada foi negada de novo: {}", v.motivo);
        assert!(v.motivo.contains("COMPROVADA"), "{}", v.motivo);
    }

    /// W2 — o furo é uma exceção pequena, não um portão aberto.
    #[test]
    fn w2_furo_tem_orcamento_proprio_e_nao_desmonta_a_convergencia() {
        let t0 = Instant::now();

        // (a) nível 2 (reload) NUNCA fura: o reload é a ação cara.
        let mut i = inner_de_teste(t0);
        i.hold_until = Some(t0 + WAKE_GRACE);
        let v = decidir_recuperacao(&mut i, t0 + Duration::from_secs(5), 2, "socket", true, true);
        assert!(!v.permitido, "nível 2 não pode furar carência: {}", v.motivo);

        // (b) o orçamento de furos acaba, e aí a carência volta a valer.
        let mut i = inner_de_teste(t0);
        i.hold_until = Some(t0 + Duration::from_secs(600));
        let mut furados = 0;
        for k in 0..40u64 {
            let t = t0 + Duration::from_secs(5 + k * 10);
            i.hold_until = Some(t0 + Duration::from_secs(600));
            if decidir_recuperacao(&mut i, t, 1, "envio-preso", true, true).permitido {
                furados += 1;
            }
        }
        assert!(
            furados <= MAX_FUROS_JANELA,
            "{furados} furos numa janela de {MAX_FUROS_JANELA}"
        );

        // (c) descanso pós-convergência NÃO é furável: quem convergiu espera.
        let mut i = inner_de_teste(t0);
        i.descanso_ate = Some(t0 + Duration::from_secs(300));
        let v = decidir_recuperacao(&mut i, t0 + Duration::from_secs(5), 1, "envio-preso", true, true);
        assert!(!v.permitido, "furou o descanso: {}", v.motivo);
        assert_eq!(v.chave, "descanso");

        // (d) e insistir com sinal "comprovado" falso converge como qualquer
        //     outro: a saída é PARAR de recuperar, nunca um laço de reload.
        let mut i = inner_de_teste(t0);
        let mut autorizadas = 0;
        for k in 0..(3600u64) {
            let t = t0 + Duration::from_secs(k);
            if decidir_recuperacao(&mut i, t, 1, "envio-preso", true, true).permitido {
                autorizadas += 1;
            }
        }
        assert!(
            autorizadas <= MAX_DISPAROS_JANELA + MAX_DISPAROS_CENARIO as usize + MAX_FUROS_JANELA,
            "sinal 'comprovado' em laço reabriu o portão: {autorizadas} recuperações em 1h"
        );
        assert!(i.descanso_ate.is_some(), "tinha que ter convergido");
    }

    /// W2 — o orçamento do cenário não pode queimar antes de a ação agir.
    /// Medido ao vivo: 3 níveis 1 em 6 segundos e FAILED em seguida.
    #[test]
    fn w2_envio_preso_nao_queima_o_orcamento_em_segundos() {
        let t0 = Instant::now();
        let mut i = inner_de_teste(t0);
        let mut instantes = vec![];
        for k in 0..600u64 {
            let t = t0 + Duration::from_secs(k);
            if decidir_recuperacao(&mut i, t, 1, "envio-preso", true, false).permitido {
                instantes.push(k);
            }
        }
        assert!(instantes.len() >= 2, "nem tentou: {instantes:?}");
        let ultimo = *instantes.last().unwrap();
        assert!(
            ultimo >= 40,
            "o cenário 'envio-preso' convergiu em {ultimo}s; o cutucão precisa de tempo para agir: {instantes:?}"
        );
        for par in instantes.windows(2) {
            assert!(
                par[1] - par[0] >= 20,
                "duas tentativas a menos de 20s uma da outra: {instantes:?}"
            );
        }
    }

    /// M1 — retaguarda: reload que a página deu sem avisar também conta.
    #[test]
    fn m1_reload_nao_declarado_e_reconhecido() {
        let t0 = Instant::now();
        let mut i = inner_de_teste(t0);
        // boot: a primeira carga não é recuperação
        assert!(carga_esperada(&i, t0, true));
        // renavegação do watchdog em voo
        i.recovering = true;
        assert!(carga_esperada(&i, t0, false));
        i.recovering = false;
        // nível 2 autorizado há pouco: a carga é a que nós pedimos
        i.reload_esperado_ate = Some(t0 + RELOAD_ESPERADO);
        assert!(carga_esperada(&i, t0, false));
        // passado o prazo, qualquer carga nova é recuperação não declarada
        assert!(!carga_esperada(
            &i,
            t0 + RELOAD_ESPERADO + Duration::from_secs(1),
            false
        ));
    }

    /* --- M2 ------------------------------------------------------------- */

    #[test]
    fn m2_failed_tem_teto_de_tempo() {
        assert!(
            DESCANSO_FAILED < RECOVERY_WINDOW,
            "o veredito FAILED não pode durar a janela inteira"
        );
        let t0 = Instant::now();
        let mut i = inner_de_teste(t0);
        i.rust_failed_until = Some(t0 + DESCANSO_FAILED);
        // durante o descanso: nada de recuperação
        let v = decidir_recuperacao(&mut i, t0 + Duration::from_secs(60), 2, "socket", true, false);
        assert!(!v.permitido);
        // depois dele: volta a tentar sozinho, sem reinício manual
        let v = decidir_recuperacao(
            &mut i,
            t0 + DESCANSO_FAILED + Duration::from_secs(1),
            2,
            "socket",
            true,
            false,
        );
        assert!(v.permitido, "o app precisa voltar a tentar sozinho: {}", v.motivo);
    }

    /// A camada que age quando o heartbeat está FRESCO e o link, morto.
    #[test]
    fn m2_link_morto_com_heartbeat_fresco_e_acionavel() {
        // o watchdog só se cala com heartbeat fresco E estado não-ruim
        for st in ESTADOS_RUINS {
            assert!(
                ESTADOS_RUINS.contains(&st),
                "estado ruim reportado com heartbeat fresco tem que ser acionável"
            );
            assert_eq!(julgar_saude(st, true, false), Saude::Ruim);
        }
        // NEEDS_AUTH (QR na tela) NÃO pode acionar este caminho
        assert!(!ESTADOS_RUINS.contains(&"NEEDS_AUTH"));
        assert!(!ESTADOS_RUINS.contains(&"STARTING"));
        // e o prazo é maior que o pior backoff do JS, para não atropelar uma
        // recuperação da página ainda em curso
        assert!(LINK_MORTO > Duration::from_secs(60));
    }

    /* --- M3 ------------------------------------------------------------- */

    #[test]
    fn m3_cenario_novo_recomeca_a_contagem_do_cenario_mas_nao_o_contador() {
        let t0 = Instant::now();
        let mut i = inner_de_teste(t0);
        let mut t = t0;
        for _ in 0..MAX_DISPAROS_CENARIO {
            assert!(decidir_recuperacao(&mut i, t, 2, "login-apos-queda", true, false).permitido);
            t += Duration::from_secs(120);
        }
        assert!(!decidir_recuperacao(&mut i, t, 2, "login-apos-queda", true, false).permitido);

        // um cenário DIFERENTE não é o mesmo problema: pode tentar de novo…
        t += DESCANSO_CONVERGIDO + Duration::from_secs(1);
        let v = decidir_recuperacao(&mut i, t, 2, "carregamento", true, false);
        assert!(v.permitido, "{}", v.motivo);
        // …mas o contador de tentativas NÃO recomeça do zero
        assert_eq!(v.tentativa, MAX_DISPAROS_CENARIO + 1);
    }

    /// M3 — a propriedade que dá nome à tarefa: um cenário que NUNCA melhora
    /// tem que produzir cada vez MENOS recuperações. O defeito de produção
    /// fazia ~12 recargas por hora, indefinidamente; a primeira versão desta
    /// correção (descanso fixo, orçamento renovado) faria ~30 por hora, que é
    /// pior. Aqui medimos o número real numa simulação de 6 horas.
    #[test]
    fn m3_recuperacao_converge_num_cenario_que_nunca_melhora() {
        let t0 = Instant::now();
        let mut i = inner_de_teste(t0);
        let mut por_hora = [0usize; 6];
        // a página pede a cada 10s, sem parar, por 6 horas
        for k in 0..(6 * 360) {
            let t = t0 + Duration::from_secs(k * 10);
            if decidir_recuperacao(&mut i, t, 2, "carregamento", true, false).permitido {
                por_hora[(k / 360) as usize] += 1;
            }
        }
        assert!(
            por_hora[0] <= 6,
            "primeira hora com {} recargas — o defeito media 12/h",
            por_hora[0]
        );
        for h in 1..6 {
            assert!(
                por_hora[h] <= por_hora[h - 1],
                "as recargas voltaram a subir: {por_hora:?}"
            );
        }
        assert!(
            por_hora[5] <= 1,
            "na 6ª hora ainda havia {} recargas: não convergiu",
            por_hora[5]
        );
        // mas NUNCA vira zero permanente: o app tem que voltar a tentar (M2)
        let total: usize = por_hora.iter().sum();
        assert!(total >= 5, "parar para sempre é o outro defeito: {por_hora:?}");
    }

    #[test]
    fn m3_descanso_dobra_e_tem_teto() {
        assert_eq!(descanso_de(1), DESCANSO_CONVERGIDO);
        assert_eq!(descanso_de(2), DESCANSO_CONVERGIDO * 2);
        assert_eq!(descanso_de(3), DESCANSO_CONVERGIDO * 4);
        assert_eq!(descanso_de(50), DESCANSO_MAX);
        assert!(descanso_de(0) <= DESCANSO_CONVERGIDO);
    }

    /* --- M4 ------------------------------------------------------------- */

    #[test]
    fn m4_sinal_positivo_encurta_todos_os_descansos() {
        let t0 = Instant::now();
        let mut i = inner_de_teste(t0);
        i.hold_until = Some(t0 + RECOVERY_WINDOW);
        i.blank_hold_until = Some(t0 + RECOVERY_WINDOW);
        i.descanso_ate = Some(t0 + DESCANSO_CONVERGIDO);
        i.rust_failed_until = Some(t0 + DESCANSO_FAILED);

        assert!(rearmar_por_sinal(&mut i, t0), "o sinal positivo não mexeu em nada");
        let teto = t0 + REARME_POR_SINAL;
        for campo in [i.hold_until, i.blank_hold_until, i.descanso_ate, i.rust_failed_until] {
            assert!(campo.unwrap() <= teto, "sobrou descanso longo depois do rearme");
        }
        // e o pior caso medido pela auditoria (~10 min sem recuperação) some
        assert!(REARME_POR_SINAL < Duration::from_secs(60));
        // rearmar de novo não estende nada
        assert!(!rearmar_por_sinal(&mut i, t0));
        // um prazo mais CURTO que o alvo não é esticado
        i.hold_until = Some(t0 + Duration::from_secs(2));
        rearmar_por_sinal(&mut i, t0);
        assert_eq!(i.hold_until, Some(t0 + Duration::from_secs(2)));
    }

    #[test]
    fn cenario_vindo_da_pagina_e_whitelist() {
        assert_eq!(cenario_valido("login-apos-queda"), "login-apos-queda");
        assert_eq!(cenario_valido("<script>"), "outro");
        assert_eq!(cenario_valido(&"x".repeat(9000)), "outro");
    }

    fn inner_de_teste(now: Instant) -> Inner {
        Inner {
            state: "STARTING".into(),
            page_state: "STARTING".into(),
            reason: String::new(),
            since_ms: 0,
            tent: Tentativas::default(),
            attempts_reported: 0,
            last_heartbeat: None,
            maior_pausa_js: Duration::ZERO,
            pausa_js_em: None,
            hb_total: 0,
            hb_max: Duration::ZERO,
            hb_soma: Duration::ZERO,
            hb_acima_9s: 0,
            hb_acima_30s: 0,
            hb_acima_60s: 0,
            calibracao_em: None,
            silencio_logado: false,
            rascunho_ate: None,
            adiando_desde: None,
            rascunho_em_risco: false,
            grace_until: now,
            recovering: false,
            recovering_since: None,
            recoveries: VecDeque::new(),
            blank_recoveries: VecDeque::new(),
            recoveries_total: 0,
            hold_until: None,
            blank_hold_until: None,
            disparos: VecDeque::new(),
            cenario: String::new(),
            cenario_disparos: 0,
            descanso_ate: None,
            convergencias: 0,
            furos: VecDeque::new(),
            ultimo_pedido: None,
            ultima_recusa: String::new(),
            reload_esperado_ate: None,
            carga_vista: true,
            link_ruim_desde: None,
            rust_failed_until: None,
            tick_mono: now,
            tick_wall: SystemTime::now(),
            page: None,
            page_origin: String::new(),
            page_at: None,
            blank_since: None,
            loaded_at: None,
            loaded_origin: String::new(),
            main_stuck_logged: false,
            visible_since: None,
            remote_window_start: now,
            remote_count: 0,
            remote_suppressed: 0,
            last_remote_sig: None,
            last_remote_at: None,
        }
    }
}
