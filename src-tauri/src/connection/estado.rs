//! Estado da máquina: `Inner` (todos os campos observados), o `ConnMonitor`
//! que o Tauri guarda como estado gerenciado, as carências e o limitador de
//! vazão da origem remota.

use super::*;

pub(crate) struct Inner {
    /// Estado EFETIVO (reconciliado). É o que vai ao log, ao evento e ao
    /// `get_connection_state`. Ver `reconciliar` (K6).
    pub(crate) state: String,
    /// Último estado REPORTADO pela página. Sinal, não veredito.
    pub(crate) page_state: String,
    pub(crate) reason: String,
    pub(crate) since_ms: u64,

    /// Contador derivado pelo Rust (K1).
    pub(crate) tent: Tentativas,
    /// Valor que a página informou por último. Diagnóstico apenas.
    pub(crate) attempts_reported: u32,

    pub(crate) last_heartbeat: Option<Instant>,

    /* --- E1/E2: distinguir "JS congelou" de "webview morreu" ------------- */
    /// E2 — maior pausa que a PRÓPRIA página relatou (salto entre execuções do
    /// seu tique de 1s). Um atraso EXPLICADO não é zumbi, e o limiar de morte
    /// se calibra por ele: ver `limiar_zumbi`.
    pub(crate) maior_pausa_js: Duration,
    /// Quando a última pausa auto-declarada chegou (para não valer para sempre).
    pub(crate) pausa_js_em: Option<Instant>,
    /// Distribuição medida dos intervalos entre heartbeats NESTA máquina.
    pub(crate) hb_total: u64,
    pub(crate) hb_max: Duration,
    pub(crate) hb_soma: Duration,
    pub(crate) hb_acima_9s: u64,
    pub(crate) hb_acima_30s: u64,
    pub(crate) hb_acima_60s: u64,
    pub(crate) calibracao_em: Option<Instant>,
    /// Já logamos o silêncio do episódio corrente? (uma linha por episódio,
    /// não uma a cada tick de 3s).
    pub(crate) silencio_logado: bool,

    /* --- E3: o que o usuário digitou não se joga fora -------------------- */
    /// Até quando um rascunho visto no campo de mensagem segura nível 2/3.
    pub(crate) rascunho_ate: Option<Instant>,
    /// Desde quando estamos adiando por causa do rascunho (tem teto).
    pub(crate) adiando_desde: Option<Instant>,
    /// A próxima recuperação autorizada vai acontecer POR CIMA de um rascunho:
    /// o motivo precisa dizer isso ao usuário.
    pub(crate) rascunho_em_risco: bool,

    /// Nenhuma recuperação antes deste instante. Unifica TODAS as carências,
    /// sempre com semântica de MÁXIMO e sempre com teto (`MAX_GRACE_AHEAD`).
    pub(crate) grace_until: Instant,

    /// Trava anti-corrida: impede o watchdog de disparar duas recuperações.
    pub(crate) recovering: bool,
    pub(crate) recovering_since: Option<Instant>,

    pub(crate) recoveries: VecDeque<Instant>,
    pub(crate) blank_recoveries: VecDeque<Instant>,
    pub(crate) recoveries_total: u32,
    pub(crate) hold_until: Option<Instant>,
    pub(crate) blank_hold_until: Option<Instant>,

    /* M1/M3 — breaker da COMPOSIÇÃO: toda recuperação disparada, de qualquer
       nível e de qualquer camada, passa por aqui. */
    /// Instantes de TODAS as recuperações disparadas (níveis 1, 2 e 3).
    pub(crate) disparos: VecDeque<Instant>,
    /// Rótulo do cenário da última recuperação autorizada.
    pub(crate) cenario: String,
    /// Quantas recuperações seguidas no MESMO cenário sem progresso.
    pub(crate) cenario_disparos: u32,
    /// Convergiu: nenhuma recuperação até aqui, em nenhum nível. Só espera.
    pub(crate) descanso_ate: Option<Instant>,
    /// Quantas vezes já convergimos sem NENHUM sucesso no meio. Cada uma
    /// dobra o descanso: é isto que impede o app de voltar a recarregar em
    /// ritmo constante para sempre. Só sucesso sustentado zera.
    pub(crate) convergencias: u32,
    /// W2 — instantes dos FUROS de carência concedidos a falha comprovada.
    /// Orçamento próprio e pequeno: ver `MAX_FUROS_JANELA`.
    pub(crate) furos: VecDeque<Instant>,
    /// Último pedido vindo da origem remota (anti-rajada).
    pub(crate) ultimo_pedido: Option<Instant>,
    /// Último motivo de recusa já logado (o log não repete recusa igual).
    pub(crate) ultima_recusa: String,
    /// Depois de autorizar um nível 2, a carga seguinte é esperada.
    pub(crate) reload_esperado_ate: Option<Instant>,
    /// Já vimos a primeira carga de documento (a do boot não é recuperação).
    pub(crate) carga_vista: bool,
    /// M2 — desde quando o link é reportado ruim COM heartbeat chegando.
    pub(crate) link_ruim_desde: Option<Instant>,

