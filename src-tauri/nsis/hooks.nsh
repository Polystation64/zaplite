; P1 — desinstalar o ZapLite não pode deixar o Windows apontando para um exe
; que não existe mais.
;
; O problema: se o usuário ligou "abrir links whatsapp:// no ZapLite" e depois
; desinstalou, HKCU\Software\Classes\whatsapp continuaria com um
; shell\open\command para um caminho apagado — e todo link de WhatsApp clicado
; no navegador passaria a não fazer nada.
;
; O desinstalador não tem parser de JSON, então o app grava, ao lado do retrato
; completo (`ProtocolBackup`), as MIGALHAS que este arquivo consegue ler:
;   ProtocolBackupExistia      REG_DWORD  a chave existia antes de ligarmos?
;   ProtocolBackupDefault      REG_SZ     valor padrão que havia
;   ProtocolBackupUrlProtocol  REG_SZ     valor "URL Protocol" que havia
;   ProtocolBackupCommand      REG_SZ     shell\open\command que havia ("" se não)
; Ver `registrar()` em src/protocol.rs.
;
; A trava: só mexemos na chave se o valor `ZapLite` estiver lá. É ele que prova
; que o handler atual é NOSSO. Sem essa marca, o registro é de outro programa e
; o desinstalador do ZapLite não tem nada que apagar registro de terceiro.

!macro NSIS_HOOK_PREUNINSTALL
  ; Tudo em HKCU: o registro foi feito por usuário, é desfeito por usuário.
  SetShellVarContext current

  ReadRegStr $0 HKCU "Software\Classes\whatsapp" "ZapLite"
  StrCmp $0 "" proto_fim 0

    ; A marca está lá: o handler é nosso. Fora com a árvore inteira.
    DeleteRegKey HKCU "Software\Classes\whatsapp"

    ; Devolve o que havia, se havia.
    ReadRegDWORD $1 HKCU "Software\ZapLite" "ProtocolBackupExistia"
    IntCmp $1 1 0 proto_limpa proto_limpa

      ReadRegStr $2 HKCU "Software\ZapLite" "ProtocolBackupDefault"
      WriteRegStr HKCU "Software\Classes\whatsapp" "" "$2"
      ReadRegStr $3 HKCU "Software\ZapLite" "ProtocolBackupUrlProtocol"
      WriteRegStr HKCU "Software\Classes\whatsapp" "URL Protocol" "$3"
      ReadRegStr $4 HKCU "Software\ZapLite" "ProtocolBackupCommand"
      StrCmp $4 "" proto_limpa 0
        WriteRegStr HKCU "Software\Classes\whatsapp\shell\open\command" "" "$4"

  proto_limpa:
    DeleteRegKey HKCU "Software\ZapLite"

  proto_fim:
  ; "Programas Padrão": ProgId e capacidades são 100% nossos, saem sempre.
  ; `RegisteredApplications` é COMPARTILHADA — sai só o VALOR com o nosso nome,
  ; nunca a chave, senão o desinstalador do ZapLite tiraria os outros programas
  ; da lista de aplicativos padrão do Windows.
  DeleteRegKey HKCU "Software\Classes\ZapLite.whatsapp"
  DeleteRegValue HKCU "Software\RegisteredApplications" "ZapLite"
!macroend
