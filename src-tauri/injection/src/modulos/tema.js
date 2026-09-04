import { css, dropCss, reg, settings } from "../nucleo.js";

/* 25. Tema / dark reforçado + acento personalizável -------------------- */
export function registrarTema() {
  reg({
    id: "theme",
    apply() {
      const accent = (settings.theme && settings.theme.accent) || "#7c3aed";
      const radius = (settings.theme && settings.theme.radius) || "14px";
      css(
        `:root{--zl-accent:${accent};--zl-radius:${radius}}
         [data-icon="status-refreshed"] , span[data-icon="status-outline"]{filter:hue-rotate(0)}
         .zl-fab{background:var(--zl-accent)!important}
         header ._ak8i, .app-wrapper-web{--wa-accent:var(--zl-accent)}`,
        "zl-theme"
      );
    },
    revert() {
      dropCss("zl-theme");
    },
  });
}