    /// Veredito de FALHA do Rust (K6). Enquanto valer, o estado efetivo é
    /// FAILED mesmo que o heartbeat seguinte diga outra coisa — e o `check()`
    /// LÊ isto para não recuperar.
    pub(crate) rust_failed_until: Option<Instant>,

    /// Último tick do watchdog nos dois relógios, para detectar salto.
    pub(crate) tick_mono: Instant,
    pub(crate) tick_wall: SystemTime,

    /// Última leitura feita NA thread principal (sonda de URL).
    pub(crate) page: Option<PageKind>,
    pub(crate) page_origin: String,
    pub(crate) page_at: Option<Instant>,
    pub(crate) blank_since: Option<Instant>,
    /// K12: instante do `NavigationCompleted` do WebView2 (via `on_page_load`).
    pub(crate) loaded_at: Option<Instant>,
    pub(crate) loaded_origin: String,
    pub(crate) main_stuck_logged: bool,

    pub(crate) visible_since: Option<Instant>,

    /* K5 — controle da vazão remota */
    pub(crate) remote_window_start: Instant,
    pub(crate) remote_count: u32,
    pub(crate) remote_suppressed: u32,
    pub(crate) last_remote_sig: Option<String>,
    pub(crate) last_remote_at: Option<Instant>,
}

pub struct ConnMonitor {
    pub(crate) inner: Mutex<Inner>,
    pub(crate) started: Instant,
    /// Visibilidade da janela main SEM IPC bloqueante.
    pub(crate) visible: AtomicBool,
    /// Idem para o foco. NÃO concede carência nenhuma (K3).
    pub(crate) focused: AtomicBool,
    /// Espelho lock-free de `recovering`, lido pelo guarda de saída.
    pub(crate) recovering: AtomicBool,
    /// K10: o USUÁRIO pediu para fechar (X, Alt+F4, comando externo). O guarda
    /// de saída nunca ressuscita a janela nesse caso.
    pub(crate) user_exit: AtomicBool,
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
pub(crate) fn lock_inner(mon: &ConnMonitor) -> MutexGuard<'_, Inner> {
    mon.inner.lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn iso_now() -> String {
    chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, false)
}

/// Whitelist de estados: nada fora da lista entra no log ou no estado.
pub(crate) fn valid_state(s: &str) -> String {
    if STATES.contains(&s) {
        s.to_string()
    } else {
        "UNKNOWN".into()
    }
}

pub(crate) fn sanitize_reason(r: &str) -> String {
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

/// K7 — semântica ÚNICA de carência: máximo com o que já existe, e teto
/// absoluto em `MAX_GRACE_AHEAD` a partir de agora.
///
/// Antes havia duas semânticas no mesmo campo: `:585` fazia máximo e `:777`
/// SOBRESCREVIA. Pior, o encadeamento não tinha teto.
pub(crate) fn nova_carencia(atual: Instant, now: Instant, dur: Duration) -> Instant {
    let alvo = now + dur;
    let escolhido = if alvo > atual { alvo } else { atual };
    let teto = now + MAX_GRACE_AHEAD;
    if escolhido > teto {
        teto
    } else {
        escolhido
    }
}

pub(crate) fn estender_carencia(i: &mut Inner, now: Instant, dur: Duration) {
    i.grace_until = nova_carencia(i.grace_until, now, dur);
}


/// K5 — decisão do limitador de vazão da origem remota.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Vazao {
    Aceita,
    /// Mesma transição repetida em rajada: estado atualiza, log não.
    Duplicada,
    /// Teto da janela estourado.
    Excedeu,
    /// Primeira supressão da janela: vale uma nota única no log.
    ExcedeuPrimeira,
}

pub(crate) fn limitar_remoto(i: &mut Inner, now: Instant, sig: &str) -> Vazao {
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
