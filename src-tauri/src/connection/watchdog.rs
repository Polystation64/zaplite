//! O laço do watchdog: sonda a URL, avalia a saúde a cada tick e conduz a
//! recuperação até o fim.

use super::*;

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
pub(crate) fn probe_url(app: &AppHandle) {
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

pub(crate) fn check(app: &AppHandle) {
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
pub(crate) fn recusar(app: &AppHandle, mut i: MutexGuard<'_, Inner>, v: Veredito) {
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
pub(crate) fn falhar(app: &AppHandle, mut i: MutexGuard<'_, Inner>, motivo: String) {
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
pub(crate) fn start_recovery(
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
pub(crate) fn navegar_ou_recriar(app: &AppHandle) -> Result<String, String> {
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

pub(crate) fn finish_recovery(app: &AppHandle, resultado: Result<String, String>) {
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
