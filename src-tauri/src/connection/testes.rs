//! Testes da camada de conexão. Continuam sendo UM módulo só: cada caso
//! amarra uma regra que já custou caro.

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
