//! A autoridade única sobre DISPARAR recuperação (`decidir_recuperacao`) e o
//! que alimenta a decisão: contador de disparo, convergência, tetos,
//! carências, rearme por sinal positivo e detecção de degradação.
//!
//! Quatro iterações de auditoria moram aqui. Mexer em qualquer constante ou
//! ramo deste arquivo muda o comportamento de recuperação do app.

use super::*;

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
pub(crate) fn piso_de_espera(cen: &str) -> Duration {
    match cen {
        // fechar o socket implicado e cutucar a reconexão: o WhatsApp precisa
        // reabrir o socket e drenar a fila antes de valer a pena tentar de novo.
        "envio-preso" | "link-morto" => Duration::from_secs(20),
        _ => Duration::ZERO,
    }
}

/// W2 — quanto tempo um furo de carência vale como orçamento.
pub(crate) const FUROS_JANELA: Duration = Duration::from_secs(10 * 60);
/// E quantos cabem nela. Dois, de propósito: o suficiente para atravessar um
/// retorno de suspensão (o momento em que a carência e a falha real colidem) e
/// pouco o bastante para que um sinal falso repetido não vire laço — o terceiro
/// pedido volta a esperar a carência inteira.
pub(crate) const MAX_FUROS_JANELA: usize = 2;

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
pub(crate) fn falha_comprovada_fura(i: &mut Inner, now: Instant, nivel: u32, comprovada: bool) -> bool {
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

pub(crate) fn decidir_recuperacao(
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
pub(crate) fn descanso_de(convergencias: u32) -> Duration {
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
pub(crate) fn carga_esperada(i: &Inner, now: Instant, primeira: bool) -> bool {
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
pub(crate) fn rearmar_por_sinal(i: &mut Inner, now: Instant) -> bool {
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
pub(crate) fn reconciliar(page_state: &str, veredito_ativo: bool) -> String {
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
pub(crate) fn limiar_zumbi(i: &Inner, now: Instant) -> Duration {
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
pub(crate) fn evidencia_de_morte(i: &Inner, silencio: Duration, limiar: Duration) -> Option<String> {
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

pub(crate) fn julgar_saude(page_state: &str, heartbeat_fresco: bool, neutro: bool) -> Saude {
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
