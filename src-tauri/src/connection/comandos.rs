//! Comandos expostos à ponte (assinaturas congeladas) e os avisos que o
//! resto do Rust manda para a máquina de estados.

use super::*;

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
